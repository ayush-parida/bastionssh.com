import type { Writable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Writes into the response (or the gzip stream in front of it) and waits for
 * `drain` whenever the consumer is behind, so a slow browser slows the remote
 * read instead of growing a buffer. Rejects once the destination fails, closes
 * or the archive is aborted.
 */
export class ByteSink {
  /** Bytes accepted so far — the next write's offset in the archive. */
  offset = 0;
  private failure: Error | null = null;

  constructor(
    private readonly out: Writable,
    private readonly signal: AbortSignal,
  ) {
    out.on('error', (err) => {
      this.failure ??= err;
    });
  }

  async write(chunk: Buffer): Promise<void> {
    this.check();
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    if (this.out.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        this.out.off('drain', onDrain);
        this.out.off('close', onClose);
        this.out.off('error', onError);
        this.signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('The download connection closed'));
      const onError = (err: Error) => done(err);
      const onAbort = () => done(abortError(this.signal));
      this.out.once('drain', onDrain);
      this.out.once('close', onClose);
      this.out.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private check(): void {
    if (this.signal.aborted) throw abortError(this.signal);
    if (this.failure) throw this.failure;
    if (this.out.destroyed || this.out.writableEnded) throw new Error('The download connection closed');
  }
}

export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('Folder download cancelled');
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zip's), continuing from `prev`: zlib's native one where Node has it, a table otherwise. */
export function crc32(data: Buffer, prev = 0): number {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data, prev);
  let c = ~prev >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
