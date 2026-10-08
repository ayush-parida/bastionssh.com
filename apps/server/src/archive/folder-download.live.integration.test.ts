import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { Client, type SFTPWrapper } from 'ssh2';
import { and, eq } from 'drizzle-orm';

/**
 * Folder downloads from all three viewers against live, throwaway servers,
 * through the HTTP API as the browser calls it: each archive is extracted
 * with the system tar / unzip and every file compared by SHA-256. Each
 * block runs when its variables are set; start the containers on unusual
 * ports and remove them by name afterwards:
 *
 *   docker run -d --name smt-fdl-live-openssh -p 127.0.0.1:22922:2222 -e PUID=1000 -e PGID=1000 \
 *     -e USER_NAME=shelluser -e USER_PASSWORD=shellpass -e PASSWORD_ACCESS=true -e SUDO_ACCESS=true \
 *     linuxserver/openssh-server
 *   docker run -d --name smt-fdl-live-atmoz -p 127.0.0.1:22923:22 atmoz/sftp testuser:testpass:1001::upload
 *   docker run -d --name smt-fdl-live-ftp -p 127.0.0.1:22921:21 -p 127.0.0.1:47300-47310:47300-47310 \
 *     -e USERS='ftpuser|ftppass|/home/ftpuser' -e ADDRESS=127.0.0.1 -e MIN_PORT=47300 -e MAX_PORT=47310 \
 *     delfer/alpine-ftp-server
 *   docker run -d --name smt-fdl-live-s3 -p 127.0.0.1:28333:8333 -e AWS_ACCESS_KEY_ID=fdlliveaccesskey \
 *     -e AWS_SECRET_ACCESS_KEY=fdllivesecretkey0123456789abcd chrislusf/seaweedfs:<pinned in images.json> \
 *     server -ip=127.0.0.1 -ip.bind=127.0.0.1 -filer -s3 -s3.ip.bind=0.0.0.0 -master.telemetry=false
 *
 *   SMT_LIVE_SSH_PORT=22922 SMT_LIVE_SFTPONLY_PORT=22923 SMT_LIVE_SFTPONLY_CONTAINER=smt-fdl-live-atmoz \
 *   SMT_LIVE_FTP_PORT=22921 SMT_LIVE_S3_ENDPOINT=http://127.0.0.1:28333 \
 *   SMT_LIVE_S3_ACCESS_KEY=fdlliveaccesskey SMT_LIVE_S3_SECRET_KEY=fdllivesecretkey0123456789abcd \
 *     pnpm vitest run src/archive/folder-download.live.integration.test.ts
 *
 *   docker rm -f -v smt-fdl-live-openssh smt-fdl-live-atmoz smt-fdl-live-ftp smt-fdl-live-s3   # -v: their anonymous volumes too
 *
 * SMT_LIVE_BIG_MB (default 200) sizes the large file. The limits block cuts
 * the limits down for its requests, or uses SMT_FOLDER_DOWNLOAD_MAX_BYTES /
 * _FILES as given when they are set.
 */

const HOST = '127.0.0.1';
const sshPort = Number(process.env.SMT_LIVE_SSH_PORT) || 0;
const sftpOnlyPort = Number(process.env.SMT_LIVE_SFTPONLY_PORT) || 0;
const sftpOnlyContainer = process.env.SMT_LIVE_SFTPONLY_CONTAINER;
const ftpPort = Number(process.env.SMT_LIVE_FTP_PORT) || 0;
const s3Endpoint = process.env.SMT_LIVE_S3_ENDPOINT;
const BIG = (Number(process.env.SMT_LIVE_BIG_MB) || 200) * 1024 * 1024;
const SMALL_FILES = 2000;
const anyLive = !!(sshPort || sftpOnlyPort || ftpPort || s3Endpoint);

const shellAccount = { username: 'shelluser', password: 'shellpass' };
const sftpAccount = { username: 'testuser', password: 'testpass' };

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { auditLog } = await import('../db/schema.js');
const { config } = await import('../config/index.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { createClient } = await import('../storage/client.js');
const ops = await import('../storage/ops.js');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tag = `fdl-live-${Date.now().toString(36)}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-fdl-live-'));

let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let admin: ReturnType<typeof seedUser>;
let apiPort = 0;
/** What each download reported, for the summary at the end. */
const report: string[] = [];

// ---- helpers ---------------------------------------------------------------

function sshConnect(port: number, account: { username: string; password: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({ host: HOST, port, ...account, hostVerifier: () => true, readyTimeout: 30_000 });
  });
}

function sshExec(client: Client, command: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, ch) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      ch.on('data', (d: Buffer) => (out += d.toString()));
      ch.stderr.on('data', (d: Buffer) => (errOut += d.toString()));
      ch.on('close', (code: number) => resolve({ code, out, err: errOut }));
      if (stdin !== undefined) ch.end(stdin);
    });
  });
}

const sftpOf = (client: Client) =>
  new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))));
const call = <T = void>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));

/** Every regular file (→ SHA-256) and link (→ `-> target`) under `dir`; empty folders as `name/`. */
function snapshot(dir: string, rel = ''): Map<string, string> {
  const out = new Map<string, string>();
  const names = fs.readdirSync(path.join(dir, rel));
  if (rel && names.length === 0) out.set(`${rel.normalize('NFC')}/`, 'dir');
  for (const name of names) {
    const p = rel ? `${rel}/${name}` : name;
    // macOS tar writes PAX (UTF-8) names out decomposed
    const key = p.normalize('NFC');
    const st = fs.lstatSync(path.join(dir, p));
    if (st.isSymbolicLink()) out.set(key, `-> ${fs.readlinkSync(path.join(dir, p))}`);
    else if (st.isDirectory()) for (const [k, v] of snapshot(dir, p)) out.set(k, v);
    else out.set(key, sha(fs.readFileSync(path.join(dir, p))));
  }
  return out;
}

/** A local tree: one big file, SMALL_FILES small ones over 20 folders, unicode names, an empty folder. */
function buildLocalTree(root: string): Map<string, string> {
  fs.mkdirSync(root, { recursive: true });
  const big = path.join(root, 'big.bin');
  const fd = fs.openSync(big, 'w');
  for (let left = BIG; left > 0; left -= 8 * 1024 * 1024) fs.writeSync(fd, randomBytes(Math.min(left, 8 * 1024 * 1024)));
  fs.closeSync(fd);
  for (let i = 0; i < SMALL_FILES; i++) {
    const d = path.join(root, 'many', `d${Math.floor(i / 100)}`);
    if (i % 100 === 0) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `f${i}.txt`), randomBytes(i % 500));
  }
  fs.mkdirSync(path.join(root, 'ünïcødé ✓', '日本語'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ünïcødé ✓', '日本語', 'ファイル 🌞.txt'), 'unicode\n');
  fs.writeFileSync(path.join(root, 'ünïcødé ✓', 'naïve.txt'), 'naïve\n');
  fs.mkdirSync(path.join(root, 'empty dir'));
  fs.writeFileSync(path.join(root, 'zero.txt'), '');
  return snapshot(root);
}

interface Downloaded {
  dir: string;
  got: Map<string, string>;
  skippedNote: string | null;
  truncatedNote: string | null;
  summary: string;
  bytes: number;
  ms: number;
}

/** GET an archive through the API, extract it with the system tools, and snapshot it (notes taken out). */
async function download(url: string, format: 'zip' | 'tar.gz', label: string): Promise<Downloaded> {
  const started = Date.now();
  const res = await app.inject({ method: 'GET', url, headers: admin.headers });
  const ms = Date.now() - started;
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const file = path.join(work, `${label.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2)}.${format}`);
  fs.writeFileSync(file, res.rawPayload);
  const dir = `${file}.d`;
  fs.mkdirSync(dir);
  if (format === 'zip') {
    execFileSync('unzip', ['-tq', file]);
    execFileSync('unzip', ['-q', file, '-d', dir]);
  } else {
    execFileSync('tar', ['-xzf', file, '-C', dir]);
  }
  const read = (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null);
  const skippedNote = read('_skipped.txt');
  const truncatedNote = read('_TRUNCATED.txt');
  const got = snapshot(dir);
  got.delete('_skipped.txt');
  got.delete('_TRUNCATED.txt');
  const summary = String(res.trailers['x-archive-summary'] ?? '');
  const files = [...got.values()].filter((v) => v !== 'dir').length;
  report.push(`${label}: ${files} entries, ${res.rawPayload.length} archive bytes in ${ms} ms [${summary}]`);
  fs.rmSync(file);
  return { dir, got, skippedNote, truncatedNote, summary, bytes: res.rawPayload.length, ms };
}

/** The newest audit entry for `action` that matches `want`, waiting for it (a cancelled download is audited once it has wound down). */
async function auditEventually(action: string, want: Record<string, unknown>, ms = 15_000): Promise<Record<string, unknown>> {
  const until = Date.now() + ms;
  let last = lastAudit(action);
  while (!Object.entries(want).every(([k, v]) => last[k] === v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    last = lastAudit(action);
  }
  return last;
}

function lastAudit(action: string): Record<string, unknown> {
  const row = getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)))
    .all()
    .at(-1);
  return JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
}

/**
 * Start a download over real HTTP and drop the connection once `afterBytes`
 * have arrived (the browser's Cancel).
 */
async function cancelAfter(url: string, afterBytes: number): Promise<number> {
  let got = 0;
  await new Promise<void>((resolve) => {
    const req = http.get({ host: HOST, port: apiPort, path: url, headers: admin.headers }, (res) => {
      res.on('data', (c: Buffer) => {
        got += c.length;
        if (got > afterBytes) req.destroy();
      });
      res.on('close', () => resolve());
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
  });
  return got;
}

/** Poll `probe` until it returns '' (nothing left running / open), or give up after `ms`. */
async function settles(probe: () => Promise<string>, ms = 10_000): Promise<string> {
  const until = Date.now() + ms;
  let last = await probe();
  while (last !== '' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300));
    last = await probe();
  }
  return last;
}

async function addServer(name: string, port: number, account: { username: string; password: string }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: admin.headers,
    payload: { name, host: HOST, port, username: account.username, authType: 'password', password: account.password, dockerMode: 'off' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const filesUrl = (serverId: string, folder: string, format: string) =>
  `/api/sftp/${serverId}/folder?path=${encodeURIComponent(folder)}&format=${format}`;

// ---- setup -----------------------------------------------------------------

beforeAll(async () => {
  if (!anyLive) return;
  await runMigrations();
  orgId = seedOrg('fdl-live');
  admin = seedUser(orgId, 'admin');
  app = await buildApp();
  await app.listen({ port: 0, host: HOST });
  apiPort = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(work, { recursive: true, force: true });
  if (report.length) console.log(`\nfolder download live report:\n  ${report.join('\n  ')}`);
});

// ---- (1) a shell account: tar fast path and the engine ---------------------

describe.skipIf(!sshPort)('Servers → Files, an account with a shell (openssh-server)', () => {
  let client: Client;
  let serverId: string;
  const root = `/config/${tag}`;
  const expected = new Map<string, string>();

  beforeAll(async () => {
    client = await sshConnect(sshPort, shellAccount);
    const script = `set -e
R='${root}'
mkdir -p "$R/many" "$R/ünïcødé ✓/日本語" "$R/empty dir"
head -c ${BIG} /dev/urandom > "$R/big.bin"
printf 'unicode\\n' > "$R/ünïcødé ✓/日本語/ファイル 🌞.txt"
: > "$R/zero.txt"
i=0
while [ $i -lt ${SMALL_FILES} ]; do
  d="$R/many/d$((i / 100))"; [ -d "$d" ] || mkdir "$d"
  head -c $((i % 500)) /dev/urandom > "$d/f$i.txt"; i=$((i + 1))
done
ln -s /etc/passwd "$R/outside-link"
ln -s .. "$R/many/up"
`;
    const made = await sshExec(client, 'sh -s', script);
    expect(made.code, made.err).toBe(0);
    // A file this account cannot read: another owner's, mode 0600
    const sudo = await sshExec(
      client,
      `sudo -S -p '' sh -c "echo root-only > '${root}/root-only.txt' && chown root:root '${root}/root-only.txt' && chmod 600 '${root}/root-only.txt'"`,
      `${shellAccount.password}\n`,
    );
    expect(sudo.code, sudo.err).toBe(0);
    const sums = await sshExec(client, `cd '${root}' && find . -type f ! -name root-only.txt -exec sha256sum {} +`);
    expect(sums.code, sums.err).toBe(0);
    for (const line of sums.out.trim().split('\n')) {
      const [hash, rel] = [line.slice(0, 64), line.slice(66).replace(/^\.\//, '')];
      expected.set(rel.normalize('NFC'), hash);
    }
    expected.set('empty dir/', 'dir');
    expect(expected.size).toBe(SMALL_FILES + 4);
    serverId = await addServer('live-openssh', sshPort, shellAccount);
  }, 300_000);

  afterAll(async () => {
    if (!client) return;
    await sshExec(client, `echo '${shellAccount.password}' | sudo -S -p '' rm -rf '${root}'`);
    client.end();
  }, 120_000);

  const links = new Map([
    ['outside-link', '-> /etc/passwd'],
    ['many/up', '-> ..'],
  ]);

  it('tar.gz (tar on the server): every byte, links kept as links, the unreadable file listed', async () => {
    const d = await download(filesUrl(serverId, root, 'tar.gz'), 'tar.gz', 'openssh shell tar.gz (fast path)');
    expect(d.got).toEqual(new Map([...expected, ...links]));
    expect(fs.lstatSync(path.join(d.dir, 'outside-link')).isSymbolicLink()).toBe(true);
    expect(d.skippedNote).toMatch(/root-only\.txt.*Permission denied/);
    report.push(`  tar.gz _skipped.txt: ${JSON.stringify(d.skippedNote)}`);
    expect(d.truncatedNote).toBeNull();
    expect(lastAudit('sftp.folder_download')).toMatchObject({ method: 'tar', format: 'tar.gz', truncated: false });
  }, 600_000);

  it('zip (the engine over SFTP): every byte, links left out and noted, the unreadable file listed', async () => {
    const d = await download(filesUrl(serverId, root, 'zip'), 'zip', 'openssh shell zip (engine)');
    expect(d.got).toEqual(expected);
    expect(d.skippedNote).toMatch(/root-only\.txt.*(Permission denied|denied)/i);
    expect(d.skippedNote).toMatch(/outside-link\tsymbolic link/);
    expect(lastAudit('sftp.folder_download')).toMatchObject({
      method: 'sftp',
      format: 'zip',
      files: SMALL_FILES + 3,
      skipped: 3,
      truncated: false,
    });
  }, 600_000);

  /** Processes of this account still running tar / gzip, and any open descriptor into the tree. */
  const leftovers = async () => {
    const r = await sshExec(
      client,
      `ps -o pid,user,args | grep -E '[t]ar -czf - -C' ; for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null; done | grep -F '${tag}' || true`,
    );
    return r.out.trim();
  };

  it('cancelled mid-way (tar.gz): the remote tar and every handle into the folder are gone', async () => {
    const got = await cancelAfter(filesUrl(serverId, root, 'tar.gz'), 4 * 1024 * 1024);
    expect(got).toBeGreaterThan(4 * 1024 * 1024);
    expect(await settles(leftovers)).toBe('');
    expect(await auditEventually('sftp.folder_download', { method: 'tar', aborted: true })).toMatchObject({ method: 'tar', aborted: true });
    report.push(`openssh tar.gz cancelled after ${got} bytes: no tar, no open handles`);
  }, 120_000);

  it('cancelled mid-way (zip): no SFTP handle into the folder stays open', async () => {
    const got = await cancelAfter(filesUrl(serverId, root, 'zip'), 4 * 1024 * 1024);
    expect(got).toBeGreaterThan(4 * 1024 * 1024);
    expect(await settles(leftovers)).toBe('');
    expect(await auditEventually('sftp.folder_download', { method: 'sftp', aborted: true })).toMatchObject({ method: 'sftp', aborted: true });
    report.push(`openssh zip cancelled after ${got} bytes: no open SFTP handles`);
  }, 120_000);

  // ---- (5) limits ----

  describe('limits', () => {
    const fromEnv = !!(process.env.SMT_FOLDER_DOWNLOAD_MAX_BYTES || process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES);
    const saved = { ...config.folderDownload };
    beforeAll(() => {
      if (!fromEnv) Object.assign(config.folderDownload, { maxFiles: 150, maxBytes: 8 * 1024 * 1024 });
    });
    afterAll(() => {
      Object.assign(config.folderDownload, saved);
    });

    for (const format of ['tar.gz', 'zip'] as const) {
      it(`${format}: stops at the limit and says so in _TRUNCATED.txt`, async () => {
        const { maxFiles, maxBytes } = config.folderDownload;
        const d = await download(
          filesUrl(serverId, `${root}/many`, format),
          format,
          `limits (${maxFiles} files / ${maxBytes} bytes) openssh ${format}`,
        );
        expect(d.truncatedNote).toMatch(/limit/i);
        expect(d.summary).toMatch(/truncated=true/);
        const files = [...d.got.values()].filter((v) => !v.startsWith('-> ') && v !== 'dir').length;
        expect(files).toBeLessThanOrEqual(maxFiles);
        expect(lastAudit('sftp.folder_download')).toMatchObject({ format, truncated: true });
      }, 300_000);

      it(`${format}: stops at the byte limit`, async () => {
        const { maxBytes } = config.folderDownload;
        const d = await download(filesUrl(serverId, root, format), format, `byte limit (${maxBytes} bytes) openssh ${format}`);
        expect(d.truncatedNote).toMatch(/limit/i);
        const bytes = [...fs.readdirSync(d.dir, { recursive: true, encoding: 'utf8' })]
          .map((rel) => fs.lstatSync(path.join(d.dir, rel)))
          .filter((st) => st.isFile())
          .reduce((n, st) => n + st.size, 0);
        // The notes are small; every file kept fits under the limit
        expect(bytes).toBeLessThanOrEqual(maxBytes + 64 * 1024);
        if (BIG > maxBytes) expect(d.got.has('big.bin')).toBe(false);
        expect(lastAudit('sftp.folder_download')).toMatchObject({ format, truncated: true });
      }, 300_000);
    }
  });
});

// ---- (2) an SFTP-only account: managed server (fallback) and SFTP connection ----

describe.skipIf(!sftpOnlyPort)('an SFTP-only account (atmoz/sftp)', () => {
  let client: Client;
  let sftp: SFTPWrapper;
  const root = `/upload/${tag}`;
  let expected: Map<string, string>;
  let serverId: string;
  let connectionId: string;

  beforeAll(async () => {
    const local = path.join(work, 'sftp-tree');
    expected = buildLocalTree(local);
    client = await sshConnect(sftpOnlyPort, sftpAccount);
    sftp = await sftpOf(client);
    // Upload the tree, folders first, a few files at a time
    const dirs: string[] = [];
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const d of fs.readdirSync(path.join(local, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          dirs.push(r);
          walk(r);
        } else files.push(r);
      }
    };
    walk('');
    await call((cb) => sftp.mkdir(root, cb));
    for (const d of dirs) await call((cb) => sftp.mkdir(`${root}/${d}`, cb));
    await call((cb) => sftp.fastPut(path.join(local, 'big.bin'), `${root}/big.bin`, cb));
    const small = files.filter((f) => f !== 'big.bin');
    for (let i = 0; i < small.length; i += 32) {
      await Promise.all(
        small.slice(i, i + 32).map((f) => call((cb) => sftp.writeFile(`${root}/${f}`, fs.readFileSync(path.join(local, f)), cb))),
      );
    }
    // Links out of the folder (and out of any jail): kept as links, never followed
    await call((cb) => sftp.symlink('/etc/passwd', `${root}/outside-link`, cb));
    await call((cb) => sftp.symlink('/', `${root}/escape`, cb));
    // Unreadable to its own (non-root) owner
    await call((cb) => sftp.writeFile(`${root}/secret.txt`, Buffer.from('nope'), cb));
    await call((cb) => sftp.chmod(`${root}/secret.txt`, 0o000, cb));
    fs.rmSync(local, { recursive: true, force: true });

    serverId = await addServer('live-sftp-only', sftpOnlyPort, sftpAccount);
    const created = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: {
        name: 'live-sftp-jail',
        protocol: 'sftp',
        host: HOST,
        port: sftpOnlyPort,
        username: sftpAccount.username,
        password: sftpAccount.password,
        rootPath: root,
        restrictToRoot: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    connectionId = (created.json() as { id: string }).id;
  }, 600_000);

  afterAll(async () => {
    if (!client) return;
    // No shell: remove what was uploaded over SFTP
    const rmTree = async (dir: string): Promise<void> => {
      const rows = await call<{ filename: string; attrs: { isDirectory(): boolean } }[]>((cb) => sftp.readdir(dir, cb)).catch(() => []);
      for (const row of rows) {
        const p = `${dir}/${row.filename}`;
        if (row.attrs.isDirectory()) await rmTree(p);
        else await call((cb) => sftp.unlink(p, cb)).catch(() => {});
      }
      await call((cb) => sftp.rmdir(dir, cb)).catch(() => {});
    };
    await rmTree(root);
    client.end();
  }, 300_000);

  const links = new Map([
    ['outside-link', '-> /etc/passwd'],
    ['escape', '-> /'],
  ]);

  /** Open descriptors into the tree inside the container (no shell for the account itself). */
  const openHandles = async () => {
    if (!sftpOnlyContainer) return '';
    const out = execFileSync('docker', ['exec', sftpOnlyContainer, 'sh', '-c', `for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null; done | grep -F '${tag}' || true`]);
    return out.toString().trim();
  };

  for (const format of ['tar.gz', 'zip'] as const) {
    it(`managed server, ${format}: no shell, so the engine over SFTP; every byte`, async () => {
      const d = await download(filesUrl(serverId, root, format), format, `sftp-only server ${format} (fallback)`);
      expect(d.got).toEqual(format === 'tar.gz' ? new Map([...expected, ...links]) : expected);
      expect(d.skippedNote).toMatch(/secret\.txt/);
      if (format === 'tar.gz') expect(fs.readlinkSync(path.join(d.dir, 'escape'))).toBe('/');
      expect(lastAudit('sftp.folder_download')).toMatchObject({ method: 'sftp', format, truncated: false });
    }, 600_000);
  }

  for (const format of ['tar.gz', 'zip'] as const) {
    it(`SFTP connection with a root jail, ${format}: every byte, links stored not followed`, async () => {
      const d = await download(
        `/api/ftp/connections/${connectionId}/folder?path=${encodeURIComponent(root)}&format=${format}`,
        format,
        `sftp connection (jailed) ${format}`,
      );
      expect(d.got).toEqual(format === 'tar.gz' ? new Map([...expected, ...links]) : expected);
      expect(d.skippedNote).toMatch(/secret\.txt/);
      expect(d.summary).toMatch(/truncated=false/);
      expect(lastAudit('ftp.folder_download')).toMatchObject({ format, truncated: false });
    }, 600_000);
  }

  it('refuses every way out of the jail', async () => {
    for (const escape of ['/upload', '/', `${root}/..`, `${root}/../..`, `${root}/escape`, `${root}/escape/upload`, '../', '/etc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/ftp/connections/${connectionId}/folder?path=${encodeURIComponent(escape)}&format=zip`,
        headers: admin.headers,
      });
      expect(res.statusCode, `${escape}: ${res.body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect(res.headers['content-type']).toMatch(/json/);
    }
    report.push('sftp jail: 8 escape attempts refused');
  });

  it('cancelled mid-way: the SFTP handles are closed', async () => {
    const got = await cancelAfter(filesUrl(serverId, root, 'zip'), 4 * 1024 * 1024);
    expect(got).toBeGreaterThan(4 * 1024 * 1024);
    expect(await settles(openHandles)).toBe('');
    const started = Date.now();
    const audited = await auditEventually('sftp.folder_download', { aborted: true }, 60_000);
    report.push(`sftp-only server cancel audited after ${Date.now() - started} ms: ${JSON.stringify(audited)}`);
    expect(audited).toMatchObject({ aborted: true });
    const viaConnection = await cancelAfter(
      `/api/ftp/connections/${connectionId}/folder?path=${encodeURIComponent(root)}&format=zip`,
      4 * 1024 * 1024,
    );
    expect(viaConnection).toBeGreaterThan(4 * 1024 * 1024);
    expect(await settles(openHandles)).toBe('');
    expect(await auditEventually('ftp.folder_download', { aborted: true })).toMatchObject({ aborted: true });
    report.push(`sftp-only cancelled (server and connection): no open handles${sftpOnlyContainer ? '' : ' (not checked: no container name)'}`);
  }, 120_000);
});

// ---- (3) FTP ---------------------------------------------------------------

describe.skipIf(!ftpPort)('an FTP connection (vsftpd)', () => {
  const remote = `/home/ftpuser/${tag}`;
  let expected: Map<string, string>;
  let connectionId: string;
  const ftpLogin = { host: HOST, port: ftpPort, user: 'ftpuser', password: 'ftppass' };

  beforeAll(async () => {
    const local = path.join(work, 'ftp-tree');
    expected = buildLocalTree(local);
    const ftp = new FtpClient(60_000);
    await ftp.access(ftpLogin);
    await ftp.ensureDir(remote);
    await ftp.uploadFromDir(local);
    // uploadFromDir skips empty folders
    await ftp.ensureDir(`${remote}/empty dir`);
    ftp.close();
    fs.rmSync(local, { recursive: true, force: true });
    const created = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: { name: 'live-ftp', protocol: 'ftp', host: HOST, port: ftpPort, username: 'ftpuser', password: 'ftppass' },
    });
    expect(created.statusCode, created.body).toBe(201);
    connectionId = (created.json() as { id: string }).id;
  }, 600_000);

  afterAll(async () => {
    const ftp = new FtpClient(60_000);
    try {
      await ftp.access(ftpLogin);
      await ftp.removeDir(remote);
    } catch {
      /* gone */
    }
    ftp.close();
  }, 300_000);

  for (const format of ['zip', 'tar.gz'] as const) {
    it(`${format}: every byte`, async () => {
      const d = await download(
        `/api/ftp/connections/${connectionId}/folder?path=${encodeURIComponent(remote)}&format=${format}`,
        format,
        `ftp ${format}`,
      );
      expect(d.got).toEqual(expected);
      expect(d.skippedNote).toBeNull();
      expect(d.summary).toMatch(new RegExp(`files=${expected.size - 1}; .*skipped=0; truncated=false`));
    }, 600_000);
  }
});

// ---- (4) S3 (SeaweedFS) ----------------------------------------------------

describe.skipIf(!s3Endpoint)('an Object Storage connection (SeaweedFS S3)', () => {
  const accessKeyId = process.env.SMT_LIVE_S3_ACCESS_KEY ?? '';
  const secret = process.env.SMT_LIVE_S3_SECRET_KEY ?? '';
  const client = createClient(
    { provider: 'other', endpoint: s3Endpoint ?? null, region: 'us-east-1', accessKeyId, forcePathStyle: true },
    secret,
  );
  const bucket = `smt-${tag}`;
  const expected = new Map<string, string>();
  let totalBytes = 0;
  let connectionId: string;
  const prefixes = ['alpha', 'beta', 'données', '日本語', 'emoji 🌞', 'ñandú', 'with space', 'z'];

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/storage/connections',
      headers: admin.headers,
      payload: { name: 'live-seaweedfs', provider: 'other', endpoint: s3Endpoint, accessKeyId, secretAccessKey: secret, forcePathStyle: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    connectionId = (created.json() as { id: string }).id;
    const bucketRes = await app.inject({
      method: 'POST',
      url: `/api/storage/connections/${connectionId}/buckets`,
      headers: admin.headers,
      payload: { name: bucket },
    });
    expect(bucketRes.statusCode, bucketRes.body).toBeLessThan(300);

    const keys: [string, Buffer][] = [];
    for (let i = 0; i < 3000; i++) {
      const p = prefixes[i % prefixes.length];
      keys.push([`data/${p}/sub${Math.floor(i / 300)}/obj ${i}.txt`, randomBytes(i % 700)]);
    }
    keys.push(['data/big.bin', randomBytes(20 * 1024 * 1024)]);
    for (let i = 0; i < keys.length; i += 64) {
      await Promise.all(
        keys.slice(i, i + 64).map(async ([key, body]) => {
          await ops.putObject(client, bucket, key, Readable.from([body]));
          expected.set(key.slice('data/'.length), sha(body));
          totalBytes += body.length;
        }),
      );
    }
    await ops.createFolder(client, bucket, 'data/empty/');
    expected.set('empty/', 'dir');
    await ops.putObject(client, bucket, 'outside.txt', Readable.from([Buffer.from('not under data/')]));
  }, 600_000);

  afterAll(async () => {
    try {
      await ops.deletePrefix(client, bucket, '');
      await ops.deleteBucket(client, bucket);
    } catch {
      /* gone */
    }
    client.destroy();
  }, 300_000);

  it('estimates the prefix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/storage/connections/${connectionId}/buckets/${bucket}/folder/estimate?prefix=data/`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ files: 3001, bytes: totalBytes, complete: true });
    report.push(`s3 estimate: ${JSON.stringify(res.json())}`);
  }, 120_000);

  for (const format of ['zip', 'tar.gz'] as const) {
    it(`${format}: 3 001 objects, unicode keys, every byte`, async () => {
      const d = await download(
        `/api/storage/connections/${connectionId}/buckets/${bucket}/folder?prefix=data/&format=${format}`,
        format,
        `s3 ${format}`,
      );
      expect(d.got).toEqual(expected);
      expect(d.skippedNote).toBeNull();
      expect(d.summary).toMatch(/files=3001; .*truncated=false/);
      expect(lastAudit('storage.folder_download')).toMatchObject({ format, truncated: false });
    }, 600_000);
  }

  it('limits: stops at the file limit with _TRUNCATED.txt', async () => {
    const saved = { ...config.folderDownload };
    const fromEnv = !!(process.env.SMT_FOLDER_DOWNLOAD_MAX_BYTES || process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES);
    if (!fromEnv) Object.assign(config.folderDownload, { maxFiles: 250, maxBytes: 1024 ** 3 });
    try {
      const d = await download(
        `/api/storage/connections/${connectionId}/buckets/${bucket}/folder?prefix=data/&format=zip`,
        'zip',
        `limits (${config.folderDownload.maxFiles} files / ${config.folderDownload.maxBytes} bytes) s3 zip`,
      );
      expect(d.truncatedNote).toMatch(/limit/i);
      expect(d.summary).toMatch(/truncated=true/);
      expect([...d.got.values()].filter((v) => v !== 'dir').length).toBeLessThanOrEqual(config.folderDownload.maxFiles);
    } finally {
      Object.assign(config.folderDownload, saved);
    }
  }, 300_000);
});
