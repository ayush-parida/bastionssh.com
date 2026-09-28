import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type {
  AccessRequest,
  AccessRequestSettings,
  AccessRequestStatus,
  RequestableServers,
} from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { getDb } from '../../db/index.js';
import { accessRequests, memberships, organizations, servers, users } from '../../db/schema.js';
import { activeGrants, extendGrants, minutesFromNow, REQUEST_TTL_MS } from '../../auth/access-grants.js';
import { serverScope } from '../../auth/server-access.js';
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
 * members can only ask to extend access to servers they already have.
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

const createSchema = z.object({
  serverIds: z.array(z.string().min(1)).min(1).max(50),
  reason: z.string().trim().min(3).max(500),
  durationMinutes: z.number().int().min(5).max(MAX_POLICY_MINUTES),
});

const approveSchema = z.object({
  durationMinutes: z.number().int().min(5).max(MAX_POLICY_MINUTES).optional(),
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

/** Rows as the API returns them, with people and server names resolved in bulk. */
function present(orgId: string, rows: RequestRow[]): AccessRequest[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const serverIds = [...new Set(rows.flatMap((r) => parseServerIds(r.serverIds)))];
  const names = new Map(
    serverIds.length
      ? db
          .select({ id: servers.id, name: servers.name })
          .from(servers)
          .where(and(eq(servers.orgId, orgId), inArray(servers.id, serverIds)))
          .all()
          .map((s) => [s.id, s.name])
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
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userEmail: people.get(r.userId)?.email ?? '',
    userDisplayName: people.get(r.userId)?.displayName ?? '',
    // A deleted server keeps its place in the request, without a name
    servers: parseServerIds(r.serverIds).map((id) => ({ id, name: names.get(id) ?? null })),
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
  }));
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

      if (serverScope(req).all) {
        return reply.status(400).send({ error: 'You already have access to every server' });
      }
      if (body.durationMinutes > settings.maxRequestMinutes) {
        return reply
          .status(400)
          .send({ error: `Access can be requested for at most ${formatMinutes(settings.maxRequestMinutes)}` });
      }

      const serverIds = [...new Set(body.serverIds)];
      const known = new Map(
        db
          .select({ id: servers.id, name: servers.name })
          .from(servers)
          .where(and(eq(servers.orgId, req.orgId), inArray(servers.id, serverIds)))
          .all()
          .map((s) => [s.id, s.name]),
      );
      const granted = new Map(activeGrants(req.orgId, req.user.id).map((g) => [g.serverId, g]));
      // With names hidden, a server they cannot see answers exactly like one that does not exist
      const unknown = serverIds.some((id) => !known.has(id) || (!settings.restrictedSeeServerNames && !granted.has(id)));
      if (unknown) return reply.status(400).send({ error: 'Unknown server in serverIds' });
      const permanent = serverIds.find((id) => granted.get(id)?.expiresAt === null);
      if (permanent) {
        return reply.status(400).send({ error: `You already have permanent access to ${known.get(permanent)}` });
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
          serverIds: JSON.stringify(serverIds),
          reason: body.reason,
          durationMinutes: body.durationMinutes,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
        })
        .run();

      await audit(req, 'access_request.create', 'access_request', id, req.user.email, {
        servers: serverIds,
        minutes: body.durationMinutes,
      });

      const names = serverIds.map((s) => known.get(s)!).join(', ');
      const reason = chatSafe(body.reason);
      notifyNotice(
        req.orgId,
        {
          event: 'access_request.created',
          title: `Access request from ${chatSafe(req.user.displayName || req.user.email)}`,
          message: `${req.user.email} asks for ${formatMinutes(body.durationMinutes)} of access to ${names}: ${reason}`,
          details: [
            ['Requested by', req.user.email],
            ['Servers', names],
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

    // Servers deleted since the request was made are simply skipped
    const requested = parseServerIds(request.serverIds);
    const serverIds = requested.length
      ? db
          .select({ id: servers.id })
          .from(servers)
          .where(and(eq(servers.orgId, req.orgId), inArray(servers.id, requested)))
          .all()
          .map((s) => s.id)
      : [];
    if (serverIds.length === 0) {
      return reply.status(409).send({ error: 'None of the requested servers exist any more' });
    }

    const now = new Date();
    const expiresAt = minutesFromNow(minutes, now.getTime());
    let extended: string[] = [];
    const won = db.transaction(() => {
      // Suspending or removing the member cancels the request; this closes
      // the gap between the check above and the decision
      const stillActive = db
        .select({ status: memberships.status })
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
      })) {
        return false;
      }
      extended = extendGrants(req.orgId, request.userId, serverIds, {
        expiresAt,
        grantedBy: req.user.id,
        reason: request.reason,
      });
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
      servers: serverIds,
      extended,
      minutes,
      requestedMinutes: request.durationMinutes,
      expiresAt,
    });

    const [presented] = present(req.orgId, [findRequest(req.orgId, request.id)!]);
    const names = presented!.servers.filter((s) => serverIds.includes(s.id)).map((s) => s.name ?? s.id).join(', ');
    notifyNotice(
      req.orgId,
      {
        event: 'access_request.approved',
        title: `Access approved for ${requester?.email ?? 'a member'}`,
        message: `${req.user.email} approved ${formatMinutes(minutes)} of access to ${names} for ${requester?.email ?? 'a member'}`,
        details: [
          ['Requested by', requester?.email ?? ''],
          ['Servers', names],
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
    });
    const names = presented!.servers.map((s) => s.name ?? s.id).join(', ');
    notifyNotice(
      req.orgId,
      {
        event: 'access_request.denied',
        title: `Access denied for ${presented!.userEmail}`,
        message: `${req.user.email} denied ${presented!.userEmail}'s request for access to ${names}`,
        details: [
          ['Requested by', presented!.userEmail],
          ['Servers', names],
          ['Denied by', req.user.email],
          ...(body.note ? ([['Note', body.note]] as [string, string][]) : []),
        ],
      },
      presented!.userEmail ? [presented!.userEmail] : [],
    );
    return presented;
  });
}
