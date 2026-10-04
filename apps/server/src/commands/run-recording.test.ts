import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const ssh = vi.hoisted(() => ({
  execOnServer: vi.fn(
    async (_server: unknown, _auth: unknown, _cmd: string, _timeout?: number, tap?: (d: Buffer) => void) => {
      tap?.(Buffer.from('deployed\n'));
      return { stdout: 'deployed\n', stderr: '', exitCode: 0 };
    },
  ),
}));
vi.mock('../ssh/broker.js', () => ({ execOnServer: ssh.execOnServer }));
vi.mock('../ssh/credentials.js', async () => {
  const { getDb } = await import('../db/index.js');
  const { servers } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  return {
    resolveServerAuth: async (_orgId: string, serverId: string) => ({
      server: getDb().select().from(servers).where(eq(servers.id, serverId)).get(),
      auth: { password: 'pw' },
    }),
  };
});

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { commandRuns, memberships, organizations, savedCommands, sessionRecordings } from '../db/schema.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import { recordingFile } from '../recordings/index.js';
import { executeSavedCommand } from './run.js';

const recordingsConfig = config.recordings as { dir: string };
const originalDir = recordingsConfig.dir;

describe('saved command runs are recorded', () => {
  let orgId: string;
  let userId: string;
  let serverId: string;
  let commandId: string;

  beforeAll(async () => {
    recordingsConfig.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-run-recordings-'));
    await runMigrations();
    orgId = seedOrg('org-run-recordings');
    userId = seedUser(orgId, 'operator').userId;
    serverId = seedServer(orgId, userId, 'app-1');
    commandId = nanoid();
    getDb()
      .insert(savedCommands)
      .values({ id: commandId, orgId, name: 'deploy', command: 'deploy --token {{token}}', createdBy: userId })
      .run();
  });

  afterAll(() => {
    fs.rmSync(recordingsConfig.dir, { recursive: true, force: true });
    recordingsConfig.dir = originalDir;
  });

  function newRun() {
    const runId = nanoid();
    getDb().insert(commandRuns).values({ id: runId, commandId, serverId, triggeredBy: userId }).run();
    return runId;
  }

  it('under the id chosen by the route, showing the template rather than variable values', async () => {
    const recordingId = nanoid();
    await executeSavedCommand({ runId: newRun(), orgId, commandId, serverId, variables: { token: 's3cret' }, recordingId });

    // The real command ran…
    expect(ssh.execOnServer.mock.calls[0]![2]).toBe('deploy --token s3cret');
    // …but the recording names the template
    const row = getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, recordingId)).get()!;
    expect(row).toMatchObject({ kind: 'exec', source: 'saved_command', command: 'deploy --token {{token}}', userId, serverId, serverName: 'app-1' });
    const cast = gunzipSync(fs.readFileSync(recordingFile(row.filePath))).toString('utf8');
    expect(cast).not.toContain('s3cret');
    expect(cast).toContain('deployed\\r\\n');
  });

  it('not at all when the org switched recording off', async () => {
    getDb().update(organizations).set({ recordingEnabled: false }).where(eq(organizations.id, orgId)).run();
    const before = getDb().select().from(sessionRecordings).all().length;
    const runId = newRun();
    await executeSavedCommand({ runId, orgId, commandId, serverId, variables: { token: 'x' } });
    expect(getDb().select().from(sessionRecordings).all()).toHaveLength(before);
    expect(getDb().select().from(commandRuns).where(eq(commandRuns.id, runId)).get()?.status).toBe('success');
  });
});

describe('saved command runs check whoever started them when they start', () => {
  it('fail without running once the starter can no longer operate the server', async () => {
    const orgId = seedOrg('org-run-starter');
    const { userId } = seedUser(orgId, 'operator');
    const serverId = seedServer(orgId, userId, 'app-2');
    const commandId = nanoid();
    getDb().insert(savedCommands).values({ id: commandId, orgId, name: 'uptime', command: 'uptime', createdBy: userId }).run();
    const newRun = () => {
      const runId = nanoid();
      getDb().insert(commandRuns).values({ id: runId, commandId, serverId, triggeredBy: userId }).run();
      return runId;
    };

    // Queued while they could; their access narrowed to roles (none) before it started
    const queued = newRun();
    getDb().update(memberships).set({ scope: 'roles' }).where(eq(memberships.userId, userId)).run();
    ssh.execOnServer.mockClear();
    await executeSavedCommand({ runId: queued, orgId, commandId, serverId });
    expect(ssh.execOnServer).not.toHaveBeenCalled();
    expect(getDb().select().from(commandRuns).where(eq(commandRuns.id, queued)).get()).toMatchObject({
      status: 'failure',
      stderr: 'Whoever started this run no longer has access to run commands on this server',
    });

    // Back to every resource: the next run goes ahead
    getDb().update(memberships).set({ scope: 'all' }).where(eq(memberships.userId, userId)).run();
    const next = newRun();
    await executeSavedCommand({ runId: next, orgId, commandId, serverId });
    expect(ssh.execOnServer).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(commandRuns).where(eq(commandRuns.id, next)).get()?.status).toBe('success');
  });
});
