import type { WebSocket, RawData } from 'ws';
import { eq } from 'drizzle-orm';
import {
  AgentCloseCode,
  FrameType,
  ProtocolError,
  decodeFrame,
  encodeClose,
  encodeDataFrames,
  encodeOpen,
} from '@smt/agent';
import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { auditSystem } from '../audit/index.js';
import logger from '../logger.js';
import { AgentTunnelError, TunnelSocket, type TunnelLink } from './tunnel-socket.js';

/**
 * Live agent connections, one per agent, and the streams tunnelled over them.
 *
 * Only the app opens streams, and only to a port of a server row an admin
 * pointed at the agent: the agent cannot ask the app to connect anywhere, and
 * anything it sends that is not an answer to an open stream ends its
 * connection. Connections live in this process — a worker running in a
 * separate process cannot reach agents.
 */

type AgentRow = typeof agents.$inferSelect;

/** Most streams one agent may carry at once. */
export const MAX_STREAMS_PER_AGENT = 64;
/** How long the agent has to confirm an OPEN. */
export const OPEN_TIMEOUT_MS = 15_000;
/** Keepalive ping interval; an agent that misses one is dropped. */
export const PING_INTERVAL_MS = 30_000;
/** last_seen_at is refreshed at most this often while connected. */
const LAST_SEEN_EVERY_MS = 60_000;

interface LiveAgent {
  agentId: string;
  orgId: string;
  name: string;
  ws: WebSocket;
  connectedAt: string;
  remoteAddress: string;
  version: string | null;
  allowedPorts: number[];
  streams: Map<number, TunnelSocket>;
  nextStreamId: number;
  alive: boolean;
  lastSeenWrite: number;
}

const live = new Map<string, LiveAgent>();
let pingTimer: ReturnType<typeof setInterval> | undefined;

function touchLastSeen(agentId: string, extra: Partial<typeof agents.$inferInsert> = {}) {
  try {
    getDb()
      .update(agents)
      .set({ lastSeenAt: new Date().toISOString(), ...extra })
      .where(eq(agents.id, agentId))
      .run();
  } catch (err) {
    logger.warn({ err, agentId }, 'Could not record agent last-seen time');
  }
}

function ensurePingLoop() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const conn of live.values()) {
      if (!conn.alive) {
        logger.warn({ agentId: conn.agentId }, 'Agent missed a keepalive — dropping the connection');
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* closing */
      }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();
}

function send(conn: LiveAgent, frame: Buffer, cb?: (err?: Error | null) => void) {
  if (conn.ws.readyState !== conn.ws.OPEN) {
    cb?.(new AgentTunnelError('Agent disconnected', 'ECONNRESET'));
    return;
  }
  conn.ws.send(frame, { binary: true }, cb);
}

function allocateStreamId(conn: LiveAgent): number {
  // Wraps at 2^32; skips ids still in use after a wrap
  for (;;) {
    const id = conn.nextStreamId;
    conn.nextStreamId = (conn.nextStreamId + 1) >>> 0;
    if (!conn.streams.has(id)) return id;
  }
}

function linkFor(conn: LiveAgent, streamId: number, socket: TunnelSocket): TunnelLink {
  const release = () => {
    if (conn.streams.get(streamId) === socket) conn.streams.delete(streamId);
  };
  return {
    write(data, done) {
      const frames = encodeDataFrames(streamId, data);
      if (!frames.length) return done();
      // Completion of the last frame means all of them were handed over, in order
      frames.forEach((frame, i) => send(conn, frame, i === frames.length - 1 ? done : undefined));
    },
    close() {
      if (conn.streams.get(streamId) !== socket) return;
      release();
      send(conn, encodeClose(streamId));
    },
    release,
  };
}

function startStream(orgId: string, agentId: string, port: number, socket: TunnelSocket) {
  const conn = live.get(agentId);
  // Org checked again here: a server row can only name an agent of its own org
  if (!conn || conn.orgId !== orgId) {
    socket.fail(new AgentTunnelError('The server\'s agent is not connected', 'EAGENTOFFLINE'));
    return;
  }
  if (conn.streams.size >= MAX_STREAMS_PER_AGENT) {
    socket.fail(new AgentTunnelError(`The agent already carries ${MAX_STREAMS_PER_AGENT} connections`, 'EAGENTBUSY'));
    return;
  }

  const streamId = allocateStreamId(conn);
  conn.streams.set(streamId, socket);
  socket.attach(linkFor(conn, streamId, socket));

  const timer = setTimeout(() => {
    if (!socket.connecting || socket.destroyed) return;
    socket.destroy(new AgentTunnelError(`The agent did not open port ${port} within ${OPEN_TIMEOUT_MS / 1000}s`, 'ETIMEDOUT'));
  }, OPEN_TIMEOUT_MS);
  timer.unref?.();
  socket.once('connect', () => clearTimeout(timer));
  socket.once('close', () => clearTimeout(timer));

  send(conn, encodeOpen(streamId, port));
}

/**
 * A socket to `port` on the agent's host, for ssh2's `sock` option. It is
 * opened when ssh2 starts connecting and fails with EAGENTOFFLINE when the
 * agent is not connected to this process.
 */
export function openAgentTunnel(target: { orgId: string; agentId: string }, port: number): TunnelSocket {
  return new TunnelSocket((socket) => startStream(target.orgId, target.agentId, port, socket), {
    agentId: target.agentId,
    port,
  });
}

function protocolViolation(conn: LiveAgent, err: Error) {
  logger.warn({ agentId: conn.agentId, err: err.message }, 'Agent broke the tunnel protocol — disconnecting');
  conn.ws.close(AgentCloseCode.PROTOCOL_ERROR, 'Protocol error');
}

function onMessage(conn: LiveAgent, data: RawData, isBinary: boolean) {
  conn.alive = true;
  if (!isBinary) return protocolViolation(conn, new ProtocolError('Text message'));
  const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

  let frame;
  try {
    frame = decodeFrame(raw);
  } catch (err) {
    return protocolViolation(conn, err as Error);
  }

  const socket = conn.streams.get(frame.streamId);
  switch (frame.type) {
    case FrameType.OPEN:
      // Only the app opens streams
      return protocolViolation(conn, new ProtocolError('Agent tried to open a stream'));
    case FrameType.OPENED:
      if (!socket) return; // the app gave up on it already
      if (!socket.connecting) return protocolViolation(conn, new ProtocolError('Stream opened twice'));
      socket.opened();
      return;
    case FrameType.DATA:
      if (!socket) return; // raced with a close
      if (socket.connecting) return protocolViolation(conn, new ProtocolError('Data before the stream opened'));
      socket.receive(frame.data);
      return;
    case FrameType.CLOSE:
      socket?.remoteClose();
      return;
    case FrameType.ERROR:
      socket?.fail(new AgentTunnelError(`Agent: ${frame.message}`, frame.code));
      return;
  }
}

export interface AcceptedAgent {
  row: AgentRow;
  remoteAddress: string;
  version: string | null;
  allowedPorts: number[];
}

/**
 * Take over an authenticated agent WebSocket. A second connection with the
 * same token replaces the first, so an agent that lost its network does not
 * lock itself out until the old socket times out.
 */
export function acceptAgentConnection(ws: WebSocket, agent: AcceptedAgent) {
  const { row } = agent;
  const previous = live.get(row.id);
  if (previous) {
    live.delete(row.id);
    previous.ws.close(AgentCloseCode.REPLACED, 'Replaced by a newer connection');
    failStreams(previous, 'Agent reconnected');
  }

  const conn: LiveAgent = {
    agentId: row.id,
    orgId: row.orgId,
    name: row.name,
    ws,
    connectedAt: new Date().toISOString(),
    remoteAddress: agent.remoteAddress,
    version: agent.version,
    allowedPorts: agent.allowedPorts,
    streams: new Map(),
    nextStreamId: 1,
    alive: true,
    lastSeenWrite: Date.now(),
  };
  live.set(row.id, conn);
  ensurePingLoop();

  touchLastSeen(row.id, agent.version ? { version: agent.version } : {});
  auditSystem(row.orgId, 'agent.connect', 'agent', row.id, row.name, {
    remoteAddress: agent.remoteAddress,
    version: agent.version,
    allowedPorts: agent.allowedPorts,
    ...(previous && { replaced: true }),
  });
  logger.info({ agentId: row.id, remoteAddress: agent.remoteAddress, version: agent.version }, 'Agent connected');

  ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
  ws.on('pong', () => {
    conn.alive = true;
    if (Date.now() - conn.lastSeenWrite >= LAST_SEEN_EVERY_MS) {
      conn.lastSeenWrite = Date.now();
      touchLastSeen(row.id);
    }
  });
  ws.on('error', (err) => logger.warn({ err, agentId: row.id }, 'Agent WebSocket error'));
  ws.on('close', (code, reason) => {
    failStreams(conn, 'Agent disconnected');
    if (live.get(row.id) === conn) live.delete(row.id);
    touchLastSeen(row.id);
    auditSystem(row.orgId, 'agent.disconnect', 'agent', row.id, row.name, {
      code,
      ...(reason.length && { reason: reason.toString().slice(0, 123) }),
      connectedSeconds: Math.round((Date.now() - Date.parse(conn.connectedAt)) / 1000),
    });
    logger.info({ agentId: row.id, code }, 'Agent disconnected');
  });
}

function failStreams(conn: LiveAgent, why: string) {
  const streams = [...conn.streams.values()];
  conn.streams.clear();
  for (const socket of streams) socket.fail(new AgentTunnelError(why, 'ECONNRESET'));
}

/** Drop an agent's live connection (after a revocation). True when one was open. */
export function disconnectAgent(agentId: string, code: number = AgentCloseCode.REVOKED, reason = 'Agent revoked'): boolean {
  const conn = live.get(agentId);
  if (!conn) return false;
  live.delete(agentId);
  failStreams(conn, reason);
  conn.ws.close(code, reason);
  // A peer that does not answer the close handshake is cut off anyway
  setTimeout(() => conn.ws.terminate(), 5_000).unref?.();
  return true;
}

export interface LiveAgentInfo {
  connectedAt: string;
  remoteAddress: string;
  allowedPorts: number[];
  openStreams: number;
}

export function liveAgentInfo(agentId: string): LiveAgentInfo | null {
  const conn = live.get(agentId);
  if (!conn) return null;
  return {
    connectedAt: conn.connectedAt,
    remoteAddress: conn.remoteAddress,
    allowedPorts: conn.allowedPorts,
    openStreams: conn.streams.size,
  };
}

export function isAgentOnline(agentId: string): boolean {
  return live.has(agentId);
}

/** Close every agent connection (tests, shutdown). */
export function disconnectAllAgents() {
  for (const agentId of [...live.keys()]) disconnectAgent(agentId, 1001, 'Server shutting down');
}
