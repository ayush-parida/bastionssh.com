import fs from 'node:fs';
import path from 'node:path';

/**
 * Test doubles for builds on the BastionSSH side: a tar writer for uploads,
 * and a fake `buildctl` — a small Node.js script, run as the real binary
 * would be — that answers `debug workers`, `du` and `prune`, and for `build`
 * prints BuildKit-like progress (one line echoing a build arg, to check
 * masking), records what it was given (argv, the context's files, the
 * Dockerfile) and writes an image tarball to stdout. Behaviour comes from
 * environment variables, read when it runs:
 *
 * - `FAKE_BUILDCTL_LOG` — a file each call appends one JSON line to;
 * - `FAKE_BUILD_DELAY_MS` — wait before exporting (time to cancel);
 * - `FAKE_BUILD_EXIT` — exit code of a build (with an ERROR line);
 * - `FAKE_BUILD_SIGNAL_FILE` — written when SIGTERM arrives (a cancel);
 * - `FAKE_BUILDKIT_DOWN` — every call fails as if the daemon were away;
 * - `FAKE_BUILDKIT_PLATFORM` — its own platform (default linux/arm64).
 */

type Entry = string | { content?: string; type?: '0' | '2' | '3' | '5'; linkname?: string };

/** A tar (ustar) of `entries`: a map of path → content (or link), or a list of `{ name, … }`. */
export function tarOf(entries: Record<string, Entry> | Array<{ name: string; content?: string; type?: string; linkname?: string }>): Buffer {
  const list = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([name, e]) => (typeof e === 'string' ? { name, content: e } : { name, ...e }));
  const parts: Buffer[] = [];
  for (const e of list) {
    const data = Buffer.from(e.content ?? '');
    const type = e.type ?? '0';
    const size = type === '0' ? data.length : 0;
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(0x20, 148, 156);
    h.write(type, 156);
    if (e.linkname) h.write(e.linkname, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h);
    if (size) parts.push(data, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
const log = (entry) => env.FAKE_BUILDCTL_LOG && fs.appendFileSync(env.FAKE_BUILDCTL_LOG, JSON.stringify(entry) + '\n');
const at = argv.indexOf('--addr');
const rest = argv.filter((a, i) => i !== at && i !== at + 1);
const command = rest[0] === 'debug' ? 'debug ' + rest[1] : rest[0];
if (env.FAKE_BUILDKIT_DOWN) {
  process.stderr.write('error: failed to dial gRPC: connection refused\n');
  process.exit(1);
}
const platform = env.FAKE_BUILDKIT_PLATFORM || 'linux/arm64';
if (command === 'debug workers') {
  const [os, architecture] = platform.split('/');
  const others = [{ os: 'linux', architecture: 'amd64' }, { os: 'linux', architecture: 'arm64' }].filter((p) => p.architecture !== architecture);
  process.stdout.write(JSON.stringify([{ id: 'w1', platforms: [{ os, architecture }, ...others], buildkitVersion: { version: 'v0.33.1' }, gcPolicy: [{ all: true, maxUsedSpace: 10e9 }] }]) + '\n');
  process.exit(0);
}
if (command === 'du') {
  process.stdout.write(JSON.stringify([{ id: 'a', size: 1000 }, { id: 'b', size: 2345 }]) + '\n');
  process.exit(0);
}
if (command === 'prune') {
  log({ command, argv: rest });
  process.stdout.write(JSON.stringify({ id: 'a', size: 1000 }) + '\n' + JSON.stringify({ id: 'b', size: 2345 }) + '\n');
  process.exit(0);
}
if (command !== 'build') {
  process.stderr.write('unknown command ' + command + '\n');
  process.exit(2);
}
const opt = (prefix) => rest.filter((a, i) => rest[i - 1] === '--opt' && a.startsWith(prefix)).map((a) => a.slice(prefix.length));
const local = (name) => rest.find((a, i) => rest[i - 1] === '--local' && a.startsWith(name + '='))?.slice(name.length + 1);
const context = local('context');
const list = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
  const p = rel ? rel + '/' + e.name : e.name;
  return e.isDirectory() ? list(dir, p) : [p];
});
const filename = opt('filename=')[0] || 'Dockerfile';
log({ command, argv: rest, files: list(context).sort(), dockerfile: fs.readFileSync(path.join(context, filename), 'utf8') });
const args = Object.fromEntries(opt('build-arg:').map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
process.on('SIGTERM', () => {
  if (env.FAKE_BUILD_SIGNAL_FILE) fs.writeFileSync(env.FAKE_BUILD_SIGNAL_FILE, 'SIGTERM');
  process.stderr.write('#9 CANCELED\nerror: context canceled\n');
  process.exit(1);
});
process.stderr.write('#1 [internal] load build definition from ' + filename + '\n#1 DONE 0.0s\n');
for (const [k, v] of Object.entries(args)) process.stderr.write('#5 0.101 ' + k + ' is ' + v + '\n');
const name = rest.find((a, i) => rest[i - 1] === '--output').replace(/^type=docker,name=/, '');
setTimeout(() => {
  if (Number(env.FAKE_BUILD_EXIT || 0) !== 0) {
    process.stderr.write('#5 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137\n');
    process.exit(Number(env.FAKE_BUILD_EXIT));
  }
  process.stderr.write('#6 exporting to docker image format\n#6 DONE 0.1s\n');
  const manifest = Buffer.from(JSON.stringify([{ Config: 'config.json', RepoTags: [name], Layers: [] }]));
  const header = (n, size) => {
    const h = Buffer.alloc(512);
    h.write(n, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(0x20, 148, 156);
    h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let s = 0; for (const b of h) s += b; h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  process.stdout.write(Buffer.concat([header('manifest.json', manifest.length), manifest, pad(manifest.length), Buffer.alloc(1024)]), () => process.exit(0));
}, Number(env.FAKE_BUILD_DELAY_MS || 0));
`;

/**
 * Write the fake buildctl into `dir` (a temp folder: no package.json above
 * it says "module", so Node runs the extension-less script as CommonJS);
 * returns its path.
 */
export function writeFakeBuildctl(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'buildctl');
  fs.writeFileSync(file, SCRIPT, { mode: 0o755 });
  return file;
}

/** The calls the fake recorded. */
export function fakeBuildctlCalls(logFile: string): Array<{ command: string; argv: string[]; files?: string[]; dockerfile?: string }> {
  try {
    return fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { command: string; argv: string[]; files?: string[]; dockerfile?: string });
  } catch {
    return [];
  }
}
