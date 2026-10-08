import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';

// Must run before `config` is imported: small limits and a short SFTP timeout
// keep the limit and stall cases quick.
vi.hoisted(() => {
  process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES = '20';
  process.env.SMT_SFTP_OP_TIMEOUT_MS = '1500';
});

// ssh2 is replaced by an in-memory SFTP server; the routes, the archive
// engine, the jail, host keys, DB and vault are real.
vi.mock('ssh2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ssh2')>()),
  ...(await import('../../ftp/fake-ssh2.test-helper.js')).fakeSsh2(),
}));

const ssh2 = (await import('ssh2')) as any;
const state = ssh2.__state as import('../../ftp/fake-ssh2.test-helper.js').FakeSsh2State;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog } = await import('../../db/schema.js');
const { seedOrg, seedUser } = await import('./test-utils.js');
const { evictFtpUser } = await import('../../ftp/index.js');
const { activeStreamCount } = await import('../sse.js');
const { readTarGz, readZip } = await import('../../archive/archive.test-helper.js');

const KEY = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8', 'base64');

const ROOT = '/var/www/html';

function seedFs() {
  for (const dir of ['/', '/var', '/var/www', ROOT, `${ROOT}/assets`, `${ROOT}/assets/img`, '/secret']) {
    state.fs.set(dir, { type: 'dir' });
  }
  state.fs.set(`${ROOT}/index.html`, { type: 'file', data: Buffer.from('hello'), mode: 0o640, mtime: 1_600_000_000 });
  state.fs.set(`${ROOT}/assets/app.js`, { type: 'file', data: Buffer.from('console.log(1)') });
  state.fs.set(`${ROOT}/assets/img/logo.bin`, { type: 'file', data: Buffer.alloc(300_000, 7) });
  state.fs.set(`${ROOT}/current`, { type: 'link', target: `${ROOT}/assets` });
  state.fs.set(`${ROOT}/latest`, { type: 'link', target: `${ROOT}/index.html` });
  state.fs.set(`${ROOT}/escape`, { type: 'link', target: '/secret' });
  state.fs.set(`${ROOT}/null`, { type: 'device' });
  state.fs.set('/secret/keep.txt', { type: 'file', data: Buffer.from('keep') });
}

const touchesSecret = () =>
  state.calls.some(([op, p]) => (op === 'readdir' || op === 'createReadStream') && String(p).startsWith('/secret'));

describe('ftp folder download over SFTP', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let id: string;

  const folder = (who: { headers: Record<string, string> }, path: string, format?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${id}/folder?path=${encodeURIComponent(path)}${format ? `&format=${format}` : ''}`,
      headers: who.headers,
    });

  const audited = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}'));

  const lastDownload = () => audited('ftp.folder_download').at(-1);

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-sftp-folder');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-sftp-folder-b'), 'owner');
    app = await buildApp();
    await app.ready();
    state.reset();
    state.presented = KEY;
    seedFs();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: {
        name: 'sftp-folder',
        host: 'sftp.example.com',
        protocol: 'sftp',
        username: 'deploy',
        password: 'shh-secret',
        rootPath: ROOT,
        restrictToRoot: true,
      },
    });
    expect(res.statusCode).toBe(201);
    id = res.json().id;
  });

  beforeEach(() => {
    state.reset();
    state.presented = KEY;
    seedFs();
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams the start folder as a zip: files and folders, links and devices left out with a note, audited', async () => {
    const res = await folder(viewer, '.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/filename="html\.zip"/);
    const zip = await readZip(res.rawPayload);
    const names = zip.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['assets/', 'assets/app.js', 'assets/img/', 'assets/img/logo.bin', 'index.html', '_skipped.txt']));
    expect(names.some((n) => n.startsWith('current') || n.startsWith('escape') || n.startsWith('null'))).toBe(false);
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    expect(byName.get('index.html')!.data!.toString()).toBe('hello');
    expect(byName.get('index.html')!.mode & 0o777).toBe(0o640);
    expect(byName.get('assets/img/logo.bin')!.data!.equals(Buffer.alloc(300_000, 7))).toBe(true);
    const skipped = byName.get('_skipped.txt')!.data!.toString();
    expect(skipped).toMatch(/current\tsymbolic link to \/var\/www\/html\/assets/);
    expect(skipped).toMatch(/escape\tsymbolic link to \/secret/);
    expect(skipped).toMatch(/null\tnot a regular file/);
    expect(touchesSecret()).toBe(false);

    expect(lastDownload()).toMatchObject({
      path: ROOT,
      format: 'zip',
      files: 3,
      bytes: 5 + 14 + 300_000,
      skipped: 3 + 1,
      truncated: false,
      aborted: false,
    });
    expect(activeStreamCount(viewer.userId)).toBe(0);
    // Its own session, closed once the archive is done
    expect(state.clients.every((c) => c.ended)).toBe(true);
  });

  it('keeps links as links in a tar.gz, never following one out of the root', async () => {
    const res = await folder(viewer, ROOT, 'tar.gz');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/html\.tar\.gz/);
    const entries = readTarGz(res.rawPayload);
    const links = Object.fromEntries(entries.filter((e) => e.type === '2').map((e) => [e.name, e.linkName]));
    expect(links).toEqual({ current: `${ROOT}/assets`, escape: '/secret', latest: `${ROOT}/index.html` });
    expect(entries.find((e) => e.name === 'index.html')!.data.toString()).toBe('hello');
    expect(touchesSecret()).toBe(false);
  });

  it('refuses paths outside the root before any header, and audits them', async () => {
    const before = audited('ftp.path_refused').length;
    for (const path of [`${ROOT}/../../../secret`, '/secret', '/var/www']) {
      const res = await folder(viewer, path);
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toMatch(/json/);
    }
    // A link inside the root that leads out of it
    const link = await folder(viewer, `${ROOT}/escape`);
    expect(link.statusCode).toBe(403);
    expect(link.json().error).toMatch(/leads outside/);
    expect(audited('ftp.path_refused').length).toBe(before + 4);
    expect(touchesSecret()).toBe(false);
    expect(activeStreamCount(viewer.userId)).toBe(0);
    expect(state.clients.every((c) => c.ended)).toBe(true);
  });

  it('skips a folder swapped for a link out of the root during the walk (realpath check) and audits it', async () => {
    const push = state.calls.push.bind(state.calls);
    state.calls.push = (...items: unknown[][]) => {
      // The jail resolves the folder just before listing it: swap it now
      if (items[0]?.[0] === 'realpath' && items[0]?.[1] === `${ROOT}/assets`) {
        for (const k of [...state.fs.keys()]) if (k.startsWith(`${ROOT}/assets/`)) state.fs.delete(k);
        state.fs.set(`${ROOT}/assets`, { type: 'link', target: '/secret' });
      }
      return push(...items);
    };
    try {
      const res = await folder(viewer, '.', 'tar.gz');
      expect(res.statusCode).toBe(200);
      const entries = readTarGz(res.rawPayload);
      expect(entries.some((e) => e.name.startsWith('assets/') && e.name !== 'assets/')).toBe(false);
      expect(entries.find((e) => e.name === '_skipped.txt')!.data.toString()).toMatch(/assets\/\tfolder could not be listed: Path leads outside/);
    } finally {
      state.calls.push = push;
    }
    expect(touchesSecret()).toBe(false);
    // The folder, and the device
    expect(lastDownload()).toMatchObject({ refused: 1, skipped: 2 });
    expect(audited('ftp.path_refused').at(-1)).toEqual({ path: `${ROOT}/assets` });
  });

  it('downloads a link to a folder, but refuses a file or a link to a file', async () => {
    const res = await folder(viewer, `${ROOT}/current`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/current\.zip/);
    const z = await readZip(res.rawPayload);
    expect(z.entries.map((e) => e.name)).toEqual(['app.js', 'img/', 'img/logo.bin']);
    for (const path of [`${ROOT}/index.html`, `${ROOT}/latest`]) {
      const r = await folder(viewer, path);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/Not a folder/);
    }
    expect((await folder(viewer, `${ROOT}/missing`)).statusCode).toBe(404);
    expect((await folder(viewer, '.', 'rar')).statusCode).toBe(400);
  });

  it('stops at SMT_FOLDER_DOWNLOAD_MAX_FILES with _TRUNCATED.txt, audited as truncated', async () => {
    state.fs.set(`${ROOT}/many`, { type: 'dir' });
    for (let i = 0; i < 25; i++) state.fs.set(`${ROOT}/many/f${String(i).padStart(2, '0')}.txt`, { type: 'file', data: Buffer.from(`${i}`) });
    const res = await folder(viewer, `${ROOT}/many`);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.filter((e) => /^f\d+\.txt$/.test(e.name))).toHaveLength(20);
    expect(zip.entries.at(-1)!.name).toBe('_TRUNCATED.txt');
    expect(res.trailers['x-archive-summary']).toMatch(/truncated=true/);
    expect(lastDownload()).toMatchObject({ files: 20, truncated: true });
  });

  it('skips an unreadable file and keeps the session', async () => {
    state.denied.add(`${ROOT}/assets/app.js`);
    const handshakes = state.clients.length;
    const res = await folder(viewer, `${ROOT}/assets`);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['img/', 'img/logo.bin', '_skipped.txt']);
    expect(zip.entries.at(-1)!.data!.toString()).toMatch(/app\.js\t.*Permission denied/);
    expect(state.clients).toHaveLength(handshakes + 1);
  });

  it('skips a file whose read stalls past SMT_SFTP_OP_TIMEOUT_MS and logs in again for the rest', async () => {
    state.fs.set(`${ROOT}/assets/a-stall.bin`, { type: 'file', data: Buffer.from('never') });
    const handshakes = state.clients.length;
    const create = state.calls.push.bind(state.calls);
    state.calls.push = (...items: unknown[][]) => {
      if (items[0]?.[0] === 'createReadStream') {
        if (items[0]?.[1] === `${ROOT}/assets/a-stall.bin`) state.stalled.add('read');
        else state.stalled.delete('read');
      }
      return create(...items);
    };
    try {
      const res = await folder(viewer, `${ROOT}/assets`);
      expect(res.statusCode).toBe(200);
      const zip = await readZip(res.rawPayload);
      expect(zip.entries.map((e) => e.name)).toEqual(['app.js', 'img/', 'img/logo.bin', '_skipped.txt']);
      expect(zip.entries.at(-1)!.data!.toString()).toMatch(/a-stall\.bin\t.*timed out/);
    } finally {
      state.calls.push = create;
    }
    expect(state.clients).toHaveLength(handshakes + 2);
    expect(state.clients.every((c) => c.ended)).toBe(true);
  }, 15_000);

  it('ends a running download when access is revoked, and when the browser goes away', async () => {
    for (const how of ['revoke', 'disconnect'] as const) {
      state.reset();
      state.presented = KEY;
      seedFs();
      state.stalled.add('read');
      await app.listen({ port: 0, host: '127.0.0.1' }).catch(() => {});
      const { port } = app.server.address() as AddressInfo;
      const before = audited('ftp.folder_download').length;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: `/api/ftp/connections/${id}/folder?path=.`, headers: viewer.headers },
          (res) => {
            res.on('data', () => {});
            res.on('close', () => resolve(res.statusCode ?? 0));
            res.on('error', () => resolve(res.statusCode ?? 0));
            // Headers are out; the first file's read is stuck on the server
            const wait = setInterval(() => {
              if (!state.calls.some(([op]) => op === 'createReadStream')) return;
              clearInterval(wait);
              if (how === 'revoke') evictFtpUser(viewer.userId, { orgId });
              else req.destroy();
            }, 5);
          },
        );
        req.on('error', () => {});
        setTimeout(() => reject(new Error('download did not stop')), 1000);
      });
      expect(status).toBe(200);
      for (let i = 0; i < 100 && audited('ftp.folder_download').length === before; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lastDownload()).toMatchObject({ aborted: true });
      expect(state.clients.every((c) => c.ended)).toBe(true);
      expect(activeStreamCount(viewer.userId)).toBe(0);
    }
  });

  it('is limited to members who can see the connection', async () => {
    const handshakes = state.clients.length;
    expect((await folder(outsider, '.')).statusCode).toBe(404);
    const res = await app.inject({ method: 'GET', url: `/api/ftp/connections/${id}/folder?path=.` });
    expect(res.statusCode).toBe(401);
    expect(state.clients).toHaveLength(handshakes);
  });
});
