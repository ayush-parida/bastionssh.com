import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AuditForwardingInfo, AuditLogEntry, AuditSettings } from '@smt/shared';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { getDb } from '../../db/index.js';
import { auditForwarders, auditLog, organizations, users } from '../../db/schema.js';
import { and, asc, count, desc, eq, gt, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { audit } from '../../audit/index.js';
import {
  currentCursor,
  decryptConfig,
  deliver,
  describeError,
  encryptConfig,
  resetBackoff,
  targetHint,
  toEntry,
  toForwardingInfo,
  type ForwarderConfig,
} from '../../audit/forward.js';
import { MAX_AUDIT_RETENTION_DAYS, MIN_AUDIT_RETENTION_DAYS } from '../../audit/retention.js';
import { resolveSafeTarget, UnsafeTargetError } from '../../net/ssrf.js';

// ── Filters ──────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO timestamp or a bare YYYY-MM-DD, normalized to the stored ISO form. */
const timeParam = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO date or timestamp');

export const filterSchema = z.object({
  from: timeParam.optional(),
  to: timeParam.optional(),
  action: z
    .string()
    .max(100)
    .regex(/^[a-z0-9_.]+\*?$/i, 'must be an action name, or a prefix ending in *')
    .optional(),
  actorEmail: z.string().max(320).optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(200).optional(),
});

const listSchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const exportSchema = filterSchema.extend({
  format: z.enum(['csv', 'jsonl']).default('csv'),
});

type Filters = z.infer<typeof filterSchema>;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function filterConditions(orgId: string, f: Filters): SQL[] {
  const where: SQL[] = [eq(auditLog.orgId, orgId)];
  if (f.from) where.push(gte(auditLog.createdAt, new Date(f.from).toISOString()));
  if (f.to) {
    // A bare date means "through the end of that day"
    if (DATE_ONLY.test(f.to)) {
      where.push(lt(auditLog.createdAt, new Date(Date.parse(f.to) + 24 * 60 * 60 * 1000).toISOString()));
    } else where.push(lte(auditLog.createdAt, new Date(f.to).toISOString()));
  }
  if (f.action) {
    if (f.action.endsWith('*')) {
      where.push(sql`${auditLog.action} LIKE ${`${likeEscape(f.action.slice(0, -1))}%`} ESCAPE '\\'`);
    } else where.push(eq(auditLog.action, f.action));
  }
  if (f.actorEmail) where.push(sql`lower(${auditLog.actorEmail}) = ${f.actorEmail.trim().toLowerCase()}`);
  if (f.resourceType) where.push(eq(auditLog.resourceType, f.resourceType));
  if (f.resourceId) where.push(eq(auditLog.resourceId, f.resourceId));
  return where;
}

// ── Export ───────────────────────────────────────────────────────────────────

const EXPORT_PAGE = 1_000;

const CSV_COLUMNS = [
  'createdAt',
  'id',
  'actorId',
  'actorEmail',
  'action',
  'resourceType',
  'resourceId',
  'resourceName',
  'ipAddress',
  'userAgent',
  'metadata',
] as const;

/**
 * One CSV cell. Quoted when it must be, and a leading = + - @ (or tab/CR) is
 * defused with a quote mark, so a spreadsheet does not run a user agent or
 * resource name someone chose as a formula.
 */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(entry: AuditLogEntry): string {
  return `${CSV_COLUMNS.map((c) => csvCell(entry[c])).join(',')}\r\n`;
}

/** Oldest first, a page at a time by (created_at, rowid), so an export of any size streams. */
function* exportRows(where: SQL[]): Generator<AuditLogEntry> {
  const db = getDb();
  let cursor: { createdAt: string; rowid: number } | null = null;
  for (;;) {
    const page: { entry: typeof auditLog.$inferSelect; rowid: number }[] = db
      .select({ entry: auditLog, rowid: sql<number>`${auditLog}.rowid`.as('rid') })
      .from(auditLog)
      .where(
        and(
          ...where,
          cursor
            ? or(
                gt(auditLog.createdAt, cursor.createdAt),
                and(eq(auditLog.createdAt, cursor.createdAt), gt(sql`${auditLog}.rowid`, cursor.rowid)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(auditLog.createdAt), asc(sql`${auditLog}.rowid`))
      .limit(EXPORT_PAGE)
      .all();
    for (const row of page) yield toEntry(row.entry);
    if (page.length < EXPORT_PAGE) return;
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.entry.createdAt, rowid: last.rowid };
  }
}

// ── Forwarding input ─────────────────────────────────────────────────────────

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((h) => h.replace(/^\[(.*)\]$/, '$1'))
  .refine((h) => /^[a-z0-9.\-:]+$/i.test(h), 'must be a hostname or IP address');

const pem = z
  .string()
  .max(64 * 1024)
  .refine((v) => v === '' || v.includes('-----BEGIN CERTIFICATE-----'), 'must be a PEM certificate bundle');

const forwardingSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('syslog'),
    host: hostname,
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['udp', 'tcp', 'tls']),
    facility: z.number().int().min(0).max(23).default(13),
    caCert: pem.optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((u) => {
        try {
          const p = new URL(u).protocol;
          return p === 'https:' || p === 'http:';
        } catch {
          return false;
        }
      }, 'must be an http(s) URL')
      .optional(),
    secret: z.string().max(256).optional(),
    enabled: z.boolean().optional(),
  }),
]);

function sendUnsafe(reply: FastifyReply, err: unknown) {
  if (err instanceof UnsafeTargetError) return reply.status(400).send({ error: err.message });
  throw err;
}

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const db = getDb();
    const { page, limit, ...filters } = listSchema.parse(req.query);
    const offset = (page - 1) * limit;
    const where = and(...filterConditions(req.orgId, filters));

    const items = db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        resourceName: auditLog.resourceName,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actorId: auditLog.actorId,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorId, users.id))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const results = db
      .select({ value: count() })
      .from(auditLog)
      .where(where)
      .all();
    const total = results[0]?.value ?? 0;

    return { items, total };
  });

  /** The whole (filtered) log as CSV or JSON Lines, oldest first, streamed. */
  app.get('/export', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { format, ...filters } = exportSchema.parse(req.query);
    const where = filterConditions(req.orgId, filters);
    const org = getDb().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, req.orgId)).get();
    // Before the rows go out, so the export is itself on record in what it exports
    await audit(req, 'audit.export', 'audit_log', undefined, undefined, { format, filters });

    const rows = exportRows(where);
    const body = Readable.from(
      (function* () {
        if (format === 'csv') yield `${CSV_COLUMNS.join(',')}\r\n`;
        for (const entry of rows) yield format === 'csv' ? csvLine(entry) : `${JSON.stringify(entry)}\n`;
      })(),
    );
    const date = new Date().toISOString().slice(0, 10);
    const filename = `audit-${org?.slug ?? 'org'}-${date}.${format === 'csv' ? 'csv' : 'jsonl'}`;
    return reply
      .header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });

  app.get('/settings', { preHandler: requireRole('admin') }, async (req): Promise<AuditSettings> => {
    const db = getDb();
    const org = db
      .select({ retentionDays: organizations.auditRetentionDays })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .get();
    const row = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).get();
    return { retentionDays: org?.retentionDays ?? 365, forwarding: row ? await toForwardingInfo(row) : null };
  });

  /** How long audit rows are kept. Shortening it deletes history, so it takes a passkey when there is one. */
  app.put('/settings/retention', { preHandler: requireRole('owner') }, async (req, reply) => {
    const { retentionDays } = z
      .object({ retentionDays: z.number().int().min(MIN_AUDIT_RETENTION_DAYS).max(MAX_AUDIT_RETENTION_DAYS) })
      .parse(req.body);
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const db = getDb();
    const before = db
      .select({ retentionDays: organizations.auditRetentionDays })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .get();
    db.update(organizations)
      .set({ auditRetentionDays: retentionDays, updatedAt: new Date().toISOString() })
      .where(eq(organizations.id, req.orgId))
      .run();
    await audit(req, 'audit.retention_update', 'organization', req.orgId, undefined, {
      from: before?.retentionDays,
      to: retentionDays,
    });
    return { retentionDays };
  });

  /**
   * Set where new audit rows are copied to. Secrets are vaulted; the target
   * must resolve to a public address unless the operator allowed its network.
   * A new target starts from now: existing history is not replayed.
   */
  app.put('/forwarding', { preHandler: requireRole('owner') }, async (req, reply): Promise<AuditForwardingInfo> => {
    const input = forwardingSchema.parse(req.body);
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const db = getDb();
    const existing = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).get();
    const previous = existing ? await decryptConfig(existing) : null;

    let cfg: ForwarderConfig;
    try {
      if (input.type === 'syslog') {
        const keptCa = previous?.type === 'syslog' ? previous.caCert : undefined;
        const caCert = input.caCert === undefined ? keptCa : input.caCert || undefined;
        cfg = {
          type: 'syslog',
          host: input.host,
          port: input.port,
          protocol: input.protocol,
          facility: input.facility,
          ...(input.protocol === 'tls' && caCert && { caCert }),
        };
        await resolveSafeTarget(input.host);
      } else {
        const url = input.url ?? (previous?.type === 'webhook' ? previous.url : undefined);
        if (!url) return reply.status(400).send({ error: 'url: required' });
        const keptSecret = previous?.type === 'webhook' ? previous.secret : undefined;
        const secret = input.secret === undefined ? keptSecret : input.secret || undefined;
        cfg = { type: 'webhook', url, ...(secret && { secret }) };
        const parsed = new URL(url);
        const target = await resolveSafeTarget(parsed.hostname);
        if (parsed.protocol === 'http:' && !target.internal) {
          return reply
            .status(400)
            .send({ error: 'Webhook URLs must use https unless they point into SMT_AUDIT_FORWARD_ALLOW_NETS' });
        }
      }
    } catch (err) {
      return sendUnsafe(reply, err);
    }

    const now = new Date().toISOString();
    const values = {
      type: cfg.type,
      enabled: input.enabled ?? existing?.enabled ?? true,
      encryptedConfig: await encryptConfig(req.orgId, cfg),
      targetHint: targetHint(cfg),
      lastStatus: null,
      lastError: null,
      updatedAt: now,
    };
    if (existing) {
      db.update(auditForwarders).set(values).where(eq(auditForwarders.orgId, req.orgId)).run();
    } else {
      db.insert(auditForwarders)
        .values({ orgId: req.orgId, ...values, ...currentCursor(req.orgId), createdBy: req.user.id, createdAt: now })
        .run();
    }
    resetBackoff(req.orgId);
    await audit(req, 'audit.forwarding_update', 'audit_forwarder', req.orgId, values.targetHint, {
      type: cfg.type,
      enabled: values.enabled,
      ...(cfg.type === 'syslog' ? { protocol: cfg.protocol } : { signed: !!cfg.secret }),
      created: !existing,
    });
    const row = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).get()!;
    return toForwardingInfo(row);
  });

  app.delete('/forwarding', { preHandler: requireRole('owner') }, async (req, reply) => {
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return reply;
    const db = getDb();
    const existing = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).get();
    if (!existing) return reply.status(404).send({ error: 'Audit forwarding is not configured' });
    db.delete(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).run();
    resetBackoff(req.orgId);
    await audit(req, 'audit.forwarding_delete', 'audit_forwarder', req.orgId, existing.targetHint, {
      type: existing.type,
    });
    return reply.status(204).send();
  });

  /** Send one test event now and report whether the target took it. */
  app.post(
    '/forwarding/test',
    { preHandler: requireRole('owner'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const db = getDb();
      const row = db.select().from(auditForwarders).where(eq(auditForwarders.orgId, req.orgId)).get();
      if (!row) return reply.status(404).send({ error: 'Audit forwarding is not configured' });
      const entry: AuditLogEntry = {
        id: `test-${nanoid()}`,
        orgId: req.orgId,
        actorId: req.user.id,
        actorEmail: req.user.email,
        action: 'audit.forwarding_test',
        resourceType: 'audit_forwarder',
        resourceId: req.orgId,
        metadata: { test: true },
        createdAt: new Date().toISOString(),
      };
      let error: string | null = null;
      try {
        await deliver(await decryptConfig(row), [entry]);
      } catch (err) {
        error = describeError(err);
      }
      await audit(req, 'audit.forwarding_test', 'audit_forwarder', req.orgId, row.targetHint, {
        ok: !error,
        ...(error && { error }),
      });
      if (error) return reply.status(502).send({ error: `Test event was not delivered: ${error}` });
      return { ok: true };
    },
  );
}
