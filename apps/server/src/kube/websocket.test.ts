import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { FrameParser, OPCODE, WebSocketConnection, acceptFor, encodeFrame } from './websocket.js';

/** The exec WebSocket's framing (websocket.ts), without a network. */

function socketPair() {
  const written: Buffer[] = [];
  const socket = new PassThrough();
  socket.write = ((chunk: Buffer, _enc?: unknown, cb?: () => void) => {
    written.push(Buffer.from(chunk));
    cb?.();
    return true;
  }) as typeof socket.write;
  return { socket, written };
}

describe('websocket framing', () => {
  it('computes the handshake accept value of RFC 6455', () => {
    expect(acceptFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips masked and unmasked frames of every length class', () => {
    const parser = new FrameParser();
    for (const size of [0, 5, 125, 126, 300, 65535, 65536, 200_000]) {
      const payload = Buffer.alloc(size, 7);
      for (const mask of [true, false]) {
        const frames = parser.push(encodeFrame(OPCODE.binary, payload, mask));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.payload.equals(payload)).toBe(true);
        expect(frames[0]!.fin).toBe(true);
      }
    }
  });

  it('masks what the client sends', () => {
    const frame = encodeFrame(OPCODE.binary, Buffer.from('secret'));
    expect(frame[1]! & 0x80).toBe(0x80);
    expect(frame.includes(Buffer.from('secret'))).toBe(false);
  });

  it('parses frames split at any byte', () => {
    const bytes = Buffer.concat([encodeFrame(OPCODE.binary, Buffer.from('hello'), false), encodeFrame(OPCODE.text, Buffer.alloc(300, 1), false)]);
    const parser = new FrameParser();
    const frames = [];
    for (let i = 0; i < bytes.length; i++) frames.push(...parser.push(bytes.subarray(i, i + 1)));
    expect(frames.map((f) => f.payload.length)).toEqual([5, 300]);
  });

  it('refuses a message over the cap instead of buffering it', () => {
    const parser = new FrameParser(1024);
    expect(() => parser.push(encodeFrame(OPCODE.binary, Buffer.alloc(2048), false))).toThrow(/too large/);
  });

  it('reassembles fragments, answers pings and echoes a close', async () => {
    const { socket, written } = socketPair();
    const ws = new WebSocketConnection(socket);
    const messages: string[] = [];
    let closed: number | null = null;
    ws.on('message', (m: Buffer) => messages.push(m.toString()));
    ws.on('close', (code: number) => (closed = code));
    const first = encodeFrame(OPCODE.binary, Buffer.from('hel'), false);
    first[0] = first[0]! & 0x7f; // not final
    const rest = encodeFrame(OPCODE.continuation, Buffer.from('lo'), false);
    socket.push(Buffer.concat([first, encodeFrame(OPCODE.ping, Buffer.from('p'), false), rest]));
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual(['hello']);
    const pong = new FrameParser().push(written[0]!)[0]!;
    expect(pong.opcode).toBe(OPCODE.pong);
    expect(pong.payload.toString()).toBe('p');

    const close = Buffer.alloc(2);
    close.writeUInt16BE(1000);
    socket.push(encodeFrame(OPCODE.close, close, false));
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(1000);
    expect(new FrameParser().push(written.at(-1)!)[0]!.opcode).toBe(OPCODE.close);
    expect(ws.send(Buffer.from('late'))).toBe(false);
  });

  it('fails the connection on a protocol error', async () => {
    const { socket } = socketPair();
    const ws = new WebSocketConnection(socket);
    const errors: Error[] = [];
    ws.on('error', (e: Error) => errors.push(e));
    socket.push(encodeFrame(OPCODE.continuation, Buffer.from('x'), false));
    await new Promise((r) => setImmediate(r));
    expect(errors[0]?.message).toMatch(/continuation/);
    expect(socket.destroyed).toBe(true);
  });
});
