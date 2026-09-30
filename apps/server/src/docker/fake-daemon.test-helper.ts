import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';

/**
 * Test doubles for Docker: an in-process Engine API on a Unix socket, and an
 * ssh2 client stand-in that reaches it the way a real server would — a
 * streamlocal channel to the socket, or `docker system dial-stdio` over exec.
 * Nothing touches a real Docker daemon or the network.
 */

/** One multiplexed log frame (1 = stdout, 2 = stderr). */
export function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

export interface FakeContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Tty?: boolean;
  Env?: string[];
}

export interface FakeDaemon {
  socketPath: string;
  /** Paths requested, versioned prefix included. */
  requests: string[];
  containers: FakeContainer[];
  /** Connections to the daemon still open. */
  openConnections: () => number;
  /** Streams (logs follow, stats, events) the daemon is still writing to. */
  openStreams: () => number;
  close: () => Promise<void>;
}

export interface FakeDaemonOptions {
  apiVersion?: string;
  minApiVersion?: string;
}

const DEFAULT_CONTAINERS: FakeContainer[] = [
  {
    Id: 'a'.repeat(64),
    Names: ['/web'],
    Image: 'nginx:1.27',
    ImageID: 'sha256:' + '1'.repeat(64),
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Env: ['DB_PASSWORD=hunter2', 'PATH=/usr/bin'],
  },
  {
    Id: 'b'.repeat(64),
    Names: ['/worker'],
    Image: 'busybox',
    ImageID: 'sha256:' + '2'.repeat(64),
    State: 'exited',
    Status: 'Exited (0) 5 minutes ago',
    Tty: true,
  },
];

export async function startFakeDaemon(opts: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-fake-docker-'));
  const socketPath = path.join(dir, 'docker.sock');
  const requests: string[] = [];
  const containers = DEFAULT_CONTAINERS.map((c) => ({ ...c }));
  const sockets = new Set<net.Socket>();
  const streams = new Set<http.ServerResponse>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const find = (ref: string) => containers.find((c) => c.Id.startsWith(ref) || c.Names.includes(`/${ref}`));
  const keepStreaming = (res: http.ServerResponse, everyMs: number, write: () => void) => {
    streams.add(res);
    const timer = setInterval(write, everyMs);
    res.on('close', () => {
      clearInterval(timer);
      streams.delete(res);
    });
  };

  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://docker');
    const route = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const q = url.searchParams;
    let m: RegExpMatchArray | null;

    if (route === '/_ping') return res.end('OK');
    if (route === '/version') {
      return json(res, 200, {
        Version: '27.3.1',
        ApiVersion: opts.apiVersion ?? '1.47',
        MinAPIVersion: opts.minApiVersion ?? '1.24',
        Components: [{ Name: 'Engine', Version: '27.3.1' }],
      });
    }
    if (route === '/info') {
      return json(res, 200, {
        Name: 'fake-host',
        ServerVersion: '27.3.1',
        OperatingSystem: 'Debian GNU/Linux 12',
        OSType: 'linux',
        Architecture: 'x86_64',
        KernelVersion: '6.1.0',
        NCPU: 4,
        MemTotal: 8 * 1024 ** 3,
        Driver: 'overlay2',
        SecurityOptions: ['name=seccomp,profile=builtin'],
        Containers: containers.length,
        ContainersRunning: containers.filter((c) => c.State === 'running').length,
        ContainersPaused: 0,
        ContainersStopped: containers.filter((c) => c.State === 'exited').length,
        Images: 2,
      });
    }
    if (route === '/system/df') {
      return json(res, 200, {
        LayersSize: 1000,
        Images: [
          { Size: 600, SharedSize: 0, Containers: 1 },
          { Size: 400, SharedSize: 0, Containers: 0 },
        ],
        Containers: [
          { SizeRw: 10, State: 'running' },
          { SizeRw: 20, State: 'exited' },
        ],
        Volumes: [{ UsageData: { Size: 50, RefCount: 0 } }],
        BuildCache: [],
      });
    }
    if (route === '/containers/json') {
      const all = q.get('all') === '1' || q.get('all') === 'true';
      return json(
        res,
        200,
        containers
          .filter((c) => all || c.State === 'running')
          .map((c) => ({
            Id: c.Id,
            Names: c.Names,
            Image: c.Image,
            ImageID: c.ImageID,
            Command: 'run',
            Created: 1_700_000_000,
            State: c.State,
            Status: c.Status,
            Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
            Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': c.Names[0]!.slice(1) },
            Mounts: [{ Type: 'volume', Name: 'data' }],
            NetworkSettings: { Networks: { bridge: {} } },
          })),
      );
    }
    if ((m = route.match(/^\/containers\/([^/]+)\/json$/))) {
      const c = find(decodeURIComponent(m[1]!));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      return json(res, 200, {
        Id: c.Id,
        Name: c.Names[0],
        State: { Status: c.State },
        Config: { Tty: c.Tty === true, Env: c.Env ?? [], Labels: { tier: 'web' } },
      });
    }
    if ((m = route.match(/^\/containers\/([^/]+)\/logs$/))) {
      const c = find(decodeURIComponent(m[1]!));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      res.writeHead(200, { 'Content-Type': c.Tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream' });
      const ts = q.get('timestamps') === '1' ? '2026-09-30T10:00:00.000000000Z ' : '';
      if (c.Tty) {
        res.write(`${ts}tty line one\r\n${ts}tty li`);
        res.write('ne two\n');
      } else {
        // Frames split mid-header and mid-payload, the way a network delivers them
        const bytes = Buffer.concat([frame(1, `${ts}hello stdout\n`), frame(2, `${ts}oops stderr\n`)]);
        res.write(bytes.subarray(0, 5));
        res.write(bytes.subarray(5, 20));
        res.write(bytes.subarray(20));
      }
      if (q.get('follow') !== '1') return res.end();
      let n = 0;
      return keepStreaming(res, 20, () => {
        n++;
        res.write(c.Tty ? `${ts}tick ${n}\n` : frame(1, `${ts}tick ${n}\n`));
      });
    }
    if ((m = route.match(/^\/containers\/([^/]+)\/stats$/))) {
      if (!find(decodeURIComponent(m[1]!))) return json(res, 404, { message: 'No such container' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let total = 0;
      const sample = () => {
        total += 50;
        res.write(
          JSON.stringify({
            read: new Date().toISOString(),
            cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: total * 4, online_cpus: 2 },
            precpu_stats: { cpu_usage: { total_usage: total - 50 }, system_cpu_usage: (total - 50) * 4 },
            memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
            networks: { eth0: { rx_bytes: 5, tx_bytes: 7 } },
            pids_stats: { current: 3 },
          }) + '\n',
        );
      };
      sample();
      return keepStreaming(res, 20, sample);
    }
    if ((m = route.match(/^\/containers\/([^/]+)\/top$/))) {
      return json(res, 200, { Titles: ['PID', 'CMD'], Processes: [['1', 'nginx']] });
    }
    if (route === '/images/json') {
      return json(res, 200, [
        { Id: 'sha256:' + '1'.repeat(64), RepoTags: ['nginx:1.27'], RepoDigests: [], Created: 1_700_000_000, Size: 600, Containers: -1 },
        { Id: 'sha256:' + '9'.repeat(64), RepoTags: ['<none>:<none>'], RepoDigests: [], Created: 1_700_000_000, Size: 400, Containers: -1 },
      ]);
    }
    if ((m = route.match(/^\/images\/(.+)\/json$/))) {
      return json(res, 200, { Id: 'sha256:' + '1'.repeat(64), RepoTags: [decodeURIComponent(m[1]!)], Config: { Env: ['TOKEN=abc'] } });
    }
    if (route === '/volumes') {
      return json(res, 200, { Volumes: [{ Name: 'data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/data', Scope: 'local' }], Warnings: null });
    }
    if (route === '/networks') {
      return json(res, 200, [{ Name: 'bridge', Id: 'n'.repeat(64), Driver: 'bridge', Scope: 'local', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } }]);
    }
    if (route === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const event = (action: string) =>
        res.write(
          JSON.stringify({ Type: 'container', Action: action, Actor: { ID: 'a'.repeat(64), Attributes: { name: 'web' } }, time: 1_700_000_000, timeNano: 1_700_000_000_000_000_000 }) + '\n',
        );
      event('start');
      return keepStreaming(res, 50, () => event('health_status: healthy'));
    }
    json(res, 404, { message: `page not found: ${route}` });
  });

  // Hijacked calls: switch protocols, then echo what arrives, upper-cased
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    requests.push(req.url ?? '');
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    if (head.length) socket.write(head.toString().toUpperCase());
    socket.on('data', (d: Buffer) => socket.write(d.toString().toUpperCase()));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    requests,
    containers,
    openConnections: () => sockets.size,
    openStreams: () => streams.size,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── ssh2 stand-in ────────────────────────────────────────────────────────────

export interface FakeSshOptions {
  /** Where the fake daemon listens; channels to `remotePath` reach it. */
  daemonSocket: string;
  /** The path the "server" has its socket at (default /var/run/docker.sock). */
  remotePath?: string;
  /** sshd refuses streamlocal forwarding, saying so ("administratively prohibited"). */
  refuseForwarding?: boolean;
  /** sshd refuses it the way OpenSSH does under AllowTcpForwarding no: a bare "open failed". */
  refuseForwardingQuietly?: boolean;
  /** Whether `docker` is installed (dial-stdio, and what the facts script reports). */
  cli?: boolean;
  /** The SSH user may not use the socket. */
  socketDenied?: boolean;
  /** $XDG_RUNTIME_DIR reported by the facts script. */
  runtimeDir?: string;
}

/** Exec channels and streamlocal channels opened, and commands run (for assertions). */
export interface FakeSshLog {
  streamlocal: string[];
  exec: string[];
}

function channelError(message: string, reason: number): Error {
  return Object.assign(new Error(`(SSH) Channel open failure: ${message}`), { reason });
}

/**
 * Stands in for an ssh2 exec channel: stdin is swallowed, stdout and stderr
 * are what the "process" printed, then `exit` and `close`.
 */
function execChannel(stdout: string, code: number, stderr = ''): Duplex & { stderr: PassThrough } {
  const channel = Object.assign(
    new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
      autoDestroy: false,
    }),
    { stderr: new PassThrough() },
  );
  setImmediate(() => {
    if (stderr) channel.stderr.write(stderr);
    if (stdout) channel.push(stdout);
    channel.push(null);
    channel.emit('exit', code);
    setImmediate(() => channel.emit('close'));
  });
  return channel;
}

/**
 * Methods of an ssh2 `Client` that Docker support uses, backed by the fake
 * daemon. `emitter` is returned for the ssh2 module mock to extend.
 */
export function fakeSshMethods(options: () => FakeSshOptions, log: FakeSshLog, track: (s: net.Socket) => void) {
  return {
    openssh_forwardOutStreamLocal(socketPath: string, cb: (err: Error | undefined, channel?: net.Socket) => void) {
      const o = options();
      log.streamlocal.push(socketPath);
      setImmediate(() => {
        if (o.refuseForwarding) return cb(channelError('administratively prohibited', 1));
        if (o.refuseForwardingQuietly) return cb(channelError('open failed', 2));
        if (socketPath !== (o.remotePath ?? '/var/run/docker.sock') || o.socketDenied) {
          return cb(channelError('open failed', 2));
        }
        const socket = net.connect(o.daemonSocket);
        track(socket);
        cb(undefined, socket);
      });
    },
    exec(command: string, cb: (err: Error | undefined, channel?: unknown) => void) {
      const o = options();
      log.exec.push(command);
      setImmediate(() => {
        if (command.includes('dial-stdio')) {
          if (!o.cli) return cb(undefined, execChannel('', 127, 'sh: docker: command not found\n'));
          const wanted = `unix://${o.remotePath ?? '/var/run/docker.sock'}`;
          if (!command.includes(wanted) || o.socketDenied) {
            return cb(undefined, execChannel('', 1, 'permission denied while trying to connect to the Docker daemon socket\n'));
          }
          const socket = Object.assign(net.connect(o.daemonSocket), { stderr: new PassThrough() });
          track(socket);
          return cb(undefined, socket);
        }
        if (command.includes('command -v docker')) {
          const runtime = o.runtimeDir ?? '/run/user/1000';
          const remote = o.remotePath ?? '/var/run/docker.sock';
          // The script's arguments are the quoted candidates after `sh`
          const args = [...command.matchAll(/'(\/[^']*)'/g)].map((mm) => mm[1]!);
          const paths = [...args, `${runtime}/docker.sock`, `${runtime}/podman/podman.sock`];
          const lines = [`cli=${o.cli ? 1 : 0}`, 'uid=1000', `runtime=${runtime}`];
          for (const p of paths) {
            const state = p === remote ? (o.socketDenied ? 'denied' : 'ok') : 'missing';
            lines.push(`sock=${state}:${p}`);
          }
          return cb(undefined, execChannel(lines.join('\n') + '\n', 0));
        }
        cb(undefined, execChannel('', 127, 'unknown command'));
      });
    },
  };
}

/** A plain fake client object (no ssh2 module mock needed), for transport and probe tests. */
export function fakeSshClient(opts: FakeSshOptions) {
  const log: FakeSshLog = { streamlocal: [], exec: [] };
  const sockets = new Set<net.Socket>();
  const methods = fakeSshMethods(
    () => opts,
    log,
    (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    },
  );
  const client = Object.assign(new EventEmitter(), methods, {
    end() {
      for (const s of sockets) s.destroy();
    },
  });
  return { client, log, openChannels: () => sockets.size };
}
