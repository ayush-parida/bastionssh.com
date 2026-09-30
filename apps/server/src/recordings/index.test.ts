import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { auditLog, organizations, sessionRecordingCommands, sessionRecordings } from '../db/schema.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import {
  containerLabel,
  containerOfRecording,
  pruneRecordings,
  recordingFile,
  recoverUnfinishedRecordings,
  startExecRecording,
  startTerminalRecording,
  withExecRecording,
} from './index.js';

const recordingsConfig = config.recordings as { dir: string; maxBytes: number };
const originalDir = recordingsConfig.dir;

let orgId: string;
let userId: string;
let serverId: string;

function row(id: string) {
  return getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, id)).get()!;
}

function castOf(id: string) {
  const file = recordingFile(row(id).filePath);
  const raw = fs.readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  const [header, ...events] = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { header, events: events as [number, string, string][] };
}

function setOrg(patch: Partial<typeof organizations.$inferInsert>) {
  getDb().update(organizations).set(patch).where(eq(organizations.id, orgId)).run();
}

const ctx = () => ({ orgId, serverId, serverName: 'web-1', userId, cols: 100, rows: 30 });

beforeAll(async () => {
  recordingsConfig.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-recordings-'));
  await runMigrations();
  orgId = seedOrg('org-recordings');
  userId = seedUser(orgId, 'operator').userId;
  serverId = seedServer(orgId, userId);
});

afterAll(() => {
  fs.rmSync(recordingsConfig.dir, { recursive: true, force: true });
  recordingsConfig.dir = originalDir;
});

beforeEach(() => {
  setOrg({ recordingEnabled: true, recordingInput: false, recordingRetentionDays: 90 });
});

describe('terminal recordings', () => {
  it('records by default: output, resizes and commands, gzipped with metadata at the end', async () => {
    const rec = startTerminalRecording(ctx())!;
    expect(rec).not.toBeNull();
    expect(rec.inputRecorded).toBe(false);
    expect(row(rec.id)).toMatchObject({ orgId, serverId, userId, kind: 'terminal', endedAt: null, cols: 100, rows: 30 });

    rec.output(Buffer.from('$ '));
    rec.input('secret\r'); // not captured: input recording is off
    rec.resize(120, 40);
    rec.command({ source: 'ai', command: 'df -h', exitCode: 0 });
    await rec.finish();

    const saved = row(rec.id);
    expect(saved.endedAt).toBeTruthy();
    expect(saved.filePath).toBe(path.join(orgId, `${rec.id}.cast.gz`));
    expect(saved.bytes).toBeGreaterThan(0);
    const { header, events } = castOf(rec.id);
    expect(header).toMatchObject({ version: 2, width: 100, height: 30, title: 'web-1' });
    expect(events.map(([, code, data]) => [code, data])).toEqual([
      ['o', '$ '],
      ['r', '120x40'],
      ['m', '$ df -h'],
    ]);
    expect(
      getDb().select().from(sessionRecordingCommands).where(eq(sessionRecordingCommands.recordingId, rec.id)).all(),
    ).toEqual([expect.objectContaining({ source: 'ai', command: 'df -h', exitCode: 0 })]);
  });

  it('captures keystrokes only when the org opted in', async () => {
    setOrg({ recordingInput: true });
    const rec = startTerminalRecording(ctx())!;
    expect(rec.inputRecorded).toBe(true);
    rec.input(Buffer.from('ls\r'));
    await rec.finish();
    expect(row(rec.id).inputRecorded).toBe(true);
    expect(castOf(rec.id).events.map(([, code, data]) => [code, data])).toEqual([['i', 'ls\r']]);
  });

  it('records nothing when the org switched recording off', async () => {
    setOrg({ recordingEnabled: false });
    const before = getDb().select().from(sessionRecordings).all().length;
    expect(startTerminalRecording(ctx())).toBeNull();
    expect(startExecRecording({ ...ctx(), source: 'ai', command: 'id' })).toBeNull();
    expect(getDb().select().from(sessionRecordings).all()).toHaveLength(before);
  });

  it('discards the row and file of a session that never opened a shell', async () => {
    const rec = startTerminalRecording(ctx())!;
    const file = recordingFile(row(rec.id).filePath);
    await rec.discard();
    expect(getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, rec.id)).get()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fails open when the recordings directory is unusable', () => {
    const dir = recordingsConfig.dir;
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    recordingsConfig.dir = blocker;
    try {
      expect(startTerminalRecording(ctx())).toBeNull();
    } finally {
      recordingsConfig.dir = dir;
    }
  });
});

describe('container shell recordings', () => {
  it('are kind container and name the container, read back from the row', async () => {
    const container = { id: 'f'.repeat(64), name: 'shop (web) 1' };
    const rec = startTerminalRecording({ ...ctx(), container })!;
    const saved = row(rec.id);
    expect(saved).toMatchObject({ kind: 'container', command: `shop (web) 1 (${'f'.repeat(12)})` });
    expect(containerOfRecording(saved)).toEqual({ id: 'f'.repeat(12), name: 'shop (web) 1' });
    expect(containerLabel(container)).toBe(saved.command);
    await rec.finish();
    expect(castOf(rec.id).header).toMatchObject({ title: 'web-1 › shop (web) 1' });

    expect(containerOfRecording({ kind: 'terminal', command: null })).toBeNull();
    expect(containerOfRecording({ kind: 'container', command: 'garbled' })).toBeNull();
  });
});

describe('exec recordings', () => {
  it('records the command, its output and exit code under a chosen id', async () => {
    const id = nanoid();
    const rec = startExecRecording({ ...ctx(), source: 'saved_command', command: 'echo {{msg}}', id });
    const result = await withExecRecording(rec, async (tap) => {
      tap?.(Buffer.from('hello\n'));
      return { stdout: 'hello\n', stderr: '', exitCode: 0 };
    });
    expect(result.recordingId).toBe(id);
    expect(row(id)).toMatchObject({ kind: 'exec', source: 'saved_command', command: 'echo {{msg}}', cols: 120 });
    const output = castOf(id).events.filter(([, code]) => code === 'o').map(([, , data]) => data).join('');
    expect(output).toContain('$ echo {{msg}}');
    expect(output).toContain('hello\r\n');
    expect(output).toContain('[exit code 0]');
  });

  it('keeps the recording when the command fails, and rethrows', async () => {
    const rec = startExecRecording({ ...ctx(), source: 'ai', command: 'uptime' })!;
    await expect(
      withExecRecording(rec, async () => {
        throw new Error('Command timed out');
      }),
    ).rejects.toThrow('Command timed out');
    expect(row(rec.id).endedAt).toBeTruthy();
    expect(castOf(rec.id).events.map(([, , data]) => data).join('')).toContain('[Command timed out]');
  });
});

describe('retention', () => {
  async function recordedAt(startedAt: string, org = orgId) {
    const rec = startTerminalRecording({ ...ctx(), orgId: org })!;
    await rec.finish();
    getDb().update(sessionRecordings).set({ startedAt }).where(eq(sessionRecordings.id, rec.id)).run();
    return rec.id;
  }

  it("prunes finished recordings past each org's retention, with their files", async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const old = await recordedAt('2026-02-01T00:00:00Z'); // 120 days
    const recent = await recordedAt('2026-04-01T00:00:00Z'); // 61 days
    const oldFile = recordingFile(row(old).filePath);
    // Still live: never pruned, however old
    const live = startTerminalRecording(ctx())!;
    getDb().update(sessionRecordings).set({ startedAt: '2025-01-01T00:00:00Z' }).where(eq(sessionRecordings.id, live.id)).run();

    // A second org keeping recordings for 30 days only
    const other = seedOrg('org-recordings-short');
    getDb().update(organizations).set({ recordingRetentionDays: 30 }).where(eq(organizations.id, other)).run();
    const otherRecent = await recordedAt('2026-04-01T00:00:00Z', other);

    const removed = await pruneRecordings(now);

    expect(removed).toBeGreaterThanOrEqual(2);
    const ids = getDb().select({ id: sessionRecordings.id }).from(sessionRecordings).all().map((r) => r.id);
    expect(ids).not.toContain(old);
    expect(ids).not.toContain(otherRecent);
    expect(ids).toEqual(expect.arrayContaining([recent, live.id]));
    expect(fs.existsSync(oldFile)).toBe(false);

    const audited = getDb().select().from(auditLog).where(eq(auditLog.action, 'recording.pruned')).all();
    expect(audited.map((a) => a.orgId)).toEqual(expect.arrayContaining([orgId, other]));
    await live.finish();
  });
});

describe('restart recovery', () => {
  it('closes out recordings a restart left open, gzipping what reached disk', async () => {
    const rec = startTerminalRecording(ctx())!;
    rec.output(Buffer.from('before the crash'));
    // Let the write stream flush, as a running process would have
    await new Promise((r) => setTimeout(r, 20));

    expect(await recoverUnfinishedRecordings()).toBeGreaterThanOrEqual(1);
    const saved = row(rec.id);
    expect(saved.endedAt).toBeTruthy();
    expect(saved.filePath.endsWith('.cast.gz')).toBe(true);
    expect(castOf(rec.id).events.map(([, , data]) => data)).toEqual(['before the crash']);
  });
});
