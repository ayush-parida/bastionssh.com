import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Container alerts: the rules (pure), sampling against a stub client, the
 * per-container reconciliation against the database, and the whole health
 * check — probe and container sample over one fake SSH connection that
 * reaches the in-process fake daemon (docker/fake-daemon.test-helper.ts).
 */
const fake = vi.hoisted(() => ({
  options: { daemonSocket: '', cli: true } as import('../docker/fake-daemon.test-helper.js').FakeSshOptions,
  log: { streamlocal: [] as string[], exec: [] as string[] },
}));
const notified = vi.hoisted(() => ({ events: [] as import('../notifications/index.js').AlertEvent[] }));

vi.mock('../notifications/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifications/index.js')>()),
  notifyAlertsChanged: (events: import('../notifications/index.js').AlertEvent[]) => notified.events.push(...events),
}));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const { fakeSshMethods } = await import('../docker/fake-daemon.test-helper.js');
  // Methods and a closure map only — class fields in a vi.mock factory break the import
  const channels = new WeakMap<object, Set<import('node:net').Socket>>();
  /** What the vitals probe prints on a healthy host. */
  const probeChannel = () => {
    const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    setImmediate(() => {
      ch.emit('data', Buffer.from('hostname fake\nuptime 100 50\ncores 2\n'));
      ch.emit('exit', 0);
      ch.emit('close', 0);
    });
    return ch;
  };
  class Client extends EventEmitter {
    constructor() {
      super();
      const open = new Set<import('node:net').Socket>();
      channels.set(this, open);
      const docker = fakeSshMethods(
        () => fake.options,
        fake.log,
        (s) => {
          open.add(s);
          s.on('close', () => open.delete(s));
        },
      );
      Object.assign(this, docker, {
        exec(command: string, cb: (err: Error | undefined, channel?: unknown) => void) {
          if (command.includes('/proc/loadavg')) return setImmediate(() => cb(undefined, probeChannel()));
          return docker.exec(command, cb);
        },
      });
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

import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { serverAlerts, servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { updateDockerSettings } from '../docker/settings.js';
import { dedupKey } from '../notifications/channels/types.js';
import { startFakeDaemon, type FakeDaemon } from '../docker/fake-daemon.test-helper.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import { checkServer, pauseHealth } from './collector.js';
import { reconcileAlerts } from './alerts.js';
import {
  MAX_INSPECTS_PER_SWEEP,
  RESTART_WINDOW_MS,
  containerOfMessage,
  evaluateContainers,
  exitCodeFromStatus,
  forgetContainers,
  reconcileContainerAlerts,
  sampleContainers,
  startedRecently,
  type ContainerSnapshot,
} from './containers.js';

const snap = (over: Partial<ContainerSnapshot> & { name: string }): ContainerSnapshot => ({
  id: `${over.name}-id`,
  state: 'running',
  status: 'Up 2 hours',
  health: null,
  ...over,
});

describe('container alert rules', () => {
  beforeEach(() => forgetContainers('srv'));

  it('reads exit codes and recent starts from Docker’s status text', () => {
    expect(exitCodeFromStatus('Exited (1) 3 minutes ago')).toBe(1);
    expect(exitCodeFromStatus('Exited (0) 2 hours ago')).toBe(0);
    expect(exitCodeFromStatus('Up 2 hours')).toBeNull();
    for (const s of ['Up Less than a second', 'Up 5 seconds', 'Up About a minute', 'Up 9 minutes (healthy)', 'Up 10 minutes']) {
      expect(startedRecently(s), s).toBe(true);
    }
    for (const s of ['Up 11 minutes', 'Up About an hour', 'Up 2 hours', 'Exited (1) 1 second ago']) {
      expect(startedRecently(s), s).toBe(false);
    }
  });

  it('flags unhealthy running containers', () => {
    const out = evaluateContainers('srv', [
      snap({ name: 'web', health: 'unhealthy', status: 'Up 2 hours (unhealthy)' }),
      snap({ name: 'api', health: 'healthy' }),
    ]);
    expect(out).toEqual([
      expect.objectContaining({ type: 'container_unhealthy', container: 'web', message: 'web: health check failing (Up 2 hours (unhealthy))' }),
    ]);
  });

  it('flags a failed exit only for containers meant to keep running, and not a plain stop', () => {
    const exited = (name: string, exitCode: number, restartPolicy: string, oomKilled = false) =>
      snap({ name, state: 'exited', status: `Exited (${exitCode}) 1 minute ago`, exitCode, restartPolicy, oomKilled });
    const out = evaluateContainers('srv', [
      exited('crashed', 1, 'on-failure'),
      exited('oneshot', 1, 'no'),
      exited('clean', 0, 'always'),
      exited('stopped', 143, 'unless-stopped'),
      exited('killed', 137, 'always'),
      exited('oom', 137, 'always', true),
      snap({ name: 'unknown-policy', state: 'exited', status: 'Exited (2) 1 minute ago' }),
    ]);
    expect(out.map((c) => c.container)).toEqual(['crashed', 'oom']);
    expect(out[0]).toMatchObject({ type: 'container_exited', severity: 'critical', value: 1 });
    expect(out[1]!.message).toBe('oom: exited with code 137 (out of memory) (restart policy always)');
  });

  it('flags three or more restarts within ten minutes, and clears once they stop', () => {
    const t0 = 1_000_000_000_000;
    const at = (min: number, count: number | undefined, id = 'loop-id') =>
      evaluateContainers('srv', [snap({ name: 'loop', id, status: 'Up 5 seconds', restartCount: count })], t0 + min * 60_000);
    expect(at(0, 1)).toEqual([]);
    expect(at(1, 2)).toEqual([]);
    expect(at(2, 4)).toEqual([
      expect.objectContaining({ type: 'container_restarting', container: 'loop', value: 3, threshold: 3 }),
    ]);
    // Not inspected (up for a while): the count is unchanged, the alert holds within the window
    expect(at(5, undefined)).toHaveLength(1);
    // Ten minutes after the restarts, the window no longer holds them
    expect(at(2 + RESTART_WINDOW_MS / 60_000 + 1, undefined)).toEqual([]);
    // Recreated under the same name: the new container starts from its own count
    expect(at(20, 50, 'new-id')).toEqual([]);
  });
});

describe('sampleContainers', () => {
  const listed = (containers: Array<{ id: string; name: string; state: string; status: string }>) =>
    containers.map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Status: c.status }));

  function stub(list: ReturnType<typeof listed>, inspect: (id: string) => Record<string, unknown>) {
    const paths: string[] = [];
    return {
      paths,
      docker: {
        json: async <T,>(req: { path: string }): Promise<T> => {
          paths.push(req.path);
          if (req.path === '/containers/json') return list as T;
          const id = decodeURIComponent(req.path.split('/')[2]!);
          return inspect(id) as T;
        },
      },
    };
  }

  beforeEach(() => forgetContainers('srv'));

  it('inspects only containers whose restarts or exit matter, and remembers restart policies', async () => {
    const list = listed([
      { id: 'steady', name: 'steady', state: 'running', status: 'Up 3 days' },
      { id: 'fresh', name: 'fresh', state: 'running', status: 'Up 30 seconds' },
      { id: 'looping', name: 'looping', state: 'restarting', status: 'Restarting (1) 2 seconds ago' },
      { id: 'done', name: 'done', state: 'exited', status: 'Exited (0) 1 hour ago' },
      { id: 'failed', name: 'failed', state: 'exited', status: 'Exited (3) 1 hour ago' },
    ]);
    const policy: Record<string, string> = { fresh: 'always', looping: 'always', failed: 'no' };
    const { docker, paths } = stub(list, (id) => ({
      RestartCount: id === 'looping' ? 7 : 0,
      HostConfig: { RestartPolicy: { Name: policy[id] ?? '' } },
      State: { ExitCode: id === 'failed' ? 3 : 0, OOMKilled: false },
    }));

    const first = await sampleContainers('srv', docker);
    expect(paths.filter((p) => p !== '/containers/json').sort()).toEqual([
      '/containers/failed/json',
      '/containers/fresh/json',
      '/containers/looping/json',
    ]);
    expect(first.find((c) => c.name === 'looping')).toMatchObject({ restartCount: 7, restartPolicy: 'always' });
    expect(first.find((c) => c.name === 'failed')).toMatchObject({ exitCode: 3, restartPolicy: 'no' });
    expect(first.find((c) => c.name === 'steady')!.restartCount).toBeUndefined();

    // Next sweep: the exited container with policy `no` is not inspected again
    paths.length = 0;
    const second = await sampleContainers('srv', docker);
    expect(paths).not.toContain('/containers/failed/json');
    expect(second.find((c) => c.name === 'failed')!.restartPolicy).toBe('no');
  });

  it('inspects a bounded number of containers per sweep', async () => {
    const many = listed(
      Array.from({ length: MAX_INSPECTS_PER_SWEEP + 15 }, (_, i) => ({
        id: `c${i}`,
        name: `c${i}`,
        state: 'restarting',
        status: 'Restarting (1) 1 second ago',
      })),
    );
    const { docker, paths } = stub(many, () => ({ RestartCount: 1, HostConfig: { RestartPolicy: { Name: 'always' } } }));
    await sampleContainers('srv', docker);
    expect(paths.filter((p) => p !== '/containers/json')).toHaveLength(MAX_INSPECTS_PER_SWEEP);
  });

  it('gets to every failed container over a few sweeps, even past the per-sweep cap', async () => {
    const failed = listed(
      Array.from({ length: MAX_INSPECTS_PER_SWEEP + 15 }, (_, i) => ({
        id: `f${i}`,
        name: `f${i}`,
        state: 'exited',
        status: 'Exited (1) 5 minutes ago',
      })),
    );
    const { docker, paths } = stub(failed, () => ({
      HostConfig: { RestartPolicy: { Name: 'on-failure' } },
      State: { ExitCode: 1, OOMKilled: false },
    }));
    await sampleContainers('srv', docker);
    const second = await sampleContainers('srv', docker);
    expect(new Set(paths.filter((p) => p !== '/containers/json')).size).toBe(failed.length);
    expect(second.every((c) => c.restartPolicy === 'on-failure')).toBe(true);
    expect(evaluateContainers('srv', second).filter((c) => c.type === 'container_exited')).toHaveLength(failed.length);
  });
});

describe('container alerts in the health check', () => {
  let daemon: FakeDaemon;
  let orgId: string;
  let userId: string;

  const openAlerts = (serverId: string) =>
    getDb()
      .select()
      .from(serverAlerts)
      .where(and(eq(serverAlerts.serverId, serverId), isNull(serverAlerts.resolvedAt)))
      .all();
  const row = (id: string) => getDb().select().from(servers).where(eq(servers.id, id)).get()!;

  async function dockerServer(name: string, patch: Partial<typeof servers.$inferInsert> = {}) {
    const id = seedServer(orgId, userId, name);
    getDb()
      .update(servers)
      .set({
        encryptedPassword: await vault.encrypt('pw', id),
        dockerTransport: 'streamlocal',
        dockerDetectedSocketPath: '/var/run/docker.sock',
        dockerDetectedAt: new Date().toISOString(),
        dockerApiVersion: '1.47',
        dockerVersion: '27.3.1',
        ...patch,
      })
      .where(eq(servers.id, id))
      .run();
    return id;
  }

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    await runMigrations();
    orgId = seedOrg('org-container-alerts');
    userId = seedUser(orgId, 'admin').userId;
  });

  afterAll(async () => {
    await daemon.close();
  });

  beforeEach(() => {
    fake.options = { daemonSocket: daemon.socketPath, cli: true };
    fake.log.streamlocal.length = 0;
    fake.log.exec.length = 0;
    notified.events.length = 0;
    daemon.containers[0]!.Status = 'Up 2 hours (unhealthy)';
    updateDockerSettings(orgId, { containerAlerts: true });
  });

  it('is off by default: nothing is sampled until the org turns it on', async () => {
    const org = seedOrg('org-container-alerts-default');
    const id = seedServer(org, seedUser(org, 'admin').userId, 'quiet');
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', id), dockerTransport: 'streamlocal', dockerDetectedSocketPath: '/var/run/docker.sock', dockerDetectedAt: new Date().toISOString(), dockerApiVersion: '1.47' })
      .where(eq(servers.id, id))
      .run();
    expect(await checkServer(row(id))).toMatchObject({ status: 'online' });
    expect(fake.log.streamlocal).toEqual([]);
    expect(openAlerts(id)).toEqual([]);
  });

  it('opens one alert per container through the notification pipeline, and does not repeat it', async () => {
    const id = await dockerServer('box-1');
    expect(await checkServer(row(id))).toMatchObject({ status: 'online' });
    // One list call over the probe's connection; nothing needed an inspect
    expect(fake.log.streamlocal).toEqual(['/var/run/docker.sock']);
    expect(openAlerts(id)).toEqual([
      expect.objectContaining({ type: 'container_unhealthy', severity: 'warning', message: 'web: health check failing (Up 2 hours (unhealthy))' }),
    ]);
    expect(notified.events).toEqual([
      expect.objectContaining({ kind: 'opened', type: 'container_unhealthy', container: 'web', serverId: id }),
    ]);
    expect(dedupKey(notified.events[0]!, 'now')).toBe(`smt:${id}:container_unhealthy:web`);

    // Still unhealthy: same row, no second notification; host alerts reconciling leave it alone
    notified.events.length = 0;
    await checkServer(row(id));
    reconcileAlerts(orgId, id, []);
    expect(openAlerts(id)).toHaveLength(1);
    expect(notified.events).toEqual([]);

    // Recovered: resolved, and the channels hear about it
    daemon.containers[0]!.Status = 'Up 2 hours (healthy)';
    await checkServer(row(id));
    expect(openAlerts(id)).toEqual([]);
    expect(notified.events).toEqual([expect.objectContaining({ kind: 'resolved', type: 'container_unhealthy', container: 'web' })]);
  });

  it('keeps separate alerts for separate containers of the same kind', () => {
    const cond = (container: string) => ({
      type: 'container_unhealthy' as const,
      container,
      severity: 'warning' as const,
      message: `${container}: health check failing`,
    });
    const serverId = seedServer(orgId, userId, 'box-2');
    reconcileContainerAlerts(orgId, serverId, [cond('a'), cond('b')]);
    expect(openAlerts(serverId).map((a) => containerOfMessage(a.message)).sort()).toEqual(['a', 'b']);
    notified.events.length = 0;
    reconcileContainerAlerts(orgId, serverId, [cond('b')]);
    expect(openAlerts(serverId).map((a) => containerOfMessage(a.message))).toEqual(['b']);
    expect(notified.events).toEqual([expect.objectContaining({ kind: 'resolved', container: 'a' })]);
  });

  it('only samples servers where Docker is on and was detected — the sweep never detects', async () => {
    const off = await dockerServer('box-off', { dockerMode: 'off' });
    const never = await dockerServer('box-never', {
      dockerTransport: null,
      dockerDetectedSocketPath: null,
      dockerDetectedAt: null,
      dockerApiVersion: null,
    });
    for (const id of [off, never]) expect(await checkServer(row(id))).toMatchObject({ status: 'online' });
    expect(fake.log.streamlocal).toEqual([]);
    expect(fake.log.exec.some((c) => c.includes('command -v docker'))).toBe(false);
  });

  it('closes container alerts quietly when the org turns them off or the server is paused', async () => {
    const id = await dockerServer('box-3');
    await checkServer(row(id));
    expect(openAlerts(id)).toHaveLength(1);

    updateDockerSettings(orgId, { containerAlerts: false });
    notified.events.length = 0;
    await checkServer(row(id));
    expect(openAlerts(id)).toEqual([]);
    expect(notified.events).toEqual([]);

    updateDockerSettings(orgId, { containerAlerts: true });
    await checkServer(row(id));
    expect(openAlerts(id)).toHaveLength(1);
    notified.events.length = 0;
    pauseHealth(row(id));
    expect(openAlerts(id)).toEqual([]);
    expect(notified.events).toEqual([]);
  });

  it('never fails the health check when the daemon does not answer, and leaves alerts as they were', async () => {
    const id = await dockerServer('box-4');
    await checkServer(row(id));
    expect(openAlerts(id)).toHaveLength(1);

    fake.options.refuseForwarding = true;
    notified.events.length = 0;
    expect(await checkServer(row(id))).toMatchObject({ status: 'online' });
    expect(openAlerts(id)).toHaveLength(1);
    expect(notified.events).toEqual([]);
  });

  it('raises exited alerts from the daemon’s inspect facts', async () => {
    const id = await dockerServer('box-5');
    daemon.containers[0]!.Status = 'Up 2 hours (healthy)';
    const worker = daemon.containers[1]!;
    Object.assign(worker, { Status: 'Exited (2) 1 minute ago', ExitCode: 2, RestartPolicy: 'on-failure' });
    try {
      await checkServer(row(id));
      expect(openAlerts(id)).toEqual([
        expect.objectContaining({ type: 'container_exited', message: 'worker: exited with code 2 (restart policy on-failure)' }),
      ]);
    } finally {
      Object.assign(worker, { Status: 'Exited (0) 5 minutes ago', ExitCode: undefined, RestartPolicy: undefined });
    }
  });
});
