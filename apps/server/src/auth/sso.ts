import { createHash, timingSafeEqual } from 'crypto';
import * as oidc from 'openid-client';
import { and, eq, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { SsoErrorCode, SsoProviderKind, SsoRole, SsoRoleMapping, SsoTestResult } from '@smt/shared';
import { getDb } from '../db/index.js';
import { memberships, ssoLoginStates, ssoProviders, userIdentities, users } from '../db/schema.js';
import { config } from '../config/index.js';
import { vault } from '../vault/index.js';
import { rank } from './middleware.js';
import { legacyRoleOf, orgRole, setJoinedMemberRoles } from './access/assign.js';

/**
 * OpenID Connect single sign-on, one provider per org.
 *
 *   GET /api/auth/sso/:orgSlug/start  → PKCE + state + nonce kept server-side,
 *                                       the state also in a cookie on this browser
 *   (identity provider)
 *   GET /api/auth/sso/callback        → state matched against the cookie and
 *                                       consumed; code exchanged; the ID token's
 *                                       signature (JWKS), iss, aud, exp, iat,
 *                                       nonce and azp checked by openid-client
 *
 * The claims then have to carry a verified email in one of the provider's
 * allowed domains, every time. Accounts are matched by the IdP's `sub` once
 * linked. The first time, an existing account is linked by email only if it is
 * already a member of the org; otherwise a new account is created when the
 * provider auto-provisions. An existing account that is not a member is never
 * taken over, since an org's IdP only vouches for that org's members.
 */

export const SSO_CALLBACK_PATH = '/api/auth/sso/callback';
export const SSO_STATE_COOKIE = 'smt_sso_state';
/** Long enough to type a password and do MFA at the IdP. */
export const SSO_STATE_TTL_MS = 10 * 60 * 1000;
/** Discovery documents are re-read at most this often (and whenever the config changes). */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Seconds, for discovery, token and JWKS requests. */
const REQUEST_TIMEOUT_S = 10;

export type SsoProvider = typeof ssoProviders.$inferSelect;
type Account = typeof users.$inferSelect;
type Membership = typeof memberships.$inferSelect;

/** A sign-in that could not complete; the code is all the browser is told. */
export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    /** For the audit row and server log only. */
    readonly detail?: string,
    readonly provider?: SsoProvider,
    readonly email?: string,
  ) {
    super(detail ?? code);
    this.name = 'SsoError';
  }
}

export function ssoRedirectUri(): string {
  return `${config.baseUrl.replace(/\/$/, '')}${SSO_CALLBACK_PATH}`;
}

export function ssoLoginUrl(orgSlug: string): string {
  return `/api/auth/sso/${encodeURIComponent(orgSlug)}/start`;
}

/** Plain HTTP issuers only for local development (a Keycloak or Dex on localhost). */
export function issuerProtocolAllowed(issuer: URL): boolean {
  return issuer.protocol === 'https:' || (config.env === 'development' && issuer.protocol === 'http:');
}

export function parseDomains(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

const SSO_ROLES: SsoRole[] = ['viewer', 'operator', 'admin'];

export function asSsoRole(role: string): SsoRole {
  return SSO_ROLES.includes(role as SsoRole) ? (role as SsoRole) : 'viewer';
}

/**
 * The role an SSO-created account gets when its default is a role rather
 * than a base role (unified roles spec §5: the `default_role` column holds a
 * role id then), or null for a base role. A role since deleted, or Owner,
 * counts as nothing here — the base role fallback (`asSsoRole`) is Viewer.
 */
export function ssoDefaultRoleId(provider: Pick<SsoProvider, 'orgId' | 'defaultRole'>): string | null {
  if (SSO_ROLES.includes(provider.defaultRole as SsoRole)) return null;
  const role = orgRole(provider.orgId, provider.defaultRole);
  return role && role.system !== 'owner' ? role.id : null;
}

/** The base role an SSO-created account's membership row records (`setJoinedMemberRoles` then gives its role). */
function ssoBaseRole(provider: SsoProvider, mapped: SsoRole | null, defaultId: string | null): string {
  if (mapped) return mapped;
  return defaultId ? legacyRoleOf(provider.orgId, [defaultId]) : asSsoRole(provider.defaultRole);
}

export function parseRoleMappings(raw: string): SsoRoleMapping[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is { group: string; role: string } => typeof m?.group === 'string' && typeof m?.role === 'string')
      .map((m) => ({ group: m.group, role: asSsoRole(m.role) }));
  } catch {
    return [];
  }
}

export function asProviderKind(kind: string): SsoProviderKind {
  return (['google', 'microsoft', 'okta', 'generic'] as const).includes(kind as SsoProviderKind)
    ? (kind as SsoProviderKind)
    : 'generic';
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

// ── Provider configuration (discovery) ──────────────────────────────────────

const configCache = new Map<string, { version: string; at: number; config: oidc.Configuration }>();

/** Drop a provider's cached discovery, after it changes or goes away. */
export function forgetProviderConfig(providerId: string) {
  configCache.delete(providerId);
}

function discoveryOptions(issuer: URL): oidc.DiscoveryRequestOptions {
  const execute: Array<(c: oidc.Configuration) => void> = [];
  if (issuer.protocol === 'http:' && issuerProtocolAllowed(issuer)) execute.push(oidc.allowInsecureRequests);
  return { execute, timeout: REQUEST_TIMEOUT_S };
}

/**
 * The openid-client configuration for a provider: its discovery document, the
 * client credentials, and ID token signatures checked against the provider's
 * JWKS. (openid-client would otherwise rely on TLS to the token endpoint
 * alone, which the spec allows; checking the signature as well costs one
 * cached JWKS fetch.)
 */
async function providerConfig(provider: SsoProvider): Promise<oidc.Configuration> {
  const cached = configCache.get(provider.id);
  if (cached && cached.version === provider.updatedAt && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.config;
  }

  const issuer = new URL(provider.issuer);
  if (!issuerProtocolAllowed(issuer)) throw new Error('The issuer must use https');
  const options = discoveryOptions(issuer);
  const discovered = await oidc.discovery(issuer, provider.clientId, undefined, undefined, options);

  // client_secret_basic is the spec default when a provider lists nothing
  const metadata = discovered.serverMetadata();
  const methods = metadata.token_endpoint_auth_methods_supported;
  const secret = await vault.decrypt(provider.encryptedClientSecret, provider.id);
  const auth =
    !methods || methods.includes('client_secret_basic') || !methods.includes('client_secret_post')
      ? oidc.ClientSecretBasic(secret)
      : oidc.ClientSecretPost(secret);
  const configured = new oidc.Configuration(metadata, provider.clientId, undefined, auth);
  configured.timeout = REQUEST_TIMEOUT_S;
  for (const extension of options.execute ?? []) extension(configured);
  oidc.enableNonRepudiationChecks(configured);

  configCache.set(provider.id, { version: provider.updatedAt, at: Date.now(), config: configured });
  return configured;
}

/**
 * The settings page's test button: can the issuer's discovery document and
 * signing keys be fetched, and does the document name the same issuer? The
 * client secret can only be proven by a real sign-in.
 */
export async function testIssuer(issuerUrl: string): Promise<SsoTestResult> {
  try {
    const issuer = new URL(issuerUrl);
    if (!issuerProtocolAllowed(issuer)) return { ok: false, error: 'The issuer URL must use https' };
    const discovered = await oidc.discovery(issuer, 'bastionssh-test', undefined, undefined, discoveryOptions(issuer));
    const metadata = discovered.serverMetadata();
    if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
      return { ok: false, error: 'The discovery document is missing its authorization, token or JWKS endpoint' };
    }
    const jwksUri = new URL(metadata.jwks_uri);
    if (!issuerProtocolAllowed(jwksUri)) return { ok: false, error: 'The JWKS endpoint must use https' };
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_S * 1000), redirect: 'manual' });
    if (!res.ok) return { ok: false, error: `The JWKS endpoint answered HTTP ${res.status}` };
    const jwks = (await res.json()) as { keys?: { use?: string }[] };
    const signingKeys = (jwks.keys ?? []).filter((k) => k.use === undefined || k.use === 'sig').length;
    if (!signingKeys) return { ok: false, error: 'The JWKS endpoint lists no signing keys' };
    return {
      ok: true,
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      signingKeys,
    };
  } catch (err) {
    return { ok: false, error: `Discovery failed: ${(err as Error).message}` };
  }
}

// ── The sign-in round trip ───────────────────────────────────────────────────

/**
 * Start a sign-in: remember the PKCE verifier and nonce under the state's
 * hash, and build the provider's authorization URL. The caller puts the state
 * in a cookie so the callback can tell it is the same browser.
 */
export async function beginSsoLogin(provider: SsoProvider, loginHint?: string): Promise<{ url: URL; state: string }> {
  const oidcConfig = await providerConfig(provider);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const stateHash = hashState(state);

  const db = getDb();
  const now = new Date();
  db.delete(ssoLoginStates).where(lt(ssoLoginStates.expiresAt, now.toISOString())).run();
  db.insert(ssoLoginStates)
    .values({
      stateHash,
      providerId: provider.id,
      encryptedCodeVerifier: await vault.encrypt(verifier, stateHash),
      nonce,
      expiresAt: new Date(now.getTime() + SSO_STATE_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    })
    .run();

  // Okta only puts groups in the ID token when asked; others reject the scope
  const scope = provider.kind === 'okta' && provider.groupsClaim ? 'openid email profile groups' : 'openid email profile';
  const url = oidc.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: ssoRedirectUri(),
    response_type: 'code',
    scope,
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...(loginHint && { login_hint: loginHint }),
  });
  return { url, state };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type IdTokenClaims = oidc.IDToken;

/**
 * Finish a sign-in from the callback's query string. The state must match
 * this browser's cookie and a live, unused row (which is deleted whatever
 * happens next). Then the code is exchanged and the ID token validated.
 */
export async function completeSsoLogin(
  rawQuery: string,
  cookieState: string | undefined,
): Promise<{ provider: SsoProvider; claims: IdTokenClaims }> {
  const params = new URLSearchParams(rawQuery);
  const state = params.get('state');
  if (!state || !cookieState || !sameString(state, cookieState)) {
    throw new SsoError('state', 'The state does not match this browser');
  }

  const db = getDb();
  const pending = db.delete(ssoLoginStates).where(eq(ssoLoginStates.stateHash, hashState(state))).returning().get();
  if (!pending) throw new SsoError('expired', 'Unknown or already used state');
  if (new Date(pending.expiresAt) <= new Date()) throw new SsoError('expired', 'The sign-in took too long');

  const provider = db.select().from(ssoProviders).where(eq(ssoProviders.id, pending.providerId)).get();
  if (!provider || !provider.enabled) throw new SsoError('unavailable', 'The provider is gone or disabled');

  if (params.get('error')) {
    // The IdP's error text is not shown or stored verbatim: it is attacker-reachable input
    throw new SsoError('denied', `The provider returned error=${params.get('error')!.slice(0, 64)}`, provider);
  }

  let oidcConfig: oidc.Configuration;
  try {
    oidcConfig = await providerConfig(provider);
  } catch (err) {
    throw new SsoError('unavailable', `Discovery failed: ${(err as Error).message}`, provider);
  }

  const verifier = await vault.decrypt(pending.encryptedCodeVerifier, pending.stateHash);
  let claims: IdTokenClaims | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(oidcConfig, new URL(`${ssoRedirectUri()}?${rawQuery}`), {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch (err) {
    // Error messages from openid-client name the failed check, never a token or secret
    throw new SsoError('token', (err as Error).message, provider);
  }
  if (!claims) throw new SsoError('token', 'No ID token', provider);
  return { provider, claims };
}

// ── Claims → account ─────────────────────────────────────────────────────────

/**
 * `email_verified`, or Microsoft Entra's `xms_edov` (email domain owner
 * verified) — Entra does not send `email_verified` at all. Some IdPs send the
 * boolean as a string.
 */
function emailVerified(claims: IdTokenClaims): boolean {
  const truthy = (v: unknown) => v === true || v === 'true';
  return truthy(claims.email_verified) || truthy(claims['xms_edov']);
}

/**
 * RFC 8176 `amr` values for proof of possession of a hardware-bound key
 * (`hwk`, Entra's `fido`), or an OpenID EAP `acr` of phishing-resistant
 * (`phr`, `phrh`). Only counted when the owner opted in.
 */
const PHISHING_RESISTANT_AMR = new Set(['hwk', 'fido']);
const PHISHING_RESISTANT_ACR = new Set(['phr', 'phrh']);

export function idpAssertsPhishingResistantMfa(provider: SsoProvider, claims: IdTokenClaims): boolean {
  if (!provider.trustIdpMfa) return false;
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  return (
    amr.some((v) => typeof v === 'string' && PHISHING_RESISTANT_AMR.has(v)) ||
    (typeof claims.acr === 'string' && PHISHING_RESISTANT_ACR.has(claims.acr))
  );
}

/** The highest role the groups claim maps to; null when no mapping applies. */
export function mappedRole(provider: SsoProvider, claims: IdTokenClaims): SsoRole | null {
  if (!provider.groupsClaim) return null;
  const raw = claims[provider.groupsClaim];
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : typeof raw === 'string' ? [raw] : [];
  let best: SsoRole | null = null;
  for (const m of parseRoleMappings(provider.roleMappings)) {
    if (groups.includes(m.group) && (!best || rank(m.role) > rank(best))) best = m.role;
  }
  return best;
}

export interface SsoAccount {
  user: Account;
  membership: Membership;
  email: string;
  /** A new account was created for this sign-in. */
  provisioned: boolean;
  /** An existing member's account was linked to this identity for the first time. */
  linked: boolean;
  /** Re-added to the org, having been removed since the identity was linked. */
  rejoined: boolean;
  roleChange?: { from: string; to: SsoRole };
}

function isGoogleIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).host === 'accounts.google.com';
  } catch {
    return false;
  }
}

function displayNameFrom(claims: IdTokenClaims, email: string): string {
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  return (name || email.split('@')[0] || email).slice(0, 100);
}

/**
 * Who a validated ID token signs in as, provisioning or linking as the
 * provider allows. Throws SsoError for anything that must not sign in.
 */
export function resolveSsoAccount(provider: SsoProvider, claims: IdTokenClaims): SsoAccount {
  const rawEmail = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!claims.sub || !rawEmail || !/^[^\s@]+@[^\s@]+$/.test(rawEmail)) {
    throw new SsoError('email_unverified', 'The ID token has no usable email claim', provider);
  }
  const email = rawEmail;
  if (!emailVerified(claims)) throw new SsoError('email_unverified', 'email_verified is not true', provider, email);
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const allowedDomains = parseDomains(provider.allowedDomains);
  if (!allowedDomains.includes(domain)) {
    throw new SsoError('domain', `${domain} is not an allowed domain`, provider, email);
  }
  // Google signs in any Google account, including a personal one registered
  // with a work address (which can outlive the Workspace mailbox). Only `hd`
  // says the account is managed by a Workspace org, so it must name an allowed domain.
  if (isGoogleIssuer(provider.issuer)) {
    const hd = typeof claims['hd'] === 'string' ? claims['hd'].toLowerCase() : '';
    if (!allowedDomains.includes(hd)) {
      throw new SsoError('domain', `Not a Google Workspace account of an allowed domain (hd=${hd.slice(0, 64) || 'none'})`, provider, email);
    }
  }

  const db = getDb();
  const now = new Date().toISOString();
  const role = mappedRole(provider, claims);
  // A mapped group decides the base role; otherwise the provider's default, which may be a role
  const defaultId = role ? null : ssoDefaultRoleId(provider);

  // Synchronous from here on, so the checks and the writes cannot interleave
  // with another sign-in for the same person.
  return db.transaction(() => {
    const identity = db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.sub)))
      .get();

    let user: Account | undefined;
    let provisioned = false;
    let linked = false;
    let rejoined = false;

    if (identity) {
      user = db.select().from(users).where(eq(users.id, identity.userId)).get();
      if (!user) throw new SsoError('not_member', 'The linked account is gone', provider, email);
    } else {
      // lower() also matches rows stored before addresses were normalized
      const existing = db.select().from(users).where(sql`lower(${users.email}) = ${email}`).get();
      if (existing) {
        const member = db
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, existing.id), eq(memberships.orgId, provider.orgId)))
          .get();
        if (!member) {
          throw new SsoError('account_exists', 'An account with this email exists but is not a member', provider, email);
        }
        const other = db
          .select({ id: userIdentities.id })
          .from(userIdentities)
          .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.userId, existing.id)))
          .get();
        if (other) {
          throw new SsoError('identity_conflict', 'The account is linked to a different subject', provider, email);
        }
        user = existing;
        linked = true;
      } else {
        if (!provider.autoProvision) throw new SsoError('not_member', 'No account and auto-provisioning is off', provider, email);
        user = {
          id: nanoid(),
          email,
          displayName: displayNameFrom(claims, email),
          // No password: this account signs in through its IdP (and passkeys it adds)
          passwordHash: null,
          avatarUrl: null,
          totpSecret: null,
          totpEnabled: false,
          createdAt: now,
          updatedAt: now,
        };
        db.insert(users).values(user).run();
        db.insert(memberships)
          .values({ userId: user.id, orgId: provider.orgId, role: ssoBaseRole(provider, role, defaultId), joinedAt: now })
          .run();
        if (defaultId) setJoinedMemberRoles(provider.orgId, user.id, [defaultId], null);
        provisioned = true;
      }
      db.insert(userIdentities)
        .values({ id: nanoid(), providerId: provider.id, subject: claims.sub, userId: user.id, email, createdAt: now })
        .run();
    }

    let membership = db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, provider.orgId)))
      .get();
    if (!membership) {
      // Removed from the org since the identity was linked. With provisioning
      // on, the IdP decides who belongs; otherwise an admin has to invite them.
      if (!provider.autoProvision) throw new SsoError('not_member', 'No longer a member', provider, email);
      membership = {
        userId: user.id,
        orgId: provider.orgId,
        role: ssoBaseRole(provider, role, defaultId),
        status: 'active',
        suspendedAt: null,
        suspendedBy: null,
        serverAccess: 'all',
        scope: 'all',
        joinedAt: now,
      };
      db.insert(memberships).values(membership).run();
      if (defaultId) setJoinedMemberRoles(provider.orgId, user.id, [defaultId], null);
      rejoined = true;
    }
    if (membership.status !== 'active') throw new SsoError('suspended', 'The membership is suspended', provider, email);

    // The groups claim keeps the role in step with the IdP, but never touches an owner
    let roleChange: SsoAccount['roleChange'];
    if (role && membership.role !== 'owner' && membership.role !== role) {
      roleChange = { from: membership.role, to: role };
      db.update(memberships)
        .set({ role })
        .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, provider.orgId)))
        .run();
      membership = { ...membership, role };
    }

    db.update(userIdentities)
      .set({ lastLoginAt: now, email })
      .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.userId, user.id)))
      .run();

    return { user, membership, email, provisioned, linked, rejoined, roleChange };
  });
}
