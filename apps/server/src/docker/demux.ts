import { Transform, type TransformCallback } from 'node:stream';

/**
 * Docker multiplexes stdout and stderr of a container without a TTY into one
 * stream of frames: an 8-byte header — stream type (0 stdin, 1 stdout,
 * 2 stderr), three zero bytes, payload length as uint32 big-endian — then the
 * payload. Containers with a TTY send raw bytes instead; callers pick by the
 * container's `Config.Tty`.
 */

export type DockerStreamType = 'stdin' | 'stdout' | 'stderr';

export interface DemuxedChunk {
  stream: DockerStreamType;
  payload: Buffer;
}

const HEADER_BYTES = 8;
const STREAMS: Record<number, DockerStreamType> = { 0: 'stdin', 1: 'stdout', 2: 'stderr' };
/** Highest type byte in a header: 3 is the engine's own error stream ("systemerr"). */
const MAX_STREAM_TYPE = 3;

/**
 * Incremental frame parser: feed it bytes as they arrive, get back the
 * complete frames. A frame split across reads is held until its tail arrives.
 */
export class Demuxer {
  private buffer: Buffer = Buffer.alloc(0);
  /** Set once the bytes turned out not to be framed (see {@link push}). */
  private raw = false;

  push(chunk: Buffer): DemuxedChunk[] {
    if (this.raw) return chunk.length > 0 ? [{ stream: 'stdout', payload: chunk }] : [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DemuxedChunk[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const type = this.buffer[0]!;
      // Not a frame header (a TTY container's raw output, e.g. one recreated
      // with a TTY since it was inspected): pass the bytes through as they
      // are, rather than wait — and buffer — for a "length" read from text
      if (type > MAX_STREAM_TYPE || this.buffer[1] !== 0 || this.buffer[2] !== 0 || this.buffer[3] !== 0) {
        this.raw = true;
        frames.push({ stream: 'stdout', payload: this.buffer });
        this.buffer = Buffer.alloc(0);
        break;
      }
      const length = this.buffer.readUInt32BE(4);
      if (this.buffer.length < HEADER_BYTES + length) break;
      frames.push({
        // An unknown type (never sent today) is treated as stdout rather than dropped
        stream: STREAMS[type] ?? 'stdout',
        payload: this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return frames;
  }

  /** Bytes of an unfinished frame still held. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Every complete frame in `buf` (tests and one-shot bodies). */
export function demuxBuffer(buf: Buffer): DemuxedChunk[] {
  return new Demuxer().push(buf);
}

/** Object-mode transform: multiplexed bytes in, {@link DemuxedChunk}s out. */
export function demuxStream(): Transform {
  const demuxer = new Demuxer();
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      for (const frame of demuxer.push(chunk)) this.push(frame);
      callback();
    },
  });
}

/**
 * Split a stream's text into lines, holding back an unfinished last line until
 * more arrives (or {@link LineSplitter.flush} at the end). Lines longer than
 * `maxLine` are cut so one runaway line cannot grow the buffer without bound.
 */
export class LineSplitter {
  private partial = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly maxLine = 64 * 1024) {}

  push(chunk: Buffer): string[] {
    const text = this.partial + this.decoder.decode(chunk, { stream: true });
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    const lines = parts.map((line) => line.replace(/\r$/, ''));
    while (this.partial.length > this.maxLine) {
      lines.push(this.partial.slice(0, this.maxLine));
      this.partial = this.partial.slice(this.maxLine);
    }
    return lines;
  }

  flush(): string[] {
    const rest = this.partial + this.decoder.decode();
    this.partial = '';
    return rest ? [rest.replace(/\r$/, '')] : [];
  }
}
