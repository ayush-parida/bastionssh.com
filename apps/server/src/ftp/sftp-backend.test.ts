import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PassThrough, Readable, Transform } from 'node:stream';
import { eq } from 'drizzle-orm';

vi.mock('ssh2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ssh2')>()),
  ...(await import('./fake-ssh2.test-helper.js')).fakeSsh2(),
}));

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as import('./fake-ssh2.test-helper.js').FakeSsh2State;
const { statusError } = await import('./fake-ssh2.test-helper.js');
const { nanoid } = await import('nanoid');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { ftpConnections } = await import('../db/schema.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { FtpError } = await import('./errors.js');
const { MAX_RESOLVED_LINKS } = await import('./ops.js');
const { HostKeyMismatchError } = await import('../ssh/host-keys.js');
const backend = await import('./sftp-backend.js');

const KEY = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');
const KEY_FP = 'SHA256:7RzRboFL75PCBozdMj7VbF+Y5sel8sTZxSqUkmATKNk';

let orgId: string;
let userId: string;

function seedConnection(overrides: Partial<typeof ftpConnections.$inferInsert> = {}) {
  const id = nanoid();
  getDb()
    .insert(ftpConnections)
    .values({
      id,
      orgId,
      name: 'sftp-only',
      host: 'sftp.example.com',
      port: 22,
      protocol: 'sftp',
      username: 'deploy',
      encryptedPassword: 'unused',
      rootPath: '/var/www/html',
      createdBy: userId,
      ...overrides,
    })
    .run();
  return getDb().select().from(ftpConnections).where(eq(ftpConnections.id, id)).get()!;
}

function seedFs() {
  const fs = state.fs;
  fs.set('/', { type: 'dir' });
  fs.set('/home', { type: 'dir' });
  fs.set('/home/deploy', { type: 'dir' });
  fs.set('/var', { type: 'dir' });
  fs.set('/var/www', { type: 'dir' });
  fs.set('/var/www/html', { type: 'dir' });
  fs.set('/var/www/html/index.html', { type: 'file', data: Buffer.from('<h1>hi</h1>'), mtime: 1_726_000_000 });
  fs.set('/var/www/html/assets', { type: 'dir', mode: 0o750 });
  fs.set('/var/www/html/assets/app.js', { type: 'file', data: Buffer.from('x') });
  fs.set('/var/www/html/Zeta.txt', { type: 'file', data: Buffer.from('z'), mode: 0o600 });
  fs.set('/var/www/html/current', { type: 'link', target: '/var/www/html/assets' });
  fs.set('/var/www/html/latest.txt', { type: 'link', target: 'index.html' });
  fs.set('/var/www/html/dangling', { type: 'link', target: '/nowhere' });
  fs.set('/secret', { type: 'dir' });
  fs.set('/secret/keep.txt', { type: 'file', data: Buffer.from('keep') });
}

async function open(connection = seedConnection()) {
  return backend.openSftp(connection, 'shh');
}

beforeAll(async () => {
  await runMigrations();
  orgId = seedOrg('sftp-backend');
  userId = seedUser(orgId, 'admin').userId;
});

beforeEach(() => {
  state.reset();
  state.presented = KEY;
  seedFs();
});

describe('entry mapping', () => {
  it('maps mode, size and mtime into the FTP entry shape', () => {
    expect(
      backend.toSftpEntry('/var/www', 'site.conf', { mode: 0o100640, size: 42, mtime: 1_700_000_000 }),
    ).toEqual({
      name: 'site.conf',
      path: '/var/www/site.conf',
      type: 'file',
      size: 42,
      permissions: 'rw-r-----',
      modifiedAt: '2023-11-14T22:13:20.000Z',
      rawModifiedAt: '',
      link: null,
      targetType: null,
    });
    expect(backend.toSftpEntry('/', 'etc', { mode: 0o040755 })).toMatchObject({
      path: '/etc',
      type: 'directory',
      permissions: 'rwxr-xr-x',
      modifiedAt: null,
      size: 0,
    });
    expect(backend.toSftpEntry('/', 'l', { mode: 0o120777 }).type).toBe('symlink');
    expect(backend.toSftpEntry('/', 's', { mode: 0o140755 }).type).toBe('other');
    expect(backend.toSftpEntry('/', 'x', {}).permissions).toBeNull();
  });
});

describe('sftp session', () => {
  it('connects with a verifier, timeouts and keepalive, and never opens a shell', async () => {
    const session = await open();
    const { config } = state.clients.at(-1)!;
    expect(config).toMatchObject({
      host: 'sftp.example.com',
      port: 22,
      username: 'deploy',
      password: 'shh',
      readyTimeout: backend.READY_TIMEOUT_MS,
      keepaliveInterval: backend.KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: backend.KEEPALIVE_COUNT_MAX,
      tryKeyboard: true,
    });
    expect(typeof config.hostVerifier).toBe('function');
    expect(config.hostHash).toBeUndefined();
    session.close();
    expect(state.clients.at(-1)!.ended).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('resolves home to the root path, else the login directory', async () => {
    const session = await open();
    expect(await session.home('/var/www/html/')).toBe('/var/www/html');
    expect(await session.home(null)).toBe('/home/deploy');
    session.close();
  });

  it('lists directories first, skips . and .., and fills the entry shape', async () => {
    const session = await open();
    const entries = await session.list('/var/www/html');
    expect(entries.map((e) => e.name)).toEqual([
      'assets',
      'current',
      'dangling',
      'index.html',
      'latest.txt',
      'Zeta.txt',
    ]);
    expect(entries.find((e) => e.name === 'index.html')).toEqual({
      name: 'index.html',
      path: '/var/www/html/index.html',
      type: 'file',
      size: 11,
      permissions: 'rw-r--r--',
      modifiedAt: new Date(1_726_000_000 * 1000).toISOString(),
      rawModifiedAt: '',
      link: null,
      targetType: null,
    });
    expect(entries.find((e) => e.name === 'assets')).toMatchObject({
      type: 'directory',
      permissions: 'rwxr-x---',
    });
    session.close();
  });

  it('resolves each symlink: its target, and whether that is a directory', async () => {
    const session = await open();
    const entries = await session.list('/var/www/html');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.current).toMatchObject({
      type: 'symlink',
      link: '/var/www/html/assets',
      targetType: 'directory',
    });
    expect(byName['latest.txt']).toMatchObject({ type: 'symlink', link: 'index.html', targetType: 'file' });
    // Dangling counts as a file, as on the FTP path
    expect(byName.dangling).toMatchObject({ type: 'symlink', link: '/nowhere', targetType: 'file' });
    session.close();
  });

  it('leaves a link unresolved when the target cannot be read', async () => {
    state.fs.set('/var/www/html/private', { type: 'link', target: '/secret' });
    state.denied.add('/secret');
    const session = await open();
    const link = (await session.list('/var/www/html')).find((e) => e.name === 'private');
    expect(link).toMatchObject({ type: 'symlink', link: '/secret', targetType: null });
    session.close();
  });

  it('resolves at most MAX_RESOLVED_LINKS links per listing', async () => {
    state.fs.set('/links', { type: 'dir' });
    for (let i = 0; i < MAX_RESOLVED_LINKS + 10; i++) {
      state.fs.set(`/links/l${String(i).padStart(3, '0')}`, { type: 'link', target: '/var' });
    }
    const session = await open();
    const entries = await session.list('/links');
    expect(entries).toHaveLength(MAX_RESOLVED_LINKS + 10);
    expect(entries.filter((e) => e.targetType === 'directory')).toHaveLength(MAX_RESOLVED_LINKS);
    expect(entries.filter((e) => e.targetType === null)).toHaveLength(10);
    expect(state.calls.filter(([op]) => op === 'stat')).toHaveLength(MAX_RESOLVED_LINKS);
    session.close();
  });

  it('stats with lstat semantics: a link is described as a link', async () => {
    const session = await open();
    expect(await session.stat('/var/www/html/current')).toMatchObject({
      name: 'current',
      path: '/var/www/html/current',
      type: 'symlink',
      link: '/var/www/html/assets',
    });
    expect(await session.stat('/')).toMatchObject({ name: '/', path: '/', type: 'directory' });
    await expect(session.stat('/var/www/html/missing')).rejects.toMatchObject({ statusCode: 404 });
    session.close();
  });

  it('sizes a link by its target and refuses a link to a directory or nowhere', async () => {
    const session = await open();
    expect(await session.linkTargetSize('/var/www/html/latest.txt')).toBe(11);
    for (const link of ['/var/www/html/current', '/var/www/html/dangling']) {
      await expect(session.linkTargetSize(link)).rejects.toMatchObject({
        statusCode: 400,
        message: 'Link does not point to a downloadable file',
      });
    }
    session.close();
  });

  it('deletes a link with unlink, never touching what it points at', async () => {
    state.fs.set('/var/www/html/to-secret', { type: 'link', target: '/secret' });
    const session = await open();
    await session.removeFile('/var/www/html/to-secret');
    expect(state.fs.has('/var/www/html/to-secret')).toBe(false);
    expect(state.fs.has('/secret/keep.txt')).toBe(true);
    // Even when the caller asks for a recursive delete of the link
    state.fs.set('/var/www/html/to-secret', { type: 'link', target: '/secret' });
    await session.removeDirRecursive('/var/www/html/to-secret');
    expect(state.fs.has('/var/www/html/to-secret')).toBe(false);
    expect(state.fs.has('/secret/keep.txt')).toBe(true);
    expect(state.calls).not.toContainEqual(['readdir', '/secret']);
    session.close();
  });

  it('deletes a tree depth-first, unlinking links inside instead of recursing', async () => {
    state.fs.set('/var/www/html/assets/nested', { type: 'dir' });
    state.fs.set('/var/www/html/assets/nested/deep.txt', { type: 'file', data: Buffer.from('d') });
    state.fs.set('/var/www/html/assets/escape', { type: 'link', target: '/secret' });
    const session = await open();
    await session.removeDirRecursive('/var/www/html/assets');
    expect([...state.fs.keys()].filter((k) => k.startsWith('/var/www/html/assets'))).toEqual([]);
    expect(state.fs.has('/secret/keep.txt')).toBe(true);
    expect(state.calls).toContainEqual(['unlink', '/var/www/html/assets/escape']);
    expect(state.calls.some(([op, p]) => op !== 'lstat' && String(p).startsWith('/secret'))).toBe(false);
    session.close();
  });

  it('refuses to remove a non-empty directory without recursion', async () => {
    const session = await open();
    await expect(session.removeEmptyDir('/var/www/html/assets')).rejects.toMatchObject({ statusCode: 400 });
    expect(state.fs.has('/var/www/html/assets/app.js')).toBe(true);
    session.close();
  });

  it('refuses a path that is not normalized, before the server sees it', async () => {
    const session = await open();
    const before = state.calls.length;
    for (const path of ['/var/www/html/../../../etc', 'relative', '/var/www/html/', '/a/./b', '/a\0b']) {
      await expect(session.list(path)).rejects.toBeInstanceOf(FtpError);
      await expect(session.removeFile(path)).rejects.toMatchObject({ statusCode: 400 });
      await expect(session.removeDirRecursive(path)).rejects.toMatchObject({ statusCode: 400 });
      await expect(session.rename('/var/www/html/index.html', path)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(state.calls.length).toBe(before);
    session.close();
  });

  it('maps SFTP status codes onto the FTP path statuses', async () => {
    state.denied.add('/var/www/html/assets');
    const session = await open();
    await expect(session.list('/var/www/html/nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(session.list('/var/www/html/assets')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Could not list directory: Permission denied',
    });
    await expect(session.mkdir('/var/www/html/index.html')).rejects.toMatchObject({ statusCode: 400 });
    await expect(session.rename('/var/www/html/index.html', '/var/www/html/Zeta.txt')).rejects.toMatchObject({
      statusCode: 400,
    });
    // A refusal leaves the session usable
    expect(session.survives(new FtpError('x', 403))).toBe(true);
    expect((await session.list('/var/www/html')).length).toBeGreaterThan(0);
    session.close();
  });

  it('downloads and uploads through streams', async () => {
    const session = await open();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    await session.download('/var/www/html/index.html', sink);
    expect(Buffer.concat(chunks).toString()).toBe('<h1>hi</h1>');

    await session.upload(Readable.from([Buffer.from('new '), Buffer.from('file')]), '/var/www/html/new.txt');
    expect(state.fs.get('/var/www/html/new.txt')?.data?.toString()).toBe('new file');

    await expect(session.download('/var/www/html/missing', new PassThrough())).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      session.upload(Readable.from([Buffer.from('x')]), '/no-such-dir/f.txt'),
    ).rejects.toMatchObject({ statusCode: 404 });
    session.close();
  });

  it('fails an upload that the size guard cuts off, with its 413, and never commits it', async () => {
    const session = await open();
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > 8) cb(new FtpError('Upload exceeds the 8 byte limit', 413));
        else cb(null, chunk);
      },
    });
    Readable.from([Buffer.alloc(6), Buffer.alloc(6)]).pipe(counter);
    await expect(session.upload(counter, '/var/www/html/big.bin')).rejects.toMatchObject({ statusCode: 413 });
    expect(state.fs.has('/var/www/html/big.bin')).toBe(false);
    expect(state.abortedWrites).toContain('/var/www/html/big.bin');
    // The channel is still fine for the next request
    expect(session.closed).toBe(false);
    session.close();
  });

  it('marks the session closed when the connection drops, so the pool reconnects', async () => {
    const session = await open();
    expect(session.closed).toBe(false);
    state.clients.at(-1)!.drop();
    expect(session.closed).toBe(true);
    expect(session.survives(new Error('whatever'))).toBe(false);
  });
});

describe('connecting', () => {
  it('trusts the host key on first use, then accepts it', async () => {
    const connection = seedConnection();
    (await open(connection)).close();
    const row = getDb().select().from(ftpConnections).where(eq(ftpConnections.id, connection.id)).get()!;
    expect(row.hostKeyFingerprint).toBe(KEY_FP);
    expect(row.hostKeyType).toBe('ssh-ed25519');
    (await open(row)).close();
  });

  it('refuses a changed host key before authenticating, and closes the client', async () => {
    const connection = seedConnection({ hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` });
    const err = await open(connection).catch((e) => e);
    expect(err).toBeInstanceOf(HostKeyMismatchError);
    expect(err.toJSON()).toMatchObject({ code: 'HOST_KEY_MISMATCH', ftpConnectionId: connection.id, presented: KEY_FP });
    expect(state.clients.at(-1)!.ended).toBe(true);
  });

  it('reports bad credentials as a 403 authentication failure and closes the client', async () => {
    state.authFail = true;
    await expect(open()).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/^Authentication failed/),
    });
    expect(state.clients.at(-1)!.ended).toBe(true);
  });

  it('maps an unreachable host to 502 and a handshake timeout to 504', async () => {
    state.connectError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:22'), { code: 'ECONNREFUSED' });
    await expect(open()).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/Could not reach/) });
    expect(state.clients.at(-1)!.ended).toBe(true);

    state.connectError = null;
    state.hang = true;
    await expect(
      backend.openSftp(seedConnection(), 'shh', { readyTimeoutMs: 20 }),
    ).rejects.toMatchObject({ statusCode: 504 });
    expect(state.clients.at(-1)!.ended).toBe(true);
  });

  it('closes the client when the server will not open the SFTP subsystem', async () => {
    state.sftpError = new Error('Unable to start subsystem: sftp');
    await expect(open()).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/did not open an SFTP session/),
    });
    expect(state.clients.at(-1)!.ended).toBe(true);
  });

  it('answers keyboard-interactive prompts with the password', async () => {
    state.keyboardPrompts = [{ prompt: 'Password: ', echo: false }];
    (await open()).close();
    expect(state.keyboardAnswers).toEqual(['shh']);
  });

  it('never types the password into an OTP, visible or multi-prompt round', async () => {
    state.keyboardPrompts = [{ prompt: 'Verification code: ', echo: false }];
    (await open()).close();
    expect(state.keyboardAnswers).toEqual(['']);

    state.keyboardPrompts = [{ prompt: 'Username: ', echo: true }];
    (await open()).close();
    expect(state.keyboardAnswers).toEqual(['']);

    state.keyboardPrompts = [
      { prompt: 'Password: ', echo: false },
      { prompt: 'Passcode: ', echo: false },
    ];
    (await open()).close();
    expect(state.keyboardAnswers).toEqual(['', '']);
  });

  it('answers the password at most once per connection', () => {
    const prompt = [{ prompt: 'Password: ', echo: false }];
    expect(backend.keyboardAnswers(prompt, 'shh', false)).toEqual(['shh']);
    expect(backend.keyboardAnswers(prompt, 'shh', true)).toEqual(['']);
    expect(backend.keyboardAnswers([], 'shh', false)).toEqual([]);
  });
});

describe('testConnection', () => {
  it('logs in, resolves the root, counts entries, and closes', async () => {
    const result = await backend.testSftpConnection(seedConnection(), 'shh');
    expect(result).toEqual({ ok: true, workingDirectory: '/var/www/html', entryCount: 6 });
    expect(state.calls).toContainEqual(['realpath', '/var/www/html']);
    expect(state.clients.at(-1)!.ended).toBe(true);
  });

  it("resolves '.' when there is no root", async () => {
    const result = await backend.testSftpConnection(seedConnection({ rootPath: null }), 'shh');
    expect(result).toEqual({ ok: true, workingDirectory: '/home/deploy', entryCount: 0 });
  });

  it('reports a failure in the result, but throws a changed host key', async () => {
    state.authFail = true;
    const failed = await backend.testSftpConnection(seedConnection(), 'shh');
    expect(failed).toEqual({ ok: false, error: expect.stringMatching(/^Authentication failed/) });

    state.authFail = false;
    const missingRoot = await backend.testSftpConnection(seedConnection({ rootPath: '/gone' }), 'shh');
    expect(missingRoot).toMatchObject({ ok: false });

    await expect(
      backend.testSftpConnection(seedConnection({ hostKeyFingerprint: `SHA256:${'B'.repeat(43)}` }), 'shh'),
    ).rejects.toBeInstanceOf(HostKeyMismatchError);
  });
});

describe('error mapping', () => {
  it('maps status codes like the FTP path and keeps the context', () => {
    expect(backend.toSftpError(statusError(2, 'No such file'), 'Could not x')).toMatchObject({
      statusCode: 404,
      message: 'Could not x: No such file',
    });
    expect(backend.toSftpError(statusError(3, ''), 'Could not x')).toMatchObject({
      statusCode: 403,
      message: 'Could not x: Permission denied',
    });
    expect(backend.toSftpError(statusError(4, 'Failure')).statusCode).toBe(400);
    expect(backend.toSftpError(statusError(8, 'Unsupported')).statusCode).toBe(400);
    expect(backend.toSftpError(statusError(7, 'Connection lost')).statusCode).toBe(502);
    expect(backend.toSftpError(new Error('No response from server')).statusCode).toBe(502);
    expect(backend.toSftpError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' })).statusCode).toBe(504);
    const already = new FtpError('keep', 413);
    expect(backend.toSftpError(already)).toBe(already);
  });

  it('maps connection failures, passing a host key refusal through', () => {
    expect(
      backend.toSftpConnectError(Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      })),
    ).toMatchObject({ statusCode: 403, message: expect.stringMatching(/^Authentication failed/) });
    expect(
      backend.toSftpConnectError(Object.assign(new Error('Timed out while waiting for handshake'), {
        level: 'client-timeout',
      })),
    ).toMatchObject({ statusCode: 504 });
    expect(
      backend.toSftpConnectError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })),
    ).toMatchObject({ statusCode: 502 });
    const mismatch = new HostKeyMismatchError('id', 'a', 'b', null, 'x', 'ftp_connection');
    expect(backend.toSftpConnectError(mismatch)).toBe(mismatch);
  });
});
