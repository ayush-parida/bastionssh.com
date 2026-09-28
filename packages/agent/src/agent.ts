import net from 'node:net';
import WebSocket from 'ws';
import {
  AGENT_PORTS_HEADER,
  AGENT_VERSION_HEADER,
  AgentCloseCode,
  FrameType,
  MAX_FRAME_BYTES,
  ProtocolError,
  connectUrl,
  decodeFrame,
  encodeClose,
  encodeDataFrames,
  encodeError,
  encodeOpened,
} from './protocol.js';
import { AGENT_VERSION } from './version.js';

/**
 * The connectivity agent: keeps one outbound WebSocket to the app and, when
 * the app asks, opens TCP connections to this host's loopback on allowlisted
 * ports and pipes bytes both ways. It never dials anything else — the app
 * names a port, never a host.
 *
 * The agent is only a transport. SSH runs end to end between the app and the
 * local sshd, so the app still verifies the host key and the agent never sees
 * credentials or plaintext.
 */

/** Only ever dialled address: this host's own loopback. */
export const LOCAL_HOST = '127.0.0.1';

export interface AgentLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AgentOptions {
  /** The app's base URL, e.g. https://ssh.example.com. */
  url: string;
  /** The agent token shown once when the agent was created. */
  token: string;
  /** Local ports the app may open. Default: 22 only. */
  allowedPorts?: number[];
  /** Permit ws:// to a non-loopback app, sending the token in the clear. */
  allowInsecure?: boolean;
  /** Most streams open at once. */
  maxStreams?: number;
  /** Reconnect backoff bounds. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Treat the link as dead when nothing (not even a ping) arrives for this long. */
  idleTimeoutMs?: number;
  logger?: AgentLogger;
  /** Reported to the app; defaults to this package's version. */
  version?: string;
}

export type AgentState = 'connecting' | 'connected' | 'waiting' | 'stopped';

export interface AgentHandle {
  readonly state: AgentState;
  /** Number of TCP streams currently open. */
  readonly openStreams: number;
  /** Resolves once connected (again); rejects if stopped first. */
  connected(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_MAX_STREAMS = 64;
const CONNECT_TIMEOUT_MS = 10_000;
/** Pause local sockets while this much is queued on the WebSocket… */
const WS_HIGH_WATER = 4 * 1024 * 1024;
/** …and resume them once it has drained below this. */
const WS_LOW_WATER = 1024 * 1024;
/** A local socket that stops reading while the app keeps sending is cut off here. */
const SOCKET_MAX_BUFFER = 16 * 1024 * 1024;
/** How long a connection must last before the backoff starts over. */
const STABLE_AFTER_MS = 30_000;
/** Backoff after the app refuses the token: no point hammering it. */
const REJECTED_BACKOFF_MS = 5 * 60_000;

const consoleLogger: AgentLogger = {
  info: (m) => console.log(`${new Date().toISOString()} INFO ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

interface LocalStream {
  socket: net.Socket;
  /** The app closed or errored the stream; do not report back. */
  done: boolean;
}

export function startAgent(options: AgentOptions): AgentHandle {
  const log = options.logger ?? consoleLogger;
  const allowed = new Set(options.allowedPorts?.length ? options.allowedPorts : [22]);
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  const initialBackoff = options.backoff?.initialMs ?? 1_000;
  const maxBackoff = options.backoff?.maxMs ?? 60_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 75_000;
  const version = options.version ?? AGENT_VERSION;
  const target = connectUrl(options.url);

  const parsedTarget = new URL(target);
  if (parsedTarget.protocol === 'ws:' && !isLoopbackHost(parsedTarget.hostname) && !options.allowInsecure) {
    throw new Error(
      `Refusing to send the agent token over unencrypted ${parsedTarget.protocol}// to ${parsedTarget.host}. ` +
        'Use an https:// URL, or set BASTION_ALLOW_INSECURE=1 to accept the risk.',
    );
  }

  let state: AgentState = 'connecting';
  let ws: WebSocket | undefined;
  let backoff = initialBackoff;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const streams = new Map<number, LocalStream>();
  const paused = new Set<net.Socket>();
  let waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  function setState(next: AgentState) {
    state = next;
    if (next === 'connected') {
      const ready = waiters;
      waiters = [];
      ready.forEach((w) => w.resolve());
    }
  }

  function send(socket: WebSocket, frame: Buffer) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(frame, { binary: true }, () => maybeResume(socket));
  }

  function maybeResume(socket: WebSocket) {
    if (!paused.size || socket.bufferedAmount > WS_LOW_WATER) return;
    for (const s of paused) s.resume();
    paused.clear();
  }

  function destroyAll() {
    for (const stream of streams.values()) {
      stream.done = true;
      stream.socket.destroy();
    }
    streams.clear();
    paused.clear();
  }

  function resetIdle(socket: WebSocket) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.warn(`Nothing heard from the app for ${Math.round(idleTimeoutMs / 1000)}s — reconnecting`);
      socket.terminate();
    }, idleTimeoutMs);
  }

  function openStream(socket: WebSocket, streamId: number, port: number) {
    if (streams.has(streamId)) {
      send(socket, encodeError(streamId, 'Stream id already in use', 'ESTREAMINUSE'));
      return;
    }
    if (!allowed.has(port)) {
      log.warn(`Refused to open local port ${port}: not in the allowlist`);
      send(socket, encodeError(streamId, `Port ${port} is not allowed by this agent`, 'EPORTNOTALLOWED'));
      return;
    }
    if (streams.size >= maxStreams) {
      send(socket, encodeError(streamId, `Too many open streams (${maxStreams})`, 'ETOOMANYSTREAMS'));
      return;
    }

    const local = net.connect({ host: LOCAL_HOST, port });
    const stream: LocalStream = { socket: local, done: false };
    streams.set(streamId, stream);
    local.setNoDelay(true);
    local.setTimeout(CONNECT_TIMEOUT_MS, () => {
      local.destroy(Object.assign(new Error(`Timed out connecting to port ${port}`), { code: 'ETIMEDOUT' }));
    });

    local.once('connect', () => {
      local.setTimeout(0);
      send(socket, encodeOpened(streamId));
    });
    local.on('data', (chunk: Buffer) => {
      // The app already closed the stream (the socket is draining or connecting)
      if (stream.done) return;
      for (const frame of encodeDataFrames(streamId, chunk)) send(socket, frame);
      if (socket.bufferedAmount > WS_HIGH_WATER && !paused.has(local)) {
        local.pause();
        paused.add(local);
      }
    });
    local.on('error', (err: NodeJS.ErrnoException) => {
      if (stream.done) return;
      stream.done = true;
      send(socket, encodeError(streamId, err.message, err.code));
    });
    local.on('close', () => {
      paused.delete(local);
      if (streams.get(streamId) === stream) streams.delete(streamId);
      if (stream.done) return;
      stream.done = true;
      send(socket, encodeClose(streamId));
    });
  }

  function onFrame(socket: WebSocket, raw: Buffer) {
    const frame = decodeFrame(raw);
    switch (frame.type) {
      case FrameType.OPEN:
        openStream(socket, frame.streamId, frame.port);
        return;
      case FrameType.DATA: {
        const stream = streams.get(frame.streamId);
        if (!stream || stream.done) return; // raced with a close
        stream.socket.write(frame.data);
        if (stream.socket.writableLength > SOCKET_MAX_BUFFER) {
          stream.done = true;
          send(socket, encodeError(frame.streamId, 'Local socket is not reading', 'EOVERFLOW'));
          stream.socket.destroy();
        }
        return;
      }
      case FrameType.CLOSE:
      case FrameType.ERROR: {
        const stream = streams.get(frame.streamId);
        if (!stream) return;
        stream.done = true;
        streams.delete(frame.streamId);
        if (frame.type === FrameType.CLOSE) {
          // Let queued bytes reach the local server, then make sure it goes
          stream.socket.end();
          setTimeout(() => stream.socket.destroy(), 5_000).unref();
        } else {
          stream.socket.destroy();
        }
        return;
      }
      default:
        throw new ProtocolError(`Unexpected frame type ${frame.type} from the app`);
    }
  }

  function scheduleReconnect(delay: number) {
    if (state === 'stopped') return;
    setState('waiting');
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    log.info(`Reconnecting in ${Math.round(jittered / 1000)}s`);
    retryTimer = setTimeout(connect, jittered);
    backoff = Math.min(Math.max(delay, initialBackoff) * 2, maxBackoff);
  }

  function connect() {
    if (state === 'stopped') return;
    setState('connecting');
    let rejected = false;
    const socket = new WebSocket(target, {
      headers: {
        authorization: `Bearer ${options.token}`,
        [AGENT_VERSION_HEADER]: version,
        [AGENT_PORTS_HEADER]: [...allowed].join(','),
      },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    });
    ws = socket;

    socket.on('unexpected-response', (_req, res) => {
      rejected = res.statusCode === 401 || res.statusCode === 403;
      log.error(
        rejected
          ? `The app refused the agent token (HTTP ${res.statusCode}). Was the agent revoked?`
          : `Unexpected HTTP ${res.statusCode} from the app`,
      );
      res.resume();
      socket.terminate();
    });

    socket.on('open', () => {
      log.info(`Connected to ${parsedTarget.host}; allowing local port(s) ${[...allowed].join(', ')}`);
      setState('connected');
      resetIdle(socket);
      stableTimer = setTimeout(() => {
        backoff = initialBackoff;
      }, STABLE_AFTER_MS);
    });

    socket.on('ping', () => resetIdle(socket));
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      resetIdle(socket);
      if (!isBinary) return;
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        onFrame(socket, raw);
      } catch (err) {
        log.error(`Protocol error from the app: ${(err as Error).message}`);
        socket.close(AgentCloseCode.PROTOCOL_ERROR, 'Protocol error');
      }
    });

    socket.on('error', (err) => {
      if (!rejected) log.warn(`Connection error: ${err.message}`);
    });

    socket.on('close', (code, reason) => {
      clearTimeout(idleTimer);
      clearTimeout(stableTimer);
      destroyAll();
      if (ws === socket) ws = undefined;
      if (state === 'stopped') return;
      if (code === AgentCloseCode.REVOKED) {
        log.error('This agent was revoked by an administrator.');
        rejected = true;
      } else if (code === AgentCloseCode.REPLACED) {
        log.warn('Another agent connected with this token and replaced this connection.');
      } else if (state === 'connected') {
        log.warn(`Disconnected (${code}${reason.length ? ` ${reason.toString()}` : ''})`);
      }
      scheduleReconnect(rejected ? REJECTED_BACKOFF_MS : backoff);
    });
  }

  connect();

  return {
    get state() {
      return state;
    },
    get openStreams() {
      return streams.size;
    },
    connected() {
      if (state === 'connected') return Promise.resolve();
      if (state === 'stopped') return Promise.reject(new Error('Agent stopped'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    stop() {
      setState('stopped');
      clearTimeout(retryTimer);
      clearTimeout(idleTimer);
      clearTimeout(stableTimer);
      const pending = waiters;
      waiters = [];
      pending.forEach((w) => w.reject(new Error('Agent stopped')));
      destroyAll();
      const socket = ws;
      if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000, 'Agent stopping');
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000).unref();
      });
    },
  };
}
