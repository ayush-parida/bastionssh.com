import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { SsoLookupResult, SsoSettings, SsoTestResult } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { memberships, organizations, sessions, ssoProviders, userIdentities } from '../../db/schema.js';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { requireBrowserSession, requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { createSession } from '../../auth/session.js';
import { notifyNewDeviceSignIn, recordSignInDevice } from '../../auth/login-security.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import {
  asProviderKind,
  asSsoRole,
  beginSsoLogin,
  completeSsoLogin,
  forgetProviderConfig,
  idpAssertsPhishingResistantMfa,
  issuerProtocolAllowed,
  parseDomains,
  parseRoleMappings,
  resolveSsoAccount,
  SsoError,
  ssoLoginUrl,
  ssoRedirectUri,
  SSO_CALLBACK_PATH,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_MS,
  testIssuer,
  type SsoProvider,
} from '../../auth/sso.js';
import { audit, auditSystem } from '../../audit/index.js';
import { vault } from '../../vault/index.js';
import { config } from '../../config/index.js';

const ssoRoleSchema = z.enum(['viewer', 'operator', 'admin']);

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/, 'is not a domain name');

const providerSchema = z.object({
  kind: z.enum(['google', 'microsoft', 'okta', 'generic']).default('generic'),
  issuer: z.string().trim().url().max(500),
  clientId: z.string().trim().min(1).max(500),
  /** Omit to keep the stored secret. */
  clientSecret: z.string().min(1).max(4000).optional(),
  allowedDomains: z.array(domainSchema).min(1).max(50),
  defaultRole: ssoRoleSchema.default('viewer'),
  autoProvision: z.boolean().default(false),
  enforceSso: z.boolean().default(false),
  enabled: z.boolean().default(true),
  trustIdpMfa: z.boolean().default(false),
  groupsClaim: z.string().trim().min(1).max(100).nullable().optional(),
  roleMappings: z
    .array(z.object({ group: z.string().trim().min(1).max(200), role: ssoRoleSchema }))
    .max(50)
    .default([]),
});

const testSchema = z.object({ issuer: z.string().trim().url().max(500).optional() });

const lookupSchema = z.object({ query: z.string().trim().toLowerCase().min(1).max(254) });

const startQuerySchema = z.object({ login_hint: z.string().trim().email().max(254).optional() });

/** Unauthenticated, and each one makes an outbound request or a sign-in: kept tight like /login. */
const SSO_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };

function webUrl(path: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}${path}`;
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.baseUrl.startsWith('https:'),
    // Only the callback needs it
    path: SSO_CALLBACK_PATH,
    maxAge: Math.floor(SSO_STATE_TTL_MS / 1000),
  };
}

function providerForOrg(orgId: string): SsoProvider | undefined {
  return getDb().select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId)).get();
}

function toSettings(provider: SsoProvider | undefined, orgSlug: string): SsoSettings {
  if (!provider) return { configured: false, redirectUri: ssoRedirectUri() };
  return {
    configured: true,
    id: provider.id,
    kind: asProviderKind(provider.kind),
    issuer: provider.issuer,
    clientId: provider.clientId,
    allowedDomains: parseDomains(provider.allowedDomains),
    defaultRole: asSsoRole(provider.defaultRole),
    autoProvision: provider.autoProvision,
    enforceSso: provider.enforceSso,
    enabled: provider.enabled,
    trustIdpMfa: provider.trustIdpMfa,
    groupsClaim: provider.groupsClaim,
    roleMappings: parseRoleMappings(provider.roleMappings),
    redirectUri: ssoRedirectUri(),
    loginUrl: webUrl(ssoLoginUrl(orgSlug)),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function orgSlug(orgId: string): string {
  return getDb().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)).get()?.slug ?? '';
}

/**
 * End every session signed in through a provider, and what those users have
 * open in its org. For when the provider stops being trusted as it was:
 * disabled, removed, or pointed at a different IdP or client.
 */
function endProviderSessions(provider: SsoProvider) {
  const db = getDb();
  const userIds = [
    ...new Set(
      db
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.ssoProviderId, provider.id))
        .all()
        .map((s) => s.userId),
    ),
  ];
  const ended = db.delete(sessions).where(eq(sessions.ssoProviderId, provider.id)).run().changes;
  for (const userId of userIds) revokeLiveAccess(userId, { orgId: provider.orgId });
  return ended;
}

/**
 * Turning enforcement on: every non-SSO session of a non-owner member is
 * refused from the next request, but terminals and file sessions they already
 * opened would outlive that. End those in this org for members with no live
 * SSO session (members who have one keep theirs, as with the passkey policy).
 */
function revokeNonSsoLiveAccess(provider: SsoProvider, exceptUserId: string) {
  const db = getDb();
  const members = db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, provider.orgId),
        eq(memberships.status, 'active'),
        ne(memberships.role, 'owner'),
        ne(memberships.userId, exceptUserId),
        sql`not exists (select 1 from ${sessions} where ${sessions.userId} = ${memberships.userId} and ${sessions.ssoProviderId} = ${provider.id})`,
      ),
    )
    .all();
  const total = { members: 0, terminals: 0, sftp: 0, docker: 0, agents: 0 };
  for (const { userId } of members) {
    const r = revokeLiveAccess(userId, { orgId: provider.orgId });
    if (r.terminals + r.sftp + r.docker + r.agents === 0) continue;
    total.members++;
    total.terminals += r.terminals;
    total.sftp += r.sftp;
    total.docker += r.docker;
    total.agents += r.agents;
  }
  return total;
}

/** Changing the SSO setup is as sensitive as a password: a person at a browser, confirmed with their passkey if they have one. */
function mayChangeSso(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!requireBrowserSession(req, reply, 'Single sign-on is configured from a signed-in browser, not with an API token')) {
    return false;
  }
  return requireStepUpIfPasskeys(req, reply, req.orgId);
}

/** Owner-only SSO configuration for the caller's org. */
export async function ssoSettingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', { preHandler: requireRole('owner') }, async (req): Promise<SsoSettings> => {
    return toSettings(providerForOrg(req.orgId), orgSlug(req.orgId));
  });

  app.put('/', { preHandler: requireRole('owner') }, async (req, reply) => {
    const body = providerSchema.parse(req.body);
    if (!mayChangeSso(req, reply)) return reply;

    if (!issuerProtocolAllowed(new URL(body.issuer))) {
      return reply.status(400).send({ error: 'issuer: must be an https URL' });
    }
    const before = providerForOrg(req.orgId);
    if (!before && !body.clientSecret) return reply.status(400).send({ error: 'clientSecret: Required' });
    if (body.groupsClaim === undefined) body.groupsClaim = before?.groupsClaim ?? null;
    if (!body.groupsClaim && body.roleMappings.length) {
      return reply.status(400).send({ error: 'groupsClaim: Required when mapping groups to roles' });
    }

    const id = before?.id ?? nanoid();
    const now = new Date().toISOString();
    const allowedDomains = [...new Set(body.allowedDomains)];
    const values = {
      kind: body.kind,
      issuer: body.issuer,
      clientId: body.clientId,
      encryptedClientSecret: body.clientSecret
        ? await vault.encrypt(body.clientSecret, id)
        : before!.encryptedClientSecret,
      allowedDomains: JSON.stringify(allowedDomains),
      defaultRole: body.defaultRole,
      autoProvision: body.autoProvision,
      enforceSso: body.enforceSso,
      enabled: body.enabled,
      trustIdpMfa: body.trustIdpMfa,
      groupsClaim: body.groupsClaim,
      roleMappings: JSON.stringify(body.roleMappings),
      updatedAt: now,
    };

    const db = getDb();
    // A different issuer or client is a different namespace of subjects: the
    // links made under the old one must not be matched by the new one.
    const retargeted = !!before && (before.issuer !== body.issuer || before.clientId !== body.clientId);
    let identitiesReset = 0;
    let sessionsEnded = 0;
    if (before) {
      if (retargeted || (before.enabled && !body.enabled)) sessionsEnded = endProviderSessions(before);
      db.transaction(() => {
        if (retargeted) {
          identitiesReset = db.delete(userIdentities).where(eq(userIdentities.providerId, id)).run().changes;
        }
        db.update(ssoProviders).set(values).where(eq(ssoProviders.id, id)).run();
      });
    } else {
      db.insert(ssoProviders)
        .values({ id, orgId: req.orgId, createdBy: req.user.id, createdAt: now, ...values })
        .run();
    }
    forgetProviderConfig(id);

    const provider = providerForOrg(req.orgId)!;
    const enforcing = provider.enabled && provider.enforceSso;
    const wasEnforcing = !!before && before.enabled && before.enforceSso;
    const live = enforcing && !wasEnforcing ? revokeNonSsoLiveAccess(provider, req.user.id) : undefined;

    await audit(req, 'org.sso_update', 'sso_provider', id, provider.issuer, {
      created: !before,
      kind: provider.kind,
      issuer: provider.issuer,
      clientId: provider.clientId,
      secretChanged: !!body.clientSecret,
      allowedDomains,
      defaultRole: provider.defaultRole,
      autoProvision: provider.autoProvision,
      enforceSso: provider.enforceSso,
      enabled: provider.enabled,
      trustIdpMfa: provider.trustIdpMfa,
      groupsClaim: provider.groupsClaim,
      roleMappings: body.roleMappings,
      ...(retargeted && { identitiesReset }),
      ...(sessionsEnded && { sessionsEnded }),
      ...(live && { live }),
    });
    return reply.status(before ? 200 : 201).send(toSettings(provider, orgSlug(req.orgId)));
  });

  /** Remove SSO. Its sessions and identity links go with it; members sign in as before. */
  app.delete('/', { preHandler: requireRole('owner') }, async (req, reply) => {
    if (!mayChangeSso(req, reply)) return reply;
    const provider = providerForOrg(req.orgId);
    if (!provider) return reply.status(404).send({ error: 'Single sign-on is not set up' });

    const sessionsEnded = endProviderSessions(provider);
    getDb().delete(ssoProviders).where(eq(ssoProviders.id, provider.id)).run();
    forgetProviderConfig(provider.id);
    await audit(req, 'org.sso_delete', 'sso_provider', provider.id, provider.issuer, { sessionsEnded });
    return reply.status(204).send();
  });

  /** Fetch the issuer's discovery document and keys — the saved issuer, or one from the form. */
  app.post('/test', { preHandler: requireRole('owner') }, async (req, reply): Promise<SsoTestResult | undefined> => {
    const body = testSchema.parse(req.body ?? {});
    const issuer = body.issuer ?? providerForOrg(req.orgId)?.issuer;
    if (!issuer) return reply.status(400).send({ error: 'issuer: Required' });
    const result = await testIssuer(issuer);
    await audit(req, 'org.sso_test', 'sso_provider', providerForOrg(req.orgId)?.id, issuer, {
      ok: result.ok,
      ...(result.error && { error: result.error }),
    });
    return result;
  });
}

/** The unauthenticated half: finding an org's SSO, the redirect out, and the way back. */
export async function publicSsoRoutes(app: FastifyInstance) {
  /**
   * The login page's "Sign in with SSO": an org slug or an email address (its
   * domain). Says which org and IdP the user is about to be sent to, so a
   * look-alike domain claimed by some other org is visible before the redirect.
   */
  app.post('/lookup', { config: SSO_RATE_LIMIT }, async (req, reply): Promise<SsoLookupResult | undefined> => {
    const { query } = lookupSchema.parse(req.body);
    const db = getDb();
    const email = query.includes('@') ? query : undefined;
    const domain = email ? email.slice(email.lastIndexOf('@') + 1) : query;

    const enabled = db
      .select({ provider: ssoProviders, org: { name: organizations.name, slug: organizations.slug } })
      .from(ssoProviders)
      .innerJoin(organizations, eq(ssoProviders.orgId, organizations.id))
      .where(eq(ssoProviders.enabled, true))
      .all();

    let matches = email ? [] : enabled.filter((p) => p.org.slug === query);
    if (!matches.length) matches = enabled.filter((p) => parseDomains(p.provider.allowedDomains).includes(domain));
    if (matches.length > 1) {
      return reply.status(409).send({
        error: 'More than one organization uses single sign-on for that domain. Enter your organization’s slug instead.',
      });
    }
    const match = matches[0];
    if (!match) return reply.status(404).send({ error: 'No single sign-on is set up for that organization or email domain' });

    const start = ssoLoginUrl(match.org.slug);
    return {
      orgName: match.org.name,
      orgSlug: match.org.slug,
      providerHost: new URL(match.provider.issuer).host,
      startUrl: email ? `${start}?login_hint=${encodeURIComponent(email)}` : start,
    };
  });

  /** Send the browser to the org's IdP. A full-page navigation, so failures come back as redirects too. */
  app.get('/:orgSlug/start', { config: SSO_RATE_LIMIT }, async (req, reply) => {
    const { orgSlug: slug } = req.params as { orgSlug: string };
    const query = startQuerySchema.safeParse(req.query ?? {});
    const loginHint = query.success ? query.data.login_hint : undefined;

    const db = getDb();
    const org = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).get();
    const provider = org ? providerForOrg(org.id) : undefined;
    if (!provider?.enabled) return reply.redirect(webUrl('/login?sso_error=unavailable'));

    let started;
    try {
      started = await beginSsoLogin(provider, loginHint);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, providerId: provider.id }, 'SSO discovery failed');
      return reply.redirect(webUrl('/login?sso_error=unavailable'));
    }
    reply.setCookie(SSO_STATE_COOKIE, started.state, stateCookieOptions());
    return reply.redirect(started.url.href);
  });

  /** The IdP sends the browser back here with a code (or an error). */
  app.get('/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const cookieState = req.cookies[SSO_STATE_COOKIE];
    // One use, whatever happens
    reply.clearCookie(SSO_STATE_COOKIE, { path: SSO_CALLBACK_PATH });

    try {
      const { provider, claims } = await completeSsoLogin(rawQuery, cookieState);
      const account = resolveSsoAccount(provider, claims);
      const passkeyVerified = idpAssertsPhishingResistantMfa(provider, claims);

      const session = await createSession(account.user.id, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        activeOrgId: provider.orgId,
        passkeyVerified,
        ssoProviderId: provider.id,
      });
      reply.setCookie('smt_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });

      // Not behind requireAuth, so fill in who this is for the audit rows
      const { user } = account;
      req.user = { id: user.id, email: user.email, displayName: user.displayName };
      req.orgId = provider.orgId;
      if (account.provisioned) {
        await audit(req, 'sso.user_provisioned', 'user', user.id, user.email, { role: account.membership.role });
      } else if (account.rejoined) {
        await audit(req, 'member.join', 'member', user.id, user.email, { role: account.membership.role, via: 'sso' });
      }
      if (account.linked) await audit(req, 'sso.identity_linked', 'user', user.id, user.email, { subject: claims.sub });
      if (account.roleChange) {
        await audit(req, 'member.role_change', 'member', user.id, user.email, { ...account.roleChange, via: 'sso' });
      }
      await audit(req, 'user.login_sso', 'user', user.id, user.email, {
        method: 'sso',
        providerId: provider.id,
        passkeyVerified,
        ...(Array.isArray(claims.amr) && { amr: claims.amr.slice(0, 10) }),
      });
      // New-device alerts cover SSO sign-ins as they do every other method
      const device = recordSignInDevice(user.id, req.ip, req.headers['user-agent'], session.id);
      if (device.isNew) {
        await audit(req, 'user.login_new_device', 'user', user.id, user.email, {
          method: 'sso',
          device: device.label,
          network: device.ipPrefix,
        });
        notifyNewDeviceSignIn(user, device, req.ip);
      }

      // The web app picks the session up from /login and applies the passkey policy from /auth/me
      return reply.redirect(webUrl('/login?sso=done'));
    } catch (err) {
      if (!(err instanceof SsoError)) throw err;
      if (err.provider) {
        auditSystem(err.provider.orgId, 'sso.login_failed', 'sso_provider', err.provider.id, err.email, {
          reason: err.code,
          detail: err.detail,
          ip: req.ip,
        });
      }
      req.log.info({ reason: err.code, detail: err.detail }, 'SSO sign-in refused');
      return reply.redirect(webUrl(`/login?sso_error=${err.code}`));
    }
  });
}
