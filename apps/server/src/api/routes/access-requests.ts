import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  ACCESS_LEVELS,
  RESOURCE_TYPES,
  type AccessLevel,
  type AccessRequest,
  type AccessRequestSettings,
  type AccessRequestStatus,
  type RequestableAccess,
  type RequestableClusters,
  type RequestableServers,
  type ResourceType,
} from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import {
  accessRequests,
  kubeClusters,
  memberships,
  organizations,
  roleMembers,
  roles,
  servers,
  users,
} from '../../db/schema.js';
import {
  activeGrants,
  extendClusterGrants,
  extendGrants,
  minutesFromNow,
  REQUEST_TTL_MS,
} from '../../auth/access-grants.js';
import { serverScope } from '../../auth/server-access.js';
import { activeClusterGrants, clusterScope } from '../../auth/cluster-access.js';
import { activeAt } from '../../auth/access/resolve.js';
import {
  addPersonalGrant,
  baseLevel,
  effectiveAccessList,
  isAccessLevel,
  isResourceType,
  levelFor,
  listResources,
  meetsLevel,
  resolveAccess,
  resourceExists,
} from '../../auth/access/index.js';
import { audit } from '../../audit/index.js';
import { notifyNotice } from '../../notifications/index.js';
import { config } from '../../config/index.js';

/**
 * Just-in-time access. A restricted member asks for some servers for a while,
 * with a reason; an admin (never the requester) approves — optionally for
 * less time — or denies. Approval adds time-bound grants that the expiry
 * sweep removes when they run out (auth/access-grants.ts).
 *
 * Whether a restricted member may see the names of servers they cannot use is
 * an org setting, on by default: without names there is nothing to ask for.
 * Only names are ever shown — never hosts, tags or anything else. With it off,
 * members can only ask to extend access to servers they already have. The
 * same goes for Kubernetes clusters (`clusterIds`), under the same setting.
 *
 * Since custom roles, any member below admin may also ask for a custom role
 * (approval adds them to it until the time is up) or for a level on
 * resources of any type they can already see — or, for servers, that the org
 * lists by name (approval adds time-bound personal grants at that level).
 *
 * A cluster request may name namespaces instead of the whole cluster, and
 * the approver may narrow it further (or narrow a whole-cluster request to
 * some namespaces), never widen it: approval then adds grants narrowed to
 * those namespaces.
 */

/** Hard ceiling for the org setting: a week. Anything longer is a permanent grant. */
const MAX_POLICY_MINUTES = 7 * 24 * 60;
/** Unanswered requests one member may have open at once. */
const MAX_PENDING_PER_MEMBER = 10;
/**
 * Requests one member may create in an hour, cancelled ones included. Each
 * one emails every admin and posts to the org's channels, so create-then-
 * cancel must not become a way to flood them.
 */
const MAX_CREATED_PER_HOUR = 20;

const settingsSchema = z.object({
  restrictedSeeServerNames: z.boolean().optional(),
  maxRequestMinutes: z.number().int().min(15).max(MAX_POLICY_MINUTES).optional(),
});

/**
 * The first cluster requests named their kind as `resourceType` beside
 * `serverIds` / `clusterIds` (no level): read those as the base-role-level
 * server or cluster request they are.
 */
function legacyKind(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;
  if (b.resourceIds !== undefined || b.level !== undefined) return body;
  // Only with the matching list: `cluster` beside `serverIds` stays an error
  const matches =
    (b.resourceType === 'server' && b.serverIds !== undefined && b.clusterIds === undefined) ||
    (b.resourceType === 'cluster' && b.clusterIds !== undefined && b.serverIds === undefined);
  if (!matches) return body;
  const { resourceType: _kind, ...rest } = b;
  return rest;
}

const namespaceSchema = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid namespace');
/** Namespaces of a cluster request or approval: at least one, when given. */
const namespacesSchema = z.array(namespaceSchema).min(1).max(100);

const createSchema = z.preprocess(
  legacyKind,
  z
    .object({
      /** Servers at the base role's level, as before custom roles. */
      serverIds: z.array(z.string().min(1)).min(1).max(50).optional(),
      /** Kubernetes clusters at the base role's level, as servers. */
      clusterIds: z.array(z.string().min(1)).min(1).max(50).optional(),
      /** A custom role, held for the duration. */
      roleId: z.string().min(1).optional(),
      /** Resources of one type at a level (custom roles spec §6). */
      resourceType: z.enum(RESOURCE_TYPES as [ResourceType, ...ResourceType[]]).optional(),
      resourceIds: z.array(z.string().min(1)).min(1).max(50).optional(),
      level: z.enum(ACCESS_LEVELS as [AccessLevel, ...AccessLevel[]]).optional(),
      /** Clusters only: these namespaces rather than the whole cluster. */
      namespaces: namespacesSchema.optional(),
      reason: z.string().trim().min(3).max(500),
      durationMinutes: z.number().int().min(5).max(MAX_POLICY_MINUTES),
    })
    .refine(
      (b) =>
        [b.serverIds !== undefined, b.clusterIds !== undefined, b.roleId !== undefined, b.resourceType !== undefined].filter(
          Boolean,
        ).length === 1 &&
        (b.resourceType === undefined || (b.resourceIds !== undefined && b.level !== undefined)),
      { message: 'Ask for servers, clusters, a role, or resources of one type at a level' },
    )
    .refine((b) => b.namespaces === undefined || b.clusterIds !== undefined || b.resourceType === 'cluster', {
      message: 'Only cluster requests can name namespaces',
    }),
);

/** Base-role-level requests: servers or clusters, with the grants each kind uses. */
type LegacyKind = 'server' | 'cluster';

/** A member's grants in force now on servers or clusters, by id. */
function grantsOf(orgId: string, userId: string, kind: LegacyKind): Map<string, { expiresAt: string | null }> {
  return kind === 'cluster'
    ? new Map(activeClusterGrants(orgId, userId).map((g) => [g.clusterId, g]))
    : new Map(activeGrants(orgId, userId).map((g) => [g.serverId, g]));
}

/** True when the caller already reaches every server (or cluster). */
function seesAllOf(req: FastifyRequest, kind: LegacyKind): boolean {
  return kind === 'cluster' ? clusterScope(req).all : serverScope(req).all;
}

const approveSchema = z.object({
  durationMinutes: z.number().int().min(5).max(MAX_POLICY_MINUTES).optional(),
  /** Cluster requests: grant only these namespaces (a subset of those asked for, if any were). */
  namespaces: namespacesSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

const denySchema = z.object({ note: z.string().trim().max(500).optional() });

const STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  /** Admins see everyone's requests unless they ask for only their own. */
  mine: z.enum(['true', 'false']).optional(),
});

type RequestRow = typeof accessRequests.$inferSelect;

export function accessRequestSettings(orgId: string): AccessRequestSettings {
  const org = getDb()
    .select({
      restrictedSeeServerNames: organizations.restrictedSeeServerNames,
      maxRequestMinutes: organizations.accessRequestMaxMinutes,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  return { restrictedSeeServerNames: org?.restrictedSeeServerNames ?? true, maxRequestMinutes: org?.maxRequestMinutes ?? 480 };
}

/** `90` → `1h 30m`, `2880` → `2d`. */
export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

function parseServerIds(raw: string): string[] {
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What a request asks for. Server requests from before custom roles keep a
 * plain id list in `server_ids` (the base role's level); a request for
 * resources at a level stores `{ ids, level }` there, under its
 * `resource_type`; a role request stores the role in `role_id`. A cluster
 * request naming namespaces adds `namespaces` (with `level: null` when it is
 * at the base role's level), and its approval `approvedNamespaces`.
 */
interface RequestTarget {
  type: ResourceType | 'role';
  ids: string[];
  level: AccessLevel | null;
  /** Clusters: the namespaces asked for; null = the whole cluster. */
  namespaces: string[] | null;
  /** Clusters, once approved: the namespaces granted; null = as asked. */
  approvedNamespaces: string[] | null;
}

/** A stored namespace list: null when absent, undefined when unreadable. */
function storedNamespaces(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length > 0 && value.every((ns) => typeof ns === 'string')) return value as string[];
  return undefined;
}

function targetOf(row: RequestRow): RequestTarget {
  const none = { namespaces: null, approvedNamespaces: null };
  if (row.resourceType === 'role') return { type: 'role', ids: [], level: null, ...none };
  const type: ResourceType = isResourceType(row.resourceType) ? row.resourceType : 'server';
  try {
    const value = JSON.parse(row.serverIds) as unknown;
    if (Array.isArray(value)) return { type, ids: parseServerIds(row.serverIds), level: null, ...none };
    const { ids, level, namespaces, approvedNamespaces } = (value ?? {}) as Record<string, unknown>;
    const asked = type === 'cluster' ? storedNamespaces(namespaces) : null;
    const approved = type === 'cluster' ? storedNamespaces(approvedNamespaces) : null;
    // An unreadable namespace list covers nothing, rather than the whole cluster
    if (asked === undefined || approved === undefined) return { type, ids: [], level: null, ...none };
    return {
      type,
      ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
      // `null`: a cluster request (namespaced, or narrowed on approval) at the base role's level
      level: level === null && type === 'cluster' ? null : isAccessLevel(level) ? level : 'view',
      namespaces: asked,
      approvedNamespaces: approved,
    };
  } catch {
    return { type, ids: [], level: null, ...none };
  }
}

/** ` in namespaces a, b` for a cluster request narrowed to some; empty otherwise. */
function namespacesText(namespaces: string[] | null | undefined): string {
  return namespaces?.length ? ` in namespace${namespaces.length === 1 ? '' : 's'} ${namespaces.join(', ')}` : '';
}

/** `a, b and c`, or the role's name: what a request is for (or was granted), for notifications. */
function targetNames(request: AccessRequest): string {
  if (request.resourceType === 'role') return `the ${request.role?.name ?? 'deleted'} role`;
  const names = (request.resources ?? request.servers).map((s) => s.name ?? 'a deleted resource').join(', ');
  const scoped = `${names}${namespacesText(request.approvedNamespaces ?? request.namespaces)}`;
  return request.level ? `${scoped} (${request.level})` : scoped;
}

/** Rows as the API returns them, with people and server names resolved in bulk. */
function present(orgId: string, rows: RequestRow[]): AccessRequest[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const targets = new Map(rows.map((r) => [r.id, targetOf(r)]));
  // Names of whatever is asked for, per type; a deleted resource has none
  const names = new Map<string, string>();
  for (const type of new Set([...targets.values()].map((t) => t.type))) {
    if (type === 'role') continue;
    const ids = [...new Set([...targets.values()].filter((t) => t.type === type).flatMap((t) => t.ids))];
    if (!ids.length) continue;
    for (const r of listResources(orgId, type)) if (ids.includes(r.id)) names.set(`${type}:${r.id}`, r.name);
  }
  const roleIds = [...new Set(rows.flatMap((r) => (r.roleId ? [r.roleId] : [])))];
  const roleNames = new Map(
    roleIds.length
      ? db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)).all().map((r) => [r.id, r.name])
      : [],
  );
  const userIds = [...new Set(rows.flatMap((r) => [r.userId, ...(r.decidedBy ? [r.decidedBy] : [])]))];
  const people = new Map(
    db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds))
      .all()
      .map((u) => [u.id, u]),
  );
  return rows.map((r) => {
    const target = targets.get(r.id)!;
    const resources =
      target.type === 'role' ? [] : target.ids.map((id) => ({ id, name: names.get(`${target.type}:${id}`) ?? null }));
    return {
      id: r.id,
      userId: r.userId,
      userEmail: people.get(r.userId)?.email ?? '',
      userDisplayName: people.get(r.userId)?.displayName ?? '',
      // A deleted server keeps its place in the request, without a name
      servers: target.type === 'server' ? resources : [],
      clusters: target.type === 'cluster' ? resources : [],
      reason: r.reason,
      durationMinutes: r.durationMinutes,
      status: r.status as AccessRequestStatus,
      approvedMinutes: r.approvedMinutes,
      decidedBy: r.decidedBy,
      decidedByEmail: r.decidedBy ? (people.get(r.decidedBy)?.email ?? null) : null,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      resourceType: target.type,
      role: target.type === 'role' ? { id: r.roleId ?? '', name: r.roleId ? (roleNames.get(r.roleId) ?? null) : null } : null,
      resources,
      level: target.level,
      ...(target.type === 'cluster' && { namespaces: target.namespaces, approvedNamespaces: target.approvedNamespaces }),
    };
  });
}

function findRequest(orgId: string, id: string): RequestRow | undefined {
  return getDb()
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, id), eq(accessRequests.orgId, orgId)))
    .get();
}

/** Active admins and owners in the org, bar `exceptUserId` — who hears about a new request. */
function adminEmails(orgId: string, exceptUserId: string): string[] {
  return getDb()
    .select({ email: users.email, role: memberships.role, userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, 'active')))
    .all()
    .filter((m) => rank(m.role) >= rank('admin') && m.userId !== exceptUserId)
    .map((m) => m.email);
}

/**
 * Member-typed text headed for shared chat channels. Breaks `@everyone` /
 * `@channel` style mentions (Discord, Mattermost) and Slack/Google Chat
 * `<!here>`, `<users/all>` and `<url|label>` markup, so a restricted member
 * cannot ping a whole channel or dress up a link in the admins' feed.
 */
export function chatSafe(text: string): string {
  return text.replace(/@/g, '@\u200b').replace(/</g, '\u2039').replace(/>/g, '\u203a');
}

function reviewLink(): string {
  return `${config.baseUrl.replace(/\/$/, '')}/team`;
}

/**
 * A decision is someone else's to make, on a request still open. Sends the
 * error and returns undefined otherwise.
 */
function decidable(req: FastifyRequest, reply: FastifyReply, verb: string): RequestRow | undefined {
  const { id } = req.params as { id: string };
  const request = findRequest(req.orgId, id);
  if (!request) {
    reply.status(404).send({ error: 'Access request not found' });
    return undefined;
  }
  if (request.userId === req.user.id) {
    reply.status(403).send({ error: `You cannot ${verb} your own access request` });
    return undefined;
  }
  if (request.status !== 'pending' || request.expiresAt <= new Date().toISOString()) {
    reply.status(409).send({ error: `This request is no longer pending (${request.status === 'pending' ? 'expired' : request.status})` });
    return undefined;
  }
  return request;
}

/**
 * Close a pending request. Conditional on it still being pending, so two
 * admins deciding at once cannot both win.
 */
function decide(id: string, set: Partial<RequestRow>): boolean {
  return (
    getDb()
      .update(accessRequests)
      .set(set)
      .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending')))
      .run().changes === 1
  );
}

export async function accessRequestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** The org's request policy. Every member may read it — the request form needs the limit. */
  app.get('/settings', async (req): Promise<AccessRequestSettings> => accessRequestSettings(req.orgId));

  app.patch('/settings', { preHandler: requireRole('admin') }, async (req) => {
    const body = settingsSchema.parse(req.body);
    const before = accessRequestSettings(req.orgId);
    const after = { ...before, ...body };
    if (after.restrictedSeeServerNames !== before.restrictedSeeServerNames || after.maxRequestMinutes !== before.maxRequestMinutes) {
      getDb()
        .update(organizations)
        .set({
          restrictedSeeServerNames: after.restrictedSeeServerNames,
          accessRequestMaxMinutes: after.maxRequestMinutes,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(organizations.id, req.orgId))
        .run();
      await audit(req, 'org.access_request_policy', 'organization', req.orgId, undefined, { from: before, to: after });
    }
    return after;
  });

  /**
   * What the caller could ask for: every server in the org by name when the
   * org allows it, else only those they already have (to extend). Members who
   * already see every server get an empty list.
   */
  app.get('/servers', async (req): Promise<RequestableServers> => {
    const settings = accessRequestSettings(req.orgId);
    const scope = serverScope(req);
    if (scope.all) return { restricted: false, settings, servers: [] };

    const granted = new Map(activeGrants(req.orgId, req.user.id).map((g) => [g.serverId, g]));
    const rows = getDb()
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(eq(servers.orgId, req.orgId))
      .orderBy(asc(servers.name))
      .all()
      .filter((s) => settings.restrictedSeeServerNames || granted.has(s.id));
    return {
      restricted: true,
      settings,
      servers: rows.map((s) => {
        const grant = granted.get(s.id);
        return { id: s.id, name: s.name, granted: grant ? { expiresAt: grant.expiresAt } : null };
      }),
    };
  });

  /** The cluster counterpart of GET /servers: what the caller could ask for, by name. */
  app.get('/clusters', async (req): Promise<RequestableClusters> => {
    const settings = accessRequestSettings(req.orgId);
    if (seesAllOf(req, 'cluster')) return { restricted: false, settings, clusters: [] };

    const granted = grantsOf(req.orgId, req.user.id, 'cluster');
    const rows = getDb()
      .select({ id: kubeClusters.id, name: kubeClusters.name })
      .from(kubeClusters)
      .where(eq(kubeClusters.orgId, req.orgId))
      .orderBy(asc(kubeClusters.name))
      .all()
      .filter((c) => settings.restrictedSeeServerNames || granted.has(c.id));
    return {
      restricted: true,
      settings,
      clusters: rows.map((c) => {
        const grant = granted.get(c.id);
        return { id: c.id, name: c.name, granted: grant ? { expiresAt: grant.expiresAt } : null };
      }),
    };
  });

  /**
   * Custom roles and resources the caller could ask for (custom roles spec
   * §6): every role by name, the resources they can already see (to ask for
   * a higher level or longer), and servers by name when the org lists them.
   * Never anything about a resource beyond its name.
   */
  app.get('/requestable', async (req): Promise<RequestableAccess> => {
    const settings = accessRequestSettings(req.orgId);
    if (resolveAccess(req).orgAdmin) return { canRequest: false, settings, roles: [], resources: [] };
    const db = getDb();
    const held = new Map(
      db
        .select({ roleId: roleMembers.roleId, expiresAt: roleMembers.expiresAt })
        .from(roleMembers)
        .where(
          and(
            eq(roleMembers.orgId, req.orgId),
            eq(roleMembers.userId, req.user.id),
            activeAt(roleMembers.expiresAt, new Date().toISOString()),
          ),
        )
        .all()
        .map((m) => [m.roleId, m.expiresAt]),
    );
    const roleRows = db
      .select({ id: roles.id, name: roles.name, description: roles.description, color: roles.color })
      .from(roles)
      .where(eq(roles.orgId, req.orgId))
      .orderBy(asc(roles.name))
      .all();
    const resources: RequestableAccess['resources'] = [];
    for (const type of RESOURCE_TYPES) {
      const levels = new Map(effectiveAccessList(req, type).map((e) => [e.resourceId, e.level]));
      for (const r of listResources(req.orgId, type)) {
        const level = levels.get(r.id) ?? null;
        if (level !== null || (type === 'server' && settings.restrictedSeeServerNames)) {
          resources.push({ type, id: r.id, name: r.name, level });
        }
      }
    }
    return {
      canRequest: true,
      settings,
      roles: roleRows.map((r) => ({ ...r, held: held.has(r.id) ? { expiresAt: held.get(r.id) ?? null } : null })),
      resources,
    };
  });

  /** Admins see the org's requests; everyone else only their own. Pending first, then newest. */
  app.get('/', async (req): Promise<AccessRequest[]> => {
    const query = listSchema.parse(req.query);
    const seesAll = rank(req.role) >= rank('admin') && query.mine !== 'true';
    const rows = getDb()
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.orgId, req.orgId),
          seesAll ? undefined : eq(accessRequests.userId, req.user.id),
          query.status ? eq(accessRequests.status, query.status) : undefined,
        ),
      )
      .orderBy(sql`case when ${accessRequests.status} = 'pending' then 0 else 1 end`, desc(accessRequests.createdAt))
      .limit(200)
      .all();
    return present(req.orgId, rows);
  });

  // Spam is bounded by MAX_PENDING_PER_MEMBER rather than a tighter rate limit
  app.post(
    '/',
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      const db = getDb();
      const settings = accessRequestSettings(req.orgId);

      // What is asked for, as stored and as named in the notification
      let stored: { resourceType: string; serverIds: string; roleId: string | null };
      let auditDetails: Record<string, unknown>;
      let names: string;

      // Servers or clusters at the base role's level, as before custom roles
      const legacy: LegacyKind | null = body.serverIds ? 'server' : body.clusterIds ? 'cluster' : null;
      if (legacy) {
        if (seesAllOf(req, legacy)) {
          return reply.status(400).send({ error: `You already have access to every ${legacy}` });
        }
      } else if (resolveAccess(req).orgAdmin) {
        return reply.status(400).send({ error: 'Owners and admins already have access to everything' });
      }
      if (body.durationMinutes > settings.maxRequestMinutes) {
        return reply
          .status(400)
          .send({ error: `Access can be requested for at most ${formatMinutes(settings.maxRequestMinutes)}` });
      }

      if (legacy) {
        const serverIds = [...new Set((legacy === 'cluster' ? body.clusterIds : body.serverIds)!)];
        const table = legacy === 'cluster' ? kubeClusters : servers;
        const known = new Map(
          db
            .select({ id: table.id, name: table.name })
            .from(table)
            .where(and(eq(table.orgId, req.orgId), inArray(table.id, serverIds)))
            .all()
            .map((s) => [s.id, s.name]),
        );
        const granted = grantsOf(req.orgId, req.user.id, legacy);
        // With names hidden, a server they cannot see answers exactly like one that does not exist
        const unknown = serverIds.some((id) => !known.has(id) || (!settings.restrictedSeeServerNames && !granted.has(id)));
        if (unknown) return reply.status(400).send({ error: `Unknown ${legacy} in ${legacy}Ids` });
        const permanent = serverIds.find((id) => granted.get(id)?.expiresAt === null);
        if (permanent) {
          return reply.status(400).send({ error: `You already have permanent access to ${known.get(permanent)}` });
        }
        const namespaces = legacy === 'cluster' && body.namespaces ? [...new Set(body.namespaces)].sort() : null;
        stored = {
          resourceType: legacy,
          // Namespaces need the object form; the level stays the base role's (null)
          serverIds: JSON.stringify(namespaces ? { ids: serverIds, level: null, namespaces } : serverIds),
          roleId: null,
        };
        auditDetails =
          legacy === 'cluster' ? { resourceType: 'cluster', clusters: serverIds, ...(namespaces && { namespaces }) } : { servers: serverIds };
        names = serverIds.map((s) => known.get(s)!).join(', ') + namespacesText(namespaces);
      } else if (body.roleId) {
        const role = db
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(and(eq(roles.id, body.roleId), eq(roles.orgId, req.orgId)))
          .get();
        if (!role) return reply.status(400).send({ error: 'Unknown role' });
        const held = db
          .select({ expiresAt: roleMembers.expiresAt })
          .from(roleMembers)
          .where(and(eq(roleMembers.roleId, role.id), eq(roleMembers.userId, req.user.id)))
          .get();
        if (held && held.expiresAt === null) {
          return reply.status(400).send({ error: `You already hold the ${role.name} role` });
        }
        stored = { resourceType: 'role', serverIds: '[]', roleId: role.id };
        auditDetails = { roleId: role.id, role: role.name };
        names = `the ${role.name} role`;
      } else {
        const type = body.resourceType!;
        const level = body.level!;
        const ids = [...new Set(body.resourceIds!)];
        const namespaces = type === 'cluster' && body.namespaces ? [...new Set(body.namespaces)].sort() : null;
        const known = new Map(listResources(req.orgId, type).map((r) => [r.id, r.name]));
        for (const id of ids) {
          const current = known.has(id) ? levelFor(req, type, id) : null;
          // Only what the member can already see — or, for servers, what the org lists by name
          const listed = current !== null || (type === 'server' && settings.restrictedSeeServerNames);
          if (!known.has(id) || !listed) return reply.status(400).send({ error: 'Unknown resource in resourceIds' });
          // Asking for what is already held for good, at that level, would change nothing
          const covers = (held: string[] | null | undefined) =>
            held == null || (namespaces !== null && namespaces.every((ns) => held.includes(ns)));
          if (current?.via.some((v) => meetsLevel(v.level, level) && !v.expiresAt && covers(v.namespaces))) {
            return reply.status(400).send({ error: `You already have ${current.level} access to ${known.get(id)}` });
          }
        }
        stored = { resourceType: type, serverIds: JSON.stringify({ ids, level, ...(namespaces && { namespaces }) }), roleId: null };
        auditDetails = { type, resources: ids, level, ...(namespaces && { namespaces }) };
        names = `${ids.map((id) => known.get(id)!).join(', ')}${namespacesText(namespaces)} (${level})`;
      }

      const recent = db
        .select({ n: count() })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.orgId, req.orgId),
            eq(accessRequests.userId, req.user.id),
            gt(accessRequests.createdAt, new Date(Date.now() - 60 * 60_000).toISOString()),
          ),
        )
        .get();
      if ((recent?.n ?? 0) >= MAX_CREATED_PER_HOUR) {
        return reply.status(429).send({ error: 'Too many access requests in the last hour. Try again later.' });
      }

      const pending = db
        .select({ n: count() })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.orgId, req.orgId),
            eq(accessRequests.userId, req.user.id),
            eq(accessRequests.status, 'pending'),
          ),
        )
        .get();
      if ((pending?.n ?? 0) >= MAX_PENDING_PER_MEMBER) {
        return reply.status(409).send({ error: 'You have too many pending requests. Cancel one or wait for a decision.' });
      }

      const id = nanoid();
      const now = Date.now();
      db.insert(accessRequests)
        .values({
          id,
          orgId: req.orgId,
          userId: req.user.id,
          ...stored,
          reason: body.reason,
          durationMinutes: body.durationMinutes,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
        })
        .run();

      await audit(req, 'access_request.create', 'access_request', id, req.user.email, {
        ...auditDetails,
        minutes: body.durationMinutes,
      });

      const reason = chatSafe(body.reason);
      notifyNotice(
        req.orgId,
        {
          event: 'access_request.created',
          title: `Access request from ${chatSafe(req.user.displayName || req.user.email)}`,
          message: `${req.user.email} asks for ${formatMinutes(body.durationMinutes)} of access to ${names}: ${reason}`,
          details: [
            ['Requested by', req.user.email],
            [body.roleId ? 'Role' : body.serverIds ? 'Servers' : body.clusterIds ? 'Clusters' : 'Resources', names],
            ['Duration', formatMinutes(body.durationMinutes)],
            ['Reason', reason],
            ['Review', reviewLink()],
          ],
        },
        adminEmails(req.orgId, req.user.id),
      );

      return reply.status(201).send(present(req.orgId, [findRequest(req.orgId, id)!])[0]);
    },
  );

  /** The requester withdraws their own pending request. */
  app.post('/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = findRequest(req.orgId, id);
    // Someone else's request does not exist as far as this caller is concerned
    if (!request || request.userId !== req.user.id) {
      return reply.status(404).send({ error: 'Access request not found' });
    }
    if (!decide(id, { status: 'cancelled', decidedAt: new Date().toISOString() })) {
      return reply.status(409).send({ error: `This request is no longer pending (${request.status})` });
    }
    await audit(req, 'access_request.cancel', 'access_request', id, req.user.email);
    return present(req.orgId, [findRequest(req.orgId, id)!])[0];
  });

  app.post('/:id/approve', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = approveSchema.parse(req.body ?? {});
    const request = decidable(req, reply, 'approve');
    if (!request) return reply;

    const minutes = body.durationMinutes ?? request.durationMinutes;
    if (minutes > request.durationMinutes) {
      return reply.status(400).send({ error: 'Approval can shorten the requested time, not extend it' });
    }

    const db = getDb();
    const member = db
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.userId, request.userId), eq(memberships.orgId, req.orgId)))
      .get();
    if (!member) return reply.status(409).send({ error: 'The requester is no longer a member of this organization' });
    if (member.status !== 'active') {
      return reply.status(409).send({ error: 'The requester is suspended in this organization' });
    }

    const target = targetOf(request);
    let ids: string[] = [];
    let role: { id: string; name: string } | undefined;
    if (target.type === 'role') {
      role = request.roleId
        ? db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(and(eq(roles.id, request.roleId), eq(roles.orgId, req.orgId)))
            .get()
        : undefined;
      if (!role) return reply.status(409).send({ error: 'The requested role no longer exists' });
    } else {
      // Resources deleted since the request was made are simply skipped
      const type = target.type;
      ids = target.ids.filter((id) => resourceExists(req.orgId, type, id));
      if (ids.length === 0) {
        return reply
          .status(409)
          .send({ error: `None of the requested ${type === 'server' ? 'servers' : 'resources'} exist any more` });
      }
    }

    // Cluster requests: the namespaces granted — those the approver picked
    // (only ever fewer than asked), else as asked; null = the whole cluster
    if (body.namespaces && target.type !== 'cluster') {
      return reply.status(400).send({ error: 'Only cluster requests can be narrowed to namespaces' });
    }
    const picked = body.namespaces ? [...new Set(body.namespaces)].sort() : null;
    if (picked && target.namespaces && picked.some((ns) => !target.namespaces!.includes(ns))) {
      return reply.status(400).send({ error: 'Approval can narrow the namespaces asked for, not add to them' });
    }
    const namespaces = target.type === 'cluster' ? (picked ?? target.namespaces) : null;

    const now = new Date();
    const expiresAt = minutesFromNow(minutes, now.getTime());
    let extended: string[] = [];
    let roleBefore: { expiresAt: string | null } | null = null;
    /** The level granted when the namespaces narrow a request at the base role's level. */
    let grantedLevel: AccessLevel | null = target.level;
    const won = db.transaction(() => {
      // Suspending or removing the member cancels the request; this closes
      // the gap between the check above and the decision
      const stillActive = db
        .select({ status: memberships.status, role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, request.userId), eq(memberships.orgId, req.orgId)))
        .get();
      if (stillActive?.status !== 'active') return false;
      if (!decide(request.id, {
        status: 'approved',
        approvedMinutes: minutes,
        decidedBy: req.user.id,
        decidedAt: now.toISOString(),
        decisionNote: body.note || null,
        expiresAt,
        // What was granted, beside what was asked
        ...(picked && {
          serverIds: JSON.stringify({ ids: target.ids, level: target.level, namespaces: target.namespaces, approvedNamespaces: picked }),
        }),
      })) {
        return false;
      }
      const grant = { expiresAt, grantedBy: req.user.id, reason: request.reason };
      if (role) {
        // A temporary role membership; one already held for longer stays as it is
        const where = and(eq(roleMembers.roleId, role.id), eq(roleMembers.userId, request.userId));
        const held = db.select({ expiresAt: roleMembers.expiresAt }).from(roleMembers).where(where).get();
        roleBefore = held ? { expiresAt: held.expiresAt } : null;
        if (!held) {
          db.insert(roleMembers)
            .values({ roleId: role.id, userId: request.userId, orgId: req.orgId, expiresAt, addedBy: req.user.id, addedAt: now.toISOString() })
            .run();
          extended = [role.id];
        } else if (held.expiresAt !== null && held.expiresAt < expiresAt) {
          db.update(roleMembers).set({ expiresAt, addedBy: req.user.id }).where(where).run();
          extended = [role.id];
        }
      } else if (target.level === null && !namespaces) {
        // Servers (or clusters) asked for without a level: the base role's level, as before custom roles
        extended =
          target.type === 'cluster'
            ? extendClusterGrants(req.orgId, request.userId, ids, grant)
            : extendGrants(req.orgId, request.userId, ids, grant);
      } else {
        // Narrowed to namespaces, a base-level cluster request becomes a personal
        // grant at the requester's base-role level, which keeps following that
        // role (a demotion before it expires lowers it) like a whole-cluster one
        const level = target.level ?? baseLevel(stillActive.role);
        grantedLevel = level;
        extended = ids.filter((id) =>
          addPersonalGrant(req.orgId, request.userId, target.type as ResourceType, id, level, grant, namespaces, {
            followsBaseRole: target.level === null,
          }),
        );
      }
      return true;
    });
    if (!won) return reply.status(409).send({ error: 'This request is no longer pending' });

    const requester = db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, request.userId))
      .get();
    await audit(req, 'access_request.approve', 'access_request', request.id, requester?.email, {
      userId: request.userId,
      ...(role
        ? { roleId: role.id, role: role.name }
        : target.type === 'server' && target.level === null
          ? { servers: ids }
          : target.type === 'cluster' && target.level === null
            ? { resourceType: 'cluster', clusters: ids, ...(namespaces && { level: grantedLevel }) }
            : { type: target.type, resources: ids, level: target.level }),
      // Namespaces asked for and granted (null = the whole cluster)
      ...(target.type === 'cluster' && { namespaces: { before: target.namespaces, after: namespaces } }),
      extended,
      minutes,
      requestedMinutes: request.durationMinutes,
      expiresAt,
    });
    if (role && extended.length) {
      await audit(req, 'role.member_add', 'role', role.id, role.name, {
        userId: request.userId,
        email: requester?.email,
        before: roleBefore,
        after: { expiresAt },
        accessRequestId: request.id,
      });
    }

    const [presented] = present(req.orgId, [findRequest(req.orgId, request.id)!]);
    const names = role
      ? `the ${role.name} role`
      : targetNames({ ...presented!, resources: presented!.resources?.filter((s) => ids.includes(s.id)) });
    notifyNotice(
      req.orgId,
      {
        event: 'access_request.approved',
        title: `Access approved for ${requester?.email ?? 'a member'}`,
        message: `${req.user.email} approved ${formatMinutes(minutes)} of access to ${names} for ${requester?.email ?? 'a member'}`,
        details: [
          ['Requested by', requester?.email ?? ''],
          [
            role
              ? 'Role'
              : target.level === null
                ? target.type === 'cluster'
                  ? 'Clusters'
                  : 'Servers'
                : 'Resources',
            names,
          ],
          ['Duration', formatMinutes(minutes)],
          ['Until', expiresAt],
          ['Approved by', req.user.email],
          ...(body.note ? ([['Note', body.note]] as [string, string][]) : []),
        ],
      },
      requester ? [requester.email] : [],
    );
    return presented;
  });

  app.post('/:id/deny', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = denySchema.parse(req.body ?? {});
    const request = decidable(req, reply, 'deny');
    if (!request) return reply;

    if (!decide(request.id, {
      status: 'denied',
      decidedBy: req.user.id,
      decidedAt: new Date().toISOString(),
      decisionNote: body.note || null,
    })) {
      return reply.status(409).send({ error: 'This request is no longer pending' });
    }

    const [presented] = present(req.orgId, [findRequest(req.orgId, request.id)!]);
    await audit(req, 'access_request.deny', 'access_request', request.id, presented!.userEmail, {
      userId: request.userId,
      servers: presented!.servers.map((s) => s.id),
      ...(presented!.resourceType === 'cluster' && !presented!.level && { clusters: presented!.clusters.map((s) => s.id) }),
      ...(presented!.role && { roleId: presented!.role.id }),
      ...(presented!.resourceType !== 'server' && presented!.resourceType !== 'role' && {
        type: presented!.resourceType,
        resources: presented!.resources?.map((s) => s.id),
      }),
      ...(presented!.level && { level: presented!.level }),
      ...(presented!.namespaces && { namespaces: presented!.namespaces }),
    });
    const legacy = presented!.resourceType === 'server' && !presented!.level;
    const legacyClusters = presented!.resourceType === 'cluster' && !presented!.level;
    const names = legacy
      ? presented!.servers.map((s) => s.name ?? s.id).join(', ')
      : legacyClusters
        ? presented!.clusters.map((s) => s.name ?? s.id).join(', ') + namespacesText(presented!.namespaces)
        : targetNames(presented!);
    notifyNotice(
      req.orgId,
      {
        event: 'access_request.denied',
        title: `Access denied for ${presented!.userEmail}`,
        message: `${req.user.email} denied ${presented!.userEmail}'s request for access to ${names}`,
        details: [
          ['Requested by', presented!.userEmail],
          [legacy ? 'Servers' : legacyClusters ? 'Clusters' : presented!.resourceType === 'role' ? 'Role' : 'Resources', names],
          ['Denied by', req.user.email],
          ...(body.note ? ([['Note', body.note]] as [string, string][]) : []),
        ],
      },
      presented!.userEmail ? [presented!.userEmail] : [],
    );
    return presented;
  });
}
