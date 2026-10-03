import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

/**
 * The client side of RFC 6455 WebSockets, just what the Kubernetes exec
 * subresource needs (spec §2.10) — no `ws` at runtime. The HTTP upgrade
 * itself is the API client's (client.ts `upgrade`, over the same verified
 * TLS route as every other call); this module only frames bytes on the
 * upgraded socket:
 *
 * - outgoing frames are masked (clients must), binary or close/pong;
 * - incoming frames are reassembled from fragments, pings answered,
 *   a close echoed; a message over {@link MAX_MESSAGE_BYTES} or a protocol
 *   violation fails the connection rather than buffering without bound.
 */

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest message accepted from the API server (exec output arrives in small frames). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** A fresh `Sec-WebSocket-Key`. */
export function websocketKey(): string {
  return randomBytes(16).toString('base64');
}

/** The `Sec-WebSocket-Accept` the server must answer `key` with. */
export function acceptFor(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** One frame; masked unless `mask` is false (servers and tests). */
export function encodeFrame(opcode: number, payload: Buffer, mask = true): Buffer {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (mask ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (mask ? 0x80 : 0) | (lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(length, 2);
  else if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!mask) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  key.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ key[i & 3]!;
  return Buffer.concat([header, masked]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export class WebSocketProtocolError extends Error {
  constructor(
    message: string,
    readonly closeCode = 1002,
  ) {
    super(message);
    this.name = 'WebSocketProtocolError';
  }
}

/** Incremental frame parser: push bytes, get whole frames. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxPayload = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) break;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      if (b0 & 0x70) throw new WebSocketProtocolError('Unexpected WebSocket extension bits');
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) break;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new WebSocketProtocolError('WebSocket message too large', 1009);
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxPayload) throw new WebSocketProtocolError('WebSocket message too large', 1009);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + length) break;
      let payload = buf.subarray(offset, offset + length);
      if (masked) {
        const key = buf.subarray(maskOffset, maskOffset + 4);
        const out = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) out[i] = payload[i]! ^ key[i & 3]!;
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
      this.buffer = buf.subarray(offset + length);
    }
    return frames;
  }
}

/**
 * A WebSocket over an already-upgraded socket. Events: `message` (payload,
 * binary), `close` (code, reason) once, `error`.
 */
export class WebSocketConnection extends EventEmitter {
  private readonly parser: FrameParser;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closeSent = false;
  private closed = false;

  constructor(
    readonly socket: Duplex,
    head: Buffer = Buffer.alloc(0),
    private readonly maxMessage = MAX_MESSAGE_BYTES,
  ) {
    super();
    this.parser = new FrameParser(maxMessage);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => {
      if (this.listenerCount('error')) this.emit('error', err);
    });
    socket.on('close', () => this.finish(1006, ''));
    if (head.length) queueMicrotask(() => this.onData(head));
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  private onData(chunk: Buffer) {
    if (this.closed) return;
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.fail(err as WebSocketProtocolError);
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      this.onFrame(frame);
    }
  }

  private onFrame({ fin, opcode, payload }: Frame) {
    if (opcode >= 8) {
      if (!fin || payload.length > 125) return this.fail(new WebSocketProtocolError('Invalid WebSocket control frame'));
      if (opcode === OPCODE.ping) return this.write(OPCODE.pong, payload);
      if (opcode === OPCODE.pong) return;
      if (opcode === OPCODE.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code);
        this.finish(code, reason);
        this.socket.end();
        return;
      }
      return this.fail(new WebSocketProtocolError(`Unknown WebSocket opcode ${opcode}`));
    }
    if (opcode === OPCODE.continuation) {
      if (!this.fragmentOpcode) return this.fail(new WebSocketProtocolError('Unexpected continuation frame'));
    } else {
      if (this.fragmentOpcode) return this.fail(new WebSocketProtocolError('Expected a continuation frame'));
      if (opcode !== OPCODE.text && opcode !== OPCODE.binary) {
        return this.fail(new WebSocketProtocolError(`Unknown WebSocket opcode ${opcode}`));
      }
      if (fin) return void this.emit('message', payload, opcode === OPCODE.binary);
      this.fragmentOpcode = opcode;
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessage) return this.fail(new WebSocketProtocolError('WebSocket message too large', 1009));
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    const binary = this.fragmentOpcode === OPCODE.binary;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.emit('message', message, binary);
  }

  private write(opcode: number, payload: Buffer): boolean {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(encodeFrame(opcode, payload));
  }

  /** Send a binary message; false when closed (or the socket wants a drain). */
  send(data: Buffer): boolean {
    if (this.closeSent) return false;
    return this.write(OPCODE.binary, data);
  }

  private sendClose(code: number, reason = '') {
    if (this.closeSent) return;
    this.closeSent = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(OPCODE.close, body);
  }

  /** Start the closing handshake; the socket is destroyed if the server does not finish it in time. */
  close(code = 1000, reason = '', timeoutMs = 2_000): void {
    if (this.closed) return;
    this.sendClose(code, reason);
    const timer = setTimeout(() => this.destroy(), timeoutMs);
    timer.unref?.();
    this.once('close', () => clearTimeout(timer));
  }

  destroy(): void {
    this.socket.destroy();
    this.finish(1006, '');
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  private fail(err: WebSocketProtocolError) {
    if (this.closed) return;
    if (this.listenerCount('error')) this.emit('error', err);
    this.sendClose(err.closeCode);
    this.socket.destroy();
    this.finish(err.closeCode, err.message);
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}
