import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { KUBE_RESOURCES, type KubeResource } from '@smt/shared';
import { KubeError, fromApiStatus, fromTransportError } from './errors.js';
import { resourcePath } from './validation.js';

/**
 * A small typed Kubernetes API client over Node's `http.request` (spec
 * §2.3) — no kubectl, no @kubernetes/client-node. Like the Docker client,
 * the agent's `createConnection` hands each HTTP connection a fresh, already
 * verified TLS socket from `openSocket` (kube/transport.ts), so nothing here
 * knows about routes, tunnels or certificates; it only speaks HTTP/1.1.
 *
 * Calls:
 * - `json` / `text` — bounded by a timeout, body size capped; non-2xx
 *   statuses become a {@link KubeError} carrying the API server's message;
 * - `list` — follows `continue` tokens up to a cap and returns the
 *   collection's `resourceVersion` (the cache watches from it);
 * - `watch` — a streaming `?watch=1` call, one parsed event per line;
 * - `patch` / `delete` / `create` — for the guided actions (K3);
 * - `logs` / `exec` — K4 (the interface is fixed here; they are not wired yet).
 *
 * Paths are built from the resource allowlist and validated names
 * (validation.ts); a credential is sent as `Authorization: Bearer` (a client
 * certificate is presented in the TLS handshake instead). With impersonation
 * on, every request names the BastionSSH user and role, so Kubernetes RBAC
 * and audit logs see the real person.
 */

export const REQUEST_TIMEOUT_MS = 20_000;
export const STREAM_HEADERS_TIMEOUT_MS = 30_000;
/** Largest JSON body read into memory (a big cluster's pod list fits comfortably). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Items per page when listing, and the most pages followed. */
export const LIST_PAGE_SIZE = 500;
const MAX_LIST_PAGES = 40;
/** A single watch event line larger than this is dropped (and the watch restarts). */
const MAX_WATCH_LINE = 8 * 1024 * 1024;

export type Json = Record<string, unknown>;
export type QueryValue = string | number | boolean | undefined | null;

/** A Kubernetes object, loosely typed: the views read the fields they need defensively. */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; uid?: string; controller?: boolean; apiVersion?: string }[];
    generation?: number;
    [key: string]: unknown;
  };
  spec?: Json;
  status?: Json;
  [key: string]: unknown;
}

export interface KubeList<T = KubeObject> {
  items: T[];
  resourceVersion: string;
}

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export interface WatchEvent<T = KubeObject> {
  type: WatchEventType;
  object: T;
}

export interface KubeIdentity {
  /** `Impersonate-User`, e.g. `bastion:ana@example.com`. */
  user: string;
  /** `Impersonate-Group` values, e.g. `bastion:operator`. */
  groups: string[];
}

export interface KubeClientOptions {
  /** Host header: the API URL's host (and port). */
  host: string;
  /** A path prefix in front of every API path (Rancher and other proxies); '' for none. */
  basePath?: string;
  /** A bearer token; null when a client certificate authenticates. */
  token?: string | null;
  /** Impersonated identity, when the cluster has impersonation on. */
  impersonate?: KubeIdentity | null;
}

export interface KubeRequest {
  method?: string;
  path: string;
  query?: Record<string, QueryValue>;
  /** Sent as JSON (or `contentType`). */
  body?: unknown;
  contentType?: string;
  /** For JSON calls the whole exchange; for streams, until headers. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ListOptions {
  namespace?: string | null;
  labelSelector?: string;
  fieldSelector?: string;
  signal?: AbortSignal;
}

export interface WatchOptions extends ListOptions {
  resourceVersion: string;
  /** The API server ends the watch after this long (the cache then resumes). */
  timeoutSeconds?: number;
}

/** K4: pod logs. */
export interface LogOptions {
  container?: string;
  previous?: boolean;
  follow?: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps?: boolean;
  signal?: AbortSignal;
}

/** K4: a shell in a container over the exec subresource (WebSocket, `v5.channel.k8s.io` then `v4`). */
export interface ExecOptions {
  container: string;
  command: string[];
  tty: boolean;
  signal?: AbortSignal;
}

export interface ExecSession {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  resize(cols: number, rows: number): void;
  close(): void;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
}

export type PatchType = 'merge' | 'strategic' | 'json';

const PATCH_CONTENT_TYPE: Record<PatchType, string> = {
  merge: 'application/merge-patch+json',
  strategic: 'application/strategic-merge-patch+json',
  json: 'application/json-patch+json',
};

function readBody(res: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new KubeError('The Kubernetes API sent more data than expected', 502));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
    res.on('aborted', () => reject(new KubeError('The Kubernetes API closed the connection mid-response', 502)));
  });
}

/** Agent that opens a fresh, verified API connection for every request. */
class ApiAgent extends http.Agent {
  constructor(private readonly open: () => Promise<Duplex>) {
    super({ keepAlive: false });
  }

  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.open().then(
      (stream) => callback?.(null, stream),
      (err: unknown) => callback?.(fromTransportError(err), undefined as unknown as Duplex),
    );
    return undefined;
  }
}

export function queryString(query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export class KubeClient {
  private readonly agent: ApiAgent;

  constructor(
    openSocket: () => Promise<Duplex>,
    private readonly opts: KubeClientOptions,
  ) {
    this.agent = new ApiAgent(openSocket);
  }

  private headers(extra: Record<string, string> = {}): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {
      Host: this.opts.host,
      Accept: 'application/json',
      'User-Agent': 'BastionSSH',
      ...extra,
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (this.opts.impersonate) {
      headers['Impersonate-User'] = this.opts.impersonate.user;
      if (this.opts.impersonate.groups.length) headers['Impersonate-Group'] = this.opts.impersonate.groups;
    }
    return headers;
  }

  /**
   * Send a request and resolve once headers arrive, whatever the status.
   * Aborting `signal` destroys the request and the connection under it.
   */
  request(req: KubeRequest): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const body =
        req.body === undefined ? undefined : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const request = http.request({
        agent: this.agent,
        method: req.method ?? 'GET',
        path: `${this.opts.basePath ?? ''}${req.path}${queryString(req.query)}`,
        headers: this.headers(
          body ? { 'Content-Type': req.contentType ?? 'application/json', 'Content-Length': String(body.length) } : {},
        ),
      });
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        reject(fromTransportError(err));
      };
      const onAbort = () => {
        request.destroy();
        fail(new KubeError('Request cancelled', 499));
      };
      const timer = req.timeoutMs
        ? setTimeout(() => {
            request.destroy();
            fail(new KubeError('The Kubernetes API did not answer in time', 504));
          }, req.timeoutMs)
        : undefined;
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });

      request.on('response', (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (req.signal) {
          const stop = () => res.destroy();
          req.signal.addEventListener('abort', stop, { once: true });
          res.once('close', () => req.signal?.removeEventListener('abort', stop));
        }
        resolve(res);
      });
      request.on('error', fail);
      request.end(body);
    });
  }

  /** The body of a 2xx answer as text; anything else throws the mapped error. */
  async text(req: KubeRequest): Promise<string> {
    const timeoutMs = req.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.request({ ...req, signal, timeoutMs });
      const body = await readBody(res);
      if (!res.statusCode || res.statusCode >= 300) throw fromApiStatus(res.statusCode ?? 502, body);
      return body;
    } catch (err) {
      if (controller.signal.aborted && !req.signal?.aborted) throw new KubeError('The Kubernetes API did not answer in time', 504);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async json<T>(req: KubeRequest): Promise<T> {
    const text = await this.text(req);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KubeError('The Kubernetes API sent a response that is not JSON', 502);
    }
  }

  /** A 2xx streaming response, for the caller to read until it ends or `signal` aborts. */
  async stream(req: KubeRequest): Promise<IncomingMessage> {
    const res = await this.request({ ...req, timeoutMs: req.timeoutMs ?? STREAM_HEADERS_TIMEOUT_MS });
    if (res.statusCode && res.statusCode < 300) return res;
    throw fromApiStatus(res.statusCode ?? 502, await readBody(res, 64 * 1024).catch(() => ''));
  }

  // ── Typed calls ─────────────────────────────────────────────

  /** `GET /version`: `{ gitVersion: 'v1.30.2', … }`. */
  version(signal?: AbortSignal): Promise<{ gitVersion?: string; major?: string; minor?: string; platform?: string }> {
    return this.json({ path: '/version', signal, timeoutMs: 10_000 });
  }

  /** One object. */
  get<T = KubeObject>(resource: KubeResource, namespace: string | null, name: string, signal?: AbortSignal): Promise<T> {
    return this.json<T>({ path: resourcePath(resource, { namespace, name }), signal });
  }

  /**
   * Every object of a resource (in one namespace, or all), following
   * `continue` tokens. Items get their `kind` back (lists leave it out).
   */
  async list<T extends KubeObject = KubeObject>(resource: KubeResource, opts: ListOptions = {}): Promise<KubeList<T>> {
    const kind = KUBE_RESOURCES[resource].kind;
    const items: T[] = [];
    let resourceVersion = '';
    let next: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const body = await this.json<{ items?: T[]; metadata?: { resourceVersion?: string; continue?: string } }>({
        path: resourcePath(resource, { namespace: opts.namespace }),
        query: {
          limit: LIST_PAGE_SIZE,
          continue: next,
          labelSelector: opts.labelSelector,
          fieldSelector: opts.fieldSelector,
        },
        signal: opts.signal,
      });
      for (const item of body.items ?? []) items.push({ ...item, kind });
      resourceVersion = body.metadata?.resourceVersion ?? resourceVersion;
      next = body.metadata?.continue || undefined;
      if (!next) return { items, resourceVersion };
    }
    throw new KubeError(`Too many ${resource} to list (more than ${LIST_PAGE_SIZE * MAX_LIST_PAGES})`, 502);
  }

  /**
   * Watch a resource from `resourceVersion`, calling `onEvent` per event
   * until the API server ends the watch (resolves), the signal aborts
   * (resolves), or the connection fails (rejects). A `410 Gone` arrives as
   * an `ERROR` event whose object is a Status with `code: 410` — or, when
   * the version is already too old at the start, as a thrown KubeError 410.
   */
  async watch<T extends KubeObject = KubeObject>(
    resource: KubeResource,
    opts: WatchOptions,
    onEvent: (event: WatchEvent<T>) => void,
  ): Promise<void> {
    const kind = KUBE_RESOURCES[resource].kind;
    const res = await this.stream({
      path: resourcePath(resource, { namespace: opts.namespace }),
      query: {
        watch: 1,
        resourceVersion: opts.resourceVersion,
        allowWatchBookmarks: true,
        timeoutSeconds: opts.timeoutSeconds ?? 300,
        labelSelector: opts.labelSelector,
        fieldSelector: opts.fieldSelector,
      },
      signal: opts.signal,
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const handle = (line: string) => {
        if (!line.trim()) return;
        let event: WatchEvent<T>;
        try {
          event = JSON.parse(line) as WatchEvent<T>;
        } catch {
          return;
        }
        if (!event || typeof event !== 'object' || !event.object) return;
        if (event.type !== 'ERROR' && event.type !== 'BOOKMARK' && !event.object.kind) {
          event.object = { ...event.object, kind };
        }
        onEvent(event);
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          handle(line);
        }
        if (buffer.length > MAX_WATCH_LINE) {
          res.destroy();
          reject(new KubeError('A watch event was too large', 502));
        }
      });
      res.on('end', () => {
        handle(buffer);
        resolve();
      });
      res.on('error', (err) => (opts.signal?.aborted ? resolve() : reject(fromTransportError(err))));
      // Closed without an end (aborted, or the connection dropped): the cache resumes from its version
      res.on('close', () => resolve());
    });
  }

  /** Patch an object (or a subresource such as `scale`). */
  patch<T = KubeObject>(
    resource: KubeResource,
    namespace: string | null,
    name: string,
    body: unknown,
    opts: { type?: PatchType; subresource?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.json<T>({
      method: 'PATCH',
      path: resourcePath(resource, { namespace, name, subresource: opts.subresource }),
      body,
      contentType: PATCH_CONTENT_TYPE[opts.type ?? 'merge'],
      signal: opts.signal,
    });
  }

  /** Create an object in a collection (a Job from a CronJob's template, a review). */
  create<T = KubeObject>(resource: KubeResource, namespace: string | null, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.json<T>({ method: 'POST', path: resourcePath(resource, { namespace }), body, signal });
  }

  /** Delete an object. */
  delete<T = KubeObject>(
    resource: KubeResource,
    namespace: string | null,
    name: string,
    opts: { gracePeriodSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.json<T>({
      method: 'DELETE',
      path: resourcePath(resource, { namespace, name }),
      query: { gracePeriodSeconds: opts.gracePeriodSeconds },
      signal: opts.signal,
    });
  }

  /** A path outside the resource allowlist the client itself needs (discovery, reviews, metrics). */
  raw<T>(path: string, req: Omit<KubeRequest, 'path'> = {}): Promise<T> {
    return this.json<T>({ ...req, path });
  }

  /** K4: a pod's logs as a stream (`follow` keeps it open). */
  logs(_namespace: string, _pod: string, _opts: LogOptions): Promise<IncomingMessage> {
    return Promise.reject(new KubeError('Pod logs are not available yet', 501));
  }

  /** K4: a shell in a container. */
  exec(_namespace: string, _pod: string, _opts: ExecOptions): Promise<ExecSession> {
    return Promise.reject(new KubeError('Pod shells are not available yet', 501));
  }

  /** Close idle bookkeeping; open streams end with their requests. */
  close(): void {
    this.agent.destroy();
  }
}
