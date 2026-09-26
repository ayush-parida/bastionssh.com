import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';

// The scan endpoint opens a real ssh2 Client; this fake presents a fixed key to
// the verifier and fails the handshake when it is refused, as ssh2 does.
// Methods only, state in a closure (see vitest-mock-class-fields).
vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const state = { presented: Buffer.alloc(0), configs: [] as any[] };
  class Client extends EventEmitter {
    connect(cfg: any) {
      state.configs.push(cfg);
      setImmediate(() => {
        if (cfg.hostVerifier?.(state.presented) === false) {
          this.emit('error', new Error('Host denied (verification failed)'));
          this.emit('close');
        } else {
          this.emit('ready');
        }
      });
      return this;
    }
    end() {}
  }
  const utils = (actual as any).utils ?? (actual as any).default?.utils;
  return { ...actual, utils, Client, __state: state };
});

const { __state: state } = (await import('ssh2')) as any;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog, serverAlerts, servers } = await import('../../db/schema.js');
const { checkHostKey } = await import('../../ssh/host-keys.js');
const { seedOrg, seedServer, seedUser } = await import('./test-utils.js');

const KEY_A = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');
const FP_A = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
const KEY_B = Buffer.from(
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNtoWHk8WMGC4dkqftSt4H56RUCtWNflzAoZau9xNp5x0X3m36igPHLTqLU369J9MaNPx8Fl9V9uX5MZg5sYUQPlm/39pR6lbrN3kSvbmMUPTBjsDCnzMm07DOG8cUcPgP6ozDjDG97WmWoaCjnNbY1naclVjaYvRDGqxxheg0ZOXukugTAPj/bfzTtUA8WrQ2jwSknnI2j3I8+0fKcNlJlwUO/samY+A4D6DaUgQw28dlrRcQL9X9Z02+rzObOA9zx0OogotKH2lZsSeuPsq9UuB0nLeAbksrMx',
  'base64',
);
const FP_B = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

describe('host key routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let foreignAdmin: ReturnType<typeof seedUser>;

  const row = (id: string) => getDb().select().from(servers).where(eq(servers.id, id)).get()!;
  const audited = (id: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all();

  /** A server that trusted KEY_A on first use and has since been shown KEY_B. */
  function mismatched() {
    const id = seedServer(orgId, admin.userId);
    checkHostKey(id, KEY_A, 'terminal');
    checkHostKey(id, KEY_B, 'terminal');
    return id;
  }

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-hostkey-routes');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    foreignAdmin = seedUser(seedOrg('org-hostkey-other'), 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET reports an unpinned server, then the TOFU key, then the mismatch', async () => {
    const id = seedServer(orgId, admin.userId);
    let res = await call('GET', `/api/servers/${id}/host-key`, admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fingerprint: null, type: null, trustedAt: null, trustedBy: null });

    checkHostKey(id, KEY_A, 'terminal');
    res = await call('GET', `/api/servers/${id}/host-key`, admin.headers);
    expect(res.json()).toMatchObject({ fingerprint: FP_A, type: 'ssh-ed25519', trustedBy: null });
    expect(res.json().mismatch).toBeUndefined();

    checkHostKey(id, KEY_B, 'terminal');
    res = await call('GET', `/api/servers/${id}/host-key`, admin.headers);
    expect(res.json()).toMatchObject({
      fingerprint: FP_A,
      mismatch: { fingerprint: FP_B, type: 'ssh-rsa' },
    });
  });

  it('is admin-only and scoped to the caller org', async () => {
    const id = seedServer(orgId, admin.userId);
    for (const who of [operator, viewer]) {
      expect((await call('GET', `/api/servers/${id}/host-key`, who.headers)).statusCode).toBe(403);
      expect((await call('PUT', `/api/servers/${id}/host-key`, who.headers, { fingerprint: FP_A })).statusCode).toBe(403);
      expect((await call('POST', `/api/servers/${id}/host-key/scan`, who.headers)).statusCode).toBe(403);
      expect((await call('DELETE', `/api/servers/${id}/host-key`, who.headers)).statusCode).toBe(403);
    }
    expect((await call('GET', `/api/servers/${id}/host-key`, foreignAdmin.headers)).statusCode).toBe(404);
    expect((await call('PUT', `/api/servers/${id}/host-key`, foreignAdmin.headers, { fingerprint: FP_A })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/servers/${id}/host-key`, foreignAdmin.headers)).statusCode).toBe(404);
    expect((await call('GET', `/api/servers/${id}/host-key`, {})).statusCode).toBe(401);
    expect(row(id).hostKeyFingerprint).toBeNull();
  });

  it('scan returns what the host presents without storing it or sending credentials', async () => {
    const id = seedServer(orgId, admin.userId);
    state.presented = KEY_B;
    const res = await call('POST', `/api/servers/${id}/host-key/scan`, admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fingerprint: FP_B, type: 'ssh-rsa' });
    expect(row(id).hostKeyFingerprint).toBeNull();
    const cfg = state.configs.at(-1);
    expect(cfg.host).toBe('10.0.0.1');
    expect(cfg.password).toBeUndefined();
    expect(cfg.privateKey).toBeUndefined();
  });

  it('PUT pins a valid fingerprint, clears a mismatch and audits', async () => {
    const id = mismatched();
    const bad = await call('PUT', `/api/servers/${id}/host-key`, admin.headers, { fingerprint: 'SHA256:short' });
    expect(bad.statusCode).toBe(400);
    const md5 = await call('PUT', `/api/servers/${id}/host-key`, admin.headers, {
      fingerprint: 'MD5:' + FP_A.slice(7),
    });
    expect(md5.statusCode).toBe(400);

    const res = await call('PUT', `/api/servers/${id}/host-key`, admin.headers, { fingerprint: FP_B });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fingerprint: FP_B, type: 'ssh-rsa', trustedBy: admin.userId });
    expect(res.json().mismatch).toBeUndefined();
    expect(row(id).hostKeyMismatchFingerprint).toBeNull();
    expect(audited(id, 'server.host_key_pinned')).toHaveLength(1);
    const alert = getDb().select().from(serverAlerts).where(eq(serverAlerts.serverId, id)).get()!;
    expect(alert.resolvedAt).toBeTruthy();
  });

  it('accept only takes the exact fingerprint the host presented', async () => {
    const id = mismatched();

    // Blind acceptance of some other key is refused
    const wrong = await call('POST', `/api/servers/${id}/host-key/accept`, admin.headers, { fingerprint: FP_A });
    expect(wrong.statusCode).toBe(409);
    expect(row(id).hostKeyFingerprint).toBe(FP_A);
    expect(row(id).hostKeyMismatchFingerprint).toBe(FP_B);

    const forbidden = await call('POST', `/api/servers/${id}/host-key/accept`, operator.headers, { fingerprint: FP_B });
    expect(forbidden.statusCode).toBe(403);

    const res = await call('POST', `/api/servers/${id}/host-key/accept`, admin.headers, { fingerprint: FP_B });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fingerprint: FP_B, type: 'ssh-rsa', trustedBy: admin.userId });
    expect(row(id).hostKeyMismatchFingerprint).toBeNull();
    expect(audited(id, 'server.host_key_accepted')).toHaveLength(1);
    // The accepted key now verifies
    expect(checkHostKey(id, KEY_B, 'terminal').ok).toBe(true);

    // Nothing left to accept
    const again = await call('POST', `/api/servers/${id}/host-key/accept`, admin.headers, { fingerprint: FP_B });
    expect(again.statusCode).toBe(409);
  });

  it('DELETE forgets the key so the next connection is TOFU', async () => {
    const id = mismatched();
    const res = await call('DELETE', `/api/servers/${id}/host-key`, admin.headers);
    expect(res.statusCode).toBe(204);
    expect(row(id)).toMatchObject({ hostKeyFingerprint: null, hostKeyMismatchFingerprint: null });
    expect(audited(id, 'server.host_key_forgotten')).toHaveLength(1);
    expect(checkHostKey(id, KEY_B, 'terminal').ok).toBe(true);
    expect(row(id).hostKeyFingerprint).toBe(FP_B);
  });

  describe('server create, update and read', () => {
    const body = { name: 'web', host: '10.0.0.7', username: 'root', authType: 'password', password: 'pw' };

    it('create can pre-pin a fingerprint and rejects a malformed one', async () => {
      const bad = await call('POST', '/api/servers', admin.headers, { ...body, hostKeyFingerprint: 'nope' });
      expect(bad.statusCode).toBe(400);

      const res = await call('POST', '/api/servers', admin.headers, { ...body, hostKeyFingerprint: FP_A });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ hostKeyFingerprint: FP_A, hostKeyStatus: 'trusted' });
      expect(row(res.json().id).hostKeyTrustedBy).toBe(admin.userId);
      // Internal columns stay internal
      expect(res.json().hostKeyMismatchFingerprint).toBeUndefined();

      const plain = await call('POST', '/api/servers', admin.headers, body);
      expect(plain.json()).toMatchObject({ hostKeyFingerprint: null, hostKeyStatus: 'unknown' });
    });

    it('list and detail include the fingerprint and status', async () => {
      const id = mismatched();
      const detail = await call('GET', `/api/servers/${id}`, viewer.headers);
      expect(detail.json()).toMatchObject({ hostKeyFingerprint: FP_A, hostKeyStatus: 'mismatch' });
      const list = await call('GET', '/api/servers', viewer.headers);
      const entry = (list.json() as { id: string }[]).find((s) => s.id === id);
      expect(entry).toMatchObject({ hostKeyFingerprint: FP_A, hostKeyStatus: 'mismatch' });
    });

    it('changing the host or port forgets the key and audits it', async () => {
      const hostChange = mismatched();
      let res = await call('PATCH', `/api/servers/${hostChange}`, admin.headers, { host: '10.9.9.9' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hostKeyFingerprint: null, hostKeyStatus: 'unknown' });
      expect(row(hostChange).hostKeyMismatchFingerprint).toBeNull();
      const [cleared] = audited(hostChange, 'server.host_key_cleared');
      expect(JSON.parse(cleared!.metadata!)).toMatchObject({
        reason: 'endpoint_changed',
        previous: FP_A,
        from: '10.0.0.1:22',
        to: '10.9.9.9:22',
      });

      const portChange = seedServer(orgId, admin.userId);
      checkHostKey(portChange, KEY_A, 'terminal');
      res = await call('PATCH', `/api/servers/${portChange}`, admin.headers, { port: 2222 });
      expect(res.json().hostKeyFingerprint).toBeNull();

      // Same endpoint (or unrelated edits) keeps the key
      const same = seedServer(orgId, admin.userId);
      checkHostKey(same, KEY_A, 'terminal');
      res = await call('PATCH', `/api/servers/${same}`, admin.headers, { host: '10.0.0.1', port: 22, name: 'renamed' });
      expect(res.json().hostKeyFingerprint).toBe(FP_A);
      expect(audited(same, 'server.host_key_cleared')).toHaveLength(0);

      // A new endpoint together with a fingerprint pins that one instead
      res = await call('PATCH', `/api/servers/${same}`, admin.headers, { host: '10.1.1.1', hostKeyFingerprint: FP_B });
      expect(res.json()).toMatchObject({ hostKeyFingerprint: FP_B, hostKeyStatus: 'trusted' });
      expect(audited(same, 'server.host_key_pinned')).toHaveLength(1);
    });
  });
});
