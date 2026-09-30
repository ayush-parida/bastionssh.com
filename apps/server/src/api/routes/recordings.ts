import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type {
  RecordingCommandSource,
  RecordingKind,
  RecordingSettings,
  SessionRecording,
  SessionRecordingDetail,
} from '@smt/shared';
import { rank, requireAuth, requireRole } from '../../auth/middleware.js';
import { serverScope } from '../../auth/server-access.js';
import { requireStepUpIfPasskeys } from '../../auth/passkey.js';
import { getDb } from '../../db/index.js';
import { organizations, sessionRecordingCommands, sessionRecordings, users } from '../../db/schema.js';
import { audit } from '../../audit/index.js';
import {
  containerOfRecording,
  deleteRecordingFile,
  openCast,
  recordingFile,
  recordingSettings,
  type RecordingRow,
} from '../../recordings/index.js';

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a date')
  .transform((v) => new Date(v).toISOString());

const listSchema = z.object({
  serverId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  kind: z.enum(['terminal', 'exec', 'container']).optional(),
  /** Container shells whose container name or id contains this. */
  container: z.string().trim().min(1).max(255).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A LIKE pattern matching `text` anywhere, its own `%`, `_` and `\` taken literally (ESCAPE '\'). */
function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    recordInput: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/**
 * Who sees which recordings: admins and owners the whole org, everyone else
 * only their own — and never one on a server they may not access, so a
 * narrowed grant hides old recordings too. A recording whose server was
 * deleted stays visible only to those with access to every server.
 */
function visibleTo(req: FastifyRequest): SQL {
  const conditions: (SQL | undefined)[] = [eq(sessionRecordings.orgId, req.orgId)];
  if (rank(req.role) < rank('admin')) conditions.push(eq(sessionRecordings.userId, req.user.id));
  const scope = serverScope(req);
  if (!scope.all) conditions.push(inArray(sessionRecordings.serverId, scope.serverIds));
  return and(...conditions)!;
}

function findVisible(req: FastifyRequest, id: string) {
  return getDb()
    .select({ recording: sessionRecordings, userEmail: users.email })
    .from(sessionRecordings)
    .leftJoin(users, eq(users.id, sessionRecordings.userId))
    .where(and(eq(sessionRecordings.id, id), visibleTo(req)))
    .get();
}

function toRecording(row: RecordingRow, userEmail: string | null): SessionRecording {
  return {
    id: row.id,
    kind: row.kind as RecordingKind,
    serverId: row.serverId,
    serverName: row.serverName,
    userId: row.userId,
    userEmail,
    source: row.source as RecordingCommandSource | null,
    command: row.command,
    container: containerOfRecording(row),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    bytes: row.bytes,
    inputRecorded: row.inputRecorded,
    truncated: row.truncated,
    cols: row.cols,
    rows: row.rows,
  };
}

/** `web-1-2026-09-28T10-00-00.cast` — safe in a Content-Disposition header on every OS. */
function castFilename(row: RecordingRow): string {
  const name = (row.serverName ?? 'session').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `${name}-${row.startedAt.slice(0, 19).replace(/:/g, '-')}.cast`;
}

export async function recordingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Org recording policy. Every member may read it — the terminal says when input is captured. */
  app.get('/settings', async (req): Promise<RecordingSettings> => recordingSettings(req.orgId));

  /**
   * Owners only: switching recording off, or shortening retention, is exactly
   * what someone covering their tracks would do. Applies to sessions opened
   * from now on; live ones keep the policy they started with.
   */
  app.patch('/settings', { preHandler: requireRole('owner') }, async (req, reply) => {
    const body = settingsSchema.parse(req.body);
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return;

    const before = recordingSettings(req.orgId);
    getDb()
      .update(organizations)
      .set({
        ...(body.enabled !== undefined && { recordingEnabled: body.enabled }),
        ...(body.recordInput !== undefined && { recordingInput: body.recordInput }),
        ...(body.retentionDays !== undefined && { recordingRetentionDays: body.retentionDays }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organizations.id, req.orgId))
      .run();
    const after = recordingSettings(req.orgId);
    await audit(req, 'org.recording_settings', 'organization', req.orgId, undefined, { before, after });
    return after;
  });

  /** GET /api/recordings?serverId=&userId=&kind=&container=&from=&to=&page=&limit= */
  app.get('/', async (req) => {
    const q = listSchema.parse(req.query);
    const where = and(
      visibleTo(req),
      q.serverId ? eq(sessionRecordings.serverId, q.serverId) : undefined,
      q.userId ? eq(sessionRecordings.userId, q.userId) : undefined,
      q.kind ? eq(sessionRecordings.kind, q.kind) : undefined,
      // The container is named in `command` (recordings/index.ts containerLabel)
      q.container ? eq(sessionRecordings.kind, 'container') : undefined,
      q.container ? sql`${sessionRecordings.command} LIKE ${likeContains(q.container)} ESCAPE '\\'` : undefined,
      q.from ? gte(sessionRecordings.startedAt, q.from) : undefined,
      q.to ? lte(sessionRecordings.startedAt, q.to) : undefined,
    );
    const db = getDb();
    const rows = db
      .select({ recording: sessionRecordings, userEmail: users.email })
      .from(sessionRecordings)
      .leftJoin(users, eq(users.id, sessionRecordings.userId))
      .where(where)
      .orderBy(desc(sessionRecordings.startedAt))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .all();
    const total = db.select({ n: count() }).from(sessionRecordings).where(where).get()?.n ?? 0;
    return { items: rows.map((r) => toRecording(r.recording, r.userEmail)), total };
  });

  /** GET /api/recordings/:id → metadata and the log of commands run over the session */
  app.get('/:id', async (req, reply): Promise<SessionRecordingDetail | undefined> => {
    const { id } = req.params as { id: string };
    const found = findVisible(req, id);
    if (!found) return reply.status(404).send({ error: 'Recording not found' });

    const commands = getDb()
      .select()
      .from(sessionRecordingCommands)
      .where(eq(sessionRecordingCommands.recordingId, id))
      .orderBy(sessionRecordingCommands.at)
      .all()
      .map((c) => ({
        id: c.id,
        at: c.at,
        source: c.source as RecordingCommandSource,
        command: c.command,
        exitCode: c.exitCode,
        createdAt: c.createdAt,
      }));
    return { ...toRecording(found.recording, found.userEmail), commands };
  });

  /**
   * GET /api/recordings/:id/cast → the asciicast (uncompressed) for the player;
   * `?download=1` as an attachment. Both are audited: a recording can hold
   * anything that crossed the terminal.
   */
  app.get('/:id/cast', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { download } = req.query as { download?: string };
    const found = findVisible(req, id);
    if (!found) return reply.status(404).send({ error: 'Recording not found' });
    const row = found.recording;

    try {
      await fs.promises.access(recordingFile(row.filePath), fs.constants.R_OK);
    } catch {
      return reply.status(404).send({ error: 'The recording file is missing' });
    }

    const asDownload = download === '1' || download === 'true';
    await audit(req, asDownload ? 'recording.download' : 'recording.view', 'recording', row.id, row.serverName ?? undefined, {
      serverId: row.serverId,
      recordedUserId: row.userId,
    });

    reply
      .header('Content-Type', 'application/x-asciicast; charset=utf-8')
      // A live recording keeps growing; never serve a stale copy
      .header('Cache-Control', 'no-store');
    if (asDownload) {
      reply.header('Content-Disposition', `attachment; filename="${castFilename(row)}"`);
    }
    return reply.send(openCast(row));
  });

  /** DELETE /api/recordings/:id — owners only, and never one that is still recording */
  app.delete('/:id', { preHandler: requireRole('owner') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = findVisible(req, id);
    if (!found) return reply.status(404).send({ error: 'Recording not found' });
    const row = found.recording;
    if (!row.endedAt) return reply.status(409).send({ error: 'This session is still being recorded' });
    if (!requireStepUpIfPasskeys(req, reply, req.orgId)) return;

    await deleteRecordingFile(row);
    getDb().delete(sessionRecordings).where(eq(sessionRecordings.id, id)).run();
    await audit(req, 'recording.delete', 'recording', row.id, row.serverName ?? undefined, {
      serverId: row.serverId,
      recordedUserId: row.userId,
      startedAt: row.startedAt,
      kind: row.kind,
    });
    return reply.status(204).send();
  });
}
