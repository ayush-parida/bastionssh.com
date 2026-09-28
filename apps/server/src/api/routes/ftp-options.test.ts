import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Must run before `config` is imported: a short operation timeout lets a
// stalled server be exercised without waiting 30s.
vi.hoisted(() => {
  process.env.SMT_SFTP_OP_TIMEOUT_MS = '150';
});

// ssh2 is replaced by an in-memory SFTP server; the routes, pool, jail, host
// key store, DB and vault are real. Notifications are only recorded.
vi.mock('ssh2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ssh2')>()),
  ...(await import('../../ftp/fake-ssh2.test-helper.js')).fakeSsh2(),
}));

vi.mock('../../notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notifications/index.js')>()),
  notifyAlertsChanged: vi.fn(),
}));

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as import('../../ftp/fake-ssh2.test-helper.js').FakeSsh2State;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog, ftpConnections } = await import('../../db/schema.js');
const { seedOrg, seedUser } = await import('./test-utils.js');
const { notifyAlertsChanged } = await import('../../notifications/index.js');

const KEY = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');
const KEY_FP = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';
const OTHER_KEY = Buffer.from(
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQDBzrp2STH2pmmNlq1rKViosIU1Jn76TBXiFnLSIpPseBjWjL39HNtoWHk8WMGC4dkqftSt4H56RUCtWNflzAoZau9xNp5x0X3m36igPHLTqLU369J9MaNPx8Fl9V9uX5MZg5sYUQPlm/39pR6lbrN3kSvbmMUPTBjsDCnzMm07DOG8cUcPgP6ozDjDG97WmWoaCjnNbY1naclVjaYvRDGqxxheg0ZOXukugTAPj/bfzTtUA8WrQ2jwSknnI2j3I8+0fKcNlJlwUO/samY+A4D6DaUgQw28dlrRcQL9X9Z02+rzObOA9zx0OogotKH2lZsSeuPsq9UuB0nLeAbksrMx',
  'base64',
);
const OTHER_FP = 'SHA256:S7Axguai+B29/IGiF9tcSRxdklcSxD2vNoSLuUdBD8U';

function seedFs() {
  for (const dir of ['/', '/var', '/var/www', '/var/www/html', '/var/www/html/assets', '/secret']) {
    state.fs.set(dir, { type: 'dir' });
  }
  state.fs.set('/var/www/html/index.html', { type: 'file', data: Buffer.from('hello') });
  state.fs.set('/var/www/html/assets/app.js', { type: 'file', data: Buffer.from('x') });
  state.fs.set('/var/www/html/current', { type: 'link', target: '/var/www/html/assets' });
  state.fs.set('/var/www/html/escape', { type: 'link', target: '/secret' });
  state.fs.set('/var/www/html/passwd', { type: 'link', target: '/secret/keep.txt' });
  state.fs.set('/secret/keep.txt', { type: 'file', data: Buffer.from('keep') });
}

describe('file connection options over SFTP', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;

  const req = (
    who: { headers: Record<string, string> },
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => app.inject({ method, url: `/api${url}`, headers: who.headers, ...(payload && { payload }) });

  const create = async (body: object) => {
    const res = await req(admin, 'POST', '/ftp/connections', {
      name: 'site',
      host: 'sftp.example.com',
      protocol: 'sftp',
      username: 'deploy',
      rootPath: '/var/www/html',
      ...body,
    });
    return res;
  };

  const row = (id: string) => getDb().select().from(ftpConnections).where(eq(ftpConnections.id, id)).get()!;
  const audited = (id: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all();

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-ftp-opts-a');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-ftp-opts-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    state.reset();
    state.presented = KEY;
    seedFs();
    vi.mocked(notifyAlertsChanged).mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('restrict to root', () => {
    let id: string;
    const as = (
      who: { headers: Record<string, string> },
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
    ) => req(who, method, `/ftp/connections/${id}${url}`, payload);
    const q = (path: string) => encodeURIComponent(path);

    beforeAll(async () => {
      const res = await create({ password: 'shh' });
      expect(res.statusCode).toBe(201);
      id = res.json().id;
    });

    it('is on by default for a new connection', async () => {
      expect(row(id).restrictToRoot).toBe(true);
      expect((await as(viewer, 'GET', '')).json()).toMatchObject({
        restrictToRoot: true,
        authMethod: 'password',
        sshKeyId: null,
      });
    });

    it('opens at the root and offers no way up from it', async () => {
      const res = await as(viewer, 'GET', '/list?path=.');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ path: '/var/www/html', parent: null, root: '/var/www/html' });
      const sub = await as(viewer, 'GET', `/list?path=${q('/var/www/html/assets')}`);
      expect(sub.json().parent).toBe('/var/www/html');
    });

    it('refuses .. traversal and sibling paths, and audits the attempt', async () => {
      for (const path of ['/var/www/html/../../../secret', '/var/www', '/var/www/html2', '/']) {
        const res = await as(viewer, 'GET', `/list?path=${q(path)}`);
        expect(res.statusCode, path).toBe(403);
        expect(res.json().error).toMatch(/outside the directory/);
      }
      expect(state.calls.filter(([op, p]) => op === 'readdir' && p !== '/var/www/html')).toEqual([]);
      const refusals = audited(id, 'ftp.path_refused');
      expect(refusals.length).toBeGreaterThanOrEqual(4);
      expect(JSON.parse(refusals[0]!.metadata!)).toMatchObject({ path: '/secret' });
      // A refusal does not cost the session
      expect(state.clients.filter((c) => !c.ended)).toHaveLength(1);
    });

    it('guards every file operation', async () => {
      const outside = '/secret/keep.txt';
      const attempts = [
        as(viewer, 'GET', `/download?path=${q(outside)}`),
        as(operator, 'POST', '/mkdir', { path: '/secret/new' }),
        as(operator, 'POST', '/rename', { from: '/var/www/html/index.html', to: '/secret/index.html' }),
        as(operator, 'POST', '/rename', { from: outside, to: '/var/www/html/keep.txt' }),
        as(operator, 'DELETE', `/file?path=${q(outside)}`),
        app.inject({
          method: 'PUT',
          url: `/api/ftp/connections/${id}/file?path=${q('/secret/up.txt')}`,
          headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
          payload: Buffer.from('x'),
        }),
      ];
      for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(403);
      expect(state.fs.get('/secret/keep.txt')?.data?.toString()).toBe('keep');
      expect(state.fs.has('/secret/new')).toBe(false);
      expect(state.fs.has('/secret/up.txt')).toBe(false);
      expect(state.fs.has('/var/www/html/index.html')).toBe(true);
    });

    it('refuses to delete or move the root itself', async () => {
      expect((await as(operator, 'DELETE', `/file?path=${q('/var/www/html')}&recursive=true`)).statusCode).toBe(403);
      expect(
        (await as(operator, 'POST', '/rename', { from: '/var/www/html', to: '/var/www/old' })).statusCode,
      ).toBe(403);
      expect(state.fs.has('/var/www/html')).toBe(true);
    });

    it('refuses symlinks that lead out of the root, but follows ones that stay inside', async () => {
      const list = await as(viewer, 'GET', `/list?path=${q('/var/www/html/escape')}`);
      expect(list.statusCode).toBe(403);
      expect(list.json().error).toMatch(/leads outside/);
      expect((await as(viewer, 'GET', `/download?path=${q('/var/www/html/passwd')}`)).statusCode).toBe(403);
      expect((await as(viewer, 'GET', `/download?path=${q('/var/www/html/escape/keep.txt')}`)).statusCode).toBe(403);
      expect((await as(operator, 'POST', '/mkdir', { path: '/var/www/html/escape/x' })).statusCode).toBe(403);
      const through = await app.inject({
        method: 'PUT',
        url: `/api/ftp/connections/${id}/file?path=${q('/var/www/html/passwd')}`,
        headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('pwned'),
      });
      expect(through.statusCode).toBe(403);
      expect(state.fs.get('/secret/keep.txt')?.data?.toString()).toBe('keep');
      expect(state.calls).not.toContainEqual(['readdir', '/var/www/html/escape']);

      const inside = await as(viewer, 'GET', `/list?path=${q('/var/www/html/current')}`);
      expect(inside.statusCode).toBe(200);
      expect(inside.json().entries.map((e: { name: string }) => e.name)).toEqual(['app.js']);

      // The escaping link itself may still be removed
      expect((await as(operator, 'DELETE', `/file?path=${q('/var/www/html/escape')}`)).statusCode).toBe(204);
      expect(state.fs.has('/var/www/html/escape')).toBe(false);
      expect(state.fs.has('/secret')).toBe(true);
    });

    it('lifts the jail when an admin turns it off, and audits that', async () => {
      const off = await as(admin, 'PATCH', '', { restrictToRoot: false });
      expect(off.statusCode).toBe(200);
      expect(off.json().restrictToRoot).toBe(false);
      const update = audited(id, 'ftp_connection.update').at(-1)!;
      expect(JSON.parse(update.metadata!)).toMatchObject({ restrictToRoot: false });

      const res = await as(viewer, 'GET', `/list?path=${q('/secret')}`);
      expect(res.statusCode).toBe(200);
      expect((await as(viewer, 'GET', '/list?path=.')).json()).toMatchObject({
        parent: '/var/www',
        root: null,
      });
    });
  });

  describe('operation timeout', () => {
    let id: string;
    const as = (who: { headers: Record<string, string> }, url: string) =>
      req(who, 'GET', `/ftp/connections/${id}${url}`);

    beforeAll(async () => {
      id = (await create({ password: 'shh', name: 'slow' })).json().id;
    });

    it('answers 504 when a request stalls, closes the session, and reconnects next time', async () => {
      expect((await as(viewer, '/list?path=.')).statusCode).toBe(200);
      const handshakes = state.clients.length;
      const session = state.clients.at(-1)!;

      state.stalled.add('readdir');
      const started = Date.now();
      const res = await as(viewer, `/list?path=${encodeURIComponent('/var/www/html/assets')}`);
      expect(res.statusCode).toBe(504);
      expect(res.json().error).toMatch(/timed out after 150ms/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(session.ended).toBe(true);

      state.stalled.clear();
      expect((await as(viewer, '/list?path=.')).statusCode).toBe(200);
      expect(state.clients.length).toBe(handshakes + 1);
    });

    it('times out a download that stops moving', async () => {
      state.stalled.add('read');
      const res = await as(viewer, `/download?path=${encodeURIComponent('/var/www/html/index.html')}`);
      // Nothing arrived, so the headers were still held back for a real status
      expect(res.statusCode).toBe(504);
      expect(res.json().error).toMatch(/transfer timed out/);
      expect(state.clients.at(-1)!.ended).toBe(true);
    });
  });

  describe('SSH key authentication', () => {
    let keyId: string;
    let privateKeyPem: string;

    beforeAll(async () => {
      const res = await req(admin, 'POST', '/keys/generate', { name: 'deploy-key' });
      expect(res.statusCode).toBe(201);
      keyId = res.json().key.id;
      privateKeyPem = res.json().privateKeyPem;
    });

    it('logs in with the org key and never offers a password', async () => {
      const res = await create({ name: 'by-key', authMethod: 'key', sshKeyId: keyId });
      expect(res.statusCode).toBe(201);
      const id = res.json().id;
      expect(res.json()).toMatchObject({ authMethod: 'key', sshKeyId: keyId });
      expect(row(id).encryptedPassword).toBe('');
      expect(JSON.stringify(res.json())).not.toContain('PRIVATE KEY');

      const test = await req(admin, 'POST', `/ftp/connections/${id}/test`);
      expect(test.json()).toMatchObject({ ok: true, workingDirectory: '/var/www/html' });
      const config = state.clients.at(-1)!.config;
      expect(config.privateKey).toBe(privateKeyPem);
      expect(config.password).toBeUndefined();
      expect(config.tryKeyboard).toBe(false);

      expect((await req(viewer, 'GET', `/ftp/connections/${id}/list?path=.`)).statusCode).toBe(200);
      expect(state.clients.at(-1)!.config.privateKey).toBe(privateKeyPem);
    });

    it('validates the key choice', async () => {
      expect((await create({ authMethod: 'key' })).statusCode).toBe(400);
      expect((await create({ authMethod: 'key', sshKeyId: 'nope' })).statusCode).toBe(400);
      // FTP has no key auth
      const ftp = await create({ protocol: 'ftps', authMethod: 'key', sshKeyId: keyId });
      expect(ftp.statusCode).toBe(400);
      expect(ftp.json().error).toMatch(/only available for SFTP/);
      // Password auth still needs a password
      expect((await create({})).statusCode).toBe(400);

      // Another org's key is not ours to use
      const theirs = await req(outsider, 'POST', '/keys/generate', { name: 'theirs' });
      expect((await create({ authMethod: 'key', sshKeyId: theirs.json().key.id })).statusCode).toBe(400);
    });

    it('switches between password and key auth', async () => {
      const id = (await create({ name: 'switch', password: 'old' })).json().id;
      const toKey = await req(admin, 'PATCH', `/ftp/connections/${id}`, { authMethod: 'key', sshKeyId: keyId });
      expect(toKey.statusCode).toBe(200);
      expect(row(id)).toMatchObject({ authMethod: 'key', sshKeyId: keyId, encryptedPassword: '' });
      expect(JSON.parse(audited(id, 'ftp_connection.update').at(-1)!.metadata!)).toMatchObject({
        authMethod: 'key',
        sshKeyId: keyId,
      });

      // Back to a password needs a new one: the old one was dropped
      expect((await req(admin, 'PATCH', `/ftp/connections/${id}`, { authMethod: 'password' })).statusCode).toBe(400);
      const back = await req(admin, 'PATCH', `/ftp/connections/${id}`, { authMethod: 'password', password: 'new' });
      expect(back.statusCode).toBe(200);
      expect(row(id)).toMatchObject({ authMethod: 'password', sshKeyId: null });
      expect(row(id).encryptedPassword).not.toBe('');

      await req(admin, 'POST', `/ftp/connections/${id}/test`);
      expect(state.clients.at(-1)!.config).toMatchObject({ password: 'new', tryKeyboard: true });
    });

    it('refuses to delete a key a file connection logs in with', async () => {
      const res = await req(admin, 'DELETE', `/keys/${keyId}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/file connection\(s\) \(.*by-key/);
    });
  });

  describe('host key scan, pin and alerts', () => {
    let id: string;
    const as = (
      who: { headers: Record<string, string> },
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: object,
    ) => req(who, method, `/ftp/connections/${id}${url}`, payload);

    beforeAll(async () => {
      id = (await create({ name: 'pinned', password: 'shh' })).json().id;
    });

    it('scans the presented key without storing or logging in', async () => {
      expect((await as(operator, 'POST', '/host-key/scan')).statusCode).toBe(403);
      expect((await as(outsider, 'POST', '/host-key/scan')).statusCode).toBe(404);

      const scan = await as(admin, 'POST', '/host-key/scan');
      expect(scan.statusCode).toBe(200);
      expect(scan.json()).toEqual({ fingerprint: KEY_FP, type: 'ssh-ed25519' });
      expect(row(id).hostKeyFingerprint).toBeNull();
      // Refused at the host key, before any credential
      const client = state.clients.at(-1)!;
      expect(client.config.password).toBeUndefined();
      expect(client.config.username).toBe('smt-host-key-scan');
      expect(state.calls).toEqual([]);
    });

    it('pins the scanned key', async () => {
      const pinned = await as(admin, 'PUT', '/host-key', { fingerprint: KEY_FP });
      expect(pinned.statusCode).toBe(200);
      expect(row(id)).toMatchObject({ hostKeyFingerprint: KEY_FP });
      expect(audited(id, 'ftp_connection.host_key_pinned')).toHaveLength(1);
      expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
      // Nothing was mismatched, so nothing is announced
      expect(notifyAlertsChanged).not.toHaveBeenCalled();
    });

    it('raises a critical notification once per new mismatched key', async () => {
      await as(admin, 'PUT', '/host-key', { fingerprint: KEY_FP });
      state.presented = OTHER_KEY;
      expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(409);
      expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(409);

      expect(notifyAlertsChanged).toHaveBeenCalledTimes(1);
      const [event] = vi.mocked(notifyAlertsChanged).mock.calls[0]![0];
      expect(event).toMatchObject({
        kind: 'opened',
        orgId,
        serverId: id,
        type: 'host_key_mismatch',
        severity: 'critical',
        message: expect.stringContaining(OTHER_FP),
        subject: { id, name: 'pinned (SFTP file connection)', host: 'sftp.example.com' },
      });
    });

    it('resolves the notification when an admin accepts the new key', async () => {
      const accepted = await as(admin, 'POST', '/host-key/accept', { fingerprint: OTHER_FP });
      expect(accepted.statusCode).toBe(200);
      expect(notifyAlertsChanged).toHaveBeenCalledTimes(1);
      const [event] = vi.mocked(notifyAlertsChanged).mock.calls[0]![0];
      expect(event).toMatchObject({ kind: 'resolved', serverId: id, type: 'host_key_mismatch' });

      // Forgetting a key with no mismatch on file announces nothing
      vi.mocked(notifyAlertsChanged).mockClear();
      expect((await as(admin, 'DELETE', '/host-key')).statusCode).toBe(204);
      expect(notifyAlertsChanged).not.toHaveBeenCalled();
    });
  });

  it('removes what an SFTP upload cut off at the size limit left behind', async () => {
    // config is read-only to the app; the test lowers the cap for one upload
    const config = (await import('../../config/index.js')).config as { ftpMaxUploadBytes: number };
    const cap = config.ftpMaxUploadBytes;
    config.ftpMaxUploadBytes = 16;
    try {
      const id = (await create({ name: 'uploads', password: 'shh' })).json().id;
      const { Readable } = await import('node:stream');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/ftp/connections/${id}/file?path=${encodeURIComponent('/var/www/html/big.bin')}`,
        headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
        payload: Readable.from([Buffer.alloc(10), Buffer.alloc(10)]),
      });
      expect(res.statusCode).toBe(413);
      expect(state.calls).toContainEqual(['unlink', '/var/www/html/big.bin']);
      expect(state.fs.has('/var/www/html/big.bin')).toBe(false);
    } finally {
      config.ftpMaxUploadBytes = cap;
    }
  });
});
