import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';
import { and, eq } from 'drizzle-orm';

/**
 * Servers → Files folder downloads against a real sshd with two accounts: one
 * with a shell (tar fast path for .tar.gz) and one forced to internal-sftp
 * (engine over SFTP). In a throwaway container:
 *
 *   docker run -d --name smt-fdl-sshd -p 127.0.0.1:2299:22 alpine:3 sh -c '
 *     apk add --no-cache openssh tar && ssh-keygen -A &&
 *     adduser -D -s /bin/sh shelluser && echo shelluser:shellpass | chpasswd &&
 *     adduser -D -s /bin/sh sftpuser && echo sftpuser:sftppass | chpasswd &&
 *     printf "PasswordAuthentication yes\nMatch User sftpuser\n  ForceCommand internal-sftp\n" >> /etc/ssh/sshd_config &&
 *     exec /usr/sbin/sshd -D -e'
 *   SMT_TEST_SSH_HOST=127.0.0.1 SMT_TEST_SSH_PORT=2299 pnpm vitest run src/ssh/folder-download.integration.test.ts
 *   docker rm -f smt-fdl-sshd
 *
 * Every archive is extracted with the system's tar / unzip and compared file
 * by file (SHA-256) with what was uploaded.
 */

const host = process.env.SMT_TEST_SSH_HOST;
const port = Number(process.env.SMT_TEST_SSH_PORT ?? 22);
const accounts = {
  shell: { username: 'shelluser', password: 'shellpass' },
  sftp: { username: 'sftpuser', password: 'sftppass' },
};

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { auditLog, servers } = await import('../db/schema.js');
const { vault } = await import('../vault/index.js');
const { seedOrg, seedServer, seedUser } = await import('../api/routes/test-utils.js');

function connect(account: { username: string; password: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client)).on('error', reject).connect({ host, port, ...account, hostVerifier: () => true });
  });
}

const sftpOf = (client: Client) =>
  new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))));
const call = <T = void>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Every regular file under `dir` (relative path → SHA-256) and every link (→ target). */
function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    const p = path.join(rel, name);
    // macOS tar writes PAX (UTF-8) names out decomposed
    const key = p.normalize('NFC');
    const st = fs.lstatSync(path.join(dir, p));
    if (st.isSymbolicLink()) out[key] = `-> ${fs.readlinkSync(path.join(dir, p))}`;
    else if (st.isDirectory()) Object.assign(out, snapshot(dir, p));
    else out[key] = sha(fs.readFileSync(path.join(dir, p)));
  }
  return out;
}

describe.skipIf(!host)('folder download from a live server', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  const serverIds: Record<keyof typeof accounts, string> = { shell: '', sftp: '' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-fdl-it-'));
  const tag = `fdl-${Date.now().toString(36)}`;
  /** Per account: relative path → SHA-256 of what was uploaded. */
  const expected: Record<keyof typeof accounts, Record<string, string>> = { shell: {}, sftp: {} };

  /** Upload the same tree to both accounts' homes. */
  async function seedTree(account: { username: string; password: string }, hashes: Record<string, string>) {
    const client = await connect(account);
    const sftp = await sftpOf(client);
    const root = `/home/${account.username}/${tag}`;
    for (const d of ['', '/src', '/src/deep', '/empty', '/ünïcødé dir']) await call((cb) => sftp.mkdir(root + d, cb));
    const files: Record<string, Buffer> = {};
    files['README.md'] = Buffer.from('# hello\n');
    files['src/main.ts'] = Buffer.from('export const x = 1;\n');
    files['src/deep/blob.bin'] = randomBytes(5 * 1024 * 1024 + 17);
    files['ünïcødé dir/naïve file.txt'] = Buffer.from('unicode');
    for (let i = 0; i < 25; i++) files[`src/deep/small-${i}.txt`] = randomBytes(i * 37);
    files[`big.bin`] = randomBytes(24 * 1024 * 1024);
    for (const [rel, data] of Object.entries(files)) {
      await call((cb) => sftp.writeFile(`${root}/${rel}`, data, cb));
      hashes[rel] = sha(data);
    }
    await call((cb) => sftp.symlink('src/main.ts', `${root}/latest`, cb));
    await call((cb) => sftp.writeFile(`${root}/secret.txt`, Buffer.from('nope'), cb));
    await call((cb) => sftp.chmod(`${root}/secret.txt`, 0o000, cb));
    client.end();
    return root;
  }

  async function download(account: keyof typeof accounts, folder: string, format: 'zip' | 'tar.gz') {
    const res = await app.inject({
      method: 'GET',
      url: `/api/sftp/${serverIds[account]}/folder?path=${encodeURIComponent(folder)}&format=${format}`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    const file = path.join(tmp, `${account}-${format.replace('.', '-')}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, res.rawPayload);
    const out = `${file}.d`;
    fs.mkdirSync(out);
    if (format === 'zip') execFileSync('unzip', ['-q', file, '-d', out]);
    else execFileSync('tar', ['-xzf', file, '-C', out]);
    return { out, res };
  }

  const lastAudit = () =>
    JSON.parse(
      getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'sftp.folder_download')))
        .all()
        .at(-1)?.metadata ?? '{}',
    ) as Record<string, unknown>;

  const roots: Record<keyof typeof accounts, string> = { shell: '', sftp: '' };

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('fdl-it');
    admin = seedUser(orgId, 'admin');
    for (const key of ['shell', 'sftp'] as const) {
      const id = seedServer(orgId, admin.userId, `fdl-${key}`);
      getDb()
        .update(servers)
        .set({ host, port, username: accounts[key].username, encryptedPassword: await vault.encrypt(accounts[key].password, id) })
        .where(eq(servers.id, id))
        .run();
      serverIds[key] = id;
      roots[key] = await seedTree(accounts[key], expected[key]);
    }
    app = await buildApp();
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of ['shell', 'sftp'] as const) {
      const client = await connect(accounts[key]).catch(() => null);
      if (!client) continue;
      const sftp = await sftpOf(client);
      await call((cb) => sftp.chmod(`${roots[key]}/secret.txt`, 0o644, cb)).catch(() => {});
      client.end();
    }
  });

  for (const account of ['shell', 'sftp'] as const) {
    for (const format of ['tar.gz', 'zip'] as const) {
      it(`${account} account, ${format}: every byte arrives; the unreadable file is listed`, async () => {
        const { out } = await download(account, roots[account], format);
        const got = snapshot(out);
        const skipped = fs.readFileSync(path.join(out, '_skipped.txt'), 'utf8');
        expect(skipped).toMatch(/secret\.txt.*Permission denied/);
        delete got['_skipped.txt'];
        const want = { ...expected[account], ...(format === 'tar.gz' && { latest: '-> src/main.ts' }) };
        expect(got).toEqual(want);
        if (format === 'zip') expect(skipped).toMatch(/latest\tsymbolic link/);
        expect(lastAudit()).toMatchObject({
          format,
          method: account === 'shell' && format === 'tar.gz' ? 'tar' : 'sftp',
          files: Object.keys(want).length,
          truncated: false,
        });
      }, 120_000);
    }
  }

  it('stops the remote tar when the browser goes away', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port: apiPort } = app.server.address() as AddressInfo;
    let got = 0;
    await new Promise<void>((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: `/api/sftp/${serverIds.shell}/folder?path=${encodeURIComponent(roots.shell)}&format=tar.gz`,
          headers: admin.headers,
        },
        (res) => {
          res.on('data', (c: Buffer) => {
            got += c.length;
            if (got > 256 * 1024) req.destroy();
          });
          res.on('close', () => resolve());
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 1500));
    const client = await connect(accounts.shell);
    const running = await new Promise<string>((resolve, reject) => {
      client.exec('pgrep -u shelluser -x tar || true', (err, ch) => {
        if (err) return reject(err);
        let out = '';
        ch.on('data', (d: Buffer) => (out += d.toString()));
        ch.stderr.resume();
        ch.on('close', () => resolve(out.trim()));
      });
    });
    client.end();
    expect(running).toBe('');
    expect(lastAudit()).toMatchObject({ method: 'tar', aborted: true });
  }, 60_000);
});
