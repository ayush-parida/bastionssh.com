import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KubeStreamEvent } from '@smt/shared';
import { MAX_STREAMS_PER_USER, abortEventStreams, abortStreamsFor, activeStreamCount, openEventStream, type EventStream } from '../api/sse.js';

/**
 * Server-sent event streams for Kubernetes views (the change feed now; pod
 * logs in K4) on the shared stream machinery (api/sse.ts): heartbeats,
 * cancellation when the browser goes away, revocation from outside the
 * request, and the per-user cap — which counts Docker streams too.
 */

export type KubeSse = EventStream<KubeStreamEvent>;

export const TOO_MANY_KUBE_STREAMS = `Too many open live views (at most ${MAX_STREAMS_PER_USER}); close a tab or a log view first`;

/** Start a stream about `clusterId`, or answer 429 and return null at the cap. */
export function openKubeSse(req: FastifyRequest, reply: FastifyReply, clusterId: string): KubeSse | null {
  return openEventStream<KubeStreamEvent>(
    req,
    reply,
    { feature: 'kube', resourceId: clusterId },
    (error, status) => ({ type: 'error', error, ...(status !== undefined && { status }) }),
    TOO_MANY_KUBE_STREAMS,
  );
}

/** End a user's Kubernetes streams (in one org when given, sparing `keepClusterIds`). */
export function abortKubeStreams(userId: string, scope: { orgId?: string; keepClusterIds?: Iterable<string> } = {}): number {
  return abortEventStreams(userId, 'kube', { orgId: scope.orgId, keepResourceIds: scope.keepClusterIds });
}

/** End every stream about a cluster (edited or removed). */
export function abortClusterStreams(clusterId: string, why: string): number {
  return abortStreamsFor('kube', clusterId, why);
}

export function activeKubeStreamCount(userId?: string): number {
  return activeStreamCount(userId, 'kube');
}
