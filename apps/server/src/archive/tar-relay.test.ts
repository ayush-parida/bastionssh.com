import { execFileSync } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { collector } from './archive.test-helper.js';
import { paxRecord, ustarHeader } from './tar.js';
import { RelayNotStarted, relayTar, type RemoteTar } from './tar-relay.js';

/**
 * The tar relay on hand-made tar streams: what goes through untouched, what
 * is left out, limits, and when it refuses to start (so the caller can fall
 * back to SFTP). The route suite (api/routes/sftp-folder.test.ts) runs it on
 * the system's real tar.
 */

const meta = (mode = 0o644) => ({ mtime: new Date(1_700_000_000_000), mode });
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function member(name: string, type: string, data = Buffer.alloc(0), extra: { linkName?: string; mode?: number } = {}) {
  return Buffer.concat([ustarHeader({ name, type, size: data.length, meta: meta(extra.mode), linkName: extra.linkName }), pad(data)]);
}

const END = Buffer.alloc(1024);

function remote(chunks: Buffer[], opts: { exitCode?: number | null; messages?: string[] } = {}) {
  let stopped = 0;
  const source = Readable.from(chunks.map((c) => Buffer.from(c)));
  const r: RemoteTar & { stopped: () => number } = {
    source,
    exited: Promise.resolve({ exitCode: opts.exitCode === undefined ? 0 : opts.exitCode }),
    messages: () => opts.messages ?? [],
    stop: () => {
      stopped++;
    },
    stopped: () => stopped,
  };
  return r;
}

async function relay(r: RemoteTar, limits: { maxBytes?: number; maxFiles?: number; signal?: AbortSignal } = {}) {
  const out = collector();
  let begun = 0;
  const summary = await relayTar(r, {
    maxBytes: limits.maxBytes ?? 1e12,
    maxFiles: limits.maxFiles ?? 1e6,
    signal: limits.signal ?? new AbortController().signal,
    begin: () => {
      begun++;
      return out;
    },
  });
  return { summary, gz: out.result(), begun };
}

/** Member names and types as the system tar lists them, plus raw headers for modes. */
function listing(gz: Buffer): string[] {
  return execFileSync('tar', ['-tvzf', '-'], { input: gz })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
}

function names(gz: Buffer): string[] {
  return execFileSync('tar', ['-tzf', '-'], { input: gz }).toString().trim().split('\n').filter(Boolean);
}

describe('relayTar', () => {
  it('copies members through, leaves out the folder’s own entry, and drops setuid bits', async () => {
    const r = remote([
      member('./', '5', undefined, { mode: 0o700 }),
      member('./a.txt', '0', Buffer.from('alpha')),
      member('./sub/', '5'),
      member('./sub/run.sh', '0', Buffer.from('#!/bin/sh\n'), { mode: 0o4755 }),
      member('./link', '2', undefined, { linkName: 'sub/run.sh' }),
      member('./hard', '1', undefined, { linkName: './a.txt' }),
      END,
      Buffer.alloc(8192),
    ]);
    const { summary, gz, begun } = await relay(r);
    expect(begun).toBe(1);
    expect(summary).toEqual({ files: 4, bytes: 15, skipped: 0, truncated: false, aborted: false });
    expect(names(gz)).toEqual(['./a.txt', './sub/', './sub/run.sh', './link', './hard']);
    // a.txt header and data, sub/, then run.sh
    const run = zlib.gunzipSync(gz).subarray(512 * 3, 512 * 4);
    expect(parseInt(run.subarray(100, 108).toString('ascii'), 8)).toBe(0o755);
    expect(listing(gz).join('\n')).toMatch(/link -> sub\/run\.sh/);
  });

  it('keeps long-name records with their member, and drops them with a member that is left out', async () => {
    const long = `./${'d'.repeat(120)}/file.txt`;
    const longHeader = ustarHeader({ name: '././@LongLink', type: 'L', size: long.length + 1, meta: meta() });
    const paxEvil = paxRecord('path', 'x/../../evil');
    const r = remote([
      longHeader,
      pad(Buffer.from(`${long}\0`)),
      member('./truncated-name', '0', Buffer.from('long')),
      ustarHeader({ name: 'PaxHeader', type: 'x', size: paxEvil.length, meta: meta() }),
      pad(paxEvil),
      member('./innocent', '0', Buffer.from('evil')),
      member('../up', '0', Buffer.from('x')),
      member('/etc/passwd', '0', Buffer.from('x')),
      member('./dev', '3'),
      member('./fifo', '6'),
      member('./outside', '1', undefined, { linkName: '../../etc/shadow' }),
      member('./ok', '0', Buffer.from('ok')),
      END,
    ]);
    const { summary, gz } = await relay(r);
    expect(names(gz)).toEqual([long, './ok', '_skipped.txt']);
    expect(summary).toMatchObject({ files: 2, bytes: 6, skipped: 6 });
    const note = execFileSync('tar', ['-xOzf', '-', '_skipped.txt'], { input: gz }).toString();
    expect(note).toContain('x/../../evil\tname is absolute or leaves the folder');
    expect(note).toContain('../up\tname is absolute');
    expect(note).toContain('/etc/passwd\tname is absolute');
    expect(note).toContain('./dev\tnot a regular file');
    expect(note).toContain('./fifo\tnot a regular file');
    expect(note).toContain('./outside\thard link to ../../etc/shadow, outside the folder');
  });

  it('adds what tar reported to _skipped.txt, renaming the note if the folder has its own', async () => {
    const r = remote([member('./_skipped.txt', '0', Buffer.from('mine')), END], {
      exitCode: 2,
      messages: ['tar: ./secret: Cannot open: Permission denied'],
    });
    const { summary, gz } = await relay(r);
    expect(names(gz)).toEqual(['./_skipped.txt', '_skipped (2).txt']);
    expect(summary.skipped).toBe(1);
    const note = execFileSync('tar', ['-xOzf', '-', '_skipped (2).txt'], { input: gz }).toString();
    expect(note).toMatch(/Reported by tar on the server[^\n]*\n\ntar: \.\/secret: Cannot open: Permission denied\n$/);
  });

  it('ends at a limit with _TRUNCATED.txt and stops the remote tar', async () => {
    const files = Array.from({ length: 5 }, (_, i) => member(`./f${i}`, '0', Buffer.alloc(100, i)));
    for (const [limits, kept] of [
      [{ maxFiles: 3 }, 3],
      [{ maxBytes: 250 }, 2],
    ] as const) {
      const r = remote([...files, END]);
      const { summary, gz } = await relay(r, limits);
      expect(names(gz)).toEqual([...Array.from({ length: kept }, (_, i) => `./f${i}`), '_TRUNCATED.txt']);
      expect(summary).toMatchObject({ files: kept, truncated: true });
      expect(r.stopped()).toBeGreaterThan(0);
    }
  });

  it('sends an empty archive for an empty folder', async () => {
    const { summary, gz, begun } = await relay(remote([member('./', '5'), END]));
    expect(begun).toBe(1);
    expect(summary.files).toBe(0);
    expect(names(gz)).toEqual([]);
  });

  it('refuses to start, sending nothing, when the output is not a usable tar stream', async () => {
    const cases: [string, RemoteTar][] = [
      ['a login banner', remote([Buffer.from('Welcome to host!\n'.repeat(40))])],
      ['no output, tar failed', remote([], { exitCode: 2, messages: ['tar: .: Cannot open: Permission denied'] })],
      ['only the folder, tar failed', remote([member('./', '5'), END], { exitCode: 2 })],
      ['cut off inside the first block', remote([member('./a', '0', Buffer.from('x')).subarray(0, 300)])],
    ];
    for (const [what, r] of cases) {
      const out = collector();
      await expect(
        relayTar(r, { maxBytes: 1e9, maxFiles: 1e6, signal: new AbortController().signal, begin: () => out }),
        what,
      ).rejects.toBeInstanceOf(RelayNotStarted);
    }
  });

  it('fails (rather than ending cleanly) when the stream breaks after it started', async () => {
    const r = remote([member('./a', '0', Buffer.alloc(2000, 1)).subarray(0, 1200)], { exitCode: null });
    await expect(relay(r)).rejects.toThrow(/ended inside a file/);
    const noEnd = remote([member('./a', '0', Buffer.from('x'))], { exitCode: null });
    await expect(relay(noEnd)).rejects.toThrow(/without its end blocks/);
  });

  it('reports a cancelled download as aborted and stops the remote tar', async () => {
    const source = new PassThrough();
    let stopped = 0;
    const r: RemoteTar = {
      source,
      exited: new Promise(() => {}),
      messages: () => [],
      stop: () => {
        stopped++;
      },
    };
    const controller = new AbortController();
    source.write(member('./big', '0', Buffer.alloc(4096)).subarray(0, 1024));
    const pending = relay(r, { signal: controller.signal });
    await new Promise((res) => setTimeout(res, 20));
    controller.abort(new Error('gone'));
    const { summary } = await pending;
    expect(summary.aborted).toBe(true);
    expect(stopped).toBeGreaterThan(0);
  });
});
