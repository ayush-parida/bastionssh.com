import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ExecResult } from '../ssh/broker.js';
import type { RecordingCommandSource, RecordingKind, RecordingSettings } from '@smt/shared';
import { getDb } from '../db/index.js';
import { organizations, sessionRecordingCommands, sessionRecordings } from '../db/schema.js';
import { config } from '../config/index.js';
import { auditSystem } from '../audit/index.js';
import logger from '../logger.js';
import { compressCast, createCastWriter, type CastWriter } from './recorder.js';

/**
 * Session recording: the org policy, the recording rows and their files.
 *
 * Recording fails open — if the directory is unwritable the session still
 * opens, unrecorded, and the failure is logged. Refusing every terminal because
 * a disk filled up would lock admins out of the very servers they need to fix.
 */

export type RecordingRow = typeof sessionRecordings.$inferSelect;

export const DEFAULT_RETENTION_DAYS = 90;

/** Exec channels have no terminal; replay them at a comfortable width. */
const EXEC_COLS = 120;
const EXEC_ROWS = 40;

export function recordingSettings(orgId: string): RecordingSettings {
  const org = getDb()
    .select({
      enabled: organizations.recordingEnabled,
      recordInput: organizations.recordingInput,
      retentionDays: organizations.recordingRetentionDays,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();
  return org ?? { enabled: false, recordInput: false, retentionDays: DEFAULT_RETENTION_DAYS };
}

export function recordingsDir(): string {
  return path.resolve(config.recordings.dir);
}

/** Resolve a stored relative path, refusing anything that escapes the recordings directory. */
export function recordingFile(relative: string): string {
  const root = recordingsDir();
  const abs = path.resolve(root, relative);
  if (!abs.startsWith(root + path.sep)) throw new Error('Recording path escapes the recordings directory');
  return abs;
}

function relativeFile(abs: string): string {
  return path.relative(recordingsDir(), abs);
}

interface RecordingContext {
  orgId: string;
  serverId: string;
  serverName: string;
  userId: string;
}

/** Insert the row and open its cast. Null when recording is off or cannot start. */
function openRecording(
  ctx: RecordingContext,
  row: {
    id?: string;
    kind: RecordingKind;
    source?: RecordingCommandSource;
    command?: string;
    title?: string;
    inputRecorded: boolean;
    cols: number;
    rows: number;
  },
): { id: string; writer: CastWriter } | null {
  const id = row.id ?? nanoid();
  const relative = path.join(ctx.orgId, `${id}.cast`);
  let writer: CastWriter;
  try {
    writer = createCastWriter({
      file: recordingFile(relative),
      header: {
        width: row.cols,
        height: row.rows,
        timestamp: Math.floor(Date.now() / 1000),
        title: row.title ?? (row.command ? `${ctx.serverName}: ${row.command}` : ctx.serverName),
        env: { TERM: 'xterm-256color' },
      },
      maxBytes: config.recordings.maxBytes,
      crlf: row.kind === 'exec',
    });
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId, serverId: ctx.serverId }, 'Could not start session recording');
    return null;
  }
  try {
    getDb()
      .insert(sessionRecordings)
      .values({
        id,
        orgId: ctx.orgId,
        serverId: ctx.serverId,
        serverName: ctx.serverName,
        userId: ctx.userId,
        kind: row.kind,
        source: row.source,
        command: row.command,
        filePath: relative,
        inputRecorded: row.inputRecorded,
        cols: row.cols,
        rows: row.rows,
      })
      .run();
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId }, 'Could not save session recording');
    void writer.discard();
    return null;
  }
  return { id, writer };
}

/** Close the cast and store where it ended up. Never throws. */
async function closeRecording(id: string, writer: CastWriter) {
  try {
    const result = await writer.finish();
    getDb()
      .update(sessionRecordings)
      .set({
        endedAt: new Date().toISOString(),
        bytes: result.bytes,
        truncated: result.truncated,
        filePath: relativeFile(result.file),
      })
      .where(eq(sessionRecordings.id, id))
      .run();
  } catch (err) {
    logger.error({ err, recordingId: id }, 'Could not finalize session recording');
  }
}

export interface TerminalRecording {
  id: string;
  inputRecorded: boolean;
  output(data: Buffer): void;
  input(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  /** Log a command run over this session's connection (a marker in the cast plus a row). */
  command(entry: { source: RecordingCommandSource; command: string; exitCode: number | null }): void;
  finish(): Promise<void>;
  /** Drop the recording entirely — the connection failed before a shell opened. */
  discard(): Promise<void>;
}

/**
 * How a container shell's recording names its container, in the `command`
 * column: `web-1 (3f2a9c1b2d4e)`. Kept there rather than in a column of its
 * own, and read back by {@link containerOfRecording}.
 */
export function containerLabel(container: { id: string; name: string }): string {
  return `${container.name} (${container.id.slice(0, 12)})`;
}

const CONTAINER_LABEL = /^(.+) \(([0-9a-f]{12})\)$/;

/** The container a `container` recording ran in, from its {@link containerLabel}. */
export function containerOfRecording(row: Pick<RecordingRow, 'kind' | 'command'>): { id: string; name: string } | null {
  if (row.kind !== 'container' || !row.command) return null;
  const match = CONTAINER_LABEL.exec(row.command);
  return match ? { name: match[1]!, id: match[2]! } : null;
}

/**
 * Start recording an interactive terminal, if the org records sessions. With
 * `container`, the terminal is a shell inside that container (Docker exec),
 * recorded as kind `container` with the container named.
 */
export function startTerminalRecording(
  ctx: RecordingContext & { cols: number; rows: number; container?: { id: string; name: string } },
): TerminalRecording | null {
  const settings = recordingSettings(ctx.orgId);
  if (!settings.enabled) return null;

  const opened = openRecording(ctx, {
    kind: ctx.container ? 'container' : 'terminal',
    ...(ctx.container && {
      command: containerLabel(ctx.container),
      title: `${ctx.serverName} › ${ctx.container.name}`,
    }),
    inputRecorded: settings.recordInput,
    cols: ctx.cols,
    rows: ctx.rows,
  });
  if (!opened) return null;
  const { id, writer } = opened;
  let done: Promise<void> | null = null;

  return {
    id,
    inputRecorded: settings.recordInput,
    output: (data) => writer.output(data),
    input: (data) => {
      if (settings.recordInput) writer.input(data);
    },
    resize: (cols, rows) => writer.resize(cols, rows),
    command({ source, command, exitCode }) {
      const at = writer.elapsed();
      writer.marker(`$ ${command}`);
      try {
        getDb()
          .insert(sessionRecordingCommands)
          .values({ id: nanoid(), recordingId: id, at, source, command, exitCode })
          .run();
      } catch (err) {
        logger.warn({ err, recordingId: id }, 'Could not log command on recording');
      }
    },
    finish() {
      done ??= closeRecording(id, writer);
      return done;
    },
    async discard() {
      done ??= (async () => {
        await writer.discard();
        getDb().delete(sessionRecordings).where(eq(sessionRecordings.id, id)).run();
      })().catch((err) => logger.warn({ err, recordingId: id }, 'Could not discard recording'));
      return done;
    },
  };
}

export interface ExecRecording {
  id: string;
  /** Feed stdout/stderr as it arrives. */
  tap(data: Buffer): void;
  finish(outcome: { result?: ExecResult; error?: unknown }): Promise<void>;
}

/**
 * Record a one-shot command run (AI agent without a terminal, saved commands).
 * `command` is what is shown and stored — for a saved command, its template,
 * so variable values (often credentials) stay out of the recording's metadata.
 */
export function startExecRecording(
  ctx: RecordingContext & { source: RecordingCommandSource; command: string; id?: string },
): ExecRecording | null {
  if (!recordingSettings(ctx.orgId).enabled) return null;
  const opened = openRecording(ctx, {
    id: ctx.id,
    kind: 'exec',
    source: ctx.source,
    command: ctx.command,
    inputRecorded: false,
    cols: EXEC_COLS,
    rows: EXEC_ROWS,
  });
  if (!opened) return null;
  const { id, writer } = opened;
  writer.marker(`$ ${ctx.command}`);
  writer.output(`\x1b[1m$ ${ctx.command}\x1b[0m\n`);

  return {
    id,
    tap: (data) => writer.output(data),
    async finish({ result, error }) {
      if (result) {
        writer.output(`\n\x1b[2m[exit code ${result.exitCode}]\x1b[0m\n`);
      } else {
        const message = error instanceof Error ? error.message : 'Command failed';
        writer.output(`\n\x1b[31m[${message}]\x1b[0m\n`);
      }
      await closeRecording(id, writer);
    },
  };
}

/** Run `exec` with its output recorded (when recording is on), finishing the recording either way. */
export async function withExecRecording(
  recording: ExecRecording | null,
  exec: (tap?: (data: Buffer) => void) => Promise<ExecResult>,
): Promise<ExecResult & { recordingId?: string }> {
  if (!recording) return exec();
  try {
    const result = await exec(recording.tap);
    await recording.finish({ result });
    return { ...result, recordingId: recording.id };
  } catch (err) {
    await recording.finish({ error: err });
    throw err;
  }
}

/** The cast as a stream of uncompressed asciicast, whether finished (gzipped) or still live. */
export function openCast(row: Pick<RecordingRow, 'filePath'>): Readable {
  const file = recordingFile(row.filePath);
  const raw = fs.createReadStream(file);
  if (!file.endsWith('.gz')) return raw;
  const gunzip = createGunzip();
  raw.on('error', (err) => gunzip.destroy(err));
  return raw.pipe(gunzip);
}

export async function deleteRecordingFile(row: Pick<RecordingRow, 'filePath'>) {
  try {
    await fs.promises.unlink(recordingFile(row.filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Delete finished recordings older than each org's retention period. Returns
 * how many were removed. A file that cannot be deleted keeps its row, so the
 * next prune tries again rather than orphaning it.
 */
export async function pruneRecordings(now = new Date()): Promise<number> {
  const db = getDb();
  const orgs = db
    .select({ id: organizations.id, days: organizations.recordingRetentionDays })
    .from(organizations)
    .all();

  let removed = 0;
  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.days * 86_400_000).toISOString();
    const expired = db
      .select()
      .from(sessionRecordings)
      .where(
        and(
          eq(sessionRecordings.orgId, org.id),
          isNotNull(sessionRecordings.endedAt),
          lt(sessionRecordings.startedAt, cutoff),
        ),
      )
      .all();
    if (expired.length === 0) continue;

    const deleted: string[] = [];
    for (const row of expired) {
      try {
        await deleteRecordingFile(row);
        deleted.push(row.id);
      } catch (err) {
        logger.warn({ err, recordingId: row.id }, 'Could not delete expired recording file');
      }
    }
    if (deleted.length === 0) continue;
    db.delete(sessionRecordings).where(inArray(sessionRecordings.id, deleted)).run();
    removed += deleted.length;
    auditSystem(org.id, 'recording.pruned', 'organization', org.id, undefined, {
      count: deleted.length,
      retentionDays: org.days,
    });
  }
  return removed;
}

/**
 * Close out recordings left open by a crash or restart: their sessions are gone,
 * so gzip whatever made it to disk and mark them ended. Only safe before any
 * terminal opens, i.e. at startup.
 */
export async function recoverUnfinishedRecordings(): Promise<number> {
  const db = getDb();
  const open = db.select().from(sessionRecordings).where(isNull(sessionRecordings.endedAt)).all();
  for (const row of open) {
    const file = recordingFile(row.filePath);
    let endedAt = row.startedAt;
    let bytes = row.bytes;
    let filePath = row.filePath;
    try {
      const stat = await fs.promises.stat(file);
      endedAt = stat.mtime.toISOString();
      bytes = stat.size;
      if (!file.endsWith('.gz')) filePath = relativeFile(await compressCast(file));
    } catch (err) {
      logger.warn({ err, recordingId: row.id }, 'Recording file missing or unreadable while recovering');
    }
    db.update(sessionRecordings)
      .set({ endedAt, bytes, filePath })
      .where(eq(sessionRecordings.id, row.id))
      .run();
  }
  return open.length;
}
