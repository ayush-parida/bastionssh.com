import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client, type SFTPWrapper } from 'ssh2';

/**
 * Runs only against a real SFTP server, e.g. an SFTP-only (chrooted,
 * internal-sftp) account in a throwaway container:
 *
 *   docker run -d --rm -p 2222:22 --name smt-sftp-test atmoz/sftp testuser:testpass:::upload
 *   SMT_TEST_SFTP_HOST=127.0.0.1 SMT_TEST_SFTP_PORT=2222 pnpm vitest run src/ftp/sftp.integration.test.ts
 *   docker stop smt-sftp-test
 *
 * Everything goes through the real API routes, pool, host key store and ssh2.
 */

vi.hoisted(() => {
  process.env.SMT_FTP_MAX_UPLOAD_BYTES = '4096';
});

const host = process.env.SMT_TEST_SFTP_HOST;
const port = Number(process.env.SMT_TEST_SFTP_PORT ?? 22);
const username = process.env.SMT_TEST_SFTP_USER ?? 'testuser';
const password = process.env.SMT_TEST_SFTP_PASSWORD ?? 'testpass';
const root = process.env.SMT_TEST_SFTP_ROOT ?? '/upload';

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');

/** A raw channel for setup the API does not offer (symlinks). */
function rawSftp(): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () =>
        client.sftp((err, sftp) => (err ? reject(err) : resolve({ client, sftp }))),
      )
      .on('error', reject)
      .connect({ host, port, username, password, hostVerifier: () => true });
  });
}

describe.skipIf(!host)('sftp connections against a live server', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  let id: string;
  const dir = `${root}/smt-it-${Date.now().toString(36)}`;

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/ftp/connections/${id}${url}`,
      headers: admin.headers,
      ...(payload !== undefined && { payload: payload as object }),
    });

  beforeAll(async () => {
    await runMigrations();
    admin = seedUser(seedOrg('sftp-it'), 'admin');
    app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: { name: 'sftp-it', host, port, protocol: 'sftp', username, password, rootPath: root },
    });
    expect(res.statusCode).toBe(201);
    id = res.json().id;
  });

  afterAll(async () => {
    await api('DELETE', `/file?path=${encodeURIComponent(dir)}&recursive=true`).catch(() => {});
    await app?.close();
  });

  it('tests the connection and trusts the host key on first use', async () => {
    expect((await api('GET', '/host-key')).json().fingerprint).toBeNull();

    const test = await api('POST', '/test');
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, workingDirectory: root });

    const key = (await api('GET', '/host-key')).json();
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(key.type).toBeTruthy();
    expect((await api('GET', '')).json().hostKeyStatus).toBe('trusted');
  });

  it('lists, uploads, downloads, renames, and deletes', async () => {
    expect((await api('POST', '/mkdir', { path: dir })).statusCode).toBe(201);
    expect((await api('POST', '/mkdir', { path: `${dir}/sub` })).statusCode).toBe(201);

    const up = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${id}/file?path=${encodeURIComponent(`${dir}/hello.txt`)}`,
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello sftp'),
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().size).toBe(10);

    const home = await api('GET', '/list?path=.');
    expect(home.json().path).toBe(root);

    const listing = (await api('GET', `/list?path=${encodeURIComponent(dir)}`)).json();
    expect(listing.entries.map((e: { name: string }) => e.name)).toEqual(['sub', 'hello.txt']);
    const file = listing.entries[1];
    expect(file).toMatchObject({ type: 'file', size: 10, path: `${dir}/hello.txt` });
    expect(file.permissions).toMatch(/^[rwx-]{9}$/);
    expect(new Date(file.modifiedAt).getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);

    const down = await api('GET', `/download?path=${encodeURIComponent(`${dir}/hello.txt`)}`);
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-length']).toBe('10');
    expect(down.body).toBe('hello sftp');

    const renamed = await api('POST', '/rename', { from: `${dir}/hello.txt`, to: `${dir}/renamed.txt` });
    expect(renamed.statusCode).toBe(200);
    expect((await api('GET', `/download?path=${encodeURIComponent(`${dir}/hello.txt`)}`)).statusCode).toBe(404);

    // A non-empty directory is refused without `recursive`
    expect((await api('DELETE', `/file?path=${encodeURIComponent(dir)}`)).statusCode).toBe(400);
    expect((await api('DELETE', `/file?path=${encodeURIComponent(`${dir}/renamed.txt`)}`)).statusCode).toBe(204);
  });

  it('refuses an upload past the cap', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${id}/file?path=${encodeURIComponent(`${dir}/big.bin`)}`,
      headers: { ...admin.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(8192),
    });
    expect(res.statusCode).toBe(413);
  });

  it('resolves symlinks and deletes through them without following', async () => {
    const { client, sftp } = await rawSftp();
    try {
      await new Promise<void>((resolve, reject) =>
        sftp.writeFile(`${dir}/sub/keep.txt`, 'keep', (err) => (err ? reject(err) : resolve())),
      );
      // `tree` holds a link to `sub`; deleting `tree` must not empty `sub`
      await new Promise<void>((resolve, reject) =>
        sftp.mkdir(`${dir}/tree`, (err) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        sftp.symlink(`${dir}/sub`, `${dir}/tree/link`, (err) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        sftp.symlink(`${dir}/nowhere`, `${dir}/dangling`, (err) => (err ? reject(err) : resolve())),
      );
    } finally {
      client.end();
    }

    const tree = (await api('GET', `/list?path=${encodeURIComponent(`${dir}/tree`)}`)).json();
    expect(tree.entries[0]).toMatchObject({
      name: 'link',
      type: 'symlink',
      targetType: 'directory',
      link: `${dir}/sub`,
    });
    const top = (await api('GET', `/list?path=${encodeURIComponent(dir)}`)).json();
    expect(top.entries.find((e: { name: string }) => e.name === 'dangling')).toMatchObject({
      type: 'symlink',
      targetType: 'file',
    });

    // Deleting the link itself unlinks it
    expect((await api('DELETE', `/file?path=${encodeURIComponent(`${dir}/dangling`)}`)).statusCode).toBe(204);
    // A recursive delete of the tree removes the link, not what it points at
    expect(
      (await api('DELETE', `/file?path=${encodeURIComponent(`${dir}/tree`)}&recursive=true`)).statusCode,
    ).toBe(204);
    const sub = (await api('GET', `/list?path=${encodeURIComponent(`${dir}/sub`)}`)).json();
    expect(sub.entries.map((e: { name: string }) => e.name)).toEqual(['keep.txt']);
  });

  it('refuses a changed host key before logging in, and accepts it only when echoed', async () => {
    const real = (await api('GET', '/host-key')).json().fingerprint as string;
    const bogus = `SHA256:${'A'.repeat(43)}`;
    expect((await api('PUT', '/host-key', { fingerprint: bogus })).statusCode).toBe(200);

    const refused = await api('GET', '/list?path=.');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'HOST_KEY_MISMATCH',
      ftpConnectionId: id,
      expected: bogus,
      presented: real,
    });
    const key = (await api('GET', '/host-key')).json();
    expect(key.mismatch.fingerprint).toBe(real);

    expect((await api('POST', '/host-key/accept', { fingerprint: bogus })).statusCode).toBe(409);
    expect((await api('POST', '/host-key/accept', { fingerprint: real })).statusCode).toBe(200);
    expect((await api('GET', '/list?path=.')).statusCode).toBe(200);
  });

  it('reports a wrong password as an authentication failure', async () => {
    expect((await api('PATCH', '', { password: 'wrong-password' })).statusCode).toBe(200);
    const test = await api('POST', '/test');
    expect(test.json()).toMatchObject({ ok: false, error: expect.stringMatching(/Authentication failed/) });
    const list = await api('GET', '/list?path=.');
    expect(list.statusCode).toBe(403);
    expect(list.json().error).toMatch(/Authentication failed/);
    expect((await api('PATCH', '', { password })).statusCode).toBe(200);
  });
});
