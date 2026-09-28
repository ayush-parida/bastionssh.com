/**
 * Wire format between the BastionSSH app and a connectivity agent.
 *
 * The agent keeps one WebSocket open to the app and carries any number of TCP
 * streams over it. Every binary WebSocket message is exactly one frame:
 *
 *   ┌──────────┬────────────────────┬─────────────────┐
 *   │ type: u8 │ stream id: u32 BE  │ payload (0..N)  │
 *   └──────────┴────────────────────┴─────────────────┘
 *
 * - OPEN   app → agent. Payload: local port, u16 BE. The agent only ever dials
 *          its own loopback, and only ports on its allowlist; the app cannot
 *          name a host.
 * - OPENED agent → app. The TCP connection is up; DATA may flow.
 * - DATA   either way. Payload: raw bytes of the stream.
 * - CLOSE  either way. The sender is done with the stream; the receiver tears
 *          it down and does not answer with its own CLOSE.
 * - ERROR  either way. Payload: UTF-8 JSON `{ message, code? }`. Ends the
 *          stream (an OPEN that failed, a socket error, a protocol violation).
 *
 * Stream ids are chosen by the app, which is the only side that opens streams.
 * WebSocket message boundaries delimit frames, so no length prefix is needed.
 */

export const FrameType = {
  OPEN: 1,
  OPENED: 2,
  DATA: 3,
  CLOSE: 4,
  ERROR: 5,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const HEADER_BYTES = 5;

/** Largest DATA payload a sender produces; bigger writes are split. */
export const MAX_DATA_PAYLOAD = 64 * 1024;

/** Largest frame a receiver accepts (the WebSocket `maxPayload`). */
export const MAX_FRAME_BYTES = HEADER_BYTES + MAX_DATA_PAYLOAD;

/** Longest ERROR message kept; the rest is cut off. */
const MAX_ERROR_MESSAGE = 512;

export const MAX_STREAM_ID = 0xffff_ffff;

/** WebSocket close codes the app uses when it ends an agent connection. */
export const AgentCloseCode = {
  /** The agent was revoked; its token will not be accepted again. */
  REVOKED: 4401,
  /** A newer connection authenticated with the same token. */
  REPLACED: 4409,
  /** The agent broke the protocol. */
  PROTOCOL_ERROR: 4400,
} as const;

/** Request header carrying the agent's version string. */
export const AGENT_VERSION_HEADER = 'x-bastion-agent-version';
/** Request header listing the local ports the agent will open, e.g. `22,2222`. */
export const AGENT_PORTS_HEADER = 'x-bastion-agent-ports';

/** Path the agent connects to, relative to the app's base URL. */
export const AGENT_CONNECT_PATH = '/api/agents/connect';

export type Frame =
  | { type: typeof FrameType.OPEN; streamId: number; port: number }
  | { type: typeof FrameType.OPENED; streamId: number }
  | { type: typeof FrameType.DATA; streamId: number; data: Buffer }
  | { type: typeof FrameType.CLOSE; streamId: number }
  | { type: typeof FrameType.ERROR; streamId: number; message: string; code?: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function assertStreamId(streamId: number) {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new ProtocolError(`Invalid stream id ${streamId}`);
  }
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function header(type: FrameType, streamId: number, payloadBytes: number): Buffer {
  assertStreamId(streamId);
  const buf = Buffer.allocUnsafe(HEADER_BYTES + payloadBytes);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId, 1);
  return buf;
}

export function encodeOpen(streamId: number, port: number): Buffer {
  if (!isValidPort(port)) throw new ProtocolError(`Invalid port ${port}`);
  const buf = header(FrameType.OPEN, streamId, 2);
  buf.writeUInt16BE(port, HEADER_BYTES);
  return buf;
}

export function encodeOpened(streamId: number): Buffer {
  return header(FrameType.OPENED, streamId, 0);
}

export function encodeClose(streamId: number): Buffer {
  return header(FrameType.CLOSE, streamId, 0);
}

/** One DATA frame; `data` must fit in {@link MAX_DATA_PAYLOAD}. See {@link encodeDataFrames}. */
export function encodeData(streamId: number, data: Uint8Array): Buffer {
  if (data.length > MAX_DATA_PAYLOAD) {
    throw new ProtocolError(`DATA payload of ${data.length} bytes exceeds ${MAX_DATA_PAYLOAD}`);
  }
  const buf = header(FrameType.DATA, streamId, data.length);
  buf.set(data, HEADER_BYTES);
  return buf;
}

/** DATA frames for `data`, split so none exceeds {@link MAX_DATA_PAYLOAD}. */
export function encodeDataFrames(streamId: number, data: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_DATA_PAYLOAD) {
    frames.push(encodeData(streamId, data.subarray(offset, offset + MAX_DATA_PAYLOAD)));
  }
  return frames;
}

export function encodeError(streamId: number, message: string, code?: string): Buffer {
  const body = Buffer.from(
    JSON.stringify({ message: message.slice(0, MAX_ERROR_MESSAGE), ...(code && { code: code.slice(0, 64) }) }),
    'utf8',
  );
  const buf = header(FrameType.ERROR, streamId, body.length);
  body.copy(buf, HEADER_BYTES);
  return buf;
}

/**
 * Parse one frame. Throws {@link ProtocolError} for anything malformed: the
 * peer is not trusted, so an odd frame ends the connection rather than being
 * guessed at.
 */
export function decodeFrame(raw: Uint8Array): Frame {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.length < HEADER_BYTES) throw new ProtocolError(`Frame of ${buf.length} bytes is too short`);
  if (buf.length > MAX_FRAME_BYTES) throw new ProtocolError(`Frame of ${buf.length} bytes is too long`);
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const payload = buf.subarray(HEADER_BYTES);

  switch (type) {
    case FrameType.OPEN: {
      if (payload.length !== 2) throw new ProtocolError('OPEN frame must carry a 2-byte port');
      const port = payload.readUInt16BE(0);
      if (!isValidPort(port)) throw new ProtocolError(`Invalid port ${port}`);
      return { type, streamId, port };
    }
    case FrameType.OPENED:
    case FrameType.CLOSE:
      if (payload.length !== 0) throw new ProtocolError(`Frame type ${type} carries no payload`);
      return { type, streamId };
    case FrameType.DATA:
      return { type, streamId, data: payload };
    case FrameType.ERROR: {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new ProtocolError('ERROR frame payload is not JSON');
      }
      const { message, code } = (parsed ?? {}) as { message?: unknown; code?: unknown };
      if (typeof message !== 'string') throw new ProtocolError('ERROR frame has no message');
      return {
        type,
        streamId,
        message: message.slice(0, MAX_ERROR_MESSAGE),
        ...(typeof code === 'string' && { code: code.slice(0, 64) }),
      };
    }
    default:
      throw new ProtocolError(`Unknown frame type ${type}`);
  }
}

/**
 * Parse a port allowlist such as `22` or `22, 2222`. Throws on anything that
 * is not a list of valid ports, so a typo cannot silently open more than meant.
 */
export function parsePortList(raw: string): number[] {
  const ports = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (!/^\d+$/.test(p)) throw new Error(`"${p}" is not a port number`);
      const port = Number(p);
      if (!isValidPort(port)) throw new Error(`${port} is not a valid port`);
      return port;
    });
  if (!ports.length) throw new Error('At least one port is required');
  return [...new Set(ports)];
}

/** `ws://` or `wss://` URL of the connect endpoint for an app base URL. */
export function connectUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported URL scheme ${url.protocol}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + AGENT_CONNECT_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}
