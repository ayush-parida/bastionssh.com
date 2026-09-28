import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The terminal itself is covered in ssh/broker.test.ts; here only what the route hands it matters. */
const broker = vi.hoisted(() => ({ createSession: vi.fn(async (_meta: Record<string, unknown>) => 'sess-1') }));
vi.mock('../../ssh/broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ssh/broker.js')>();
  return { ...actual, SSHBroker: { ...actual.SSHBroker, createSession: broker.createSession } };
});

import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { config } from '../../config/index.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, memberServerAccess, memberships, organizations, servers, sessionRecordings } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { startTerminalRecording, type TerminalRecording } from '../../recordings/index.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

const recordingsConfig = config.recordings as { dir: string };
const originalDir = recordingsConfig.dir;

describe('session recordings API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let owner: ReturnType<typeof seedUser>;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let restricted: ReturnType<typeof seedUser>;
  let viewer: ReturnType<typeof seedUser>;
  let serverA: string;
  let serverB: string;
  /** operator on A, operator on B, restricted on A, restricted on B, admin on A */
  let recs: Record<'opA' | 'opB' | 'resA' | 'resB' | 'adminA', string>;

  const as = (who: { headers: Record<string, string> }) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: who.headers }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, headers: who.headers, payload: payload ?? {} }),
    patch: (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: who.headers, payload }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: who.headers }),
  });

  async function record(userId: string, serverId: string, output = 'hello\r\n', finish = true) {
    const rec = startTerminalRecording({ orgId, serverId, serverName: serverId === serverA ? 'alpha' : 'bravo', userId, cols: 80, rows: 24 })!;
    rec.output(Buffer.from(output));
    if (finish) await rec.finish();
    return rec;
  }

  const ids = (res: { json: () => { items: { id: string }[] } }) => res.json().items.map((r) => r.id).sort();

  function setOrg(patch: Partial<typeof organizations.$inferInsert>) {
    getDb().update(organizations).set(patch).where(eq(organizations.id, orgId)).run();
  }

  beforeAll(async () => {
    recordingsConfig.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-recordings-api-'));
    await runMigrations();
    orgId = seedOrg('org-recordings-api');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    restricted = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    serverA = seedServer(orgId, owner.userId, 'alpha');
    serverB = seedServer(orgId, owner.userId, 'bravo');

    // `restricted` may only use server A
    getDb()
      .update(memberships)
      .set({ serverAccess: 'restricted' })
      .where(and(eq(memberships.userId, restricted.userId), eq(memberships.orgId, orgId)))
      .run();
    getDb().insert(memberServerAccess).values({ orgId, userId: restricted.userId, serverId: serverA }).run();
    // Something to authenticate with, so opening a terminal gets as far as the broker
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', serverA) })
      .where(eq(servers.id, serverA))
      .run();

    recs = {
      opA: (await record(operator.userId, serverA)).id,
      opB: (await record(operator.userId, serverB)).id,
      resA: (await record(restricted.userId, serverA)).id,
      resB: (await record(restricted.userId, serverB)).id, // from before the grant was narrowed
      adminA: (await record(admin.userId, serverA)).id,
    };

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(recordingsConfig.dir, { recursive: true, force: true });
    recordingsConfig.dir = originalDir;
  });

  beforeEach(() => {
    setOrg({ recordingEnabled: true, recordingInput: false });
    broker.createSession.mockClear();
  });

  describe('listing', () => {
    it('shows admins and owners the whole org', async () => {
      const all = Object.values(recs).sort();
      expect(ids(await as(admin).get('/api/recordings'))).toEqual(expect.arrayContaining(all));
      expect(ids(await as(owner).get('/api/recordings'))).toEqual(expect.arrayContaining(all));
    });

    it('shows everyone else only their own', async () => {
      expect(ids(await as(operator).get('/api/recordings'))).toEqual([recs.opA, recs.opB].sort());
      expect(ids(await as(viewer).get('/api/recordings'))).toEqual([]);
    });

    it('hides a restricted member’s own recordings on servers they can no longer access', async () => {
      expect(ids(await as(restricted).get('/api/recordings'))).toEqual([recs.resA]);
      expect((await as(restricted).get(`/api/recordings/${recs.resB}`)).statusCode).toBe(404);
      expect((await as(restricted).get(`/api/recordings/${recs.resB}/cast`)).statusCode).toBe(404);
    });

    it('filters by server, user and date', async () => {
      const byServer = await as(admin).get(`/api/recordings?serverId=${serverB}`);
      expect(ids(byServer)).toEqual([recs.opB, recs.resB].sort());
      const byUser = await as(admin).get(`/api/recordings?userId=${operator.userId}`);
      expect(ids(byUser)).toEqual([recs.opA, recs.opB].sort());
      expect(byUser.json().items[0].userEmail).toBe(`${operator.userId}@test.local`);
      expect(ids(await as(admin).get('/api/recordings?from=2999-01-01'))).toEqual([]);
      expect((await as(admin).get('/api/recordings?from=nonsense')).statusCode).toBe(400);
    });

    it('never shows another org’s recordings', async () => {
      const otherOrg = seedOrg('org-recordings-other');
      const otherAdmin = seedUser(otherOrg, 'admin');
      expect(ids(await as(otherAdmin).get('/api/recordings'))).toEqual([]);
      expect((await as(otherAdmin).get(`/api/recordings/${recs.opA}`)).statusCode).toBe(404);
    });
  });

  describe('metadata and playback', () => {
    it('returns metadata with the command log', async () => {
      const res = await as(operator).get(`/api/recordings/${recs.opA}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: recs.opA,
        kind: 'terminal',
        serverId: serverA,
        serverName: 'alpha',
        userId: operator.userId,
        inputRecorded: false,
        truncated: false,
        commands: [],
      });
      expect((await as(viewer).get(`/api/recordings/${recs.opA}`)).statusCode).toBe(404);
    });

    it('streams the uncompressed cast for playback and audits the view', async () => {
      const res = await as(operator).get(`/api/recordings/${recs.opA}/cast`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-asciicast');
      expect(res.headers['content-disposition']).toBeUndefined();
      const [header, first] = res.body.split('\n').map((l) => (l ? JSON.parse(l) : null));
      expect(header).toMatchObject({ version: 2, width: 80, height: 24 });
      expect(first.slice(1)).toEqual(['o', 'hello\r\n']);

      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'recording.view'), eq(auditLog.resourceId, recs.opA)))
        .all();
      expect(audited).toHaveLength(1);
      expect(audited[0]!.actorId).toBe(operator.userId);
    });

    it('serves a download as an attachment and audits it as a download', async () => {
      const res = await as(admin).get(`/api/recordings/${recs.opB}/cast?download=1`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="bravo-.*\.cast"$/);
      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'recording.download'), eq(auditLog.resourceId, recs.opB)))
        .get();
      expect(audited?.actorId).toBe(admin.userId);
    });

    it('streams a live recording as far as it has got', async () => {
      const live = await record(operator.userId, serverA, 'still going', false);
      await new Promise((r) => setTimeout(r, 20));
      const res = await as(operator).get(`/api/recordings/${live.id}/cast`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('still going');
      await live.finish();
    });
  });

  describe('deleting', () => {
    it('is for owners only', async () => {
      for (const who of [admin, operator]) {
        expect((await as(who).delete(`/api/recordings/${recs.adminA}`)).statusCode).toBe(403);
      }
      expect(getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, recs.adminA)).get()).toBeTruthy();
    });

    it('removes the row and the file, and audits it', async () => {
      const rec = await record(operator.userId, serverA);
      const row = getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, rec.id)).get()!;
      const file = path.join(recordingsConfig.dir, row.filePath);
      expect(fs.existsSync(file)).toBe(true);

      expect((await as(owner).delete(`/api/recordings/${rec.id}`)).statusCode).toBe(204);
      expect(fs.existsSync(file)).toBe(false);
      expect(getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, rec.id)).get()).toBeUndefined();
      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'recording.delete'), eq(auditLog.resourceId, rec.id)))
        .get();
      expect(audited?.actorId).toBe(owner.userId);
    });

    it('refuses a recording that is still live', async () => {
      const live: TerminalRecording = await record(operator.userId, serverA, 'x', false);
      expect((await as(owner).delete(`/api/recordings/${live.id}`)).statusCode).toBe(409);
      await live.finish();
    });
  });

  describe('org settings', () => {
    it('defaults to recording on, input off, 90 days — readable by any member', async () => {
      const other = seedOrg('org-recordings-defaults');
      const member = seedUser(other, 'viewer');
      const res = await as(member).get('/api/recordings/settings');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, recordInput: false, retentionDays: 90 });
    });

    it('only owners change them, and the change is audited', async () => {
      expect((await as(admin).patch('/api/recordings/settings', { enabled: false })).statusCode).toBe(403);

      const res = await as(owner).patch('/api/recordings/settings', { recordInput: true, retentionDays: 30 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, recordInput: true, retentionDays: 30 });
      const audited = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'org.recording_settings'), eq(auditLog.orgId, orgId)))
        .get();
      expect(JSON.parse(audited!.metadata!)).toMatchObject({
        before: { recordInput: false, retentionDays: 90 },
        after: { recordInput: true, retentionDays: 30 },
      });
      expect((await as(owner).patch('/api/recordings/settings', { retentionDays: 0 })).statusCode).toBe(400);
      expect((await as(owner).patch('/api/recordings/settings', {})).statusCode).toBe(400);
      setOrg({ recordingRetentionDays: 90 });
    });
  });

  describe('opening a terminal', () => {
    it('records it and links the connect audit entry to the recording', async () => {
      setOrg({ recordingInput: true });
      const res = await as(operator).post('/api/ssh-sessions', { serverId: serverA });
      expect(res.statusCode).toBe(201);
      const { recording } = res.json();
      expect(recording).toEqual({ id: expect.any(String), inputRecorded: true });

      // The broker got the recorder, to feed the shell's output to
      const meta = broker.createSession.mock.calls[0]![0];
      expect((meta.recording as TerminalRecording).id).toBe(recording.id);

      const connect = getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'server.connect'), eq(auditLog.actorId, operator.userId)))
        .get();
      expect(JSON.parse(connect!.metadata!)).toEqual({ recordingId: recording.id });
      await (meta.recording as TerminalRecording).finish();
    });

    it('records nothing when the org switched recording off', async () => {
      setOrg({ recordingEnabled: false });
      const before = getDb().select().from(sessionRecordings).all().length;
      const res = await as(admin).post('/api/ssh-sessions', { serverId: serverA });
      expect(res.statusCode).toBe(201);
      expect(res.json().recording).toBeNull();
      expect(broker.createSession.mock.calls[0]![0].recording).toBeNull();
      expect(getDb().select().from(sessionRecordings).all()).toHaveLength(before);
    });

    it('drops the recording when the session cannot be created', async () => {
      broker.createSession.mockRejectedValueOnce(new Error('No authentication method available'));
      const before = getDb().select().from(sessionRecordings).all().length;
      const res = await as(admin).post('/api/ssh-sessions', { serverId: serverA });
      expect(res.statusCode).toBe(500);
      expect(getDb().select().from(sessionRecordings).all()).toHaveLength(before);
    });
  });
});
