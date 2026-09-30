import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * A shell inside a container (D3), end to end: the exec route opens it over
 * the pooled SSH connection (a stand-in ssh2 reaching the fake daemon with
 * the exec endpoints, actions-daemon.test-helper.ts), the terminal broker
 * adopts it, and a real WebSocket attaches on the SSH terminals' path. Under
 * test: shell choice, TTY resize, input and output, recording, audit, the
 * role matrix and org toggle, per-server access, and every way a shell is
 * closed from outside (disconnect, revocation, demotion, the org switch).
 */
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { fakeSshMethods } = await import('../../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<import('node:net').Socket>>();
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<import('node:net').Socket>();
      channels.set(this, open);
      Object.assign(
        this,
        fakeSshMethods(
          () => fake.options,
          fake.log,
          (s) => {
            open.add(s);
            s.on('close', () => open.delete(s));
          },
        ),
      );
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    end() {
      for (const s of channels.get(this) ?? []) s.destroy();
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { and, eq } from 'drizzle-orm';
import type { DockerExecSession } from '@smt/shared';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, organizations, servers, sessionRecordings } from '../../db/schema.js';
import { config } from '../../config/index.js';
import { vault } from '../../vault/index.js';
import { revokeLiveAccess } from '../../auth/revoke.js';
import { SSHBroker } from '../../ssh/broker.js';
import { startFakeDaemon, type FakeDaemon } from '../../docker/fake-daemon.test-helper.js';
import { fakeEngine, type FakeEngine } from '../../docker/actions-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from './test-utils.js';

type Who = { userId: string; headers: Record<string, string> };

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('docker exec', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let daemon: FakeDaemon;
  let engine: FakeEngine;
  let wsBase: string;
  let orgId: string;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let serverA: string;
  let serverB: string;
  const sockets: WebSocket[] = [];
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-docker-exec-rec-'));
  const originalRecordingsDir = config.recordings.dir;

  const openShell = (who: Who, container = 'web', body: object = {}, server = serverA) =>
    app.inject({
      method: 'POST',
      url: `/api/docker/servers/${server}/containers/${container}/exec`,
      headers: who.headers,
      payload: { cols: 100, rows: 30, ...body },
    });

  function audits(action: string) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .all()
      .map((r) => JSON.parse(r.metadata ?? '{}') as Record<string, unknown>);
  }

  /** Attach to a session's terminal; `text` accumulates what it prints. */
  async function attach(who: Who, session: DockerExecSession) {
    const ws = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: who.headers });
    sockets.push(ws);
    const term = { ws, text: '', closeCode: null as number | null };
    ws.on('message', (data: Buffer) => {
      term.text += data.toString();
    });
    ws.on('close', (code) => {
      term.closeCode = code;
    });
    await once(ws, 'open');
    return term;
  }

  async function withPassword(orgOf: string, createdBy: string, name: string) {
    const id = seedServer(orgOf, createdBy, name);
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id) })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  beforeAll(async () => {
    (config.recordings as { dir: string }).dir = recordingsDir;
    engine = fakeEngine();
    daemon = await startFakeDaemon(engine.options);
    fake.options.daemonSocket = daemon.socketPath;
    await runMigrations();
    orgId = seedOrg('org-docker-exec');
    getDb().update(organizations).set({ recordingEnabled: true }).where(eq(organizations.id, orgId)).run();
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');
    serverA = await withPassword(orgId, admin.userId, 'alpha');
    serverB = await withPassword(orgId, admin.userId, 'bravo');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    wsBase = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const grant = await app.inject({
      method: 'PUT',
      url: `/api/team/members/${restricted.userId}/access`,
      headers: admin.headers,
      payload: { serverAccess: 'restricted', serverIds: [serverA] },
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
    await daemon.close();
    (config.recordings as { dir: string }).dir = originalRecordingsDir;
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
    engine.shells = new Set(['/bin/bash', '/bin/sh']);
    await app.inject({
      method: 'PATCH',
      url: '/api/docker/settings',
      headers: admin.headers,
      payload: { operatorsCanExec: true },
    });
  });

  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.terminate();
  });

  it('opens /bin/bash in the container as a terminal session, sized, recorded and audited', async () => {
    const res = await openShell(operator);
    expect(res.statusCode).toBe(201);
    const session = res.json() as DockerExecSession;
    expect(session).toMatchObject({ container: { id: 'a'.repeat(64), name: 'web' }, cmd: ['/bin/bash'] });
    expect(session.wsUrl).toMatch(new RegExp(`/api/ssh-sessions/${session.sessionId}/ws$`));
    expect(session.recording).toMatchObject({ inputRecorded: false });

    const exec = engine.execs.at(-1)!;
    expect(exec).toMatchObject({ cmd: ['/bin/bash'], tty: true, consoleSize: [30, 100] });
    // The size also goes to /exec/:id/resize, for engines that ignore ConsoleSize
    await until(() => exec.resizes.length > 0);
    expect(exec.resizes[0]).toEqual({ h: 30, w: 100 });

    const term = await attach(operator, session);
    await until(() => term.text.includes('/bin/bash$ '));
    term.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    await until(() => exec.resizes.some((r) => r.h === 43 && r.w === 132));
    term.ws.send('ls\r');
    await until(() => term.text.includes('ran: ls'));

    expect(audits('docker.exec_start').at(-1)).toMatchObject({
      container: { id: 'a'.repeat(64), name: 'web' },
      cmd: ['/bin/bash'],
      tty: true,
      sessionId: session.sessionId,
      recordingId: session.recording!.id,
    });

    // The shell exits: the terminal closes, the exit is audited, the recording kept
    term.ws.send('exit\r');
    await until(() => term.closeCode !== null);
    await until(() => audits('docker.exec_end').some((a) => a.sessionId === session.sessionId));
    expect(audits('docker.exec_end').find((a) => a.sessionId === session.sessionId)).toMatchObject({ exitCode: 0 });
    const recording = getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, session.recording!.id)).get()!;
    expect(recording).toMatchObject({ kind: 'container', command: 'web (aaaaaaaaaaaa)', serverId: serverA });
    await until(() => !!getDb().select().from(sessionRecordings).where(eq(sessionRecordings.id, session.recording!.id)).get()!.endedAt);

    const listed = await app.inject({ method: 'GET', url: '/api/recordings?container=web', headers: admin.headers });
    expect(listed.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: session.recording!.id, container: { id: 'aaaaaaaaaaaa', name: 'web' } })]),
    );
    // A full container id finds it too, though the recording keeps the short one
    const byFullId = await app.inject({ method: 'GET', url: `/api/recordings?container=${'a'.repeat(64)}`, headers: admin.headers });
    expect(byFullId.json().items.map((r: { id: string }) => r.id)).toContain(session.recording!.id);
    const none = await app.inject({ method: 'GET', url: '/api/recordings?container=w_b', headers: admin.headers });
    expect(none.json().items).toEqual([]);
  });

  it('falls back to /bin/sh when the container has no bash', async () => {
    engine.shells = new Set(['/bin/sh']);
    const res = await openShell(operator);
    expect(res.json().cmd).toEqual(['/bin/sh']);
    expect(engine.execs.at(-1)!.cmd).toEqual(['/bin/sh']);
  });

  it('runs a given command as a given user, and validates both', async () => {
    const res = await openShell(admin, 'web', { cmd: ['/usr/bin/env', 'sh'], user: 'www-data:www-data' });
    expect(res.statusCode).toBe(201);
    expect(engine.execs.at(-1)).toMatchObject({ cmd: ['/usr/bin/env', 'sh'], user: 'www-data:www-data' });
    expect((await openShell(admin, 'web', { user: 'root; reboot' })).statusCode).toBe(400);
    expect((await openShell(admin, 'web', { cmd: [] })).statusCode).toBe(400);
    expect((await openShell(admin, 'web', { cols: 99999 })).statusCode).toBe(400);
  });

  it('delivers stdout and stderr without a TTY', async () => {
    const session = (await openShell(operator, 'web', { tty: false })).json() as DockerExecSession;
    const term = await attach(operator, session);
    await until(() => term.text.includes('$ '));
    term.ws.send('id\n');
    await until(() => term.text.includes('ran: id') && term.text.includes('warn: id'));
    // No frame headers leak through: they start with a 0-2 byte and three zero bytes
    expect(term.text).not.toContain('\u0000\u0000\u0000');
  });

  it('refuses a container that is not running, or missing', async () => {
    const stopped = await openShell(operator, 'worker');
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error).toBe('worker is not running');
    expect((await openShell(operator, 'nope')).statusCode).toBe(404);
    expect((await openShell(operator, '..%2Fetc')).statusCode).toBe(400);
  });

  it('closes a shell it started when handing it to the broker fails, and drops its recording', async () => {
    const recordings = () =>
      getDb()
        .select()
        .from(sessionRecordings)
        .where(and(eq(sessionRecordings.kind, 'container'), eq(sessionRecordings.userId, operator.userId)))
        .all().length;
    const recordedBefore = recordings();
    const startsBefore = audits('docker.exec_start').length;
    const adopt = vi.spyOn(SSHBroker, 'adoptSession').mockImplementationOnce(() => {
      throw new Error('broker unavailable');
    });
    try {
      expect((await openShell(operator)).statusCode).toBe(500);
    } finally {
      adopt.mockRestore();
    }
    const exec = engine.execs.at(-1)!;
    // Not left running in the container with nobody attached: it got ^C ^D and exited
    await until(() => !exec.running && exec.socket === null);
    await until(() => recordings() === recordedBefore);
    expect(audits('docker.exec_start')).toHaveLength(startsBefore);
  });

  it('follows the role matrix and the org switch', async () => {
    expect((await openShell(viewer)).statusCode).toBe(403);
    await app.inject({ method: 'PATCH', url: '/api/docker/settings', headers: admin.headers, payload: { operatorsCanExec: false } });
    const refused = await openShell(operator);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/shell in a container/);
    expect((await openShell(admin)).statusCode).toBe(201);
  });

  it('answers 404 for servers the caller cannot access', async () => {
    expect((await openShell(restricted, 'web', {}, serverB)).statusCode).toBe(404);
    expect((await openShell(restricted, 'web', {}, serverA)).statusCode).toBe(201);
    const outsider = seedUser(seedOrg('org-docker-exec-other'), 'owner');
    expect((await openShell(outsider)).statusCode).toBe(404);
  });

  it('closes a shell on disconnect, ending the exec’s attach', async () => {
    const session = (await openShell(operator)).json() as DockerExecSession;
    const term = await attach(operator, session);
    await until(() => term.text.includes('$ '));
    const exec = engine.execs.at(-1)!;
    const del = await app.inject({ method: 'DELETE', url: `/api/ssh-sessions/${session.sessionId}`, headers: operator.headers });
    expect(del.statusCode).toBe(204);
    await until(() => term.closeCode !== null);
    await until(() => exec.socket === null);
    expect(SSHBroker.getSessionForUser(session.sessionId, operator.userId, orgId)).toBeUndefined();
    await until(() => audits('docker.exec_end').some((a) => a.sessionId === session.sessionId));
    // Not left running: the shell got ^C ^D and exited
    expect(exec.running).toBe(false);
    expect(audits('docker.exec_end').find((a) => a.sessionId === session.sessionId)).toMatchObject({ exitCode: 0 });
  });

  it('closes operators’ shells when the org switch turns exec off, and on demotion; admins keep theirs', async () => {
    const opSession = (await openShell(operator)).json() as DockerExecSession;
    const adminSession = (await openShell(admin)).json() as DockerExecSession;
    const opTerm = await attach(operator, opSession);
    const adminTerm = await attach(admin, adminSession);
    await until(() => opTerm.text.includes('$ ') && adminTerm.text.includes('$ '));

    await app.inject({ method: 'PATCH', url: '/api/docker/settings', headers: admin.headers, payload: { operatorsCanExec: false } });
    await until(() => opTerm.closeCode === 4403);
    expect(adminTerm.closeCode).toBeNull();
    expect(SSHBroker.getSessionForUser(adminSession.sessionId, admin.userId, orgId)).toBeDefined();

    // Demoted below operator: their shell ends too
    const who = seedUser(orgId, 'admin');
    const whoSession = (await openShell(who)).json() as DockerExecSession;
    const whoTerm = await attach(who, whoSession);
    await until(() => whoTerm.text.includes('$ '));
    const demoted = await app.inject({
      method: 'PATCH',
      url: `/api/team/members/${who.userId}`,
      headers: seedUser(orgId, 'owner').headers,
      payload: { role: 'operator' },
    });
    expect(demoted.statusCode).toBe(200);
    await until(() => whoTerm.closeCode === 4403);
  });

  it('closes a shell when the user’s access is revoked, and refuses to re-attach it', async () => {
    const who = seedUser(orgId, 'operator');
    const session = (await openShell(who)).json() as DockerExecSession;
    const term = await attach(who, session);
    await until(() => term.text.includes('$ '));
    const exec = engine.execs.at(-1)!;

    const revoked = revokeLiveAccess(who.userId, { orgId });
    expect(revoked.terminals).toBe(1);
    await until(() => term.closeCode === 4403 && exec.socket === null);

    const again = new WebSocket(`${wsBase}/api/ssh-sessions/${session.sessionId}/ws`, { headers: who.headers });
    sockets.push(again);
    const [code] = (await once(again, 'close')) as [number];
    expect(code).toBe(4404);
  });
});
