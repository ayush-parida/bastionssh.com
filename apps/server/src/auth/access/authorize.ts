import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { AccessLevel, AccessReason, ResourceType } from '@smt/shared';
import { getDb } from '../../db/index.js';
import { servers } from '../../db/schema.js';
import {
  baseAllowsAtView,
  levelRank,
  meetsLevel,
  RESOURCE_LABELS,
  requiredLevel,
  type ResourceAction,
} from './levels.js';
import { resourceExists } from './filter.js';
import {
  resolveAccess,
  topLevel,
  wholeResource,
  type AccessSubject,
  type Contribution,
  type ResolvedAccess,
} from './resolve.js';

/**
 * Decisions on one resource (spec §4 authorize.ts). A resource the subject
 * cannot reach at all is reported as not found (404), never as forbidden, so
 * its existence does not leak; one they can see but not act on at the level
 * the action needs is forbidden (403).
 */

export interface ResourceLevel {
  level: AccessLevel;
  /** Every reason that applies, highest level first. */
  via: AccessReason[];
  /** Clusters only: namespaces the subject may see; null = every namespace. */
  namespaces: string[] | null;
}

/** A server's tags, if it is in `orgId`; undefined when it is not. Malformed tags count as none. */
function serverTags(orgId: string, serverId: string): string[] | undefined {
  const row = getDb()
    .select({ tags: servers.tags })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.orgId, orgId)))
    .get();
  if (!row) return undefined;
  try {
    const tags: unknown = JSON.parse(row.tags);
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Everything that reaches resource `id` of `type`, given it exists (tags: the server's). */
export function contributionsFor(access: ResolvedAccess, type: ResourceType, id: string, tags: string[] = []): Contribution[] {
  if (!access.active) return [];
  const typeAccess = access.types[type];
  const found = [...typeAccess.every, ...(typeAccess.byId.get(id) ?? [])];
  if (type === 'server') for (const tag of new Set(tags)) found.push(...(typeAccess.byTag.get(tag) ?? []));
  return found;
}

/** Fold contributions into a level, its reasons and (clusters) namespaces. Null when nothing reaches. */
export function foldContributions(access: ResolvedAccess, found: Contribution[]): ResourceLevel | null {
  const level = topLevel(access, found);
  if (!level) return null;
  const via = [...found].sort((a, b) => levelRank(b.level) - levelRank(a.level)).map((c) => c.reason);
  const namespaces = found.some((c) => c.namespaces === null)
    ? null
    : [...new Set(found.flatMap((c) => c.namespaces ?? []))].sort();
  return { level, via, namespaces };
}

/**
 * The subject's level on one resource, or null when they cannot reach it or
 * it is not in their org. For clusters, `namespace` counts only what covers
 * that namespace; without one, the level is on the cluster as a whole, where
 * a namespace-narrowed grant gives `view` at most (`wholeResource`).
 */
export function levelFor(
  who: AccessSubject,
  type: ResourceType,
  id: string,
  opts: { namespace?: string } = {},
): ResourceLevel | null {
  const access = resolveAccess(who);
  if (!access.active) return null;
  let tags: string[] = [];
  if (type === 'server') {
    const found = serverTags(access.orgId, id);
    if (!found) return null;
    tags = found;
  } else if (!resourceExists(access.orgId, type, id)) {
    return null;
  }
  let found = contributionsFor(access, type, id, tags);
  if (type === 'cluster' && opts.namespace !== undefined) {
    const ns = opts.namespace;
    found = found.filter((c) => c.namespaces === null || c.namespaces.includes(ns));
  } else {
    // The whole cluster: namespace-narrowed grants show it, and give no more
    found = found.map(wholeResource);
  }
  return foldContributions(access, found);
}

export interface AuthorizeResult {
  ok: boolean;
  /** 200 allowed, 404 not reachable (or not there), 403 visible but the action needs more. */
  status: 200 | 403 | 404;
  level: AccessLevel | null;
  required: AccessLevel;
  via: AccessReason[];
}

/** May the subject do `action` on resource `id` of `type`? */
export function authorize<T extends ResourceType>(
  who: AccessSubject,
  type: T,
  id: string,
  action: ResourceAction<T>,
  opts: { namespace?: string } = {},
): AuthorizeResult {
  const required = requiredLevel(type, action);
  const found = levelFor(who, type, id, opts);
  if (!found) return { ok: false, status: 404, level: null, required, via: [] };
  // The base role (scope `all`) keeps what it always allowed at view (levels.ts BASE_VIEW_ACTIONS)
  const ok =
    meetsLevel(found.level, required) ||
    (found.via.some((reason) => reason.kind === 'base') && baseAllowsAtView(type, action));
  return { ok, status: ok ? 200 : 403, level: found.level, required, via: found.via };
}

/**
 * preHandler gate: `{ preHandler: requireResource('server', 'terminal') }`.
 * Must run after `requireAuth`. Takes the resource id from the `id` route
 * parameter (or `param`), and for clusters the namespace from `namespaceParam`.
 */
export function requireResource<T extends ResourceType>(
  type: T,
  action: ResourceAction<T>,
  opts: { param?: string; namespaceParam?: string } = {},
) {
  return async function resourceGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const id = params[opts.param ?? 'id'];
    const namespace = opts.namespaceParam ? params[opts.namespaceParam] : undefined;
    const result = id ? authorize(req, type, id, action, { namespace }) : null;
    if (!result || result.status === 404) {
      return reply.status(404).send({ error: `${RESOURCE_LABELS[type]} not found` });
    }
    if (!result.ok) {
      return reply.status(403).send({
        error: `This needs ${result.required} access to the ${RESOURCE_LABELS[type].toLowerCase()} (you have ${result.level})`,
      });
    }
  };
}
