import type { IncomingMessage } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DockerStreamEvent } from '@smt/shared';
import {
  HEARTBEAT_MS,
  MAX_STREAMS_PER_USER,
  abortEventStreams,
  activeStreamCount,
  openEventStream,
  type EventStream,
} from '../api/sse.js';

/**
 * Server-sent event streams for Docker (logs, stats, events, pull progress
 * and compose output) on the shared stream machinery (api/sse.ts):
 * heartbeats, cancellation when the browser goes away, revocation from
 * outside the request, and the per-user cap — which counts every feature's
 * streams, Kubernetes ones included.
 */

export { MAX_STREAMS_PER_USER, HEARTBEAT_MS };

export type DockerSse = EventStream<DockerStreamEvent>;

const TOO_MANY = `Too many open streams (at most ${MAX_STREAMS_PER_USER}); close a log or stats view first`;

/**
 * Start an event stream for `serverId`, or answer 429 and return null when the
 * user already has {@link MAX_STREAMS_PER_USER} open. The route owns the
 * returned stream and must `end()` it; the stream also ends itself when the
 * client disconnects.
 */
export function openDockerSse(req: FastifyRequest, reply: FastifyReply, serverId: string): DockerSse | null {
  return openEventStream<DockerStreamEvent>(
    req,
    reply,
    { feature: 'docker', resourceId: serverId },
    (error, status) => ({ type: 'error', error, ...(status !== undefined && { status }) }),
    TOO_MANY,
  );
}

/** The 429 body for a user at the stream cap (checked before any work starts). */
export const TOO_MANY_STREAMS = TOO_MANY;

/**
 * End a user's open Docker streams — in one org when `orgId` is given, sparing
 * servers in `keepServerIds`. Returns how many were ended.
 */
export function abortDockerStreams(
  userId: string,
  scope: { orgId?: string; keepServerIds?: Iterable<string> } = {},
): number {
  return abortEventStreams(userId, 'docker', { orgId: scope.orgId, keepResourceIds: scope.keepServerIds });
}

/** Docker streams currently open (tests and diagnostics). */
export function activeDockerStreamCount(userId?: string): number {
  return activeStreamCount(userId, 'docker');
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
