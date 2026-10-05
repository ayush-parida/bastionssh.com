import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/**
 * The proxy front (deployments spec §5 step 6): PID 1 of the `bastion-caddy`
 * container, and the only process that owns its public sockets. It runs
 * Caddy as a child on loopback ports and hands every connection to it with a
 * PROXY protocol header (so Caddy still sees the client's address).
 *
 * A config change starts a new Caddy with the new Caddyfile next to the
 * running one, waits until it listens and serves a certificate for every
 * name the running one does, then sends new connections to it; the old Caddy
 * keeps the connections it has until they close (or the drain time passes)
 * and only then stops gracefully. Caddy's own reload cannot do that: it binds
 * a new socket (connections queued on the old one are reset) and Go's server
 * shutdown closes a connection whose request it reads after shutdown began —
 * both lose requests on a busy site. Here no request is ever read by a Caddy
 * that is shutting down, except on a kept-alive connection the old one closes
 * when the drain time ends (which clients retry, as for any idle timeout).
 *
 * `reload` on the command line asks the running front over its control
 * socket and prints its progress; it fails, leaving the old config serving,
 * when the new Caddy does not start or misses a certificate.
 */

export type ListenKind = 'http' | 'https';

export interface FrontOptions {
  /** The Caddyfile each new Caddy starts from. */
  config: string;
  listen: Array<{ port: number; kind: ListenKind }>;
  /** Address the public listeners bind (default: every address). */
  host?: string;
  /** Unix socket `reload` talks to. */
  control: string;
  /** The Caddy program and its arguments for a config file. */
  caddy: string;
  caddyArgs?: (config: string) => string[];
  /** Loopback ports of Caddy slot `slot`; it gets them as BASTION_HTTP_PORT, BASTION_HTTPS_PORT and BASTION_ADMIN_PORT. */
  slotPorts?: (slot: number) => SlotPorts;
  /** How long an old Caddy keeps its open connections after a switch. */
  drainMs?: number;
  /** How long a new Caddy may take to listen and to serve the running one's certificates. */
  readyMs?: number;
  log?: (line: string) => void;
  /** The serving Caddy exited by itself (the container should restart). */
  onFatal?: (message: string) => void;
}

export interface SlotPorts {
  http: number;
  https: number;
  admin: number;
}

interface Instance {
  generation: number;
  slot: number;
  ports: SlotPorts;
  child: ChildProcess;
  conns: number;
  tail: string[];
  exited: boolean;
  /** Exit code or signal, once exited. */
  exitStatus: string;
  exit: Promise<void>;
  stopping: boolean;
}

/** Where the front's control socket is in the proxy container. */
export const FRONT_CONTROL = '/run/bastion-proxy.sock';
const SLOTS = 4;
export const defaultSlotPorts = (slot: number): SlotPorts => ({ http: 18000 + slot * 10, https: 18001 + slot * 10, admin: 2019 + slot });

/** Why a Caddy did not start: its error log lines' messages (Caddy logs JSON), else its last lines. */
function failureReason(tail: string[]): string {
  const errors = tail.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { level?: string; msg?: string; error?: string };
      return entry.level === 'error' || entry.level === 'fatal' ? [[entry.msg, entry.error].filter(Boolean).join(': ')] : [];
    } catch {
      return [];
    }
  });
  return (errors.length > 0 ? errors : tail.filter((l) => l.trim())).slice(-6).join('\n');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A PROXY protocol v1 header for a connection accepted on `socket`. */
export function proxyHeader(socket: Pick<net.Socket, 'remoteAddress' | 'remotePort' | 'localAddress' | 'localPort'>): string {
  const plain = (a: string | undefined) => (a ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const src = plain(socket.remoteAddress);
  const dst = plain(socket.localAddress);
  const family = net.isIPv4(src) && net.isIPv4(dst) ? 'TCP4' : net.isIPv6(src) && net.isIPv6(dst) ? 'TCP6' : null;
  if (!family || !socket.remotePort || !socket.localPort) return 'PROXY UNKNOWN\r\n';
  return `PROXY ${family} ${src} ${dst} ${socket.remotePort} ${socket.localPort}\r\n`;
}

function connectOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** Whether a Caddy on `port` completes a TLS handshake for `name` (any certificate: it is the one it would serve). */
function handshake(port: number, name: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      raw.destroy();
      resolve(ok);
    };
    const raw = net.connect({ host: '127.0.0.1', port }, () => {
      raw.write(`PROXY TCP4 127.0.0.1 127.0.0.1 1 ${port}\r\n`);
      const t = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => done(true));
      t.once('error', () => done(false));
    });
    raw.once('error', () => done(false));
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

export interface Front {
  /**
   * Start a new Caddy from the config file and switch to it; rejects (old one
   * serving) when it fails. With `sha256`, only that exact text is started.
   */
  reload(probe: string[], progress?: (line: string) => void, sha256?: string): Promise<void>;
  /** Open connections per running Caddy generation. */
  generations(): Array<{ generation: number; conns: number; serving: boolean }>;
  stop(): Promise<void>;
}

export async function startFront(opts: FrontOptions): Promise<Front> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`bastion-proxy: ${line}\n`));
  const slotPorts = opts.slotPorts ?? defaultSlotPorts;
  const drainMs = opts.drainMs ?? 10_000;
  const readyMs = opts.readyMs ?? 30_000;
  const caddyArgs = opts.caddyArgs ?? ((config: string) => ['run', '--config', config, '--adapter', 'caddyfile']);
  const instances = new Set<Instance>();
  let current: Instance | null = null;
  let generation = 0;
  let stopping = false;

  async function stopInstance(inst: Instance, waitMs: number): Promise<void> {
    if (inst.exited) return;
    inst.stopping = true;
    const until = Date.now() + waitMs;
    while (inst.conns > 0 && Date.now() < until && !inst.exited) await sleep(100);
    if (inst.exited) return;
    inst.child.kill('SIGTERM');
    // Caddy finishes requests in flight (its grace period), then exits
    const killed = setTimeout(() => inst.child.kill('SIGKILL'), 30_000);
    await inst.exit;
    clearTimeout(killed);
  }

  /**
   * The config, copied where only this container writes: Caddy runs exactly
   * the text read (and checked against `sha256`, the text bastionctl
   * validated), however the mounted file changes later. A mount that shows
   * a renamed file late (Docker Desktop's file sharing) is read again until
   * it has that text.
   */
  async function snapshot(generationNo: number, sha256?: string): Promise<string> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      let text: Buffer | null = null;
      try {
        text = fs.readFileSync(opts.config);
      } catch {
        // missing for now
      }
      if (text && (!sha256 || createHash('sha256').update(text).digest('hex') === sha256)) {
        const file = path.join(os.tmpdir(), `bastion-caddy-${process.pid}-${generationNo}.Caddyfile`);
        fs.writeFileSync(file, text, { mode: 0o600 });
        return file;
      }
      if (Date.now() > deadline) throw new Error(text ? 'The config file is not the one bastionctl wrote (changed meanwhile)' : `No config file at ${opts.config}`);
      await sleep(100);
    }
  }

  async function launch(sha256?: string): Promise<Instance> {
    const used = new Set([...instances].map((i) => i.slot));
    let slot = [...Array(SLOTS).keys()].find((s) => !used.has(s));
    if (slot === undefined) {
      // Switches faster than old ones drain: the oldest draining Caddy goes now
      const oldest = [...instances].filter((i) => i !== current).sort((a, b) => a.generation - b.generation)[0]!;
      log(`stopping generation ${oldest.generation} early to free its ports`);
      await stopInstance(oldest, 0);
      slot = oldest.slot;
    }
    const ports = slotPorts(slot);
    const config = await snapshot(generation + 1, sha256);
    const child = spawn(opts.caddy, caddyArgs(config), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BASTION_HTTP_PORT: String(ports.http), BASTION_HTTPS_PORT: String(ports.https), BASTION_ADMIN_PORT: String(ports.admin) },
    });
    const inst: Instance = { generation: ++generation, slot, ports, child, conns: 0, tail: [], exited: false, exitStatus: '', exit: Promise.resolve(), stopping: false };
    inst.exit = new Promise<void>((resolve) => {
      // 'close', not 'exit': its last stderr lines (why it failed) are read by then
      child.once('close', (code, signal) => {
        fs.rmSync(config, { force: true });
        inst.exitStatus = signal ?? `exit code ${code}`;
        inst.exited = true;
        instances.delete(inst);
        if (inst === current && !stopping) opts.onFatal?.(`Caddy (generation ${inst.generation}) exited (${signal ?? code}):\n${inst.tail.join('\n')}`);
        resolve();
      });
      child.once('error', (err) => {
        inst.tail.push(err.message);
        inst.exited = true;
        instances.delete(inst);
        resolve();
      });
    });
    // Both go to the container's log (Caddy's JSON log is read from there); the last lines are kept for errors
    for (const [stream, out] of [
      [child.stdout!, process.stdout],
      [child.stderr!, process.stderr],
    ] as const) {
      stream.on('data', (chunk: Buffer) => {
        out.write(chunk);
        inst.tail.push(...chunk.toString('utf8').trimEnd().split('\n'));
        if (inst.tail.length > 40) inst.tail.splice(0, inst.tail.length - 40);
      });
    }
    instances.add(inst);

    const deadline = Date.now() + readyMs;
    for (const { kind } of opts.listen) {
      while (!(await connectOnce(ports[kind]))) {
        if (inst.exited || Date.now() > deadline) {
          await stopInstance(inst, 0);
          const reason = failureReason(inst.tail);
          throw new Error(inst.exited ? `Caddy did not start with the new config (${inst.exitStatus}):\n${reason}` : `Caddy did not listen on its ${kind} port in time`);
        }
        await sleep(50);
      }
    }
    return inst;
  }

  // Connections: always to the serving generation, with the client's address in a PROXY header
  function accept(kind: ListenKind, client: net.Socket) {
    const inst = current;
    if (!inst || inst.exited) {
      client.destroy();
      return;
    }
    inst.conns++;
    let counted = true;
    const release = () => {
      if (counted) {
        counted = false;
        inst.conns--;
      }
    };
    const upstream = net.connect({ host: '127.0.0.1', port: inst.ports[kind], allowHalfOpen: true });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    upstream.write(proxyHeader(client));
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      upstream.destroy();
      release();
    });
    upstream.on('close', (hadError) => {
      if (hadError) client.destroy();
      release();
    });
  }

  current = await launch();
  log(`generation ${current.generation} serves`);
  const servers = await Promise.all(
    opts.listen.map(
      ({ port, kind }) =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: false }, (c) => accept(kind, c));
          server.once('error', reject);
          server.listen({ port, host: opts.host, backlog: 1024 }, () => resolve(server));
        }),
    ),
  );

  let queue: Promise<unknown> = Promise.resolve();
  const front: Front = {
    reload(probe, progress = () => {}, sha256) {
      const run = async () => {
        if (stopping) throw new Error('The proxy is stopping');
        const next = await launch(sha256);
        progress(`Started Caddy generation ${next.generation}`);
        const running = current;
        if (running && opts.listen.some((l) => l.kind === 'https')) {
          const deadline = Date.now() + readyMs;
          for (const name of probe) {
            // Only names the running Caddy has a certificate for: a new domain's certificate is still to be issued
            if (!(await handshake(running.ports.https, name, 3000))) continue;
            while (!(await handshake(next.ports.https, name, 3000))) {
              if (next.exited || Date.now() > deadline) {
                await stopInstance(next, 0);
                throw new Error(`The new config serves no certificate for ${name}; the old one keeps serving`);
              }
              await sleep(200);
            }
          }
        }
        current = next;
        log(`generation ${next.generation} serves`);
        if (running) {
          progress(`Caddy generation ${next.generation} serves; generation ${running.generation} finishes its open connections`);
          void stopInstance(running, drainMs).then(() => log(`generation ${running.generation} stopped`));
        }
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
    generations: () => [...instances].map((i) => ({ generation: i.generation, conns: i.conns, serving: i === current })),
    async stop() {
      stopping = true;
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      await Promise.all([...instances].map((i) => stopInstance(i, 0)));
    },
  };
  return front;
}

/** Serve `reload` requests on the control socket: one JSON line in, progress lines and a result line out. */
export function serveControl(front: Front, socketPath: string): net.Server {
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1 || buffer.length > 64 * 1024) return;
      let request: { probe?: unknown; sha256?: unknown };
      try {
        request = JSON.parse(buffer.slice(0, nl)) as { probe?: unknown; sha256?: unknown };
      } catch {
        conn.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n');
        return;
      }
      buffer = '';
      const probe = Array.isArray(request.probe) ? request.probe.filter((p): p is string => typeof p === 'string' && /^[a-z0-9.-]{1,253}$/.test(p)) : [];
      const sha256 = typeof request.sha256 === 'string' && /^[0-9a-f]{64}$/.test(request.sha256) ? request.sha256 : undefined;
      front.reload(probe, (line) => conn.write(JSON.stringify({ log: line }) + '\n'), sha256).then(
        () => conn.end(JSON.stringify({ ok: true }) + '\n'),
        (err: Error) => conn.end(JSON.stringify({ ok: false, error: err.message }) + '\n'),
      );
    });
    conn.on('error', () => {});
  });
  server.listen(socketPath);
  return server;
}

/** `reload [--sha256 <hex>] [names…]`: ask the front to switch to the config file; 0 on success. */
export function requestReload(
  socketPath: string,
  probe: string[],
  out: { log: (line: string) => void; error: (line: string) => void },
  sha256?: string,
): Promise<number> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath, () => conn.write(JSON.stringify({ probe, sha256 }) + '\n'));
    let buffer = '';
    let result: { ok?: boolean; error?: string } | null = null;
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { log?: string; ok?: boolean; error?: string };
          if (typeof msg.log === 'string') out.log(msg.log);
          else result = msg;
        } catch {
          // not ours
        }
      }
    });
    let failure: string | null = null;
    conn.on('error', (err) => {
      failure = `The proxy front is not running (${(err as NodeJS.ErrnoException).code ?? err.message})`;
    });
    conn.on('close', () => {
      if (result?.ok) return resolve(0);
      out.error(result ? (result.error ?? 'The reload failed') : (failure ?? 'The proxy front closed the connection without an answer'));
      resolve(1);
    });
  });
}
