import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * An in-process Docker Engine API on a unix socket, with just what bastionctl
 * calls: containers, exec, images, build, pull, networks, volumes, logs.
 * Commands run in containers are answered by `exec` (default: success), so a
 * test can fail a health check or a proxy reload.
 */

export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Labels: Record<string, string>;
  Env: string[];
  HostConfig: Record<string, unknown>;
  Cmd: string[] | null;
  State: { Status: string; Running: boolean; Restarting: boolean; ExitCode: number; StartedAt: string };
  RestartCount: number;
  /** Networks joined after create (network connect), with their aliases. */
  Networks: Record<string, { Aliases: string[] }>;
  /** Address on the network it was created on. */
  IPAddress: string;
}

export interface ExecCall {
  container: string;
  cmd: string[];
}

export interface FakeDocker {
  socket: string;
  containers: Map<string, FakeContainer>;
  images: Map<string, { Id: string; Labels: Record<string, string> }>;
  networks: Set<string>;
  /** Networks created internal. */
  internalNetworks: Set<string>;
  volumesRemoved: string[];
  execs: ExecCall[];
  builds: Array<{ query: URLSearchParams; bytes: number; tar: Buffer }>;
  pulls: string[];
  requests: string[];
  /** Answer a command run in a container. */
  exec: (call: ExecCall) => { exitCode: number; stdout?: string; stderr?: string };
  /** Make a build fail with this message. */
  buildError: string | null;
  /** Extra build output, one stream message per entry (what a project's build prints). */
  buildOutput: string[];
  /** Containers whose start leaves them exited (a crashing app). */
  crashOnStart: (name: string) => boolean;
  close: () => Promise<void>;
}

let counter = 0;
const hexId = () => (++counter).toString(16).padStart(12, '0').repeat(6).slice(0, 64);

function mux(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function labelFilter(query: URLSearchParams): string[] {
  const raw = query.get('filters');
  if (!raw) return [];
  return ((JSON.parse(raw) as { label?: string[] }).label ?? []) as string[];
}

function matches(labels: Record<string, string>, wanted: string[]): boolean {
  return wanted.every((w) => {
    const [k, v] = w.split('=');
    return v === undefined ? k! in labels : labels[k!] === v;
  });
}

export async function startFakeDocker(): Promise<FakeDocker> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfd-'));
  const socket = path.join(dir, 'd.sock');
  const fake: FakeDocker = {
    socket,
    containers: new Map(),
    images: new Map(),
    networks: new Set(),
    internalNetworks: new Set(),
    volumesRemoved: [],
    execs: [],
    builds: [],
    pulls: [],
    requests: [],
    exec: () => ({ exitCode: 0 }),
    buildError: null,
    crashOnStart: () => false,
    buildOutput: [],
    close: async () => {},
  };
  const execs = new Map<string, ExecCall>();
  const execResults = new Map<string, number>();

  const find = (ref: string): FakeContainer | undefined => {
    const name = decodeURIComponent(ref);
    return fake.containers.get(name) ?? [...fake.containers.values()].find((c) => c.Id === name || c.Id.startsWith(name));
  };
  const imageKey = (ref: string) => {
    const name = decodeURIComponent(ref);
    if (fake.images.has(name)) return name;
    return [...fake.images.entries()].find(([, v]) => v.Id === name)?.[0];
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const p = url.pathname;
      const q = url.searchParams;
      fake.requests.push(`${req.method} ${p}`);
      const body = Buffer.concat(chunks);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      const notFound = (what: string) => json(404, { message: `No such ${what}` });
      let m: RegExpExecArray | null;

      if (p === '/_ping') return void res.end('OK');

      if (p === '/containers/json') {
        const wanted = labelFilter(q);
        const all = q.get('all') === 'true';
        return json(
          200,
          [...fake.containers.values()]
            .filter((c) => matches(c.Labels, wanted) && (all || c.State.Running))
            .map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image, State: c.State.Status, Status: c.State.Status, Labels: c.Labels })),
        );
      }
      if (p === '/containers/create' && req.method === 'POST') {
        const name = q.get('name')!;
        if (fake.containers.has(name)) return json(409, { message: `Conflict. The container name "/${name}" is already in use` });
        const spec = JSON.parse(body.toString()) as { Image: string; Labels?: Record<string, string>; Env?: string[]; HostConfig?: Record<string, unknown>; Cmd?: string[] };
        if (!imageKey(spec.Image)) return json(404, { message: `No such image: ${spec.Image}` });
        const c: FakeContainer = {
          Id: hexId(),
          Name: name,
          Image: spec.Image,
          Labels: spec.Labels ?? {},
          Env: spec.Env ?? [],
          HostConfig: spec.HostConfig ?? {},
          Cmd: spec.Cmd ?? null,
          State: { Status: 'created', Running: false, Restarting: false, ExitCode: 0, StartedAt: '' },
          RestartCount: 0,
          Networks: {},
          IPAddress: `172.30.0.${fake.containers.size + 2}`,
        };
        fake.containers.set(name, c);
        return json(201, { Id: c.Id, Warnings: [] });
      }
      if ((m = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(p)) && req.method === 'POST') {
        const c = find(m[1]!);
        if (!c) return notFound('container');
        if (m[2] === 'stop') {
          if (!c.State.Running) return json(304, undefined);
          c.State = { ...c.State, Status: 'exited', Running: false };
        } else if (fake.crashOnStart(c.Name)) {
          c.State = { ...c.State, Status: 'exited', Running: false, ExitCode: 1 };
        } else {
          c.State = { ...c.State, Status: 'running', Running: true, StartedAt: new Date().toISOString() };
        }
        return json(204, undefined);
      }
      if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
        const c = find(m[1]!);
        if (!c) return notFound('container');
        return json(200, {
          Id: c.Id,
          Name: `/${c.Name}`,
          Config: { Image: c.Image, Labels: c.Labels, Env: c.Env },
          State: c.State,
          RestartCount: c.RestartCount,
          HostConfig: c.HostConfig,
          NetworkSettings: { Networks: { [String(c.HostConfig.NetworkMode ?? 'bridge')]: { Aliases: null, IPAddress: c.IPAddress }, ...c.Networks } },
        });
      }
      if ((m = /^\/containers\/([^/]+)\/stats$/.exec(p))) {
        const c = find(m[1]!);
        if (!c) return notFound('container');
        // Half a CPU of 2 between the samples; 64 MiB used of which 4 MiB page cache
        return json(200, {
          cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 10_000_000_000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 1_500_000_000 }, system_cpu_usage: 8_000_000_000 },
          memory_stats: { usage: 64 * 1024 ** 2, limit: Number(c.HostConfig.Memory ?? 8 * 1024 ** 3), stats: { inactive_file: 4 * 1024 ** 2 } },
        });
      }
      if ((m = /^\/containers\/([^/]+)\/logs$/.exec(p))) {
        if (!find(m[1]!)) return notFound('container');
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
        return void res.end(mux(2, 'boom: app crashed\n'));
      }
      if ((m = /^\/containers\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const c = find(m[1]!);
        if (!c) return notFound('container');
        fake.containers.delete(c.Name);
        return json(204, undefined);
      }
      if ((m = /^\/containers\/([^/]+)\/exec$/.exec(p)) && req.method === 'POST') {
        const c = find(m[1]!);
        if (!c) return notFound('container');
        if (!c.State.Running) return json(409, { message: `Container ${c.Id} is not running` });
        const id = hexId();
        execs.set(id, { container: c.Name, cmd: (JSON.parse(body.toString()) as { Cmd: string[] }).Cmd });
        return json(201, { Id: id });
      }
      if ((m = /^\/exec\/([^/]+)\/start$/.exec(p))) {
        const call = execs.get(m[1]!);
        if (!call) return notFound('exec');
        fake.execs.push(call);
        const result = fake.exec(call);
        execResults.set(m[1]!, result.exitCode);
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
        return void res.end(Buffer.concat([mux(1, result.stdout ?? ''), mux(2, result.stderr ?? '')]));
      }
      if ((m = /^\/exec\/([^/]+)\/json$/.exec(p))) {
        if (!execResults.has(m[1]!)) return notFound('exec');
        return json(200, { ExitCode: execResults.get(m[1]!), Running: false });
      }
      if (p === '/images/json') {
        const wanted = labelFilter(q);
        return json(
          200,
          [...fake.images.entries()].filter(([, v]) => matches(v.Labels, wanted)).map(([ref, v]) => ({ Id: v.Id, RepoTags: [ref], Labels: v.Labels })),
        );
      }
      if (p === '/images/create' && req.method === 'POST') {
        const ref = `${q.get('fromImage')}@${q.get('tag')}`;
        fake.pulls.push(ref);
        fake.images.set(ref, { Id: `sha256:${hexId()}`, Labels: {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(`${JSON.stringify({ status: 'Pulling fs layer', id: 'abc' })}\n${JSON.stringify({ status: 'Downloaded newer image' })}\n`);
      }
      if ((m = /^\/images\/(.+)\/json$/.exec(p))) {
        const key = imageKey(m[1]!);
        return key ? json(200, { Id: fake.images.get(key)!.Id }) : notFound('image');
      }
      if ((m = /^\/images\/(.+)$/.exec(p)) && req.method === 'DELETE') {
        const key = imageKey(m[1]!);
        if (!key) return notFound('image');
        const id = fake.images.get(key)!.Id;
        if ([...fake.containers.values()].some((c) => c.Image === key || c.Image === id)) return json(409, { message: 'image is being used by a container' });
        fake.images.delete(key);
        return json(200, [{ Untagged: key }]);
      }
      if (p === '/build' && req.method === 'POST') {
        fake.builds.push({ query: q, bytes: body.length, tar: body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (fake.buildError) return void res.end(`${JSON.stringify({ stream: 'Step 1/2 : FROM busybox\n' })}\n${JSON.stringify({ error: fake.buildError, errorDetail: { message: fake.buildError } })}\n`);
        fake.images.set(q.get('t')!, { Id: `sha256:${hexId()}`, Labels: JSON.parse(q.get('labels') ?? '{}') as Record<string, string> });
        const extra = fake.buildOutput.map((stream) => `${JSON.stringify({ stream })}\n`).join('');
        return void res.end(`${JSON.stringify({ stream: 'Step 1/2 : FROM busybox\n' })}\n${extra}${JSON.stringify({ stream: ' ---> 1234\nSuccessfully built 1234\n' })}\n`);
      }
      if ((m = /^\/networks\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        return fake.networks.has(m[1]!) ? json(200, { Name: m[1] }) : notFound('network');
      }
      if (p === '/networks/create' && req.method === 'POST') {
        const spec = JSON.parse(body.toString()) as { Name: string; Internal?: boolean };
        if (fake.networks.has(spec.Name)) return json(409, { message: `network with name ${spec.Name} already exists` });
        fake.networks.add(spec.Name);
        if (spec.Internal) fake.internalNetworks.add(spec.Name);
        return json(201, { Id: hexId() });
      }
      if ((m = /^\/networks\/([^/]+)\/connect$/.exec(p)) && req.method === 'POST') {
        if (!fake.networks.has(m[1]!)) return notFound('network');
        const spec = JSON.parse(body.toString()) as { Container: string; EndpointConfig?: { Aliases?: string[] } };
        const c = find(spec.Container);
        if (!c) return notFound('container');
        if (c.Networks[m[1]!]) return json(403, { message: `endpoint with name ${c.Name} already exists in network ${m[1]}` });
        c.Networks[m[1]!] = { Aliases: spec.EndpointConfig?.Aliases ?? [] };
        return json(200, undefined);
      }
      if ((m = /^\/volumes\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        fake.volumesRemoved.push(m[1]!);
        return json(204, undefined);
      }
      return json(404, { message: `page not found: ${req.method} ${p}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
      server.closeAllConnections();
    });
  return fake;
}
