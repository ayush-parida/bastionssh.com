import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Must run before `config` is imported: a tiny cap lets the upload guard be
// exercised with a handful of bytes.
vi.hoisted(() => {
  process.env.SMT_FTP_MAX_UPLOAD_BYTES = '16';
});

// ssh2 is replaced by an in-memory SFTP server; the routes, pool, host key
// store, DB and vault are real. basic-ftp must never be reached for SFTP.
vi.mock('ssh2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ssh2')>()),
  ...(await import('../../ftp/fake-ssh2.test-helper.js')).fakeSsh2(),
}));

vi.mock('../../ftp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/client.js')>();
  return {
    ...actual,
    openClient: vi.fn(async () => {
      throw new Error('basic-ftp must not be used for an SFTP connection');
    }),
  };
});

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as import('../../ftp/fake-ssh2.test-helper.js').FakeSsh2State;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog, ftpConnections } = await import('../../db/schema.js');
const { seedOrg, seedUser } = await import('./test-utils.js');
const { openClient } = await import('../../ftp/client.js');

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
  state.fs.set('/var/www/html/latest', { type: 'link', target: '/var/www/html/index.html' });
  state.fs.set('/var/www/html/escape', { type: 'link', target: '/secret' });
  state.fs.set('/secret/keep.txt', { type: 'file', data: Buffer.from('keep') });
}

describe('ftp routes with an SFTP connection', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let id: string;

  const as = (
    who: { headers: Record<string, string> },
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/ftp/connections/${id}${url}`,
      headers: who.headers,
      ...(payload && { payload }),
    });

  const row = () => getDb().select().from(ftpConnections).where(eq(ftpConnections.id, id)).get()!;
  const audited = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all();

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-sftp-a');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-sftp-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    state.reset();
    state.presented = KEY;
    seedFs();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an SFTP connection on port 22 with no host key yet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: {
        name: 'sftp-only',
        host: 'SFTP.example.com',
        protocol: 'sftp',
        username: 'deploy',
        password: 'shh-secret',
        rootPath: '/var/www/html',
      },
    });
    expect(res.statusCode).toBe(201);
    id = res.json().id;
    expect(res.json()).toMatchObject({
      protocol: 'sftp',
      port: 22,
      host: 'sftp.example.com',
      hostKeyFingerprint: null,
      hostKeyStatus: 'unknown',
    });
    expect(Object.keys(res.json())).not.toContain('hostKeyMismatchFingerprint');
  });

  it('tests the connection over SFTP and trusts the host key on first use', async () => {
    const res = await as(admin, 'POST', '/test');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, workingDirectory: '/var/www/html', entryCount: 5 });
    expect(openClient).not.toHaveBeenCalled();

    expect(row()).toMatchObject({ hostKeyFingerprint: KEY_FP, hostKeyType: 'ssh-ed25519', lastStatus: 'ok' });
    expect(audited('ftp_connection.host_key_trusted')).toHaveLength(1);
    // The test connection is not pooled
    expect(state.clients.every((c) => c.ended)).toBe(true);

    const card = (await as(viewer, 'GET', '')).json();
    expect(card).toMatchObject({ hostKeyFingerprint: KEY_FP, hostKeyStatus: 'trusted' });
  });

  it('lists through the SFTP backend and reuses one session per user', async () => {
    const handshakes = state.clients.length;
    const res = await as(viewer, 'GET', '/list?path=.');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe('/var/www/html');
    expect(body.parent).toBe('/var/www');
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
      'assets',
      'current',
      'escape',
      'index.html',
      'latest',
    ]);
    expect(body.entries[1]).toMatchObject({ type: 'symlink', targetType: 'directory' });

    await as(viewer, 'GET', '/list?path=/var/www/html/assets/');
    expect(state.clients).toHaveLength(handshakes + 1);
    expect(state.calls).toContainEqual(['readdir', '/var/www/html/assets']);

    await as(operator, 'GET', '/list?path=/var/www/html');
    expect(state.clients).toHaveLength(handshakes + 2);
    expect(openClient).not.toHaveBeenCalled();
  });

  it('collapses .. in the request path and refuses a relative one', async () => {
    const res = await as(viewer, 'GET', `/list?path=${encodeURIComponent('/var/www/html/../../..')}`);
    expect(res.json().path).toBe('/');
    expect((await as(viewer, 'GET', '/list?path=..')).statusCode).toBe(400);
    expect(state.calls.some(([, p]) => String(p).includes('..'))).toBe(false);
  });

  it('downloads a file, sizes a link by its target, and refuses a link to a directory', async () => {
    const file = await as(viewer, 'GET', '/download?path=/var/www/html/index.html');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-length']).toBe('5');
    expect(file.body).toBe('hello');

    const link = await as(viewer, 'GET', '/download?path=/var/www/html/latest');
    expect(link.headers['content-length']).toBe('5');
    expect(link.body).toBe('hello');

    const dirLink = await as(viewer, 'GET', '/download?path=/var/www/html/current');
    expect(dirLink.statusCode).toBe(400);
    expect(dirLink.json().error).toMatch(/downloadable/);

    expect((await as(viewer, 'GET', '/download?path=/var/www/html/assets')).statusCode).toBe(400);
    expect((await as(viewer, 'GET', '/download?path=/var/www/html/missing')).statusCode).toBe(404);
  });

  it('refuses to download a device or FIFO, which would never end', async () => {
    state.fs.set('/var/www/html/zero', { type: 'device' });
    const res = await as(viewer, 'GET', '/download?path=/var/www/html/zero');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/regular files/);
    expect(state.calls.some(([op]) => op === 'createReadStream' || op === 'open')).toBe(false);
  });

  it('uploads under the cap and refuses one over it', async () => {
    const put = (path: string, payload: Buffer, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'PUT',
        url: `/api/ftp/connections/${id}/file?path=${encodeURIComponent(path)}`,
        headers: { ...operator.headers, 'content-type': 'application/octet-stream', ...headers },
        payload,
      });

    const ok = await put('/var/www/html/new.txt', Buffer.from('fresh'));
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ path: '/var/www/html/new.txt', size: 5 });
    expect(state.fs.get('/var/www/html/new.txt')?.data?.toString()).toBe('fresh');

    expect((await put('/var/www/html/big.bin', Buffer.alloc(32))).statusCode).toBe(413);
    expect(state.calls).not.toContainEqual(['createWriteStream', '/var/www/html/big.bin']);

    // No declared length: the counter cuts it off mid-stream
    const { Readable } = await import('node:stream');
    const chunked = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${id}/file?path=${encodeURIComponent('/var/www/html/chunked.bin')}`,
      headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
      payload: Readable.from([Buffer.alloc(10), Buffer.alloc(10)]),
    });
    expect(chunked.statusCode).toBe(413);
    expect(state.fs.has('/var/www/html/chunked.bin')).toBe(false);

    // The session survived the refusal
    expect((await as(operator, 'GET', '/list?path=.')).statusCode).toBe(200);
  });

  it('creates, renames and maps refusals to the FTP statuses', async () => {
    expect((await as(operator, 'POST', '/mkdir', { path: '/var/www/html/new/' })).statusCode).toBe(201);
    expect(state.fs.get('/var/www/html/new')?.type).toBe('dir');
    expect((await as(operator, 'POST', '/mkdir', { path: '/var/www/html/new' })).statusCode).toBe(400);

    const renamed = await as(operator, 'POST', '/rename', {
      from: '/var/www/html/index.html',
      to: '/var/www/html/home.html',
    });
    expect(renamed.statusCode).toBe(200);
    expect(state.fs.has('/var/www/html/home.html')).toBe(true);

    state.denied.add('/var/www/html/assets');
    const refused = await as(viewer, 'GET', '/list?path=/var/www/html/assets');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/Permission denied/);
    expect((await as(viewer, 'GET', '/list?path=/nope')).statusCode).toBe(404);
  });

  it('deletes with lstat semantics: links are unlinked, never followed', async () => {
    const del = (path: string, recursive = false) =>
      as(operator, 'DELETE', `/file?path=${encodeURIComponent(path)}${recursive ? '&recursive=true' : ''}`);

    // A link to a directory, even with recursive=true, only loses the link
    expect((await del('/var/www/html/escape', true)).statusCode).toBe(204);
    expect(state.fs.has('/var/www/html/escape')).toBe(false);
    expect(state.fs.has('/secret/keep.txt')).toBe(true);

    expect((await del('/var/www/html/index.html')).statusCode).toBe(204);
    // Non-empty directory without recursive: the server's FAILURE is a 400
    expect((await del('/var/www/html/assets')).statusCode).toBe(400);
    state.fs.set('/var/www/html/assets/out', { type: 'link', target: '/secret' });
    expect((await del('/var/www/html/assets', true)).statusCode).toBe(204);
    expect(state.fs.has('/var/www/html/assets')).toBe(false);
    expect(state.fs.has('/secret/keep.txt')).toBe(true);
    expect(state.calls.some(([op, p]) => op !== 'lstat' && op !== 'stat' && String(p).startsWith('/secret'))).toBe(
      false,
    );

    expect((await del('/')).statusCode).toBe(400);
  });

  it('keeps the host key endpoints to admins in the same org', async () => {
    for (const who of [viewer, operator]) {
      expect((await as(who, 'GET', '/host-key')).statusCode).toBe(403);
      expect((await as(who, 'DELETE', '/host-key')).statusCode).toBe(403);
      expect((await as(who, 'PUT', '/host-key', { fingerprint: KEY_FP })).statusCode).toBe(403);
    }
    expect((await as(outsider, 'GET', '/host-key')).statusCode).toBe(404);
    expect((await as(admin, 'PUT', '/host-key', { fingerprint: 'MD5:nope' })).statusCode).toBe(400);

    const key = await as(admin, 'GET', '/host-key');
    expect(key.statusCode).toBe(200);
    expect(key.json()).toMatchObject({ fingerprint: KEY_FP, type: 'ssh-ed25519' });
    expect(key.json().mismatch).toBeUndefined();
  });

  it('refuses a changed key with 409, records it once, and accepts it only when echoed', async () => {
    // Drop the pooled sessions so the next request handshakes again
    await as(admin, 'PUT', '/host-key', { fingerprint: KEY_FP });
    const handshakes = state.clients.length;
    state.presented = OTHER_KEY;

    const refused = await as(viewer, 'GET', '/list?path=.');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'HOST_KEY_MISMATCH',
      ftpConnectionId: id,
      expected: KEY_FP,
      presented: OTHER_FP,
    });
    expect(refused.json().serverId).toBeUndefined();
    expect(state.clients.length).toBe(handshakes + 1);
    // Refused before any credential was sent, and the client closed
    expect(state.clients.at(-1)!.ended).toBe(true);

    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(409);
    expect(audited('ftp_connection.host_key_mismatch')).toHaveLength(1);
    expect(row()).toMatchObject({ hostKeyFingerprint: KEY_FP, hostKeyMismatchFingerprint: OTHER_FP });
    expect((await as(viewer, 'GET', '')).json().hostKeyStatus).toBe('mismatch');

    // The test button reports it the same way, and records the failure
    const test = await as(admin, 'POST', '/test');
    expect(test.statusCode).toBe(409);
    expect(row().lastStatus).toBe('failed');

    const view = (await as(admin, 'GET', '/host-key')).json();
    expect(view.mismatch).toMatchObject({ fingerprint: OTHER_FP });

    const wrong = await as(admin, 'POST', '/host-key/accept', { fingerprint: KEY_FP });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe('HOST_KEY_FINGERPRINT_DIFFERS');

    const accepted = await as(admin, 'POST', '/host-key/accept', { fingerprint: OTHER_FP });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ fingerprint: OTHER_FP });
    expect(accepted.json().mismatch).toBeUndefined();
    expect(audited('ftp_connection.host_key_accepted')).toHaveLength(1);

    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
    // The accepted key's type is filled in from the real key on connect
    expect(row().hostKeyType).toBe('ssh-rsa');
    expect((await as(admin, 'POST', '/host-key/accept', { fingerprint: OTHER_FP })).statusCode).toBe(409);
  });

  it('forgets the key so the next connection trusts on first use again', async () => {
    const res = await as(admin, 'DELETE', '/host-key');
    expect(res.statusCode).toBe(204);
    expect(row()).toMatchObject({ hostKeyFingerprint: null, hostKeyMismatchFingerprint: null });
    expect(audited('ftp_connection.host_key_forgotten')).toHaveLength(1);

    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
    expect(row().hostKeyFingerprint).toBe(KEY_FP);
  });

  it('reports bad credentials as a 403 authentication failure', async () => {
    expect((await as(admin, 'PATCH', '', { password: 'wrong' })).statusCode).toBe(200);
    state.authFail = true;
    const list = await as(viewer, 'GET', '/list?path=.');
    expect(list.statusCode).toBe(403);
    expect(list.json().error).toMatch(/^Authentication failed/);
    expect(state.clients.at(-1)!.ended).toBe(true);

    const test = await as(admin, 'POST', '/test');
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: false, error: expect.stringMatching(/^Authentication failed/) });
  });

  it('reconnects after the connection drops', async () => {
    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
    const handshakes = state.clients.length;
    state.clients.at(-1)!.drop();
    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
    expect(state.clients.length).toBe(handshakes + 1);
  });

  it('clears the pinned key when the endpoint changes, but not on a rename', async () => {
    expect(row().hostKeyFingerprint).toBe(KEY_FP);
    await as(admin, 'PATCH', '', { name: 'renamed' });
    expect(row().hostKeyFingerprint).toBe(KEY_FP);

    const pooled = state.clients.filter((c) => !c.ended);
    await as(admin, 'PATCH', '', { port: 2222 });
    expect(row()).toMatchObject({ port: 2222, hostKeyFingerprint: null, hostKeyTrustedAt: null });
    // The edit closed every pooled session
    expect(pooled.every((c) => c.ended)).toBe(true);
  });

  it('refuses host key endpoints for an FTP connection', async () => {
    const ftp = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: { name: 'plain', host: 'ftp.example.com', username: 'u', password: 'p' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${ftp.json().id}/host-key`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(ftp.json().hostKeyStatus).toBe('unknown');
  });

  it('closes the pooled session when the connection is deleted', async () => {
    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(200);
    const open = state.clients.filter((c) => !c.ended);
    expect(open.length).toBeGreaterThan(0);
    expect((await as(admin, 'DELETE', '')).statusCode).toBe(204);
    expect(open.every((c) => c.ended)).toBe(true);
    expect((await as(viewer, 'GET', '/list?path=.')).statusCode).toBe(404);
  });
});
