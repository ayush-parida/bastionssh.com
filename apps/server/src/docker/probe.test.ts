import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'ssh2';
import { candidateSockets, parseHostFacts, probeDocker } from './probe.js';
import { fakeSshClient, startFakeDaemon, type FakeDaemon, type FakeSshOptions } from './fake-daemon.test-helper.js';

describe('host facts', () => {
  it('parses what the detection script prints', () => {
    const facts = parseHostFacts('cli=1\nuid=1000\nruntime=/run/user/1000\nsock=ok:/var/run/docker.sock\nsock=denied:/run/podman/podman.sock\njunk\n');
    expect(facts.cli).toBe(true);
    expect(facts.runtimeDir).toBe('/run/user/1000');
    expect([...facts.sockets]).toEqual([
      ['/var/run/docker.sock', 'ok'],
      ['/run/podman/podman.sock', 'denied'],
    ]);
  });

  it('tries the default, rootless Docker, then Podman — or the override alone', () => {
    const facts = parseHostFacts('runtime=/run/user/1000\n');
    expect(candidateSockets(null, facts)).toEqual([
      '/var/run/docker.sock',
      '/run/user/1000/docker.sock',
      '/run/podman/podman.sock',
      '/run/user/1000/podman/podman.sock',
    ]);
    expect(candidateSockets('/srv/docker.sock', facts)).toEqual(['/srv/docker.sock']);
  });
});

describe('Docker detection', () => {
  let daemon: FakeDaemon;
  let oldDaemon: FakeDaemon;

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    oldDaemon = await startFakeDaemon({ apiVersion: '1.20' });
  });
  afterAll(async () => {
    await daemon.close();
    await oldDaemon.close();
  });

  const probe = (opts: Partial<FakeSshOptions>, override: string | null = null) => {
    const ssh = fakeSshClient({ daemonSocket: daemon.socketPath, cli: true, ...opts });
    return {
      ssh,
      result: probeDocker(ssh.client as unknown as Client, { override, username: 'deploy' }),
    };
  };

  it('uses the default socket over streamlocal, with no shell at all', async () => {
    const { ssh, result } = probe({});
    expect(await result).toMatchObject({
      ok: true,
      transport: 'streamlocal',
      socketPath: '/var/run/docker.sock',
      version: '27.3.1',
      apiVersion: '1.47',
      flavor: 'docker',
      problem: null,
    });
    expect(ssh.log.exec).toEqual([]);
  });

  it('falls back to dial-stdio when sshd refuses socket forwarding', async () => {
    const { result } = probe({ refuseForwarding: true });
    const r = await result;
    expect(r).toMatchObject({ ok: true, transport: 'dial-stdio', socketPath: '/var/run/docker.sock' });
    expect(r.attempts.map((a) => [a.transport, a.ok])).toEqual([
      ['streamlocal', false],
      ['dial-stdio', true],
    ]);
  });

  it('recognises OpenSSH’s bare "open failed" on a socket the user may use as forwarding being off', async () => {
    const viaCli = await probe({ refuseForwardingQuietly: true }).result;
    expect(viaCli).toMatchObject({ ok: true, transport: 'dial-stdio' });
    const noCli = await probe({ refuseForwardingQuietly: true, cli: false }).result;
    expect(noCli).toMatchObject({ ok: false, problem: 'forwarding_disabled' });
    expect(noCli.hint).toContain('AllowTcpForwarding');
  });

  it('says forwarding is disabled when there is no CLI to fall back on', async () => {
    const r = await probe({ refuseForwarding: true, cli: false }).result;
    expect(r).toMatchObject({ ok: false, problem: 'forwarding_disabled' });
    expect(r.hint).toContain('AllowStreamLocalForwarding');
  });

  it('finds rootless Docker under the user’s runtime directory', async () => {
    const r = await probe({ remotePath: '/run/user/1000/docker.sock' }).result;
    expect(r).toMatchObject({ ok: true, transport: 'streamlocal', socketPath: '/run/user/1000/docker.sock', flavor: 'rootless' });
  });

  it('finds Podman’s Docker-compatible socket', async () => {
    const r = await probe({ remotePath: '/run/podman/podman.sock' }).result;
    expect(r).toMatchObject({ ok: true, socketPath: '/run/podman/podman.sock' });
  });

  it('explains a socket the user may not use, with the usermod hint', async () => {
    const r = await probe({ socketDenied: true }).result;
    expect(r).toMatchObject({ ok: false, problem: 'permission_denied' });
    expect(r.error).toContain('deploy');
    expect(r.hint).toContain('sudo usermod -aG docker deploy');
  });

  it('tells a missing daemon from a missing install', async () => {
    const down = await probe({ remotePath: '/elsewhere.sock', cli: true }).result;
    expect(down).toMatchObject({ ok: false, problem: 'daemon_not_running' });
    const none = await probe({ remotePath: '/elsewhere.sock', cli: false }).result;
    expect(none).toMatchObject({ ok: false, problem: 'not_installed' });
    expect(none.hint).toContain('docs.docker.com');
  });

  it('only tries the configured socket when there is an override', async () => {
    const found = await probe({ remotePath: '/srv/docker.sock' }, '/srv/docker.sock').result;
    expect(found).toMatchObject({ ok: true, socketPath: '/srv/docker.sock' });
    // The default socket works, but the override points elsewhere: not used
    const { ssh, result } = probe({}, '/srv/missing.sock');
    expect(await result).toMatchObject({ ok: false, problem: 'daemon_not_running' });
    expect(ssh.log.streamlocal).toEqual(['/srv/missing.sock']);
  });

  it('refuses an engine too old to talk to', async () => {
    const ssh = fakeSshClient({ daemonSocket: oldDaemon.socketPath, cli: true });
    const r = await probeDocker(ssh.client as unknown as Client, { override: null, username: 'deploy' });
    expect(r).toMatchObject({ ok: false, problem: 'unsupported_version' });
  });
});
