import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { BastionError } from './names.js';

/**
 * A small Docker Engine API client over the mounted socket (deployments spec
 * §2.2): no Docker CLI and no library inside the bastionctl container. Paths
 * are unversioned, so the daemon answers in its own current API version.
 */

export const DEFAULT_SOCKET = '/var/run/docker.sock';
const DEFAULT_TIMEOUT_MS = 60_000;
/** Most of a JSON answer read into memory. */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

export class DockerApiError extends BastionError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** A raw request body (a build context). */
  stream?: Readable;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `{label: ['a=b']}` → the `filters` query value. */
export function filters(spec: Record<string, string[]>): string {
  return JSON.stringify(spec);
}

function queryString(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Split Docker's multiplexed stream (8-byte frame headers: stream type, three
 * zero bytes, big-endian length) into stdout and stderr.
 */
export function demux(data: Buffer): { stdout: Buffer; stderr: Buffer } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= data.length) {
    const type = data[i]!;
    const size = data.readUInt32BE(i + 4);
    const frame = data.subarray(i + 8, i + 8 + size);
    (type === 2 ? err : out).push(frame);
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

export class DockerApi {
  constructor(readonly socketPath: string = DEFAULT_SOCKET) {}

  /** The raw response; the caller reads (or destroys) it. Times out waiting for headers only. */
  stream(method: string, path: string, opts: RequestOptions = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...opts.headers };
      let payload: Buffer | undefined;
      if (opts.body !== undefined) {
        payload = Buffer.from(JSON.stringify(opts.body));
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      const req = http.request({ socketPath: this.socketPath, method, path: path + queryString(opts.query), headers });
      const timer = setTimeout(() => req.destroy(new DockerApiError(`Docker did not answer ${method} ${path} in time`, 504)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      req.on('response', (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES') {
          reject(new DockerApiError(`Cannot reach Docker at ${this.socketPath} (${code})`, 502));
        } else reject(err);
      });
      if (opts.stream) opts.stream.on('error', (err) => req.destroy(err)).pipe(req);
      else req.end(payload);
    });
  }

  /** A whole response body; non-2xx answers throw with Docker's message. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<{ status: number; body: Buffer }> {
    const res = await this.stream(method, path, opts);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        res.destroy();
        throw new DockerApiError(`Docker's answer to ${path} is too large`, 502);
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      let message = body.toString('utf8').trim();
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {
        // plain text
      }
      throw new DockerApiError(message || `Docker answered ${status} to ${method} ${path}`, status);
    }
    return { status, body };
  }

  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { body } = await this.request(method, path, opts);
    return (body.length > 0 ? JSON.parse(body.toString('utf8')) : null) as T;
  }

  /** null on 404. */
  async inspect<T>(path: string): Promise<T | null> {
    try {
      return await this.json<T>('GET', path);
    } catch (err) {
      if (err instanceof DockerApiError && err.status === 404) return null;
      throw err;
    }
  }

  ping(): Promise<{ status: number; body: Buffer }> {
    return this.request('GET', '/_ping', { timeoutMs: 10_000 });
  }

  inspectContainer(name: string) {
    return this.inspect<ContainerInspect>(`/containers/${encodeURIComponent(name)}/json`);
  }

  listContainers(labels: string[], all = true): Promise<ContainerSummary[]> {
    return this.json<ContainerSummary[]>('GET', '/containers/json', { query: { all, filters: filters({ label: labels }) } });
  }

  async createContainer(name: string, spec: Record<string, unknown>): Promise<string> {
    const res = await this.json<{ Id: string }>('POST', '/containers/create', { query: { name }, body: spec });
    return res.Id;
  }

  /** Start; already running is fine. */
  async start(name: string): Promise<void> {
    await this.request('POST', `/containers/${encodeURIComponent(name)}/start`);
  }

  /** Stop; already stopped (304) or gone (404) is fine. */
  async stop(name: string, timeoutS = 10): Promise<void> {
    try {
      await this.request('POST', `/containers/${encodeURIComponent(name)}/stop`, { query: { t: timeoutS }, timeoutMs: (timeoutS + 30) * 1000 });
    } catch (err) {
      if (err instanceof DockerApiError && err.status === 404) return;
      throw err;
    }
  }

  async restart(name: string, timeoutS = 10): Promise<void> {
    await this.request('POST', `/containers/${encodeURIComponent(name)}/restart`, { query: { t: timeoutS }, timeoutMs: (timeoutS + 30) * 1000 });
  }

  /** Force-remove; gone already is fine. */
  async remove(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/containers/${encodeURIComponent(name)}`, { query: { force: true } });
    } catch (err) {
      if (err instanceof DockerApiError && err.status === 404) return;
      throw err;
    }
  }

  /**
   * Run `cmd` in a running container and wait for it (`docker exec`). Output
   * is demultiplexed; the exit code comes from inspecting the exec.
   */
  async exec(container: string, cmd: string[], timeoutMs = 30_000): Promise<ExecResult> {
    const { Id } = await this.json<{ Id: string }>('POST', `/containers/${encodeURIComponent(container)}/exec`, {
      body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false },
    });
    const res = await this.stream('POST', `/exec/${Id}/start`, { body: { Detach: false, Tty: false }, timeoutMs });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        res.destroy();
        reject(new DockerApiError(`${cmd[0]} in ${container} did not finish in time`, 504));
      }, timeoutMs);
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if ((res.statusCode ?? 0) >= 400) {
      throw new DockerApiError(Buffer.concat(chunks).toString('utf8').trim() || `exec failed (${res.statusCode})`, res.statusCode ?? 500);
    }
    const { stdout, stderr } = demux(Buffer.concat(chunks));
    const info = await this.json<{ ExitCode: number | null; Running: boolean }>('GET', `/exec/${Id}/json`);
    return { exitCode: info.ExitCode ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  }

  async imageExists(ref: string): Promise<boolean> {
    return (await this.inspect(`/images/${encodeURIComponent(ref)}/json`)) !== null;
  }

  /** Remove an image; gone already is fine. In use (409) is reported. */
  async removeImage(ref: string): Promise<void> {
    try {
      await this.request('DELETE', `/images/${encodeURIComponent(ref)}`, { query: { force: false, noprune: false } });
    } catch (err) {
      if (err instanceof DockerApiError && err.status === 404) return;
      throw err;
    }
  }

  listImages(labels: string[]): Promise<Array<{ Id: string; RepoTags: string[] | null; Labels: Record<string, string> | null }>> {
    return this.json('GET', '/images/json', { query: { filters: filters({ label: labels }) } });
  }

  /** Pull `repo@digest` (or `repo:tag`), reporting progress lines. */
  async pull(ref: string, onLine: (line: string) => void): Promise<void> {
    const at = ref.indexOf('@');
    const [fromImage, tag] = at > 0 ? [ref.slice(0, at).replace(/:[^/]*$/, ''), ref.slice(at + 1)] : splitTag(ref);
    const res = await this.stream('POST', '/images/create', { query: { fromImage, tag }, timeoutMs: 120_000 });
    await readJsonLines(res, (msg) => {
      if (typeof msg.error === 'string') throw new DockerApiError(msg.error, 502);
      if (typeof msg.status === 'string' && !msg.progressDetail?.current) onLine(msg.id ? `${msg.id}: ${msg.status}` : msg.status);
    });
  }

  /**
   * Build an image from a tar context. Build output lines go to `onLine`;
   * a build error throws with Docker's message.
   */
  async build(context: Readable, query: Query, onLine: (line: string) => void): Promise<void> {
    const res = await this.stream('POST', '/build', {
      query,
      stream: context,
      headers: { 'Content-Type': 'application/x-tar' },
      timeoutMs: 10 * 60_000,
    });
    if ((res.statusCode ?? 0) >= 400) {
      const chunks: Buffer[] = [];
      for await (const c of res as AsyncIterable<Buffer>) chunks.push(c);
      let message = Buffer.concat(chunks).toString('utf8');
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {
        // plain text
      }
      throw new DockerApiError(`Build failed: ${message.trim()}`, res.statusCode ?? 500);
    }
    let pending = '';
    await readJsonLines(res, (msg) => {
      if (typeof msg.error === 'string') throw new DockerApiError(`Build failed: ${msg.error.trim()}`, 422);
      if (typeof msg.stream === 'string') {
        pending += msg.stream;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      } else if (typeof msg.status === 'string') onLine(msg.status);
    });
    if (pending) onLine(pending);
  }

  inspectNetwork(name: string) {
    return this.inspect<NetworkInspect>(`/networks/${encodeURIComponent(name)}`);
  }

  async ensureNetwork(name: string, labels: Record<string, string>, opts: { internal?: boolean } = {}): Promise<boolean> {
    const existing = await this.inspect(`/networks/${encodeURIComponent(name)}`);
    if (existing) return false;
    try {
      await this.json('POST', '/networks/create', { body: { Name: name, Driver: 'bridge', CheckDuplicate: true, Internal: !!opts.internal, Labels: labels } });
    } catch (err) {
      // Created by someone else since the inspect (another setup, by hand): it exists, which is all we need
      if (err instanceof DockerApiError && err.status === 409) return false;
      throw err;
    }
    return true;
  }

  /** Attach a container (running or not) to a network under `aliases`. */
  async connectNetwork(network: string, container: string, aliases: string[] = []): Promise<void> {
    await this.request('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: container, EndpointConfig: { Aliases: aliases } },
    });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/volumes/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof DockerApiError && err.status === 404) return;
      throw err;
    }
  }

  async logsTail(name: string, tail = 30): Promise<string> {
    try {
      const { body } = await this.request('GET', `/containers/${encodeURIComponent(name)}/logs`, { query: { stdout: true, stderr: true, tail } });
      const { stdout, stderr } = demux(body);
      return (stdout.toString('utf8') + stderr.toString('utf8')).trim();
    } catch {
      return '';
    }
  }
}

function splitTag(ref: string): [string, string | undefined] {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, 'latest'];
}

interface JsonMessage {
  stream?: string;
  status?: string;
  id?: string;
  error?: string;
  progressDetail?: { current?: number };
  aux?: unknown;
}

/** Docker's newline-delimited JSON progress (pull, build). */
async function readJsonLines(res: IncomingMessage, handle: (msg: JsonMessage) => void): Promise<void> {
  let buffer = '';
  const feed = (text: string) => {
    if (!text.trim()) return;
    let msg: JsonMessage;
    try {
      msg = JSON.parse(text) as JsonMessage;
    } catch {
      return;
    }
    handle(msg);
  };
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        feed(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    feed(buffer);
  } catch (err) {
    res.destroy();
    throw err;
  }
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string> | null;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Status: string; Running: boolean; Restarting?: boolean; StartedAt?: string; ExitCode?: number; Health?: { Status: string } };
  RestartCount?: number;
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null; IPAddress?: string } | null> | null };
}

export interface NetworkInspect {
  Name: string;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null } | null;
}
