import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeployStreamEvent } from '@smt/shared';
import { MAX_STREAMS_PER_USER, abortEventStreams, activeStreamCount, openEventStream, type EventStream } from '../api/sse.js';

/**
 * Deploy and rollback logs as server-sent events, on the shared stream
 * machinery (api/sse.ts): heartbeats, the per-user cap across every feature,
 * and revocation — a member who loses the server, the Servers module or the
 * Deployments module has their deploy log streams ended (spec §8).
 */

export type DeploySse = EventStream<DeployStreamEvent>;

export const TOO_MANY_STREAMS = `Too many open streams (at most ${MAX_STREAMS_PER_USER}); close a log view first`;

export function openDeploySse(req: FastifyRequest, reply: FastifyReply, serverId: string): DeploySse | null {
  return openEventStream<DeployStreamEvent>(
    req,
    reply,
    { feature: 'deploy', resourceId: serverId },
    (error, status) => ({ type: 'error', error, ...(status !== undefined && { status }) }),
    TOO_MANY_STREAMS,
  );
}

/** End a user's deploy streams — in one org when `orgId` is given, sparing servers in `keepServerIds`. */
export function abortDeployStreams(userId: string, scope: { orgId?: string; keepServerIds?: Iterable<string> } = {}): number {
  return abortEventStreams(userId, 'deploy', { orgId: scope.orgId, keepResourceIds: scope.keepServerIds });
}

export function activeDeployStreamCount(userId?: string): number {
  return activeStreamCount(userId, 'deploy');
}
