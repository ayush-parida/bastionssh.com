import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import logger from '../logger.js';

/**
 * Streams an asciicast v2 file (https://docs.asciinema.org/manual/asciicast/v2/):
 * a JSON header line, then one `[seconds, code, data]` event per line. Codes
 * used here: `o` output, `i` input, `r` resize ("COLSxROWS"), `m` marker.
 *
 * Writes are appended as they happen so a crash loses at most what the OS had
 * not flushed. Once the cast reaches `maxBytes` a truncation marker is written
 * and everything after it is dropped. `finish()` gzips the file.
 */

/** Shown in the player where a recording stopped because it hit the size cap. */
export const TRUNCATION_NOTICE = '\r\n\x1b[33m[Recording truncated: size limit reached]\x1b[0m\r\n';

/** Room kept below the cap so the truncation events always fit. */
const TRUNCATION_RESERVE = 256;

export interface CastHeader {
  width: number;
  height: number;
  /** Unix seconds. */
  timestamp: number;
  title?: string;
  env?: Record<string, string>;
}

export interface CastWriterOptions {
  /** Where the uncompressed cast is written while recording. */
  file: string;
  header: CastHeader;
  maxBytes: number;
  /** Turn bare `\n` into `\r\n`: output from an exec channel has no pty to do it. */
  crlf?: boolean;
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
}

export interface CastResult {
  /** The gzipped cast, or the raw one if compressing failed. */
  file: string;
  /** Uncompressed size. */
  bytes: number;
  truncated: boolean;
}

export type CastWriter = ReturnType<typeof createCastWriter>;

export function createCastWriter(opts: CastWriterOptions) {
  fs.mkdirSync(path.dirname(opts.file), { recursive: true, mode: 0o700 });
  // `wx`: never append to (or clobber) some other recording's file
  const out = fs.createWriteStream(opts.file, { flags: 'wx', mode: 0o600 });
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const decoders = { o: new StringDecoder('utf8'), i: new StringDecoder('utf8') };

  let bytes = 0;
  let truncated = false;
  let failed = false;
  let ending: Promise<CastResult> | null = null;

  out.on('error', (err) => {
    failed = true;
    logger.error({ err, file: opts.file }, 'Recording write failed');
  });

  function writeLine(line: string) {
    out.write(line + '\n');
    bytes += Buffer.byteLength(line) + 1;
  }

  /** Seconds since the start, to the microsecond like asciinema itself. */
  function elapsed() {
    return Math.round(Math.max(0, now() - started) * 1000) / 1_000_000;
  }

  function event(code: 'o' | 'i' | 'r' | 'm', data: string) {
    if (!data || truncated || failed || ending) return;
    const line = JSON.stringify([elapsed(), code, data]);
    if (bytes + Buffer.byteLength(line) + 1 > opts.maxBytes - TRUNCATION_RESERVE) {
      truncated = true;
      const t = elapsed();
      writeLine(JSON.stringify([t, 'm', 'truncated']));
      writeLine(JSON.stringify([t, 'o', TRUNCATION_NOTICE]));
      return;
    }
    writeLine(line);
  }

  function text(data: Buffer | string, decoder: StringDecoder) {
    const s = typeof data === 'string' ? data : decoder.write(data);
    return opts.crlf ? s.replace(/\r?\n/g, '\r\n') : s;
  }

  writeLine(JSON.stringify({ version: 2, ...opts.header }));

  async function closeStream() {
    if (out.closed) return;
    await new Promise<void>((resolve) => {
      out.end(() => resolve());
      // An errored stream never calls back from end()
      out.once('error', () => resolve());
    });
  }

  return {
    output(data: Buffer | string) {
      event('o', text(data, decoders.o));
    },
    input(data: Buffer | string) {
      event('i', text(data, decoders.i));
    },
    resize(cols: number, rows: number) {
      event('r', `${cols}x${rows}`);
    },
    marker(label: string) {
      event('m', label);
    },
    /** Seconds since the recording started. */
    elapsed,
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    /** Flush, close and gzip the cast. Safe to call more than once. */
    finish(): Promise<CastResult> {
      if (ending) return ending;
      // Anything a decoder was holding back (half a UTF-8 sequence) goes out first
      const tail = decoders.o.end();
      if (tail) event('o', tail);
      ending = (async () => {
        await closeStream();
        const gz = `${opts.file}.gz`;
        try {
          await pipeline(fs.createReadStream(opts.file), createGzip(), fs.createWriteStream(gz, { mode: 0o600 }));
          await fs.promises.unlink(opts.file);
          return { file: gz, bytes, truncated };
        } catch (err) {
          logger.error({ err, file: opts.file }, 'Could not compress recording; keeping it uncompressed');
          await fs.promises.unlink(gz).catch(() => {});
          return { file: opts.file, bytes, truncated };
        }
      })();
      return ending;
    },
    /** Close and delete the cast — the session never got as far as a shell. */
    async discard(): Promise<void> {
      if (!ending) ending = Promise.resolve({ file: opts.file, bytes, truncated });
      await closeStream();
      await fs.promises.unlink(opts.file).catch(() => {});
    },
  };
}

/** Gzip a cast left behind by a crash or restart; returns the new path. */
export async function compressCast(file: string): Promise<string> {
  const gz = `${file}.gz`;
  await pipeline(fs.createReadStream(file), createGzip(), fs.createWriteStream(gz, { mode: 0o600 }));
  await fs.promises.unlink(file);
  return gz;
}
