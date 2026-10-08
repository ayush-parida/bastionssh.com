import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Must run before `config` is imported: a small file limit keeps the limit case quick.
vi.hoisted(() => {
  process.env.SMT_FOLDER_DOWNLOAD_MAX_FILES = '20';
});

// basic-ftp's Client is replaced by an in-memory server (ftp-fake below); the
// FTP ops, routes, archive engine, jail, DB and vault are real.
vi.mock('../../ftp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/client.js')>();
  const { fakeFtp } = await import('../../ftp/fake-ftp.test-helper.js');
  return { ...actual, ...fakeFtp() };
});

const client = (await import('../../ftp/client.js')) as any;
const state = client.__state as import('../../ftp/fake-ftp.test-helper.js').FakeFtpState;
const { buildApp } = await import('../app.js');
const { runMigrations } = await import('../../db/migrate.js');
const { getDb } = await import('../../db/index.js');
const { auditLog } = await import('../../db/schema.js');
const { seedOrg, seedUser } = await import('./test-utils.js');
const { activeStreamCount } = await import('../sse.js');
const { readTarGz, readZip } = await import('../../archive/archive.test-helper.js');

const HOME = '/home/deploy';

function seedFs() {
  for (const dir of ['/', '/home', HOME, `${HOME}/site`, `${HOME}/site/css`, `${HOME}/site/empty`, '/etc']) {
    state.fs.set(dir, { type: 'dir' });
  }
  state.fs.set(`${HOME}/site/index.html`, { type: 'file', data: Buffer.from('<h1>hi</h1>') });
  state.fs.set(`${HOME}/site/css/app.css`, { type: 'file', data: Buffer.from('body{}') });
  // Many chunks on the data connection
  state.fs.set(`${HOME}/site/big.bin`, { type: 'file', data: Buffer.alloc(700_000, 3) });
  state.fs.set(`${HOME}/site/current`, { type: 'link', target: '/etc' });
  state.fs.set('/etc/passwd', { type: 'file', data: Buffer.from('root:x:0:0') });
}

describe('ftp folder download over FTP/FTPS', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let open: string;
  let jailed: string;

  const folder = (id: string, path: string, format?: string, who = viewer) =>
    app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${id}/folder?path=${encodeURIComponent(path)}${format ? `&format=${format}` : ''}`,
      headers: who.headers,
    });

  const audited = (id: string, action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, id), eq(auditLog.action, action)))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}'));

  const create = async (name: string, extra: object) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: { name, host: 'ftp.example.com', username: 'deploy', password: 'shh', ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  const retrieved = () => state.calls.filter(([op]) => op === 'downloadTo').map(([, p]) => p);

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-ftp-folder');
    admin = seedUser(orgId, 'admin');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-ftp-folder-b'), 'owner');
    app = await buildApp();
    await app.ready();
    open = await create('open', { restrictToRoot: false });
    jailed = await create('jailed', { rootPath: `${HOME}/site`, restrictToRoot: true });
  });

  beforeEach(() => {
    state.reset();
    seedFs();
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams a folder as a zip over one control connection, one command at a time, and audits it', async () => {
    const res = await folder(open, `${HOME}/site`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename="site\.zip"/);
    const zip = await readZip(res.rawPayload);
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    expect([...byName.keys()]).toEqual(['big.bin', 'css/', 'css/app.css', 'empty/', 'index.html', '_skipped.txt']);
    expect(byName.get('big.bin')!.data!.equals(Buffer.alloc(700_000, 3))).toBe(true);
    expect(byName.get('css/app.css')!.data!.toString()).toBe('body{}');
    expect(byName.get('index.html')!.mode & 0o777).toBe(0o644);
    expect(byName.get('_skipped.txt')!.data!.toString()).toMatch(/current\tsymbolic link to \/etc/);
    // Never followed
    expect(retrieved()).toEqual([`${HOME}/site/big.bin`, `${HOME}/site/css/app.css`, `${HOME}/site/index.html`]);
    expect(state.calls.some(([, p]) => String(p).startsWith('/etc'))).toBe(false);
    expect(state.overlaps).toBe(0);
    expect(state.logins).toBe(1);
    expect(state.open).toBe(0);
    expect(audited(open, 'ftp.folder_download').at(-1)).toMatchObject({
      path: `${HOME}/site`,
      format: 'zip',
      files: 3,
      bytes: 700_000 + 6 + 11,
      skipped: 1,
      truncated: false,
      aborted: false,
    });
    expect(activeStreamCount(viewer.userId)).toBe(0);
  });

  it('keeps links as links in a tar.gz', async () => {
    const res = await folder(open, `${HOME}/site`, 'tar.gz');
    const entries = readTarGz(res.rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['big.bin', 'css/', 'css/app.css', 'current', 'empty/', 'index.html']);
    expect(entries.find((e) => e.name === 'current')).toMatchObject({ type: '2', linkName: '/etc' });
    expect(state.calls.some(([op, p]) => op !== 'cd' && String(p).startsWith('/etc'))).toBe(false);
  });

  it('never sends a listed name that is not one plain path segment back to the server', async () => {
    state.extra.set(`${HOME}/site`, [
      { name: 'a/b', type: 'dir' },
      { name: '../../etc/passwd', type: 'file', size: 10 },
      { name: 'evil\r\nDELE index.html', type: 'file', size: 3 },
      { name: 'sock', type: 'other' },
    ]);
    const res = await folder(open, `${HOME}/site`, 'tar.gz');
    expect(res.statusCode).toBe(200);
    const entries = readTarGz(res.rawPayload);
    const skipped = entries.find((e) => e.name === '_skipped.txt')!.data.toString();
    expect(skipped).toMatch(/^a_b\/\tfolder could not be listed: The server listed a name that is not a plain file name/m);
    expect(skipped).toMatch(/\.\.\/\.\.\/etc\/passwd\tcould not be opened: The server listed a name that is not a plain file name/);
    expect(skipped).toMatch(/evil\?\?DELE index\.html\tcould not be opened/);
    expect(skipped).toMatch(/sock\tnot a regular file/);
    expect(state.calls.some(([, p]) => /\.\.|[\r\n]/.test(String(p)))).toBe(false);
    expect(retrieved()).toHaveLength(3);
  });

  it('honours the root-path jail: outside paths are refused before any header and audited', async () => {
    const before = audited(jailed, 'ftp.path_refused').length;
    for (const path of [HOME, `${HOME}/site/../..`, '/etc']) {
      const res = await folder(jailed, path);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/outside the directory/);
    }
    expect(audited(jailed, 'ftp.path_refused').length).toBe(before + 3);
    expect(state.calls.some(([, p]) => String(p).startsWith('/etc'))).toBe(false);

    // The start directory itself is fine, and named after the folder
    const res = await folder(jailed, '.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename="site\.zip"/);
    expect(activeStreamCount(viewer.userId)).toBe(0);
  });

  it('refuses a file', async () => {
    const res = await folder(open, `${HOME}/site/index.html`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Not a folder/);
    expect((await folder(open, `${HOME}/nope`)).statusCode).toBe(404);
  });

  it('skips a file the server refuses and keeps the control connection', async () => {
    state.denied.add(`${HOME}/site/css/app.css`);
    const res = await folder(open, `${HOME}/site`);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['big.bin', 'css/', 'empty/', 'index.html', '_skipped.txt']);
    expect(zip.entries.at(-1)!.data!.toString()).toMatch(/css\/app\.css\tcould not be read: Permission denied/);
    expect(state.logins).toBe(1);
  });

  it('logs in again after a data connection drops part-way, and marks the file incomplete', async () => {
    state.dropAfter.set(`${HOME}/site/big.bin`, 100_000);
    const res = await folder(open, `${HOME}/site`);
    expect(res.statusCode).toBe(200);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.map((e) => e.name)).toEqual(['big.bin', 'css/', 'css/app.css', 'empty/', 'index.html', '_skipped.txt']);
    expect(zip.entries.at(-1)!.data!.toString()).toMatch(/big\.bin\tread failed after \d+ of 700000 bytes/);
    expect(zip.entries.find((e) => e.name === 'index.html')!.data!.toString()).toBe('<h1>hi</h1>');
    expect(state.logins).toBe(2);
    expect(state.overlaps).toBe(0);
    expect(state.open).toBe(0);
  });

  it('reads a file that grew only up to its listed size, without logging in again', async () => {
    state.grow.set(`${HOME}/site/css/app.css`, 4096);
    const res = await folder(open, `${HOME}/site`);
    const zip = await readZip(res.rawPayload);
    expect(zip.entries.find((e) => e.name === 'css/app.css')!.data!.toString()).toBe('body{}');
    expect(zip.entries.some((e) => e.name === '_skipped.txt' && /app\.css/.test(e.data!.toString()))).toBe(false);
    expect(state.logins).toBe(1);
    expect(state.overlaps).toBe(0);
  });

  it('stops at SMT_FOLDER_DOWNLOAD_MAX_FILES with _TRUNCATED.txt', async () => {
    state.fs.set(`${HOME}/many`, { type: 'dir' });
    for (let i = 0; i < 30; i++) state.fs.set(`${HOME}/many/f${String(i).padStart(2, '0')}`, { type: 'file', data: Buffer.from('x') });
    const res = await folder(open, `${HOME}/many`, 'tar.gz');
    const entries = readTarGz(res.rawPayload);
    expect(entries).toHaveLength(21);
    expect(entries.at(-1)!.name).toBe('_TRUNCATED.txt');
    expect(audited(open, 'ftp.folder_download').at(-1)).toMatchObject({ files: 20, truncated: true });
  });

  it('ends a running download when the connection is edited', async () => {
    state.stall.add(`${HOME}/site/big.bin`);
    const before = audited(open, 'ftp.folder_download').length;
    const pending = folder(open, `${HOME}/site`);
    for (let i = 0; i < 200 && !retrieved().length; i++) await new Promise((r) => setTimeout(r, 5));
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/ftp/connections/${open}`,
      headers: admin.headers,
      payload: { name: 'open (renamed)' },
    });
    expect(edit.statusCode).toBe(200);
    // Headers were out: the cut body is the only signal left
    await expect(pending).rejects.toThrow(/destroyed/);
    expect(audited(open, 'ftp.folder_download')).toHaveLength(before + 1);
    expect(audited(open, 'ftp.folder_download').at(-1)).toMatchObject({ aborted: true, files: 0 });
    expect(state.open).toBe(0);
    expect(activeStreamCount(viewer.userId)).toBe(0);
  });

  it('is limited to members who can see the connection', async () => {
    expect((await folder(open, '.', undefined, outsider)).statusCode).toBe(404);
    expect(state.logins).toBe(0);
  });
});
