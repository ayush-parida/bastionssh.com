import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Folder downloads against live servers. A tree is generated in
 * SMT_TEST_FOLDER_DIR on this machine, which the servers serve (bind-mount it):
 *
 *   mkdir -p /tmp/smt-folder && chmod 777 /tmp/smt-folder
 *   docker run -d --rm --name smt-folder-sftp -p 2223:22 \
 *     -v /tmp/smt-folder:/home/testuser/upload atmoz/sftp testuser:testpass:1000
 *   docker run -d --rm --name smt-folder-ftp -p 2121:21 -p 47100-47110:47100-47110 \
 *     -e USERS='testuser|testpass|/home/testuser' -e ADDRESS=127.0.0.1 -e MIN_PORT=47100 -e MAX_PORT=47110 \
 *     -v /tmp/smt-folder:/home/testuser/upload delfer/alpine-ftp-server
 *   SMT_TEST_FOLDER_DIR=/tmp/smt-folder \
 *   SMT_TEST_SFTP_HOST=127.0.0.1 SMT_TEST_SFTP_PORT=2223 SMT_TEST_SFTP_ROOT=/upload \
 *   SMT_TEST_FTP_HOST=127.0.0.1 SMT_TEST_FTP_PORT=2121 SMT_TEST_FTP_ROOT=/home/testuser/upload \
 *     pnpm vitest run src/ftp/folder-download.integration.test.ts
 *   docker stop smt-folder-sftp smt-folder-ftp
 *
 * Each archive is extracted with the system unzip / tar and every file
 * compared by SHA-256 with the original.
 */

const local = process.env.SMT_TEST_FOLDER_DIR;

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');

const targets = [
  {
    protocol: 'sftp',
    host: process.env.SMT_TEST_SFTP_HOST,
    port: Number(process.env.SMT_TEST_SFTP_PORT ?? 22),
    root: process.env.SMT_TEST_SFTP_ROOT ?? '/upload',
  },
  {
    protocol: 'ftp',
    host: process.env.SMT_TEST_FTP_HOST,
    port: Number(process.env.SMT_TEST_FTP_PORT ?? 21),
    root: process.env.SMT_TEST_FTP_ROOT ?? '/home/testuser/upload',
  },
].filter((t) => t.host);

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Regular files under `dir`, relative path → SHA-256 (links not followed). */
function digests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      // macOS tar writes names decomposed (NFD); compare them composed
      else if (d.isFile()) out.set(r.normalize('NFC'), sha(fs.readFileSync(path.join(dir, r))));
    }
  };
  walk('');
  return out;
}

describe.skipIf(!local || targets.length === 0)('folder downloads against live FTP/SFTP servers', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: ReturnType<typeof seedUser>;
  const name = `tree-${Date.now().toString(36)}`;
  const tree = path.join(local ?? '', name);
  let expected: Map<string, string>;

  beforeAll(async () => {
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, 'big.bin'), randomBytes(24 * 1024 * 1024));
    for (let d = 0; d < 12; d++) {
      const sub = path.join(tree, 'nested', `d${d}`, 'deeper');
      fs.mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 40; f++) fs.writeFileSync(path.join(sub, `f${f}.txt`), `${d}/${f} ${randomBytes(f * 37).toString('hex')}`);
    }
    fs.mkdirSync(path.join(tree, 'données'));
    fs.writeFileSync(path.join(tree, 'données', 'é.txt'), 'unicode');
    fs.mkdirSync(path.join(tree, 'empty'));
    fs.writeFileSync(path.join(tree, 'zero.txt'), '');
    fs.symlinkSync('nested', path.join(tree, 'link'));
    fs.chmodSync(tree, 0o755);
    expected = digests(tree);

    await runMigrations();
    admin = seedUser(seedOrg('folder-it'), 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (local) fs.rmSync(tree, { recursive: true, force: true });
  });

  for (const target of targets) {
    for (const format of ['zip', 'tar.gz'] as const) {
      it(`${target.protocol}: downloads a nested tree as ${format}, every file intact`, async () => {
        const created = await app.inject({
          method: 'POST',
          url: '/api/ftp/connections',
          headers: admin.headers,
          payload: {
            name: `${target.protocol}-${format}`,
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            username: process.env.SMT_TEST_FOLDER_USER ?? 'testuser',
            password: process.env.SMT_TEST_FOLDER_PASSWORD ?? 'testpass',
            rootPath: target.root,
            restrictToRoot: true,
          },
        });
        expect(created.statusCode).toBe(201);
        const id = created.json().id;
        const started = Date.now();
        const res = await app.inject({
          method: 'GET',
          url: `/api/ftp/connections/${id}/folder?path=${encodeURIComponent(`${target.root}/${name}`)}&format=${format}`,
          headers: admin.headers,
        });
        expect(res.statusCode).toBe(200);
        expect(res.trailers['x-archive-summary']).toMatch(/truncated=false/);

        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-folder-it-'));
        try {
          const file = path.join(out, `archive.${format}`);
          fs.writeFileSync(file, res.rawPayload);
          const into = path.join(out, 'x');
          fs.mkdirSync(into);
          if (format === 'zip') {
            execFileSync('unzip', ['-tq', file]);
            execFileSync('unzip', ['-q', file, '-d', into]);
          } else {
            execFileSync('tar', ['-xzf', file, '-C', into]);
          }
          const got = digests(into);
          for (const note of ['_skipped.txt']) got.delete(note);
          expect(got).toEqual(expected);
          expect(fs.statSync(path.join(into, 'empty')).isDirectory()).toBe(true);
          if (format === 'tar.gz' && target.protocol === 'sftp') {
            expect(fs.readlinkSync(path.join(into, 'link'))).toBe('nested');
          }
        } finally {
          fs.rmSync(out, { recursive: true, force: true });
        }
        console.log(`${target.protocol} ${format}: ${res.rawPayload.length} bytes in ${Date.now() - started} ms`);
      }, 120_000);
    }
  }
});
