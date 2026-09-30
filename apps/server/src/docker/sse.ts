import type { IncomingMessage } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DockerStreamEvent } from '@smt/shared';

/**
 * Server-sent event streams for Docker (logs, stats, events, and later pull
 * progress and compose output), with the AI chat's conventions: heartbeat
 * comments so proxies keep the connection, the work aborted as soon as the
 * browser goes away, and at most {@link MAX_STREAMS_PER_USER} open per user.
 *
 * Streams are registered so revoking a user's access ends them from outside
 * the request (auth/revoke.ts), not only when their SSH connection drops.
 */

export const MAX_STREAMS_PER_USER = 8;
export const HEARTBEAT_MS = 15_000;
/** Abort reason for a stream ended by an access revocation. */
const REVOKED = 'Access revoked';

interface ActiveStream {
  orgId: string;
  userId: string;
  serverId: string;
  controller: AbortController;
}

const streams = new Set<ActiveStream>();

export interface DockerSse {
  /** Aborted when the browser disconnects, the stream is ended, or access is revoked. */
  signal: AbortSignal;
  /** Send one event; ignored once closed. */
  send: (event: DockerStreamEvent) => void;
  /** Send an error event and end the stream. */
  fail: (err: unknown) => void;
  /** End the stream (idempotent). */
  end: () => void;
  readonly closed: boolean;
  /** The browser is not keeping up: stop reading from the daemon until {@link DockerSse.onDrain}. */
  readonly backpressured: boolean;
  onDrain: (fn: () => void) => void;
}

function streamCount(userId: string): number {
  let n = 0;
  for (const s of streams) if (s.userId === userId) n++;
  return n;
}

/**
 * Start an event stream for `serverId`, or answer 429 and return null when the
 * user already has {@link MAX_STREAMS_PER_USER} open. The route owns the
 * returned stream and must `end()` it; the stream also ends itself when the
 * client disconnects.
 */
export function openDockerSse(req: FastifyRequest, reply: FastifyReply, serverId: string): DockerSse | null {
  if (streamCount(req.user.id) >= MAX_STREAMS_PER_USER) {
    void reply
      .status(429)
      .send({ error: `Too many open Docker streams (at most ${MAX_STREAMS_PER_USER}); close a log or stats view first` });
    return null;
  }

  const controller = new AbortController();
  const entry: ActiveStream = { orgId: req.orgId, userId: req.user.id, serverId, controller };
  streams.add(entry);

  // Taken over from Fastify: headers set by hooks so far (CORS, security) are kept
  reply.hijack();
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx and similar proxies would otherwise buffer the whole stream
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  let closed = false;
  const write = (chunk: string) => {
    if (!closed && !reply.raw.writableEnded) reply.raw.write(chunk);
  };
  const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    streams.delete(entry);
    if (!controller.signal.aborted) controller.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  const send = (event: DockerStreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`);

  reply.raw.on('close', end);
  // Revoked from outside: say why, then end
  controller.signal.addEventListener(
    'abort',
    () => {
      if (closed) return;
      const reason = controller.signal.reason;
      if (reason instanceof Error && reason.message === REVOKED) {
        send({ type: 'error', error: 'Your access has changed. This stream was stopped.', status: 403 });
      }
      end();
    },
    { once: true },
  );

  return {
    signal: controller.signal,
    send,
    fail: (err: unknown) => {
      const status = (err as { statusCode?: unknown } | undefined)?.statusCode;
      send({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(typeof status === 'number' && { status }),
      });
      end();
    },
    end,
    get closed() {
      return closed;
    },
    get backpressured() {
      return !closed && reply.raw.writableNeedDrain;
    },
    onDrain: (fn: () => void) => {
      reply.raw.once('drain', fn);
    },
  };
}


/**
 * End a user's open Docker streams — in one org when `orgId` is given, sparing
 * servers in `keepServerIds`. Returns how many were ended.
 */
export function abortDockerStreams(
  userId: string,
  scope: { orgId?: string; keepServerIds?: Iterable<string> } = {},
): number {
  const keep = new Set(scope.keepServerIds ?? []);
  let aborted = 0;
  for (const entry of [...streams]) {
    if (entry.userId !== userId) continue;
    if (scope.orgId && entry.orgId !== scope.orgId) continue;
    if (keep.has(entry.serverId)) continue;
    entry.controller.abort(new Error(REVOKED));
    aborted++;
  }
  return aborted;
}

/** Streams currently open (tests and diagnostics). */
export function activeDockerStreamCount(userId?: string): number {
  return userId ? streamCount(userId) : streams.size;
}

/**
 * Feed a daemon response into an event stream: `onChunk` turns bytes into
 * events, reading pauses while the browser is behind, and the response is
 * destroyed as soon as the stream ends (disconnect, revocation). Resolves
 * when either side is done; sends `end` when the daemon closed first.
 */
export function pipeToSse(
  res: IncomingMessage,
  sse: DockerSse,
  onChunk: (chunk: Buffer) => void,
  onEnd?: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sse.signal.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      res.destroy();
      finish();
    };
    if (sse.signal.aborted) return stop();
    sse.signal.addEventListener('abort', stop, { once: true });
    res.on('data', (chunk: Buffer) => {
      if (sse.closed) return;
      onChunk(chunk);
      if (sse.backpressured) {
        res.pause();
        sse.onDrain(() => res.resume());
      }
    });
    res.on('end', () => {
      if (!sse.closed) {
        onEnd?.();
        sse.send({ type: 'end' });
      }
      finish();
    });
    res.on('error', (err) => {
      if (!sse.closed) sse.fail(err);
      finish();
    });
    res.on('close', () => {
      // Closed without an end: the SSH connection or channel went away under the stream
      if (!finished && !sse.closed) sse.fail(new Error('The connection to Docker was lost'));
      finish();
    });
  });
}
