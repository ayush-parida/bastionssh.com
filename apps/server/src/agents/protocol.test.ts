import { describe, it, expect } from 'vitest';
import {
  FrameType,
  HEADER_BYTES,
  MAX_DATA_PAYLOAD,
  MAX_STREAM_ID,
  ProtocolError,
  connectUrl,
  decodeFrame,
  encodeClose,
  encodeData,
  encodeDataFrames,
  encodeError,
  encodeOpen,
  encodeOpened,
  parsePortList,
} from '@smt/agent';

/** The agent wire format (packages/agent/src/protocol.ts), shared by both ends. */

function frame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId, 1);
  return Buffer.concat([header, payload]);
}

describe('agent frame encoding', () => {
  it('round-trips every frame type', () => {
    expect(decodeFrame(encodeOpen(7, 22))).toEqual({ type: FrameType.OPEN, streamId: 7, port: 22 });
    expect(decodeFrame(encodeOpened(7))).toEqual({ type: FrameType.OPENED, streamId: 7 });
    expect(decodeFrame(encodeClose(MAX_STREAM_ID))).toEqual({ type: FrameType.CLOSE, streamId: MAX_STREAM_ID });

    const data = decodeFrame(encodeData(9, Buffer.from('hello')));
    expect(data.type).toBe(FrameType.DATA);
    expect(data.streamId).toBe(9);
    expect((data as { data: Buffer }).data.toString()).toBe('hello');

    expect(decodeFrame(encodeError(3, 'connect refused', 'ECONNREFUSED'))).toEqual({
      type: FrameType.ERROR,
      streamId: 3,
      message: 'connect refused',
      code: 'ECONNREFUSED',
    });
    expect(decodeFrame(encodeError(3, 'no code'))).toEqual({ type: FrameType.ERROR, streamId: 3, message: 'no code' });
  });

  it('lays the header out as type u8 then stream id u32 BE', () => {
    const buf = encodeOpen(0x01020304, 2222);
    expect([...buf]).toEqual([FrameType.OPEN, 1, 2, 3, 4, 0x08, 0xae]);
  });

  it('accepts an empty DATA frame and a Uint8Array view', () => {
    expect((decodeFrame(encodeData(1, new Uint8Array())) as { data: Buffer }).data.length).toBe(0);
    const backing = new Uint8Array(32);
    const encoded = encodeData(5, Buffer.from('xyz'));
    backing.set(encoded, 10);
    const view = backing.subarray(10, 10 + encoded.length);
    expect((decodeFrame(view) as { data: Buffer }).data.toString()).toBe('xyz');
  });

  it('splits large writes into frames no bigger than the maximum payload', () => {
    const big = Buffer.alloc(MAX_DATA_PAYLOAD * 2 + 10, 0xab);
    const frames = encodeDataFrames(4, big);
    expect(frames.map((f) => f.length - HEADER_BYTES)).toEqual([MAX_DATA_PAYLOAD, MAX_DATA_PAYLOAD, 10]);
    const joined = Buffer.concat(frames.map((f) => (decodeFrame(f) as { data: Buffer }).data));
    expect(joined.equals(big)).toBe(true);
    expect(encodeDataFrames(4, Buffer.alloc(0))).toEqual([]);
    expect(() => encodeData(4, Buffer.alloc(MAX_DATA_PAYLOAD + 1))).toThrow(ProtocolError);
  });

  it('truncates long error messages and codes', () => {
    const decoded = decodeFrame(encodeError(1, 'x'.repeat(5000), 'C'.repeat(200))) as { message: string; code: string };
    expect(decoded.message.length).toBe(512);
    expect(decoded.code.length).toBe(64);
  });

  it('refuses invalid ports and stream ids when encoding', () => {
    expect(() => encodeOpen(1, 0)).toThrow(ProtocolError);
    expect(() => encodeOpen(1, 65536)).toThrow(ProtocolError);
    expect(() => encodeOpen(1, 22.5)).toThrow(ProtocolError);
    expect(() => encodeOpened(-1)).toThrow(ProtocolError);
    expect(() => encodeClose(MAX_STREAM_ID + 1)).toThrow(ProtocolError);
  });
});

describe('agent frame decoding of untrusted input', () => {
  it.each([
    ['a frame shorter than the header', Buffer.from([FrameType.DATA, 0, 0])],
    ['an unknown type', frame(99, 1)],
    ['an OPEN without a port', frame(FrameType.OPEN, 1)],
    ['an OPEN with a 3-byte port', frame(FrameType.OPEN, 1, Buffer.from([0, 22, 0]))],
    ['an OPEN to port 0', frame(FrameType.OPEN, 1, Buffer.from([0, 0]))],
    ['an OPENED with a payload', frame(FrameType.OPENED, 1, Buffer.from('x'))],
    ['a CLOSE with a payload', frame(FrameType.CLOSE, 1, Buffer.from('x'))],
    ['an ERROR that is not JSON', frame(FrameType.ERROR, 1, Buffer.from('nope'))],
    ['an ERROR without a message', frame(FrameType.ERROR, 1, Buffer.from('{"code":"X"}'))],
    ['an ERROR whose JSON is null', frame(FrameType.ERROR, 1, Buffer.from('null'))],
    ['an oversized frame', frame(FrameType.DATA, 1, Buffer.alloc(MAX_DATA_PAYLOAD + 1))],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodeFrame(raw)).toThrow(ProtocolError);
  });

  it('ignores a non-string error code', () => {
    const raw = frame(FrameType.ERROR, 1, Buffer.from('{"message":"m","code":42}'));
    expect(decodeFrame(raw)).toEqual({ type: FrameType.ERROR, streamId: 1, message: 'm' });
  });
});

describe('agent configuration helpers', () => {
  it('parses a port allowlist strictly', () => {
    expect(parsePortList('22')).toEqual([22]);
    expect(parsePortList(' 22, 2222 ,22')).toEqual([22, 2222]);
    expect(() => parsePortList('')).toThrow();
    expect(() => parsePortList('22,abc')).toThrow();
    expect(() => parsePortList('0')).toThrow();
    expect(() => parsePortList('70000')).toThrow();
    expect(() => parsePortList('22-80')).toThrow();
  });

  it('derives the WebSocket URL from the app URL', () => {
    expect(connectUrl('https://ssh.example.com')).toBe('wss://ssh.example.com/api/agents/connect');
    expect(connectUrl('https://ssh.example.com/base/?x=1#h')).toBe('wss://ssh.example.com/base/api/agents/connect');
    expect(connectUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/api/agents/connect');
    expect(connectUrl('wss://a.test')).toBe('wss://a.test/api/agents/connect');
    expect(() => connectUrl('ftp://a.test')).toThrow();
  });
});
