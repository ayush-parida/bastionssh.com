import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { and, eq } from 'drizzle-orm';

/**
 * GET /api/sftp/:serverId/folder. ssh2 is the in-memory fake (SFTP over
 * `state.fs`); its `exec` runs the command in a real local /bin/sh, so the
 * tar fast path is exercised with the system's own tar against a real
 * temporary folder that `state.fs` mirrors. Routes, pool, access engine, DB
 * and audit are real.
 */

vi.hoisted(() => {
  process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES = '40';
  process.env.SMT_FOLDER_DOWNLOAD_MAX_BYTES = String(24 * 1024 * 1024);
});

vi.mock('ssh2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ssh2')>()),
  ...(await import('../../ftp/fake-ssh2.test-helper.js')).fakeSsh2(),
}));

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as import('../../ftp/fake-ssh2.test-helper.js').FakeSsh2State;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog, servers } = await import('../../db/schema.js');
const { vault } = await import('../../vault/index.js');
const { seedOrg, seedServer, seedUser } = await import('./test-utils.js');
const { evictUser } = await import('../../ssh/sftp.js');
const { tarCommand } = await import('../../ssh/folder-download.js');
const { MAX_STREAMS_PER_USER, activeStreamCount, reserveStream } = await import('../sse.js');
const { readZip } = await import('../../archive/archive.test-helper.js');

const KEY = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');

// ── The fake server's shell ──

type ShellMode = 'shell' | 'sftp-only' | 'refused';
const shell = { mode: 'shell' as ShellMode, commands: [] as string[], children: [] as ChildProcess[] };
/** Where the local shell runs, so a command that escaped its quoting would leave a file here. */
let sandbox: string;

/** A channel running `command` in a local /bin/sh, shaped like ssh2's ClientChannel. */
function localChannel(command: string) {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: sandbox,
    // macOS tar would otherwise add ._ AppleDouble members for extended attributes
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  shell.children.push(child);
  child.stdin.on('error', () => {});
  // Readable side: the command's stdout; writable side: its stdin
  const channel: any = new Duplex({
    emitClose: false,
    read() {
      child.stdout.resume();
    },
    write(chunk, _enc, cb) {
      child.stdin.write(chunk, () => cb());
    },
    final(cb) {
      child.stdin.end();
      cb();
    },
  });
  child.stdout.on('data', (d: Buffer) => {
    if (!channel.push(d)) child.stdout.pause();
  });
  child.stdout.on('end', () => channel.push(null));
  channel.stderr = child.stderr;
  channel.signal = (name: string) => child.kill(`SIG${name}` as NodeJS.Signals);
  channel.close = () => child.kill('SIGKILL');
  child.on('close', (code) => {
    channel.emit('exit', code);
    setImmediate(() => channel.emit('close'));
  });
  return channel;
}

/** `ForceCommand internal-sftp`: whatever is asked, an sftp-server that waits for a client, never printing. */
function sftpOnlyChannel() {
  const channel: any = new Duplex({
    emitClose: false,
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
    final(cb) {
      cb();
      this.push(null);
      this.emit('exit', 0);
      setImmediate(() => this.emit('close'));
    },
  });
  channel.stderr = new PassThrough();
  channel.stderr.end();
  channel.signal = () => {};
  channel.close = () => channel.end();
  return channel;
}

ssh2.Client.prototype.exec = function (command: string, cb: (err: Error | undefined, channel?: unknown) => void) {
  shell.commands.push(command);
  setImmediate(() => {
    if (shell.mode === 'refused') cb(new Error('Unable to exec'));
    else cb(undefined, shell.mode === 'sftp-only' ? sftpOnlyChannel() : localChannel(command));
  });
  return this;
};

// ── A real folder, mirrored into the fake SFTP server ──

type Spec = { [name: string]: string | Buffer | Spec | { link: string } | { mode: number; data: string } };

function mirror(dir: string) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    state.fs.set(dir, { type: 'link', target: fs.readlinkSync(dir) });
  } else if (st.isDirectory()) {
    state.fs.set(dir, { type: 'dir', mode: st.mode & 0o7777 });
    for (const name of fs.readdirSync(dir)) mirror(path.join(dir, name));
  } else {
    state.fs.set(dir, { type: 'file', data: fs.readFileSync(dir), mode: st.mode & 0o7777 });
  }
}

function build(dir: string, spec: Spec) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, node] of Object.entries(spec)) {
    const p = path.join(dir, name);
    if (typeof node === 'string' || Buffer.isBuffer(node)) fs.writeFileSync(p, node);
    else if ('link' in node && typeof node.link === 'string') fs.symlinkSync(node.link, p);
    else if ('mode' in node && typeof node.mode === 'number') {
      fs.writeFileSync(p, node.data as string);
      fs.chmodSync(p, node.mode);
    } else build(p, node as Spec);
  }
}

let tmp: string;
/** A fresh folder under the temp root, on disk and on the fake server. */
function folder(name: string, spec: Spec): string {
  const dir = path.join(tmp, name);
  build(dir, spec);
  for (let p = tmp; ; p = path.dirname(p)) {
    if (!state.fs.has(p)) state.fs.set(p, { type: 'dir' });
    if (p === path.dirname(p)) break;
  }
  mirror(dir);
  return dir;
}

// ── Reading what came back ──

interface TarMember {
  name: string;
  type: string;
  mode: number;
  data: Buffer;
}

/** A small reader for whatever tar dialect the system tar wrote (GNU long names, PAX paths). */
function tarMembers(gz: Buffer): TarMember[] {
  const buf = zlib.gunzipSync(gz);
  const str = (b: Buffer) => b.subarray(0, b.indexOf(0) === -1 ? b.length : b.indexOf(0)).toString('utf8');
  const out: TarMember[] = [];
  let long: string | undefined;
  let p = 0;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const data = buf.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      long = str(data);
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) long = m[1];
      continue;
    }
    let name = long ?? str(h.subarray(0, 100));
    long = undefined;
    if (h.subarray(257, 263).toString('latin1') === 'ustar\0' && str(h.subarray(345, 500))) {
      name = `${str(h.subarray(345, 500))}/${name}`;
    }
    out.push({ name: name.replace(/^\.\//, ''), type, mode: parseInt(str(h.subarray(100, 108)).trim(), 8), data: Buffer.from(data) });
  }
  return out;
}

const fileNames = (members: { name: string; type: string }[]) =>
  members.filter((m) => m.type !== '5').map((m) => m.name).sort();

describe('GET /api/sftp/:serverId/folder', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let serverId: string;

  const url = (p: string, format?: string) =>
    `/api/sftp/${serverId}/folder?path=${encodeURIComponent(p)}${format ? `&format=${encodeURIComponent(format)}` : ''}`;
  const get = (who: { headers: Record<string, string> }, u: string) => app.inject({ method: 'GET', url: u, headers: who.headers });

  /** The folder_download audit rows, oldest first (written once the archive has ended). */
  async function audits(count: number) {
    let rows: (typeof auditLog.$inferSelect)[] = [];
    for (let i = 0; i < 200; i++) {
      rows = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'sftp.folder_download')))
        .all();
      if (rows.length >= count) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return rows.map((r) => ({ ...r, meta: JSON.parse(r.metadata ?? '{}') as Record<string, any> }));
  }

  beforeAll(async () => {
    await runMigrations();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'smt-folder-dl-')));
    sandbox = path.join(tmp, '_sandbox');
    fs.mkdirSync(sandbox);
    orgId = seedOrg('org-folder-dl');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-folder-dl-other'), 'admin');
    serverId = seedServer(orgId, admin.userId, 'files-1');
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', serverId) })
      .where(eq(servers.id, serverId))
      .run();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.reset();
    state.presented = KEY;
    shell.mode = 'shell';
    shell.commands.length = 0;
    getDb().delete(auditLog).where(eq(auditLog.orgId, orgId)).run();
  });

  afterEach(() => {
    // A fresh pooled connection (and shell probe) per test
    evictUser(admin.userId);
    expect(activeStreamCount(admin.userId)).toBe(0);
  });

  it('needs the same access as a single-file download', async () => {
    const dir = folder('perm', { 'a.txt': 'a' });
    for (const who of [viewer, outsider]) {
      const single = await get(who, `/api/sftp/${serverId}/download?path=${encodeURIComponent(`${dir}/a.txt`)}`);
      const whole = await get(who, url(dir));
      expect([403, 404]).toContain(whole.statusCode);
      expect(whole.statusCode).toBe(single.statusCode);
    }
    expect(await audits(0)).toEqual([]);
  });

  it('validates the path and format before anything streams', async () => {
    const dir = folder('validate', { 'a.txt': 'a' });
    const cases: [string, string | undefined, number, RegExp][] = [
      ['relative/dir', undefined, 400, /absolute/],
      [`${dir}/../validate`, undefined, 400, /\.\./],
      [`${dir}\0x`, undefined, 400, /null byte/],
      [`${dir}/a.txt`, undefined, 400, /Not a folder/],
      [`${dir}/missing`, undefined, 404, /./],
      [dir, 'rar', 400, /format/],
    ];
    for (const [p, format, status, error] of cases) {
      const res = await get(admin, url(p, format));
      expect(res.statusCode, p).toBe(status);
      expect(res.json().error).toMatch(error);
    }
    expect(shell.commands).toEqual([]);
    expect(await audits(0)).toEqual([]);
  });

  it('serves a zip through the engine over SFTP, without running anything on the server', async () => {
    const dir = folder('site', {
      'index.html': '<h1>hi</h1>',
      assets: { 'app.js': 'console.log(1)', 'empty': {} },
      current: { link: 'assets' },
    });
    const res = await get(admin, url(dir));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/filename="site\.zip"/);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['assets/', 'assets/app.js', 'assets/empty/', 'index.html', '_skipped.txt']);
    const skipped = zip.entries.find((e) => e.name === '_skipped.txt')!.data!.toString();
    expect(skipped).toMatch(/current\tsymbolic link/);
    expect(shell.commands).toEqual([]);
    const [row] = await audits(1);
    expect(row).toMatchObject({ resourceType: 'server', resourceId: serverId, resourceName: 'files-1' });
    expect(row!.meta).toMatchObject({ path: dir, format: 'zip', method: 'sftp', files: 2, bytes: 25, skipped: 1, truncated: false });
  });

  it('serves tar.gz with the server’s own tar when the account has a shell, probing the shell once', async () => {
    const dir = folder('app', {
      'README.md': 'read me',
      src: { 'main.ts': 'export {}', deep: { 'x.bin': randomBytes(70_000) } },
      latest: { link: 'src/main.ts' },
      'setuid.sh': { mode: 0o4755, data: '#!/bin/sh\n' },
    });
    for (let i = 0; i < 2; i++) {
      const res = await get(admin, url(dir, 'tar.gz'));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/gzip');
      expect(res.headers['content-disposition']).toMatch(/filename="app\.tar\.gz"/);
      expect(res.trailers['x-archive-summary']).toBe('files=5; bytes=70026; skipped=0; truncated=false');
      const members = tarMembers(res.rawPayload);
      // The folder's own ./ entry is left out; links stay links
      expect(members.map((m) => m.name)).not.toContain('');
      expect(fileNames(members)).toEqual(['README.md', 'latest', 'setuid.sh', 'src/deep/x.bin', 'src/main.ts']);
      expect(members.find((m) => m.name === 'latest')).toMatchObject({ type: '2' });
      expect(members.find((m) => m.name === 'src/deep/x.bin')!.data).toEqual(fs.readFileSync(`${dir}/src/deep/x.bin`));
      expect(members.find((m) => m.name === 'setuid.sh')!.mode & 0o7777).toBe(0o755);
      // And the system tar reads it
      const listed = execFileSync('tar', ['-tzf', '-'], { input: res.rawPayload }).toString();
      expect(listed).toMatch(/src\/deep\/x\.bin/);
    }
    const probes = shell.commands.filter((c) => c.startsWith('command -v'));
    expect(probes).toHaveLength(1);
    expect(shell.commands.filter((c) => c === tarCommand(dir))).toHaveLength(2);
    const rows = await audits(2);
    expect(rows[0]!.meta).toMatchObject({ path: dir, format: 'tar.gz', method: 'tar', files: 5, bytes: 70026, skipped: 0, truncated: false });
  });

  it('falls back to SFTP for a shell-less account, and when exec is refused', async () => {
    const dir = folder('nosh', { 'a.txt': 'alpha', sub: { 'b.txt': 'bravo' }, l: { link: 'a.txt' } });
    for (const mode of ['sftp-only', 'refused'] as const) {
      shell.mode = mode;
      shell.commands.length = 0;
      const res = await get(admin, url(dir, 'tar.gz'));
      expect(res.statusCode).toBe(200);
      const members = tarMembers(res.rawPayload);
      expect(fileNames(members)).toEqual(['a.txt', 'l', 'sub/b.txt']);
      expect(members.find((m) => m.name === 'l')).toMatchObject({ type: '2' });
      expect(shell.commands).toHaveLength(1);
      evictUser(admin.userId);
    }
    const rows = await audits(2);
    expect(rows.map((r) => r.meta.method)).toEqual(['sftp', 'sftp']);
  });

  it('quotes the folder path so no part of it reaches the shell as syntax', async () => {
    const hostile = `it's $(touch PWNED) \`touch PWNED2\`; touch PWNED3 && "x" -rf *`;
    const dir = folder(hostile, { 'inside.txt': 'safe' });
    const res = await get(admin, url(dir, 'tar.gz'));
    expect(res.statusCode).toBe(200);
    expect(shell.commands.at(-1)).toBe(tarCommand(dir));
    expect(fileNames(tarMembers(res.rawPayload))).toEqual(['inside.txt']);
    expect(fs.readdirSync(sandbox)).toEqual([]);
    expect(res.headers['content-disposition']).toMatch(/\.tar\.gz"; filename\*=UTF-8''it%27s%20%24%28touch%20PWNED%29/);
    // Same path with `-` and quotes at the start of a segment
    const dashed = folder('-C x', { 'f': '1' });
    expect(fileNames(tarMembers((await get(admin, url(dashed, 'tar.gz'))).rawPayload))).toEqual(['f']);
    // A backslash or newline is not literal inside single quotes in every login shell (fish, csh): SFTP instead
    for (const odd of ['back\\slash\\', 'new\nline']) {
      const sent = shell.commands.length;
      const res2 = await get(admin, url(folder(odd, { 'g': '2' }), 'tar.gz'));
      expect(res2.statusCode).toBe(200);
      expect(shell.commands.length).toBe(sent);
      expect(fileNames(tarMembers(res2.rawPayload))).toEqual(['g']);
    }
  });

  it.skipIf(process.getuid?.() === 0)('lists what tar could not read in _skipped.txt and the audit entry', async () => {
    const dir = folder('locked', { 'ok.txt': 'fine', 'secret.txt': 'hidden' });
    fs.chmodSync(`${dir}/secret.txt`, 0o000);
    try {
      const res = await get(admin, url(dir, 'tar.gz'));
      expect(res.statusCode).toBe(200);
      const members = tarMembers(res.rawPayload);
      expect(fileNames(members)).toEqual(['_skipped.txt', 'ok.txt']);
      const note = members.find((m) => m.name === '_skipped.txt')!.data.toString();
      expect(note).toMatch(/Reported by tar on the server/);
      expect(note).toMatch(/secret\.txt.*Permission denied/);
      const [row] = await audits(1);
      expect(row!.meta).toMatchObject({ method: 'tar', skipped: 1 });
      expect(row!.meta.tarMessages.join('\n')).toMatch(/secret\.txt.*Permission denied/);
    } finally {
      fs.chmodSync(`${dir}/secret.txt`, 0o644);
    }
  });

  it('stops at the file limit with _TRUNCATED.txt, both ways, and stops the remote tar', async () => {
    const many: Spec = {};
    for (let i = 0; i < 60; i++) many[`f${String(i).padStart(2, '0')}.txt`] = `file ${i}`;
    const dir = folder('many', many);
    for (const format of ['tar.gz', 'zip'] as const) {
      const res = await get(admin, url(dir, format));
      expect(res.statusCode).toBe(200);
      const names = format === 'zip' ? (await readZip(res.rawPayload)).entries.map((e) => e.name) : fileNames(tarMembers(res.rawPayload));
      expect(names).toHaveLength(41);
      expect(names).toContain('_TRUNCATED.txt');
      expect(res.trailers['x-archive-summary']).toMatch(/files=40; .*truncated=true/);
    }
    const rows = await audits(2);
    expect(rows.map((r) => [r.meta.method, r.meta.files, r.meta.truncated])).toEqual([
      ['tar', 40, true],
      ['sftp', 40, true],
    ]);
  });

  it('stops at the byte limit with _TRUNCATED.txt', async () => {
    const dir = folder('bytes', { 'a.bin': randomBytes(16 * 1024 * 1024), 'b.bin': randomBytes(16 * 1024 * 1024) });
    const res = await get(admin, url(dir, 'tar.gz'));
    const members = tarMembers(res.rawPayload);
    // tar walks in directory order, so either file may be the one that fits
    const names = fileNames(members);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('_TRUNCATED.txt');
    expect(members.find((m) => m.name === '_TRUNCATED.txt')!.data.toString()).toMatch(/SMT_FOLDER_DOWNLOAD_MAX_BYTES/);
    const [row] = await audits(1);
    expect(row!.meta).toMatchObject({ method: 'tar', files: 1, bytes: 16 * 1024 * 1024, truncated: true });
    // The remote tar was stopped rather than left to finish
    await new Promise((r) => setTimeout(r, 50));
    expect(shell.children.at(-1)!.exitCode === 0).toBe(false);
  });

  it('answers 429 at the per-user stream cap', async () => {
    const dir = folder('cap', { 'a.txt': 'a' });
    const fakeReq = { user: { id: admin.userId }, orgId } as Parameters<typeof reserveStream>[0];
    const held = Array.from({ length: MAX_STREAMS_PER_USER }, () => reserveStream(fakeReq, { feature: 'docker', resourceId: 'x' })!);
    try {
      for (const format of ['tar.gz', 'zip']) {
        const res = await get(admin, url(dir, format));
        expect(res.statusCode).toBe(429);
      }
    } finally {
      held.forEach((h) => h.release());
    }
  });

  it('cancels the remote work when the browser disconnects or access is revoked', async () => {
    const parts: Spec = {};
    for (let i = 0; i < 20; i++) parts[`part${i}.bin`] = randomBytes(1024 * 1024);
    const dir = folder('huge', parts);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    try {
      const cases = [
        ['tar.gz', 'disconnect'],
        ['tar.gz', 'revoke'],
        ['zip', 'disconnect'],
        ['zip', 'revoke'],
      ] as const;
      for (const [format, how] of cases) {
        let got = 0;
        await new Promise<void>((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: url(dir, format), headers: admin.headers }, (res) => {
            expect(res.statusCode).toBe(200);
            res.on('data', (c: Buffer) => {
              const before = got;
              got += c.length;
              if (before < 1024 * 1024 && got >= 1024 * 1024) {
                if (how === 'disconnect') req.destroy();
                else evictUser(admin.userId);
              }
            });
            res.on('close', () => resolve());
            res.on('error', () => resolve());
          });
          req.on('error', () => resolve());
          setTimeout(() => reject(new Error('download did not stop')), 15_000);
        });
        expect(got).toBeLessThan(20 * 1024 * 1024);
      }
      const rows = await audits(4);
      expect(rows.map((r) => [r.meta.format, r.meta.method, r.meta.aborted])).toEqual([
        ['tar.gz', 'tar', true],
        ['tar.gz', 'tar', true],
        ['zip', 'sftp', true],
        ['zip', 'sftp', true],
      ]);
      // Every local stand-in for the remote tar has ended
      await new Promise((r) => setTimeout(r, 100));
      expect(shell.children.filter((c) => c.exitCode === null && c.signalCode === null)).toEqual([]);
    } finally {
      await app.close();
      app = await buildApp();
      await app.ready();
    }
  });
});
