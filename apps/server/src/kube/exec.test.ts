import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Pod exec (exec.ts, client.ts `exec`) against the fake API server's exec
 * WebSocket (real `ws` on the far side): protocol negotiation (v5, falling
 * back to v4), the channels — stdin, stdout, stderr, status, resize, close —
 * exit codes, refusals before the upgrade, and the same over a managed
 * server's SSH `forwardOut` (a stand-in dialing the fake server).
 */
const fake = vi.hoisted(() => ({ target: 0, forwards: 0 }));

vi.mock('ssh2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ssh2')>();
  const { EventEmitter } = await import('node:events');
  const net = await import('node:net');
  class Client extends EventEmitter {
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
    forwardOut(_srcIP: string, _srcPort: number, _host: string, _port: number, cb: (err: Error | undefined, ch?: unknown) => void) {
      fake.forwards += 1;
      setImmediate(() => cb(undefined, net.connect(fake.target, '127.0.0.1')));
    }
    end() {
      setImmediate(() => this.emit('close'));
      return this;
    }
  }
  return { ...actual, default: { ...(actual as { default?: object }).default, Client }, Client };
});

import { eq } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { vault } from '../vault/index.js';
import { seedOrg, seedServer, seedUser } from '../api/routes/test-utils.js';
import { clientFor, type ClientParams } from './service.js';
import { KubeError } from './errors.js';
import { evictKubeServer } from './ssh-pool.js';
import { FAKE_TOKEN, startFakeApi, type FakeApi } from './fake-api.test-helper.js';
import { fakePods, type FakePods } from './fake-pod-api.test-helper.js';
import { CA_CERT } from './test-certs.test-helper.js';
import { openPodShell, parseExecStatus } from './exec.js';

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('parseExecStatus', () => {
  it('reads success, a non-zero exit code, and failures without one', () => {
    expect(parseExecStatus('{"metadata":{},"status":"Success"}')).toEqual({ exitCode: 0, message: null });
    expect(
      parseExecStatus(
        JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', message: 'exit 3', details: { causes: [{ reason: 'ExitCode', message: '3' }] } }),
      ),
    ).toEqual({ exitCode: 3, message: 'exit 3' });
    expect(parseExecStatus(JSON.stringify({ status: 'Failure', reason: 'InternalError', message: 'no such file' }))).toEqual({
      exitCode: null,
      message: 'no such file',
    });
    expect(parseExecStatus('plain text error')).toEqual({ exitCode: null, message: 'plain text error' });
  });
});

describe('pod exec', () => {
  let api: FakeApi;
  let pods: FakePods;
  let orgId: string;
  let serverId: string;

  const client = (overrides: Partial<ClientParams> = {}) =>
    clientFor({
      orgId,
      apiUrl: api.url,
      caData: CA_CERT,
      credential: { type: 'token', token: FAKE_TOKEN },
      connectVia: 'direct',
      viaServerId: null,
      viaAgentId: null,
      ...overrides,
    });

  beforeAll(async () => {
    await runMigrations();
    api = await startFakeApi();
    pods = fakePods(api);
    fake.target = api.port;
    orgId = seedOrg('kube-exec');
    serverId = seedServer(orgId, seedUser(orgId, 'admin').userId, 'bastion');
    getDb()
      .update(servers)
      .set({ encryptedPassword: await vault.encrypt('pw', serverId) })
      .where(eq(servers.id, serverId))
      .run();
  });

  afterAll(async () => {
    pods.close();
    await api.close();
  });

  beforeEach(() => {
    pods.protocols = ['v5.channel.k8s.io', 'v4.channel.k8s.io'];
  });

  it('runs a command over v5 with the right query, output, input and exit code', async () => {
    const session = await client().exec('shop', 'web-1', { container: 'app', command: ['sh', '-c', 'echo hi'], tty: true });
    expect(session.protocol).toBe('v5.channel.k8s.io');
    const exec = pods.execs.at(-1)!;
    expect(exec.query.getAll('command')).toEqual(['sh', '-c', 'echo hi']);
    expect(exec.query.get('container')).toBe('app');
    expect(exec.query.get('tty')).toBe('true');
    expect(exec.query.get('stdin')).toBe('true');
    // With a TTY the API server refuses a separate stderr
    expect(exec.query.get('stderr')).toBeNull();
    let out = '';
    session.stdout.on('data', (d: Buffer) => (out += d.toString()));
    session.stdin.write('ls\r');
    await until(() => out.includes('ls\r'));
    expect(out.startsWith('$ ')).toBe(true);
    session.stdin.write('exit 3\r');
    expect(await session.exited).toBe(3);
    expect(session.failure).toMatch(/exit code 3/);
  });

  it('falls back to v4 on an older API server', async () => {
    pods.protocols = ['v4.channel.k8s.io'];
    const session = await client().exec('shop', 'web-1', { container: 'app', command: ['sh'], tty: true });
    expect(session.protocol).toBe('v4.channel.k8s.io');
    session.stdin.write('exit 0\r');
    expect(await session.exited).toBe(0);
  });

  it('refuses when the API server offers no protocol it speaks', async () => {
    pods.protocols = ['v3.channel.k8s.io'];
    await expect(client().exec('shop', 'web-1', { container: 'app', command: ['sh'], tty: true })).rejects.toThrow();
  });

  it('separates stderr without a TTY', async () => {
    const session = await client().exec('shop', 'web-1', { container: 'app', command: ['sh'], tty: false, stdin: true });
    expect(pods.execs.at(-1)!.query.get('stderr')).toBe('true');
    let err = '';
    session.stderr.on('data', (d: Buffer) => (err += d.toString()));
    session.stdin.write('oops');
    await until(() => err.includes('oops on stderr'));
    session.close();
    await session.exited;
  });

  it('turns a refused upgrade into the API server’s error', async () => {
    const bad = client({ credential: { type: 'token', token: 'nope' } });
    const err = await bad.exec('shop', 'web-1', { container: 'app', command: ['sh'], tty: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeError);
    expect((err as KubeError).message).toMatch(/refused the stored credential/);
  });

  it('opens a shell sized by a first resize, follows resizes, and closes it with ^C ^D', async () => {
    const shell = await openPodShell(client(), { namespace: 'shop', pod: 'web-1', container: 'app' }, { cmd: ['sh'], cols: 120, rows: 40 });
    const exec = pods.execs.at(-1)!;
    let out = '';
    shell.channel.on('data', (d: Buffer) => (out += d.toString()));
    await until(() => exec.resizes.length === 1);
    expect(exec.resizes[0]).toEqual({ Width: 120, Height: 40 });
    shell.channel.setWindow(30, 100, 0, 0);
    await until(() => exec.resizes.length === 2);
    expect(exec.resizes[1]).toEqual({ Width: 100, Height: 30 });
    shell.channel.write('pwd\r');
    await until(() => out.includes('pwd'));
    expect(await shell.close()).toBe(0);
    expect(exec.stdin).toContain('\x03\x04');
    await until(() => exec.closed);
    expect(shell.channel.destroyed).toBe(true);
  });

  it('shows why a process could not start in the terminal', async () => {
    const shell = await openPodShell(client(), { namespace: 'shop', pod: 'web-1', container: 'app' }, { cmd: ['/missing'], cols: 80, rows: 24 });
    let out = '';
    shell.channel.on('data', (d: Buffer) => (out += d.toString()));
    await until(() => shell.channel.destroyed);
    expect(out).toMatch(/no such file or directory/);
  });

  it('reaches the exec WebSocket through a managed server’s SSH forwardOut', async () => {
    evictKubeServer(orgId, serverId);
    const before = fake.forwards;
    const session = await client({ connectVia: 'server', viaServerId: serverId }).exec('shop', 'web-1', {
      container: 'app',
      command: ['sh'],
      tty: true,
    });
    expect(fake.forwards).toBe(before + 1);
    session.endInput();
    expect(await session.exited).toBe(0);
    expect(pods.execs.at(-1)!.stdinClosed).toBe(true);
  });
});
