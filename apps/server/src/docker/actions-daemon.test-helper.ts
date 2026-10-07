import type http from 'node:http';
import type net from 'node:net';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import type { FakeContainer, FakeDaemonOptions } from './fake-daemon.test-helper.js';

/**
 * The Act and Exec endpoints (D2, D3) for the fake daemon
 * (fake-daemon.test-helper.ts): container lifecycle, removal, image pull and
 * removal, prune, image load (`docker save` archives built by
 * {@link imageArchive}, plain or gzipped), and exec — create, start detached
 * or hijacked, resize, inspect. The hijacked exec echoes what it is sent (as a TTY would) and
 * exits 0 on `exit` or ^D at an empty line; a dropped attach leaves it
 * running, as a real daemon does.
 */

export interface FakeExec {
  id: string;
  containerId: string;
  cmd: string[];
  tty: boolean;
  user: string | null;
  consoleSize: [number, number] | null;
  running: boolean;
  exitCode: number | null;
  resizes: Array<{ h: number; w: number }>;
  /** The hijacked stream, while attached. */
  socket: net.Socket | null;
}

export interface FakeEngine {
  /** Lifecycle calls as `start web`, `kill web SIGTERM`, `stop web t=5`. */
  actions: string[];
  execs: FakeExec[];
  /** Shells the containers have (default both). */
  shells: Set<string>;
  /** Image references pulled, as `fromImage:tag`. */
  pulls: string[];
  /** Pulls still streaming. */
  openPulls: () => number;
  prunes: string[];
  removedImages: string[];
  /** Set to make a pull fail after it started (an `error` line). */
  failPull: boolean;
  /** Set to make the next pull stream until the client leaves. */
  slowPull: boolean;
  /** `/images/load` calls: bytes received, whether the body arrived whole, what was loaded. */
  loads: Array<{ bytes: number; complete: boolean; loaded: string[] }>;
  /** Images loaded so far, on top of the fake daemon's two; a moved tag leaves the old one untagged. */
  images: FakeImage[];
  options: Pick<FakeDaemonOptions, 'routes' | 'upgrade'>;
}

export interface FakeImage {
  Id: string;
  RepoTags: string[];
  Architecture: string;
}

/** One tar entry: a 512-byte ustar header, then the content padded to 512. */
function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

/**
 * A `docker save`-shaped archive: a `manifest.json` naming the image's tags
 * and config, the config with its architecture, and `padding` bytes of layer.
 */
export function imageArchive(opts: { tags: string[]; architecture?: string; seed?: string; padding?: number }): Buffer {
  const config = Buffer.from(JSON.stringify({ architecture: opts.architecture ?? 'amd64', os: 'linux', seed: opts.seed ?? 'x' }));
  const digest = createHash('sha256').update(config).digest('hex');
  const manifest = Buffer.from(JSON.stringify([{ Config: `${digest}.json`, RepoTags: opts.tags, Layers: ['layer.tar'] }]));
  return Buffer.concat([
    tarEntry('manifest.json', manifest),
    tarEntry(`${digest}.json`, config),
    tarEntry('layer.tar', Buffer.alloc(opts.padding ?? 1024, 7)),
    Buffer.alloc(1024),
  ]);
}

/** The entries of a tar, by name. */
function readTar(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    out.set(name, data.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

export function fakeEngine(): FakeEngine {
  const pullStreams = new Set<http.ServerResponse>();
  const engine: FakeEngine = {
    actions: [],
    execs: [],
    shells: new Set(['/bin/bash', '/bin/sh']),
    pulls: [],
    openPulls: () => pullStreams.size,
    prunes: [],
    removedImages: [],
    failPull: false,
    slowPull: false,
    loads: [],
    images: [],
    options: {},
  };

  /** Answer and report the request as taken. */
  const json = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
    return true;
  };
  const empty = (res: http.ServerResponse, status: number) => {
    res.writeHead(status).end();
    return true;
  };
  const find = (containers: FakeContainer[], ref: string) =>
    containers.find((c) => c.Id === ref || c.Id.startsWith(ref) || c.Names.includes(`/${ref}`));
  const nameOf = (c: FakeContainer) => c.Names[0]!.slice(1);

  engine.options.routes = (req, res, route, containers) => {
    const url = new URL(req.url ?? '/', 'http://docker');
    const q = url.searchParams;
    let m: RegExpMatchArray | null;

    if (req.method === 'POST' && (m = route.match(/^\/containers\/([^/]+)\/(start|stop|restart|kill|pause|unpause)$/))) {
      const c = find(containers, decodeURIComponent(m[1]!));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      const action = m[2]!;
      engine.actions.push([action, nameOf(c), q.get('signal'), q.get('t') !== null ? `t=${q.get('t')}` : null].filter(Boolean).join(' '));
      if (action === 'start' && c.State === 'running') return empty(res, 304);
      if (action === 'stop' && c.State !== 'running') return empty(res, 304);
      if (action === 'pause' && c.State !== 'running') {
        return json(res, 409, { message: `Container ${c.Id} is not running` });
      }
      c.State = { start: 'running', restart: 'running', unpause: 'running', stop: 'exited', kill: 'exited', pause: 'paused' }[action]!;
      return empty(res, 204);
    }
    if (req.method === 'DELETE' && (m = route.match(/^\/containers\/([^/]+)$/))) {
      const c = find(containers, decodeURIComponent(m[1]!));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      if (c.State === 'running' && q.get('force') !== '1') {
        return json(res, 409, { message: 'You cannot remove a running container. Stop the container before attempting removal or force remove' });
      }
      engine.actions.push(`remove ${nameOf(c)}${q.get('v') === '1' ? ' volumes' : ''}`);
      containers.splice(containers.indexOf(c), 1);
      return empty(res, 204);
    }
    if (req.method === 'POST' && route === '/images/create') {
      const ref = `${q.get('fromImage')}:${q.get('tag')}`;
      engine.pulls.push(ref);
      if (q.get('fromImage') === 'private/missing') {
        return json(res, 404, { message: 'pull access denied for private/missing, repository does not exist' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const line = (v: object) => res.write(JSON.stringify(v) + '\r\n');
      line({ status: `Pulling from ${q.get('fromImage')}`, id: q.get('tag') });
      line({ status: 'Downloading', id: 'layer1', progressDetail: { current: 50, total: 100 }, progress: '[=====>     ]' });
      if (engine.failPull) {
        line({ errorDetail: { message: 'unexpected EOF' }, error: 'unexpected EOF' });
        res.end();
        return true;
      }
      if (engine.slowPull) {
        pullStreams.add(res);
        const timer = setInterval(() => line({ status: 'Downloading', id: 'layer2', progressDetail: { current: 1, total: 1000 } }), 20);
        res.on('close', () => {
          clearInterval(timer);
          pullStreams.delete(res);
        });
        return true;
      }
      line({ status: 'Pull complete', id: 'layer1' });
      // A partial last line, finished without a newline
      res.end(JSON.stringify({ status: `Status: Downloaded newer image for ${ref}` }));
      return true;
    }
    if (req.method === 'POST' && route === '/images/load') {
      const load = { bytes: 0, complete: false, loaded: [] as string[] };
      engine.loads.push(load);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        chunks.push(c);
        load.bytes += c.length;
      });
      // Like the engine: nothing is answered (or loaded) until the whole archive is in
      req.on('end', () => {
        load.complete = true;
        let data = Buffer.concat(chunks);
        if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
        const files = readTar(data);
        const manifest = files.get('manifest.json');
        if (!manifest) return json(res, 500, { message: 'open /var/lib/docker/tmp/docker-import-1/repositories: no such file or directory' });
        const [entry] = JSON.parse(manifest.toString()) as Array<{ Config: string; RepoTags: string[] | null }>;
        const config = JSON.parse(files.get(entry!.Config)?.toString() ?? '{}') as { architecture?: string };
        const id = `sha256:${entry!.Config.replace(/\.json$/, '')}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const line = (v: object) => res.write(JSON.stringify(v) + '\r\n');
        line({ status: 'Loading layer', progressDetail: { current: 512, total: 1024 }, progress: '[====>    ]', id: 'abcdef012345' });
        const tags = entry!.RepoTags ?? [];
        // A tag moved here leaves the image it pointed at untagged (dangling), as in Docker
        for (const other of engine.images) other.RepoTags = other.RepoTags.filter((t) => !tags.includes(t));
        const existing = engine.images.find((i) => i.Id === id);
        if (existing) existing.RepoTags = [...new Set([...existing.RepoTags, ...tags])];
        else engine.images.push({ Id: id, RepoTags: [...tags], Architecture: config.architecture ?? 'amd64' });
        for (const tag of tags) line({ stream: `Loaded image: ${tag}\n` });
        if (tags.length === 0) line({ stream: `Loaded image ID: ${id}\n` });
        load.loaded = tags.length ? tags : [id];
        res.end();
      });
      return true;
    }
    if (req.method === 'GET' && route === '/images/json') {
      return json(res, 200, [
        { Id: 'sha256:' + '1'.repeat(64), RepoTags: ['nginx:1.27'], RepoDigests: [], Created: 1_700_000_000, Size: 600, Containers: -1 },
        { Id: 'sha256:' + '9'.repeat(64), RepoTags: ['<none>:<none>'], RepoDigests: [], Created: 1_700_000_000, Size: 400, Containers: -1 },
        ...engine.images.map((i) => ({ Id: i.Id, RepoTags: i.RepoTags.length ? i.RepoTags : ['<none>:<none>'], RepoDigests: [], Created: 1_700_000_000, Size: 100, Containers: -1 })),
      ]);
    }
    if (req.method === 'GET' && (m = route.match(/^\/images\/(.+)\/json$/))) {
      const ref = decodeURIComponent(m[1]!);
      const image = engine.images.find((i) => i.Id === ref || i.RepoTags.includes(ref));
      if (!image) return false;
      return json(res, 200, { Id: image.Id, RepoTags: image.RepoTags, Os: 'linux', Architecture: image.Architecture, Size: 100, Config: { Env: [] } });
    }
    if (req.method === 'DELETE' && (m = decodeURIComponent(route).match(/^\/images\/(sha256:[a-f0-9]{64})$/))) {
      const image = engine.images.find((i) => i.Id === m![1]);
      if (image) {
        engine.removedImages.push(`${image.Id}${q.get('force') === '1' ? ' force' : ''}`);
        engine.images.splice(engine.images.indexOf(image), 1);
        return json(res, 200, [{ Deleted: image.Id }]);
      }
    }
    if (req.method === 'DELETE' && (m = route.match(/^\/images\/(.+)$/))) {
      const ref = decodeURIComponent(m[1]!);
      if (ref === 'busy:1') return json(res, 409, { message: 'conflict: unable to remove repository reference "busy:1" (must force)' });
      engine.removedImages.push(`${ref}${q.get('force') === '1' ? ' force' : ''}`);
      return json(res, 200, [{ Untagged: ref }, { Deleted: 'sha256:' + '9'.repeat(64) }]);
    }
    if (req.method === 'POST' && (m = route.match(/^\/(containers|images|volumes|networks)\/prune$/))) {
      const kind = m[1]!;
      engine.prunes.push(`${kind}${q.get('filters') ? ` ${q.get('filters')}` : ''}`);
      const body: Record<string, Record<string, unknown>> = {
        containers: { ContainersDeleted: ['c1', 'c2'], SpaceReclaimed: 20 },
        images: { ImagesDeleted: [{ Deleted: 'sha256:9' }], SpaceReclaimed: 400 },
        volumes: { VolumesDeleted: ['v1'], SpaceReclaimed: 50 },
        networks: { NetworksDeleted: ['n1'] },
      };
      return json(res, 200, body[kind]);
    }
    if (req.method === 'POST' && (m = route.match(/^\/containers\/([^/]+)\/exec$/))) {
      const c = find(containers, decodeURIComponent(m[1]!));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      if (c.State !== 'running') return json(res, 409, { message: `Container ${c.Id} is not running` });
      void readJson(req).then((body) => {
        const exec: FakeExec = {
          id: `e${engine.execs.length + 1}`.padEnd(64, '0'),
          containerId: c.Id,
          cmd: (body.Cmd as string[]) ?? [],
          tty: body.Tty === true,
          user: typeof body.User === 'string' ? body.User : null,
          consoleSize: (body.ConsoleSize as [number, number]) ?? null,
          running: false,
          exitCode: null,
          resizes: [],
          socket: null,
        };
        engine.execs.push(exec);
        json(res, 201, { Id: exec.id });
      });
      return true;
    }
    if ((m = route.match(/^\/exec\/([^/]+)\/(start|resize|json)$/))) {
      const exec = engine.execs.find((e) => e.id === m![1]);
      if (!exec) return json(res, 404, { message: 'No such exec instance' });
      if (m[2] === 'json') return json(res, 200, { ID: exec.id, Running: exec.running, ExitCode: exec.exitCode });
      if (m[2] === 'resize') {
        if (!exec.running) return json(res, 409, { message: 'exec is not running' });
        exec.resizes.push({ h: Number(q.get('h')), w: Number(q.get('w')) });
        return empty(res, 201);
      }
      // Started detached: the shell check
      void readJson(req).then(() => {
        const [shell, flag, script] = exec.cmd;
        exec.exitCode = flag === '-c' && script === 'exit 0' ? (engine.shells.has(shell!) ? 0 : 126) : 0;
        res.writeHead(200).end();
      });
      return true;
    }
    return false;
  };

  engine.options.upgrade = (req, socket, head, route) => {
    const m = route.match(/^\/exec\/([^/]+)\/start$/);
    if (!m) return false;
    const exec = engine.execs.find((e) => e.id === m[1]);
    if (!exec) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 35\r\n\r\n{"message":"No such exec instance"}');
      return true;
    }
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    exec.running = true;
    exec.socket = socket;
    const prompt = () => socket.write(exec.tty ? `${exec.cmd.join(' ')}$ ` : frame(1, `${exec.cmd.join(' ')}$ `));
    prompt();
    let line = '';
    // The start request's JSON body arrives on the upgraded socket first
    let body = Number(req.headers['content-length'] ?? 0);
    const onInput = (raw: Buffer) => {
      const d = raw.subarray(Math.min(body, raw.length));
      body -= raw.length - d.length;
      for (const ch of d.toString()) {
        if (ch === '\x03') {
          line = '';
          continue;
        }
        // ^D at an empty prompt: the shell exits
        if (ch === '\x04' && line === '') {
          exec.running = false;
          exec.exitCode = 0;
          socket.end();
          return;
        }
        if (ch === '\r' || ch === '\n') {
          const cmd = line;
          line = '';
          if (cmd === 'exit') {
            exec.running = false;
            exec.exitCode = 0;
            socket.end();
            return;
          }
          socket.write(exec.tty ? `\r\nran: ${cmd}\r\n` : Buffer.concat([frame(1, `ran: ${cmd}\n`), frame(2, `warn: ${cmd}\n`)]));
          prompt();
        } else {
          line += ch;
          if (exec.tty) socket.write(ch);
        }
      }
    };
    if (head.length) onInput(head);
    socket.on('data', onInput);
    // The client hung up (the server side is half-open until it ends too)
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    // The attach went away: like a real daemon, the process keeps running
    socket.on('close', () => {
      exec.socket = null;
    });
    return true;
  };

  return engine;
}

/** One multiplexed frame (1 = stdout, 2 = stderr). */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
