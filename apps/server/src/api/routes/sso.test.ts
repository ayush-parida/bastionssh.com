import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import {
  auditLog,
  memberships,
  organizations,
  passkeys,
  sessions,
  ssoLoginStates,
  ssoProviders,
  userIdentities,
  users,
} from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { vault } from '../../vault/index.js';
import { addMembership, seedOrg, seedSession, seedUser } from './test-utils.js';
import { resolveSsoAccount, type IdTokenClaims } from '../../auth/sso.js';

/**
 * A mocked identity provider behind a stubbed global fetch: a discovery
 * document, a JWKS with a freshly generated RSA key, and a token endpoint that
 * checks the client's credentials and the PKCE verifier before handing out
 * whatever ID token the test built for that code.
 */
const ISSUER = 'https://idp.test';
const CLIENT_ID = 'bastion-client';
const CLIENT_SECRET = 'bastion-secret';

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

const idp = {
  /** code → what the token endpoint answers for it */
  codes: new Map<string, { challenge: string; idToken: string }>(),
  tokenRequests: 0,
};

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(claims: Record<string, unknown>, key: KeyObject = signingKey.privateKey, kid = 'k1') {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  code_challenge_methods_supported: ['S256'],
};

async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${ISSUER}/.well-known/openid-configuration`) return json(discovery);
  if (url === `${ISSUER}/jwks`) {
    return json({ keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  }
  if (url === `${ISSUER}/token`) {
    idp.tokenRequests++;
    const headers = new Headers(init?.headers);
    // client_secret_basic form-encodes both halves before base64 (RFC 6749 §2.3.1)
    const basic = headers.get('authorization')?.match(/^Basic (.+)$/)?.[1];
    const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json({ error: 'invalid_client' }, 401);
    const form = new URLSearchParams(init?.body as string | URLSearchParams);
    const issued = idp.codes.get(form.get('code') ?? '');
    idp.codes.delete(form.get('code') ?? '');
    if (!issued || form.get('grant_type') !== 'authorization_code') return json({ error: 'invalid_grant' }, 400);
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (challenge !== issued.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
    return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: issued.idToken });
  }
  return new Response('not found', { status: 404 });
}

type Role = 'owner' | 'admin' | 'operator' | 'viewer';

describe('single sign-on (OIDC)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // Sign-in routes are rate-limited per address; give each call its own
  let address = 0;
  const from = () => `10.7.${Math.floor(++address / 250)}.${address % 250}`;

  async function configureProvider(orgId: string, overrides: Partial<typeof ssoProviders.$inferInsert> = {}) {
    const id = nanoid();
    getDb()
      .insert(ssoProviders)
      .values({
        id,
        orgId,
        kind: 'generic',
        issuer: ISSUER,
        clientId: CLIENT_ID,
        encryptedClientSecret: await vault.encrypt(CLIENT_SECRET, id),
        allowedDomains: JSON.stringify(['corp.test']),
        defaultRole: 'viewer',
        autoProvision: true,
        createdBy: 'test',
        ...overrides,
      })
      .run();
    return id;
  }

  function orgWithSso(prefix: string, overrides: Partial<typeof ssoProviders.$inferInsert> = {}) {
    const slug = `${prefix}-${nanoid(6).toLowerCase()}`;
    const orgId = seedOrg(slug);
    return configureProvider(orgId, overrides).then((providerId) => ({ orgId, slug, providerId }));
  }

  async function seedPerson(orgId: string, role: Role, password = 'the-password') {
    const member = seedUser(orgId, role);
    const email = `${nanoid(8).toLowerCase()}@corp.test`;
    getDb()
      .update(users)
      .set({ email, passwordHash: await hashPassword(password) })
      .where(eq(users.id, member.userId))
      .run();
    return { ...member, email, password };
  }

  async function start(slug: string, query = '') {
    const res = await app.inject({ method: 'GET', url: `/api/auth/sso/${slug}/start${query}`, remoteAddress: from() });
    expect(res.statusCode).toBe(302);
    const authorize = new URL(res.headers.location as string);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    return {
      authorize,
      state: authorize.searchParams.get('state')!,
      nonce: authorize.searchParams.get('nonce')!,
      challenge: authorize.searchParams.get('code_challenge')!,
      cookie: res.cookies.find((c) => c.name === 'smt_sso_state')!.value,
    };
  }

  const now = () => Math.floor(Date.now() / 1000);

  interface SignInOptions {
    /** Claims layered over a valid set for this login. */
    claims?: Record<string, unknown>;
    key?: KeyObject;
    /** The state to send back instead of the real one. */
    state?: string;
    /** The state cookie to send instead of the real one; null sends none. */
    cookie?: string | null;
  }

  /** The whole round trip: start, the IdP issues a code, the browser comes back. */
  async function ssoSignIn(slug: string, sub: string, email: string, opts: SignInOptions = {}) {
    const started = await start(slug);
    const code = nanoid();
    const claims = {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub,
      email,
      email_verified: true,
      name: 'Pat Example',
      nonce: started.nonce,
      iat: now(),
      exp: now() + 300,
      ...opts.claims,
    };
    idp.codes.set(code, { challenge: started.challenge, idToken: signJwt(claims, opts.key) });
    const state = opts.state ?? started.state;
    const cookie = opts.cookie === undefined ? started.cookie : opts.cookie;
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: cookie === null ? {} : { cookie: `smt_sso_state=${cookie}` },
      remoteAddress: from(),
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    const session = res.cookies.find((c) => c.name === 'smt_session')?.value;
    return {
      res,
      started,
      location,
      error: location.searchParams.get('sso_error'),
      session,
      headers: session ? { cookie: `smt_session=${session}` } : {},
    };
  }

  const userByEmail = (email: string) => getDb().select().from(users).where(eq(users.email, email)).get();
  const membership = (userId: string, orgId: string) =>
    getDb()
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
      .get();
  const auditFor = (orgId: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)))
      .all();

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch));
    await runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  describe('happy path', () => {
    it('provisions a new user from an allowed domain and signs them in', async () => {
      const { orgId, slug, providerId } = await orgWithSso('jit', { defaultRole: 'operator' });
      const email = `${nanoid(8).toLowerCase()}@corp.test`;

      const signed = await ssoSignIn(slug, 'sub-new', email);
      expect(signed.error).toBeNull();
      expect(signed.location.pathname).toBe('/login');
      expect(signed.location.searchParams.get('sso')).toBe('done');
      expect(signed.session).toBeTruthy();

      // PKCE and the state/nonce went out; the verifier never did
      expect(signed.started.authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(signed.started.authorize.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/auth/sso/callback');
      expect(signed.started.authorize.searchParams.get('client_id')).toBe(CLIENT_ID);

      const user = userByEmail(email)!;
      expect(user.passwordHash).toBeNull();
      expect(user.displayName).toBe('Pat Example');
      expect(membership(user.id, orgId)).toMatchObject({ role: 'operator', status: 'active' });
      expect(
        getDb().select().from(userIdentities).where(eq(userIdentities.userId, user.id)).get(),
      ).toMatchObject({ providerId, subject: 'sub-new', email });

      const session = getDb().select().from(sessions).where(eq(sessions.id, signed.session!)).get()!;
      expect(session).toMatchObject({ ssoProviderId: providerId, activeOrgId: orgId, passkeyVerified: false });

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: signed.headers });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email, orgId, role: 'operator', signedInWithSso: true, passkeyVerified: false });

      expect(auditFor(orgId, 'sso.user_provisioned')).toHaveLength(1);
      expect(auditFor(orgId, 'user.login_sso')).toHaveLength(1);

      // The state row is gone: the same callback cannot be replayed
      expect(getDb().select().from(ssoLoginStates).where(eq(ssoLoginStates.providerId, providerId)).all()).toHaveLength(0);
    });

    it('matches the returning user by subject, not by a new email', async () => {
      const { orgId, slug } = await orgWithSso('return');
      const email = `${nanoid(8).toLowerCase()}@corp.test`;
      await ssoSignIn(slug, 'sub-returning', email);
      const user = userByEmail(email)!;

      const again = await ssoSignIn(slug, 'sub-returning', `renamed-${email}`);
      expect(again.error).toBeNull();
      const session = getDb().select().from(sessions).where(eq(sessions.id, again.session!)).get()!;
      expect(session.userId).toBe(user.id);
      expect(userByEmail(`renamed-${email}`)).toBeUndefined();
      expect(getDb().select().from(memberships).where(eq(memberships.orgId, orgId)).all()).toHaveLength(1);
    });

    it('reports a sign-in from a new network, as other sign-in methods do', async () => {
      const { orgId, slug } = await orgWithSso('newdev');
      const email = `${nanoid(8).toLowerCase()}@corp.test`;
      await ssoSignIn(slug, 'sub-newdev', email);
      // The first sign-in of an account is not "new"
      expect(auditFor(orgId, 'user.login_new_device')).toHaveLength(0);

      address += 250; // the next /24
      await ssoSignIn(slug, 'sub-newdev', email);
      const rows = auditFor(orgId, 'user.login_new_device');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ method: 'sso' });
    });

    it('links an existing member by verified email', async () => {
      const { orgId, slug, providerId } = await orgWithSso('link', { autoProvision: false });
      const member = await seedPerson(orgId, 'admin');

      const signed = await ssoSignIn(slug, 'sub-linked', member.email.toUpperCase());
      expect(signed.error).toBeNull();
      expect(getDb().select().from(sessions).where(eq(sessions.id, signed.session!)).get()!.userId).toBe(member.userId);
      expect(
        getDb()
          .select()
          .from(userIdentities)
          .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.userId, member.userId)))
          .get(),
      ).toMatchObject({ subject: 'sub-linked' });
      expect(membership(member.userId, orgId)!.role).toBe('admin');
      expect(auditFor(orgId, 'sso.identity_linked')).toHaveLength(1);

      // A second subject cannot claim the same account
      const other = await ssoSignIn(slug, 'sub-imposter', member.email);
      expect(other.error).toBe('identity_conflict');
      expect(other.session).toBeUndefined();
    });

    it('maps groups to roles, but never to owner and never over an owner', async () => {
      const mappings = JSON.stringify([
        { group: 'ops', role: 'operator' },
        { group: 'admins', role: 'admin' },
        { group: 'root', role: 'owner' },
      ]);
      const { orgId, slug } = await orgWithSso('groups', { groupsClaim: 'groups', roleMappings: mappings });

      const email = `${nanoid(8).toLowerCase()}@corp.test`;
      await ssoSignIn(slug, 'sub-g1', email, { claims: { groups: ['ops', 'admins', 'root'] } });
      const user = userByEmail(email)!;
      expect(membership(user.id, orgId)!.role).toBe('admin');

      // The IdP moves them down; the role follows
      await ssoSignIn(slug, 'sub-g1', email, { claims: { groups: ['ops'] } });
      expect(membership(user.id, orgId)!.role).toBe('operator');
      expect(auditFor(orgId, 'member.role_change')).toHaveLength(1);

      const owner = await seedPerson(orgId, 'owner');
      await ssoSignIn(slug, 'sub-owner', owner.email, { claims: { groups: ['ops'] } });
      expect(membership(owner.userId, orgId)!.role).toBe('owner');
    });
  });

  describe('refused sign-ins', () => {
    let slug: string;
    let orgId: string;
    beforeAll(async () => {
      ({ slug, orgId } = await orgWithSso('refuse'));
    });

    const email = () => `${nanoid(8).toLowerCase()}@corp.test`;

    it('refuses a state that does not match this browser', async () => {
      const addr = email();
      const wrongCookie = await ssoSignIn(slug, 'sub-s1', addr, { cookie: 'someone-elses-state' });
      expect(wrongCookie.error).toBe('state');
      const noCookie = await ssoSignIn(slug, 'sub-s1', addr, { cookie: null });
      expect(noCookie.error).toBe('state');
      // Same forged value in both places: no such pending sign-in
      const forged = await ssoSignIn(slug, 'sub-s1', addr, { state: 'forged', cookie: 'forged' });
      expect(forged.error).toBe('expired');
      expect(userByEmail(addr)).toBeUndefined();
    });

    it('refuses a replayed callback', async () => {
      const started = await start(slug);
      const code = nanoid();
      idp.codes.set(code, {
        challenge: started.challenge,
        idToken: signJwt({ iss: ISSUER, aud: CLIENT_ID, sub: 'sub-replay', email: email(), email_verified: true, nonce: started.nonce, iat: now(), exp: now() + 300 }),
      });
      const url = `/api/auth/sso/callback?code=${code}&state=${started.state}`;
      const headers = { cookie: `smt_sso_state=${started.cookie}` };
      const first = await app.inject({ method: 'GET', url, headers, remoteAddress: from() });
      expect(new URL(first.headers.location as string).searchParams.get('sso')).toBe('done');
      const second = await app.inject({ method: 'GET', url, headers, remoteAddress: from() });
      expect(new URL(second.headers.location as string).searchParams.get('sso_error')).toBe('expired');
    });

    it('refuses an expired pending sign-in', async () => {
      const started = await start(slug);
      getDb().update(ssoLoginStates).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).run();
      const res = await app.inject({
        method: 'GET',
        url: `/api/auth/sso/callback?code=x&state=${started.state}`,
        headers: { cookie: `smt_sso_state=${started.cookie}` },
        remoteAddress: from(),
      });
      expect(new URL(res.headers.location as string).searchParams.get('sso_error')).toBe('expired');
    });

    it('refuses an ID token with the wrong nonce', async () => {
      const addr = email();
      const res = await ssoSignIn(slug, 'sub-n', addr, { claims: { nonce: 'not-the-nonce' } });
      expect(res.error).toBe('token');
      expect(res.session).toBeUndefined();
      expect(userByEmail(addr)).toBeUndefined();
    });

    it('refuses an ID token for another audience or from another issuer', async () => {
      expect((await ssoSignIn(slug, 'sub-a', email(), { claims: { aud: 'someone-else' } })).error).toBe('token');
      expect((await ssoSignIn(slug, 'sub-i', email(), { claims: { iss: 'https://evil.test' } })).error).toBe('token');
    });

    it('refuses an expired ID token', async () => {
      const res = await ssoSignIn(slug, 'sub-e', email(), { claims: { iat: now() - 7200, exp: now() - 3600 } });
      expect(res.error).toBe('token');
    });

    it('refuses an ID token not signed by the provider’s keys', async () => {
      const res = await ssoSignIn(slug, 'sub-sig', email(), { key: strangerKey.privateKey });
      expect(res.error).toBe('token');
    });

    it('refuses an unverified email', async () => {
      const addr = email();
      expect((await ssoSignIn(slug, 'sub-u', addr, { claims: { email_verified: false } })).error).toBe('email_unverified');
      expect((await ssoSignIn(slug, 'sub-u', addr, { claims: { email_verified: undefined } })).error).toBe('email_unverified');
      expect(userByEmail(addr)).toBeUndefined();
      const failures = auditFor(orgId, 'sso.login_failed');
      expect(failures.some((f) => f.resourceName === addr && JSON.parse(f.metadata!).reason === 'email_unverified')).toBe(true);
    });

    it('refuses an email outside the allowed domains', async () => {
      const res = await ssoSignIn(slug, 'sub-d', 'pat@elsewhere.test');
      expect(res.error).toBe('domain');
      // A subdomain is not the domain
      expect((await ssoSignIn(slug, 'sub-d2', 'pat@evil.corp.test')).error).toBe('domain');
      expect(userByEmail('pat@elsewhere.test')).toBeUndefined();
    });

    it('takes a Google sign-in only from a Workspace account of an allowed domain (hd)', async () => {
      const { providerId } = await orgWithSso('google', { issuer: 'https://accounts.google.com' });
      const provider = getDb().select().from(ssoProviders).where(eq(ssoProviders.id, providerId)).get()!;
      const claims = (extra: Record<string, unknown>) =>
        ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: nanoid(), email: email(), email_verified: true, iat: now(), exp: now() + 300, ...extra }) as IdTokenClaims;
      // A personal Google account registered with a work address has no hd
      expect(() => resolveSsoAccount(provider, claims({}))).toThrow(expect.objectContaining({ code: 'domain' }));
      expect(() => resolveSsoAccount(provider, claims({ hd: 'elsewhere.test' }))).toThrow(expect.objectContaining({ code: 'domain' }));
      const ok = resolveSsoAccount(provider, claims({ hd: 'corp.test' }));
      expect(ok.provisioned).toBe(true);
    });

    it('refuses a suspended member', async () => {
      const member = await seedPerson(orgId, 'operator');
      getDb()
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.userId, member.userId), eq(memberships.orgId, orgId)))
        .run();
      const res = await ssoSignIn(slug, 'sub-suspended', member.email);
      expect(res.error).toBe('suspended');
      expect(res.session).toBeUndefined();
      expect(getDb().select().from(sessions).where(eq(sessions.userId, member.userId)).all()).toHaveLength(0);
    });

    it('never takes over an account that is not a member of the org', async () => {
      const elsewhere = seedOrg(`other-${nanoid(6).toLowerCase()}`);
      const outsider = await seedPerson(elsewhere, 'owner');
      const res = await ssoSignIn(slug, 'sub-outsider', outsider.email);
      expect(res.error).toBe('account_exists');
      expect(membership(outsider.userId, orgId)).toBeUndefined();
      expect(getDb().select().from(userIdentities).where(eq(userIdentities.userId, outsider.userId)).all()).toHaveLength(0);
    });

    it('does not create accounts when auto-provisioning is off', async () => {
      const off = await orgWithSso('noprov', { autoProvision: false });
      const addr = email();
      expect((await ssoSignIn(off.slug, 'sub-np', addr)).error).toBe('not_member');
      expect(userByEmail(addr)).toBeUndefined();
    });

    it('comes back with a fixed code when the IdP reports an error', async () => {
      const started = await start(slug);
      const res = await app.inject({
        method: 'GET',
        url: `/api/auth/sso/callback?error=access_denied&error_description=%3Cscript%3E&state=${started.state}`,
        headers: { cookie: `smt_sso_state=${started.cookie}` },
        remoteAddress: from(),
      });
      expect(res.headers.location).toBe('http://localhost:8080/login?sso_error=denied');
    });

    it('does not start for an unknown org or a disabled provider', async () => {
      const unknown = await app.inject({ method: 'GET', url: '/api/auth/sso/no-such-org/start', remoteAddress: from() });
      expect(unknown.headers.location).toBe('http://localhost:8080/login?sso_error=unavailable');
      const disabled = await orgWithSso('disabled', { enabled: false });
      const res = await app.inject({ method: 'GET', url: `/api/auth/sso/${disabled.slug}/start`, remoteAddress: from() });
      expect(res.headers.location).toBe('http://localhost:8080/login?sso_error=unavailable');
    });
  });

  describe('enforce SSO', () => {
    let org: { orgId: string; slug: string; providerId: string };
    beforeAll(async () => {
      org = await orgWithSso('enforce', { enforceSso: true });
    });

    const login = (email: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: from() });

    it('blocks password login for members other than owners', async () => {
      const member = await seedPerson(org.orgId, 'admin');
      const res = await login(member.email, member.password);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'SSO_REQUIRED', orgSlug: org.slug });
      expect(res.cookies.find((c) => c.name === 'smt_session')).toBeUndefined();
    });

    it('still lets owners in with a password (break-glass)', async () => {
      const owner = await seedPerson(org.orgId, 'owner');
      const res = await login(owner.email, owner.password);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ orgId: org.orgId, role: 'owner' });
    });

    it('refuses existing non-SSO sessions, but lets them sign out', async () => {
      const member = await seedPerson(org.orgId, 'operator');
      const browser = await seedSession(member.userId);
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: browser.headers });
      expect(me.statusCode).toBe(403);
      expect(me.json().code).toBe('SSO_REQUIRED');
      const servers = await app.inject({ method: 'GET', url: '/api/servers', headers: browser.headers });
      expect(servers.statusCode).toBe(403);
      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: browser.headers });
      expect(logout.statusCode).toBe(200);
    });

    it('accepts the same member through SSO', async () => {
      const member = await seedPerson(org.orgId, 'operator');
      const signed = await ssoSignIn(org.slug, 'sub-enforced', member.email);
      expect(signed.error).toBeNull();
      const servers = await app.inject({ method: 'GET', url: '/api/servers', headers: signed.headers });
      expect(servers.statusCode).toBe(200);
    });

    it('lets a member of another org sign in with a password there', async () => {
      const member = await seedPerson(org.orgId, 'viewer');
      const other = seedOrg(`free-${nanoid(6).toLowerCase()}`);
      addMembership(member.userId, other, 'operator');
      const res = await login(member.email, member.password);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ orgId: other });
      // …but that session cannot switch into the enforcing org
      const cookie = { cookie: `smt_session=${res.cookies.find((c) => c.name === 'smt_session')!.value}` };
      const switched = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: cookie, payload: { orgId: org.orgId } });
      expect(switched.statusCode).toBe(200);
      const after = await app.inject({ method: 'GET', url: '/api/servers', headers: cookie });
      expect(after.statusCode).toBe(403);
      expect(after.json().code).toBe('SSO_REQUIRED');
    });

    it('leaves API tokens alone', async () => {
      const member = await seedPerson(org.orgId, 'operator');
      const res = await app.inject({ method: 'GET', url: '/api/servers', headers: member.headers });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('SSO sessions', () => {
    it('only work in the org whose SSO they signed in through', async () => {
      const { orgId, slug } = await orgWithSso('pinned');
      const member = await seedPerson(orgId, 'operator');
      const other = seedOrg(`side-${nanoid(6).toLowerCase()}`);
      addMembership(member.userId, other, 'admin');

      const signed = await ssoSignIn(slug, 'sub-pinned', member.email);
      const switched = await app.inject({
        method: 'POST',
        url: '/api/auth/switch-org',
        headers: signed.headers,
        payload: { orgId: other },
      });
      expect(switched.statusCode).toBe(403);
      expect(switched.json().code).toBe('SSO_SESSION_ORG');

      // Nor may it mint an account-wide credential that would work in the other org
      const token = await app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: signed.headers,
        payload: { name: 'ci', scopes: ['read'] },
      });
      expect(token.statusCode).toBe(403);
      expect(token.json().code).toBe('SSO_SESSION_CREDENTIALS');
      const passkey = await app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/register/options',
        headers: signed.headers,
        payload: {},
      });
      expect(passkey.statusCode).toBe(403);
      expect(passkey.json().code).toBe('SSO_SESSION_CREDENTIALS');
    });

    it('are subject to the org passkey policy unless the IdP asserts phishing-resistant MFA', async () => {
      const { orgId, slug } = await orgWithSso('pk', { trustIdpMfa: true });
      getDb().update(organizations).set({ requirePasskey: true }).where(eq(organizations.id, orgId)).run();

      const plain = await ssoSignIn(slug, 'sub-pk1', `${nanoid(8).toLowerCase()}@corp.test`, { claims: { amr: ['pwd', 'mfa'] } });
      const blocked = await app.inject({ method: 'GET', url: '/api/servers', headers: plain.headers });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('PASSKEY_REQUIRED');
      // A fresh SSO-only account may enroll its first passkey (no password to ask for)
      const enroll = await app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/register/options',
        headers: plain.headers,
        payload: {},
      });
      expect(enroll.statusCode).toBe(200);

      const hwk = await ssoSignIn(slug, 'sub-pk2', `${nanoid(8).toLowerCase()}@corp.test`, { claims: { amr: ['hwk', 'mfa'] } });
      expect(getDb().select().from(sessions).where(eq(sessions.id, hwk.session!)).get()!.passkeyVerified).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/api/servers', headers: hwk.headers })).statusCode).toBe(200);
    });

    it('give a password-less account no backup codes, which only finish a password sign-in', async () => {
      const { slug } = await orgWithSso('codes', { trustIdpMfa: true });
      const email = `${nanoid(8).toLowerCase()}@corp.test`;
      const signed = await ssoSignIn(slug, 'sub-codes', email, { claims: { amr: ['hwk'] } });
      const user = userByEmail(email)!;
      getDb()
        .insert(passkeys)
        .values({
          id: nanoid(),
          userId: user.id,
          credentialId: `cred-${nanoid(10)}`,
          publicKey: Buffer.from([1, 2, 3]),
          deviceType: 'multiDevice',
          name: 'Laptop',
        })
        .run();
      const res = await app.inject({ method: 'POST', url: '/api/auth/backup-codes', headers: signed.headers });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/password/);
    });

    it('ignores amr unless the owner opted in', async () => {
      const { slug } = await orgWithSso('pk-off');
      const signed = await ssoSignIn(slug, 'sub-amr', `${nanoid(8).toLowerCase()}@corp.test`, { claims: { amr: ['hwk'] } });
      expect(getDb().select().from(sessions).where(eq(sessions.id, signed.session!)).get()!.passkeyVerified).toBe(false);
    });
  });

  describe('lookup', () => {
    it('finds an org by slug or by email domain', async () => {
      const { slug } = await orgWithSso('lookup', { allowedDomains: JSON.stringify(['lookup.test']) });
      const bySlug = await app.inject({ method: 'POST', url: '/api/auth/sso/lookup', payload: { query: slug }, remoteAddress: from() });
      expect(bySlug.statusCode).toBe(200);
      expect(bySlug.json()).toMatchObject({ orgSlug: slug, providerHost: 'idp.test', startUrl: `/api/auth/sso/${slug}/start` });

      const byEmail = await app.inject({
        method: 'POST',
        url: '/api/auth/sso/lookup',
        payload: { query: 'Pat@Lookup.test' },
        remoteAddress: from(),
      });
      expect(byEmail.json().startUrl).toBe(`/api/auth/sso/${slug}/start?login_hint=pat%40lookup.test`);

      const none = await app.inject({ method: 'POST', url: '/api/auth/sso/lookup', payload: { query: 'x@nowhere.test' }, remoteAddress: from() });
      expect(none.statusCode).toBe(404);
    });

    it('will not guess between two orgs claiming the same domain', async () => {
      await orgWithSso('dup-a', { allowedDomains: JSON.stringify(['shared.test']) });
      await orgWithSso('dup-b', { allowedDomains: JSON.stringify(['shared.test']) });
      const res = await app.inject({ method: 'POST', url: '/api/auth/sso/lookup', payload: { query: 'a@shared.test' }, remoteAddress: from() });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('settings', () => {
    let orgId: string;
    let owner: Awaited<ReturnType<typeof seedPerson>>;
    let ownerBrowser: { headers: Record<string, string> };
    const input = {
      kind: 'okta',
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedDomains: ['Corp.test', 'corp.test'],
      defaultRole: 'viewer',
      autoProvision: true,
      enforceSso: false,
      enabled: true,
      trustIdpMfa: false,
      groupsClaim: 'groups',
      roleMappings: [{ group: 'admins', role: 'admin' }],
    };

    beforeAll(async () => {
      orgId = seedOrg(`settings-${nanoid(6).toLowerCase()}`);
      owner = await seedPerson(orgId, 'owner');
      ownerBrowser = await seedSession(owner.userId);
    });

    it('is for owners only, from a browser', async () => {
      const admin = await seedPerson(orgId, 'admin');
      const adminBrowser = await seedSession(admin.userId);
      expect((await app.inject({ method: 'GET', url: '/api/sso', headers: adminBrowser.headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'PUT', url: '/api/sso', headers: adminBrowser.headers, payload: input })).statusCode,
      ).toBe(403);
      // An owner's API token cannot change it either
      expect((await app.inject({ method: 'PUT', url: '/api/sso', headers: owner.headers, payload: input })).statusCode).toBe(403);
    });

    it('saves the config with the secret encrypted and never returned', async () => {
      const before = await app.inject({ method: 'GET', url: '/api/sso', headers: ownerBrowser.headers });
      expect(before.json()).toEqual({ configured: false, redirectUri: 'http://localhost:8080/api/auth/sso/callback' });

      const res = await app.inject({ method: 'PUT', url: '/api/sso', headers: ownerBrowser.headers, payload: input });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ configured: true, kind: 'okta', allowedDomains: ['corp.test'], groupsClaim: 'groups' });
      expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);

      const row = getDb().select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId)).get()!;
      expect(row.encryptedClientSecret).not.toContain(CLIENT_SECRET);
      expect(await vault.decrypt(row.encryptedClientSecret, row.id)).toBe(CLIENT_SECRET);
      expect(JSON.stringify(auditFor(orgId, 'org.sso_update'))).not.toContain(CLIENT_SECRET);

      // Updating without a secret keeps the stored one
      const kept = await app.inject({
        method: 'PUT',
        url: '/api/sso',
        headers: ownerBrowser.headers,
        payload: { ...input, clientSecret: undefined, defaultRole: 'operator' },
      });
      expect(kept.statusCode).toBe(200);
      const after = getDb().select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId)).get()!;
      expect(after.encryptedClientSecret).toBe(row.encryptedClientSecret);
      expect(after.defaultRole).toBe('operator');
    });

    it('rejects plain-http issuers, an owner role and an empty domain list', async () => {
      const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/sso', headers: ownerBrowser.headers, payload });
      expect((await put({ ...input, issuer: 'http://idp.test' })).statusCode).toBe(400);
      expect((await put({ ...input, defaultRole: 'owner' })).statusCode).toBe(400);
      expect((await put({ ...input, allowedDomains: [] })).statusCode).toBe(400);
      expect((await put({ ...input, roleMappings: [{ group: 'x', role: 'owner' }] })).statusCode).toBe(400);
    });

    it('tests discovery and keys', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/sso/test', headers: ownerBrowser.headers, payload: {} });
      expect(res.json()).toMatchObject({ ok: true, issuer: ISSUER, signingKeys: 1 });
      const bad = await app.inject({
        method: 'POST',
        url: '/api/sso/test',
        headers: ownerBrowser.headers,
        payload: { issuer: 'https://nothing.test' },
      });
      expect(bad.json().ok).toBe(false);
    });

    it('forgets identity links and ends SSO sessions when pointed at another client', async () => {
      const row = getDb().select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId)).get()!;
      const slug = getDb().select().from(organizations).where(eq(organizations.id, orgId)).get()!.slug;
      const signed = await ssoSignIn(slug, 'sub-retarget', `${nanoid(8).toLowerCase()}@corp.test`);
      expect(signed.error).toBeNull();
      expect(getDb().select().from(userIdentities).where(eq(userIdentities.providerId, row.id)).all()).toHaveLength(1);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/sso',
        headers: ownerBrowser.headers,
        payload: { ...input, clientSecret: undefined, clientId: 'another-client' },
      });
      expect(res.statusCode).toBe(200);
      expect(getDb().select().from(userIdentities).where(eq(userIdentities.providerId, row.id)).all()).toHaveLength(0);
      expect(getDb().select().from(sessions).where(eq(sessions.id, signed.session!)).get()).toBeUndefined();
    });

    it('removes SSO with its sessions', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sso', headers: ownerBrowser.headers });
      expect(res.statusCode).toBe(204);
      expect(getDb().select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId)).get()).toBeUndefined();
      expect(auditFor(orgId, 'org.sso_delete')).toHaveLength(1);
    });
  });
});
