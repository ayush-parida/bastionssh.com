import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'ssh2';
import { DockerClient, MAX_API_VERSION, compareApiVersions, negotiateApiVersion } from './client.js';
import { DockerError } from './errors.js';
import { Demuxer } from './demux.js';
import { openDaemonStream, openDialStdio, openStreamLocal, type DaemonEndpoint } from './transport.js';
import { fakeSshClient, startFakeDaemon, type FakeDaemon } from './fake-daemon.test-helper.js';

const until = async (check: () => boolean, ms = 2000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('API version negotiation', () => {
  it('compares versions numerically', () => {
    expect(compareApiVersions('1.9', '1.10')).toBe(-1);
    expect(compareApiVersions('1.41', '1.41')).toBe(0);
    expect(compareApiVersions('2.0', '1.47')).toBe(1);
  });

  it('uses the daemon’s version when it is older than ours, ours when newer', () => {
    expect(negotiateApiVersion({ ApiVersion: '1.41', MinAPIVersion: '1.12' })).toBe('1.41');
    expect(negotiateApiVersion({ ApiVersion: '1.52', MinAPIVersion: '1.44' })).toBe(MAX_API_VERSION);
  });

  it('assumes 1.24 for daemons that do not say, and refuses those too old', () => {
    expect(() => negotiateApiVersion({})).toThrow(/too old/);
    expect(() => negotiateApiVersion({ ApiVersion: '1.23' })).toThrow(DockerError);
  });

  it('refuses a daemon that no longer serves what this app speaks', () => {
    try {
      negotiateApiVersion({ ApiVersion: '1.60', MinAPIVersion: '1.50' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, problem: 'unsupported_version' });
    }
  });
});

describe('Docker API over SSH channels (fake daemon)', () => {
  let daemon: FakeDaemon;

  beforeAll(async () => {
    daemon = await startFakeDaemon();
  });
  afterAll(async () => {
    await daemon.close();
  });

  const transports: DaemonEndpoint['transport'][] = ['streamlocal', 'dial-stdio'];

  for (const transport of transports) {
    describe(transport, () => {
      const setup = () => {
        const ssh = fakeSshClient({ daemonSocket: daemon.socketPath, cli: true });
        const endpoint: DaemonEndpoint = { transport, socketPath: '/var/run/docker.sock' };
        const docker = new DockerClient(() => openDaemonStream(ssh.client as unknown as Client, endpoint), '1.43');
        return { ssh, docker };
      };

      it('makes JSON calls on versioned paths, one fresh stream per request', async () => {
        const { ssh, docker } = setup();
        const before = daemon.requests.length;
        const [list, version] = await Promise.all([
          docker.json<unknown[]>({ path: '/containers/json', query: { all: true } }),
          docker.json<{ Version: string }>({ path: '/version', versioned: false }),
        ]);
        expect(list).toHaveLength(2);
        expect(version.Version).toBe('27.3.1');
        expect(daemon.requests.slice(before)).toEqual(expect.arrayContaining(['/v1.43/containers/json?all=1', '/version']));
        if (transport === 'streamlocal') expect(ssh.log.streamlocal).toHaveLength(2);
        else expect(ssh.log.exec.filter((c) => c.includes('dial-stdio'))).toHaveLength(2);
        // No keep-alive: every stream closes with its request
        await until(() => ssh.openChannels() === 0);
      });

      it('maps daemon errors', async () => {
        const { docker } = setup();
        await expect(docker.json({ path: '/containers/nope/json' })).rejects.toMatchObject({
          statusCode: 404,
          message: 'No such container: nope',
        });
      });

      it('streams a chunked, multiplexed body as it arrives', async () => {
        const { docker } = setup();
        const res = await docker.stream({ path: '/containers/web/logs', query: { stdout: true, stderr: true } });
        const demuxer = new Demuxer();
        const got: string[] = [];
        for await (const chunk of res) for (const f of demuxer.push(chunk as Buffer)) got.push(`${f.stream}:${f.payload}`);
        expect(got).toEqual(['stdout:hello stdout\n', 'stderr:oops stderr\n']);
      });

      it('closes the channel and stops the daemon writing when a follow is aborted', async () => {
        const { ssh, docker } = setup();
        const abort = new AbortController();
        const res = await docker.stream({ path: '/containers/web/logs', query: { follow: true, stdout: true }, signal: abort.signal });
        await new Promise((resolve) => res.once('data', resolve));
        expect(daemon.openStreams()).toBe(1);
        abort.abort();
        await until(() => daemon.openStreams() === 0 && ssh.openChannels() === 0);
      });

      it('hijacks a connection for raw two-way traffic', async () => {
        const { docker } = setup();
        const { socket } = await docker.hijack({ path: '/exec/abc/start', body: { Detach: false, Tty: true } });
        socket.write('echo hi');
        const reply = await new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString())));
        expect(reply).toBe('ECHO HI');
        socket.destroy();
      });
    });
  }

  it('reports the CLI’s own error when dial-stdio cannot run', async () => {
    const ssh = fakeSshClient({ daemonSocket: daemon.socketPath, cli: false });
    const docker = new DockerClient(() => openDialStdio(ssh.client as unknown as Client, '/var/run/docker.sock'));
    await expect(docker.ping()).rejects.toThrow(/command not found|dial-stdio/);
  });

  it('surfaces sshd refusing the forward with the channel-open reason', async () => {
    const ssh = fakeSshClient({ daemonSocket: daemon.socketPath, refuseForwarding: true });
    await expect(openStreamLocal(ssh.client as unknown as Client, '/var/run/docker.sock')).rejects.toMatchObject({ reason: 1 });
  });

  it('times out a request the daemon never answers', async () => {
    const hang = new DockerClient(() => new Promise(() => {}));
    await expect(hang.json({ path: '/info', timeoutMs: 50 })).rejects.toMatchObject({ statusCode: 504 });
  });
});
