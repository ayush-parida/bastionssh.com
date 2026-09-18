import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Readable, Writable } from 'node:stream';

// Must run before `config` is imported: a tiny cap lets the upload guard be
// exercised with a handful of bytes.
vi.hoisted(() => {
  process.env.SMT_FTP_MAX_UPLOAD_BYTES = '16';
});

// No network: the login and every command are replaced, but the routes, auth,
// DB, vault, path handling and the per-user client pool around them are real.
vi.mock('../../ftp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/client.js')>();
  return {
    ...actual,
    openClient: vi.fn(async () => ({ closed: false, close: vi.fn() })),
  };
});

vi.mock('../../ftp/ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ftp/ops.js')>();
  const entry = (name: string, type: 'file' | 'directory', size = 0) => ({
    name,
    path: `/home/deploy/${name}`,
    type,
    size,
    permissions: 'rw-r--r--',
    modifiedAt: null,
    rawModifiedAt: 'Sep 18 10:22',
    link: null,
  });
  return {
    ...actual,
    testConnection: vi.fn(async () => ({
      ok: true,
      workingDirectory: '/home/deploy',
      entryCount: 2,
    })),
    home: vi.fn(async (_c: unknown, rootPath: string | null) => rootPath ?? '/home/deploy'),
    list: vi.fn(async () => [entry('logs', 'directory'), entry('index.html', 'file', 5)]),
    stat: vi.fn(async (_c: unknown, path: string) =>
      path.endsWith('/logs') ? entry('logs', 'directory') : entry('index.html', 'file', 5),
    ),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    removeEmptyDir: vi.fn(async () => {}),
    removeDirRecursive: vi.fn(async () => {}),
    download: vi.fn(async (_c: unknown, _p: string, dest: Writable) => {
      dest.end('hello');
    }),
    upload: vi.fn(async (_c: unknown, body: Readable) => {
      for await (const _chunk of body) {
        /* drain */
      }
    }),
  };
});

import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { seedOrg, seedUser } from './test-utils.js';
import * as ops from '../../ftp/ops.js';
import { openClient } from '../../ftp/client.js';

const connectionBody = {
  name: 'shared host',
  host: 'FTP.Example.com',
  username: 'deploy',
  password: 'shh-secret',
};

describe('ftp routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let outsider: ReturnType<typeof seedUser>;
  let connectionId: string;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-ftp-a');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    outsider = seedUser(seedOrg('org-ftp-b'), 'owner');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets an admin create a connection, defaults the port, and never returns the password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: connectionBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    connectionId = body.id;
    expect(body.host).toBe('ftp.example.com');
    expect(body.protocol).toBe('ftps');
    expect(body.port).toBe(21);
    expect(body.verifyTls).toBe(true);
    expect(body.rootPath).toBeNull();
    expect(JSON.stringify(body)).not.toContain('shh-secret');
    expect(Object.keys(body).some((k) => /password/i.test(k))).toBe(false);
  });

  it('uses 990 for implicit TLS unless a port is given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ftp/connections',
      headers: admin.headers,
      payload: { ...connectionBody, name: 'implicit', protocol: 'ftps-implicit' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().port).toBe(990);
  });

  it('refuses a viewer and an operator from managing connections', async () => {
    for (const who of [viewer, operator]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ftp/connections',
        headers: who.headers,
        payload: connectionBody,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects a URL, a metadata address, a bad protocol and a relative root path', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/ftp/connections',
        headers: admin.headers,
        payload: { ...connectionBody, ...payload },
      });
    expect((await post({ host: 'ftp://ftp.example.com' })).statusCode).toBe(400);
    expect((await post({ host: '169.254.169.254' })).statusCode).toBe(400);
    expect((await post({ protocol: 'sftp' })).statusCode).toBe(400);
    expect((await post({ rootPath: 'public_html' })).statusCode).toBe(400);
  });

  it('hides a connection from another organisation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=.`,
      headers: outsider.headers,
    });
    expect(list.statusCode).toBe(404);
  });

  it('records the result of a connection test', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/ftp/connections/${connectionId}/test`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(ops.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'ftp.example.com', port: 21, protocol: 'ftps' }),
      'shh-secret',
    );

    const stored = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}`,
      headers: viewer.headers,
    });
    expect(stored.json().lastStatus).toBe('ok');
  });

  it('lets a viewer list, resolving "." to the login directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=.`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe('/home/deploy');
    expect(body.parent).toBe('/home');
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['logs', 'index.html']);
    expect(openClient).toHaveBeenCalledTimes(1);
  });

  it('reuses one client per user and opens another for a second user', async () => {
    const opens = vi.mocked(openClient).mock.calls.length;
    await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=/var/www/`,
      headers: viewer.headers,
    });
    expect(vi.mocked(openClient).mock.calls.length).toBe(opens);
    expect(ops.list).toHaveBeenLastCalledWith(expect.anything(), '/var/www');

    await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=/`,
      headers: operator.headers,
    });
    expect(vi.mocked(openClient).mock.calls.length).toBe(opens + 1);
  });

  it('rejects a relative path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=www`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('streams a download with a filename and length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/download?path=/home/deploy/index.html`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('index.html');
    expect(res.headers['content-length']).toBe('5');
    expect(res.body).toBe('hello');
  });

  it('refuses to download a directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/download?path=/home/deploy/logs`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps viewers out of every write', async () => {
    const attempts = [
      { method: 'PUT' as const, url: `/api/ftp/connections/${connectionId}/file?path=/x` },
      {
        method: 'POST' as const,
        url: `/api/ftp/connections/${connectionId}/mkdir`,
        payload: { path: '/x' },
      },
      {
        method: 'POST' as const,
        url: `/api/ftp/connections/${connectionId}/rename`,
        payload: { from: '/x', to: '/y' },
      },
      { method: 'DELETE' as const, url: `/api/ftp/connections/${connectionId}/file?path=/x` },
    ];
    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: viewer.headers });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }
  });

  it('rejects an upload the declared length says is over the cap, before reading it', async () => {
    vi.mocked(ops.upload).mockClear();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${connectionId}/file?path=/home/deploy/big.bin`,
      headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(32),
    });
    expect(res.statusCode).toBe(413);
    expect(ops.upload).not.toHaveBeenCalled();
  });

  it('accepts an upload under the cap', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${connectionId}/file?path=/home/deploy/small.bin`,
      headers: { ...operator.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(8),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ path: '/home/deploy/small.bin', size: 8 });
    expect(ops.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/home/deploy/small.bin',
    );
  });

  it('answers 400, not 500, when the upload body is not a raw stream', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ftp/connections/${connectionId}/file?path=/home/deploy/x.json`,
      headers: operator.headers,
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates and renames with normalized paths', async () => {
    const mk = await app.inject({
      method: 'POST',
      url: `/api/ftp/connections/${connectionId}/mkdir`,
      headers: operator.headers,
      payload: { path: '/home/deploy/new//dir/' },
    });
    expect(mk.statusCode).toBe(201);
    expect(ops.mkdir).toHaveBeenCalledWith(expect.anything(), '/home/deploy/new/dir');

    const mv = await app.inject({
      method: 'POST',
      url: `/api/ftp/connections/${connectionId}/rename`,
      headers: operator.headers,
      payload: { from: '/home/deploy/a', to: '/home/deploy/../deploy/b' },
    });
    expect(mv.statusCode).toBe(200);
    expect(ops.rename).toHaveBeenCalledWith(expect.anything(), '/home/deploy/a', '/home/deploy/b');
  });

  it('deletes a file, an empty directory, or a tree only when recursive is literally true', async () => {
    const del = (suffix: string) =>
      app.inject({
        method: 'DELETE',
        url: `/api/ftp/connections/${connectionId}/file?path=${suffix}`,
        headers: operator.headers,
      });

    expect((await del('/home/deploy/index.html')).statusCode).toBe(204);
    expect(ops.removeFile).toHaveBeenCalledWith(expect.anything(), '/home/deploy/index.html');

    vi.mocked(ops.removeDirRecursive).mockClear();
    for (const q of ['', '&recursive=false', '&recursive=0']) {
      expect((await del(`/home/deploy/logs${q}`)).statusCode, q).toBe(204);
    }
    expect(ops.removeEmptyDir).toHaveBeenCalledTimes(3);
    expect(ops.removeDirRecursive).not.toHaveBeenCalled();

    expect((await del('/home/deploy/logs&recursive=true')).statusCode).toBe(204);
    expect(ops.removeDirRecursive).toHaveBeenCalledWith(expect.anything(), '/home/deploy/logs');

    expect((await del('/')).statusCode).toBe(400);
  });

  it('reconnects after an edit and blanks the last test result when the target changes', async () => {
    const opens = vi.mocked(openClient).mock.calls.length;
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/ftp/connections/${connectionId}`,
      headers: admin.headers,
      payload: { name: 'renamed' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().name).toBe('renamed');
    expect(rename.json().lastStatus).toBe('ok');

    const retarget = await app.inject({
      method: 'PATCH',
      url: `/api/ftp/connections/${connectionId}`,
      headers: admin.headers,
      payload: { host: 'ftp2.example.com', rootPath: '/public_html/' },
    });
    expect(retarget.statusCode).toBe(200);
    expect(retarget.json().lastStatus).toBeNull();
    expect(retarget.json().rootPath).toBe('/public_html');

    const list = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=.`,
      headers: viewer.headers,
    });
    expect(list.json().path).toBe('/public_html');
    expect(vi.mocked(openClient).mock.calls.length).toBe(opens + 1);
    expect(openClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: 'ftp2.example.com' }),
      'shh-secret',
    );
  });

  it('deletes a connection', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ftp/connections/${connectionId}`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(204);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/ftp/connections/${connectionId}/list?path=.`,
      headers: viewer.headers,
    });
    expect(gone.statusCode).toBe(404);
  });
});
