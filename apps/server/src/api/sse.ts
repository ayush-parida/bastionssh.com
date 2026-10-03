import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Server-sent event streams for live views (Docker logs, stats and events;
 * the Kubernetes change feed), with the AI chat's conventions: heartbeat
 * comments so proxies keep the connection, the work aborted as soon as the
 * browser goes away, and at most {@link MAX_STREAMS_PER_USER} open per user
 * across every feature.
 *
 * Streams are registered so revoking a user's access ends them from outside
 * the request (auth/revoke.ts), not only when their connection drops. Each
 * feature wraps this with its own event type (docker/sse.ts, kube/sse.ts).
 */

export const MAX_STREAMS_PER_USER = 8;
export const HEARTBEAT_MS = 15_000;
/** Abort reason for a stream ended by an access revocation. */
const REVOKED = 'Access revoked';

/** Which feature a stream belongs to, and the server or cluster it is about. */
export interface StreamTarget {
  feature: 'docker' | 'kube';
  resourceId: string;
}

interface ActiveStream extends StreamTarget {
  orgId: string;
  userId: string;
  controller: AbortController;
}

const streams = new Set<ActiveStream>();

export interface EventStream<E> {
  /** Aborted when the browser disconnects, the stream is ended, or access is revoked. */
  signal: AbortSignal;
  /** Send one event; ignored once closed. */
  send: (event: E) => void;
  /** Send an error event and end the stream. */
  fail: (err: unknown) => void;
  /** End the stream (idempotent). */
  end: () => void;
  readonly closed: boolean;
  /** The browser is not keeping up: stop reading upstream until {@link EventStream.onDrain}. */
  readonly backpressured: boolean;
  onDrain: (fn: () => void) => void;
}

/** Streams a user has open — every feature, or one. */
export function activeStreamCount(userId?: string, feature?: StreamTarget['feature']): number {
  let n = 0;
  for (const s of streams) {
    if (userId && s.userId !== userId) continue;
    if (feature && s.feature !== feature) continue;
    n++;
  }
  return n;
}

/**
 * Start an event stream, or answer 429 with `tooMany` and return null when
 * the user already has {@link MAX_STREAMS_PER_USER} open. The route owns the
 * returned stream and must `end()` it; the stream also ends itself when the
 * client disconnects. `errorEvent` builds the feature's error event.
 */
export function openEventStream<E>(
  req: FastifyRequest,
  reply: FastifyReply,
  target: StreamTarget,
  errorEvent: (error: string, status?: number) => E,
  tooMany: string,
): EventStream<E> | null {
  if (activeStreamCount(req.user.id) >= MAX_STREAMS_PER_USER) {
    void reply.status(429).send({ error: tooMany });
    return null;
  }

  const controller = new AbortController();
  const entry: ActiveStream = { orgId: req.orgId, userId: req.user.id, ...target, controller };
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

  const send = (event: E) => write(`data: ${JSON.stringify(event)}\n\n`);

  reply.raw.on('close', end);
  // Revoked from outside: say why, then end
  controller.signal.addEventListener(
    'abort',
    () => {
      if (closed) return;
      const reason = controller.signal.reason;
      if (reason instanceof Error && reason.message === REVOKED) {
        send(errorEvent('Your access has changed. This stream was stopped.', 403));
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
      send(errorEvent(err instanceof Error ? err.message : String(err), typeof status === 'number' ? status : undefined));
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
 * End a user's open streams of one feature — in one org when `orgId` is
 * given, sparing the servers or clusters in `keepResourceIds`. Returns how
 * many were ended.
 */
export function abortEventStreams(
  userId: string,
  feature: StreamTarget['feature'],
  scope: { orgId?: string; keepResourceIds?: Iterable<string> } = {},
): number {
  const keep = new Set(scope.keepResourceIds ?? []);
  let aborted = 0;
  for (const entry of [...streams]) {
    if (entry.userId !== userId || entry.feature !== feature) continue;
    if (scope.orgId && entry.orgId !== scope.orgId) continue;
    if (keep.has(entry.resourceId)) continue;
    entry.controller.abort(new Error(REVOKED));
    aborted++;
  }
  return aborted;
}

/** End every open stream of one feature about one server or cluster (it was removed or changed). */
export function abortStreamsFor(feature: StreamTarget['feature'], resourceId: string, reason: string): number {
  let aborted = 0;
  for (const entry of [...streams]) {
    if (entry.feature !== feature || entry.resourceId !== resourceId) continue;
    entry.controller.abort(new Error(reason));
    aborted++;
  }
  return aborted;
}
