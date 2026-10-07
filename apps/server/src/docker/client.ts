import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import { DockerError, fromDaemonStatus, fromTransportError } from './errors.js';
import { asSocket } from './transport.js';

/**
 * A small Docker Engine API client over Node's `http.request`. The agent's
 * `createConnection` hands each HTTP connection a fresh stream from
 * `openStream` (a forwarded socket or dial-stdio, docker/transport.ts), so
 * nothing here knows about SSH and nothing opens a network connection of its
 * own. No keep-alive: a stream serves one request and is closed with it.
 *
 * Four kinds of call:
 * - JSON (`json`, `text`) — bounded by a timeout, body size capped;
 * - streamed body (`send`) — an image archive piped through to `/images/load`;
 * - streaming (`stream`) — logs, stats, events: the response is handed back
 *   once headers arrive and the caller reads it until done or aborted;
 * - hijacked (`hijack`) — `Upgrade: tcp`, for exec attach: the raw duplex
 *   stream after the 101 response.
 *
 * Paths are versioned (`/v1.43/containers/json`) with the API version
 * negotiated from `/version` and pinned per server (docker/probe.ts).
 */

/** Oldest API this client speaks (Docker 1.13). */
export const MIN_API_VERSION = '1.25';
/** Newest API this client knows; newer daemons still serve it. */
export const MAX_API_VERSION = '1.47';

/** JSON calls that take longer than this fail with 504. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Streaming calls must at least send headers within this. */
export const STREAM_HEADERS_TIMEOUT_MS = 30_000;
/** Largest JSON body read into memory. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Compare dotted API versions numerically: `1.9 < 1.10`. */
export function compareApiVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const API_VERSION_PATTERN = /^\d+\.\d+$/;

/**
 * The API version to talk to a daemon that reports `ApiVersion` (its newest)
 * and `MinAPIVersion` (its oldest): the newest both sides speak. Throws when
 * there is none — an engine older than {@link MIN_API_VERSION}, or one that no
 * longer serves {@link MAX_API_VERSION}.
 */
export function negotiateApiVersion(daemon: { ApiVersion?: unknown; MinAPIVersion?: unknown }): string {
  // Daemons too old to report it speak 1.24 at most, like the docker CLI assumes
  const newest =
    typeof daemon.ApiVersion === 'string' && API_VERSION_PATTERN.test(daemon.ApiVersion) ? daemon.ApiVersion : '1.24';
  const chosen = compareApiVersions(newest, MAX_API_VERSION) < 0 ? newest : MAX_API_VERSION;
  if (compareApiVersions(chosen, MIN_API_VERSION) < 0) {
    throw new DockerError(
      `This Docker Engine is too old (API ${newest}); API ${MIN_API_VERSION} or newer is needed`,
      400,
      'unsupported_version',
    );
  }
  const oldest = typeof daemon.MinAPIVersion === 'string' && API_VERSION_PATTERN.test(daemon.MinAPIVersion) ? daemon.MinAPIVersion : null;
  if (oldest && compareApiVersions(chosen, oldest) < 0) {
    throw new DockerError(
      `This Docker Engine needs API ${oldest} or newer; this app speaks up to ${MAX_API_VERSION}`,
      400,
      'unsupported_version',
    );
  }
  return chosen;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface DaemonRequest {
  method?: string;
  path: string;
  query?: Record<string, QueryValue>;
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Unversioned paths (`/_ping`, `/version`) are used before a version is known. */
  versioned?: boolean;
  /** For JSON calls, the whole exchange; for streams, until headers. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function readBody(res: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new DockerError('Docker sent more data than expected', 502));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
    res.on('aborted', () => reject(new DockerError('Docker closed the connection mid-response', 502)));
  });
}

/** Agent that opens a fresh daemon stream for every connection. */
class DaemonAgent extends http.Agent {
  constructor(private readonly open: () => Promise<Duplex>) {
    super({ keepAlive: false });
  }

  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.open().then(
      (stream) => callback?.(null, asSocket(stream)),
      (err: unknown) => callback?.(fromTransportError(err), undefined as unknown as Duplex),
    );
    return undefined;
  }
}

export class DockerClient {
  private readonly agent: DaemonAgent;

  constructor(
    openStream: () => Promise<Duplex>,
    /** Null until negotiated; versioned calls then go unversioned (the daemon's newest). */
    public apiVersion: string | null = null,
  ) {
    this.agent = new DaemonAgent(openStream);
  }

  path(path: string, query?: Record<string, QueryValue>, versioned = true): string {
    const prefix = versioned && this.apiVersion ? `/v${this.apiVersion}` : '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    const qs = params.toString();
    return `${prefix}${path}${qs ? `?${qs}` : ''}`;
  }

  /**
   * Send a request and resolve with the response once its headers arrive,
   * whatever the status. Aborting `signal` destroys the request (and so the
   * stream under it).
   */
  request(req: DaemonRequest): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body));
      const request = http.request({
        agent: this.agent,
        // Nothing resolves this name: the agent supplies the stream. Docker wants a Host header.
        host: 'docker',
        method: req.method ?? 'GET',
        path: this.path(req.path, req.query, req.versioned ?? true),
        headers: {
          ...(body && { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }),
          ...req.headers,
        },
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
        fail(new DockerError('Request cancelled', 499));
      };
      const timer = req.timeoutMs
        ? setTimeout(() => {
            request.destroy();
            fail(new DockerError('Docker did not answer in time', 504));
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
        // Still honoured after headers: aborting ends the body too
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

  /**
   * Send `body` as a chunked request body (image load) and resolve with the
   * response once its headers arrive, whatever the status. The body is piped
   * with backpressure, so nothing is buffered here. Until the body has been
   * sent whole, the body failing (an upload over its limit, the browser gone)
   * or `signal` aborting destroys the request, so the daemon sees a cut-off
   * body and loads nothing; before the headers the promise rejects with that
   * error, after them the response errors. Once the body is sent nothing here
   * cancels the call: the caller owns the response.
   */
  send(req: Omit<DaemonRequest, 'body'> & { body: Readable; contentType: string }): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        agent: this.agent,
        host: 'docker',
        method: req.method ?? 'POST',
        path: this.path(req.path, req.query, req.versioned ?? true),
        headers: { 'Content-Type': req.contentType, 'Transfer-Encoding': 'chunked', ...req.headers },
      });
      let settled = false;
      let sent = false;
      const cut = (err: unknown) => {
        req.signal?.removeEventListener('abort', onAbort);
        req.body.unpipe(request);
        request.destroy(err instanceof Error ? err : undefined);
        if (settled) return;
        settled = true;
        reject(fromTransportError(err));
      };
      const onAbort = () => {
        if (!sent) cut(req.signal?.reason instanceof Error ? req.signal.reason : new DockerError('Request cancelled', 499));
      };
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });

      request.on('response', (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        resolve(res);
      });
      request.on('error', (err) => {
        if (!settled) cut(err);
      });
      req.body.on('error', (err) => {
        if (!sent) cut(err);
      });
      req.body.on('end', () => {
        sent = true;
        req.signal?.removeEventListener('abort', onAbort);
      });
      req.body.pipe(request);
    });
  }

  /** A JSON call: throws the mapped daemon error on a non-2xx status. */
  async json<T>(req: DaemonRequest): Promise<T> {
    const text = await this.text(req);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DockerError('Docker sent a response that is not JSON', 502);
    }
  }

  /** Like {@link json}, returning the body as text. */
  async text(req: DaemonRequest): Promise<string> {
    const timeoutMs = req.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.request({ ...req, signal, timeoutMs });
      const body = await readBody(res);
      if (!res.statusCode || res.statusCode >= 300) throw fromDaemonStatus(res.statusCode ?? 502, body);
      return body;
    } catch (err) {
      if (controller.signal.aborted && !req.signal?.aborted) throw new DockerError('Docker did not answer in time', 504);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A streaming call: resolves with the response once a 2xx status arrives,
   * for the caller to read until it ends or `signal` aborts.
   */
  async stream(req: DaemonRequest): Promise<IncomingMessage> {
    const res = await this.request({ ...req, timeoutMs: req.timeoutMs ?? STREAM_HEADERS_TIMEOUT_MS });
    if (res.statusCode && res.statusCode < 300) return res;
    throw fromDaemonStatus(res.statusCode ?? 502, await readBody(res, 64 * 1024).catch(() => ''));
  }

  /**
   * A hijacked call (`Connection: Upgrade`, `Upgrade: tcp`): resolves with the
   * raw stream once the daemon switches protocols. `head` holds any bytes that
   * arrived with the 101 response.
   */
  hijack(req: DaemonRequest): Promise<{ socket: Duplex; head: Buffer }> {
    return new Promise((resolve, reject) => {
      const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body));
      const request = http.request({
        agent: this.agent,
        host: 'docker',
        method: req.method ?? 'POST',
        path: this.path(req.path, req.query, req.versioned ?? true),
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'tcp',
          ...(body && { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }),
          ...req.headers,
        },
      });
      let settled = false;
      const timer = setTimeout(() => {
        request.destroy();
        settle(() => reject(new DockerError('Docker did not answer in time', 504)));
      }, req.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      request.on('upgrade', (_res, socket, head) => settle(() => resolve({ socket, head })));
      // Not upgraded: an error status, or a daemon that answered 200 without switching
      request.on('response', (res) => {
        void readBody(res, 64 * 1024)
          .catch(() => '')
          .then((text) =>
            settle(() =>
              reject(
                res.statusCode && res.statusCode >= 300
                  ? fromDaemonStatus(res.statusCode, text)
                  : new DockerError('Docker did not switch protocols for the attach', 502),
              ),
            ),
          );
      });
      request.on('error', (err) => settle(() => reject(fromTransportError(err))));
      req.signal?.addEventListener('abort', () => {
        request.destroy();
        settle(() => reject(new DockerError('Request cancelled', 499)));
      }, { once: true });
      request.end(body);
    });
  }

  /** `GET /_ping`: true when the daemon answers `OK`. */
  async ping(timeoutMs = 10_000): Promise<boolean> {
    const text = await this.text({ path: '/_ping', versioned: false, timeoutMs });
    return text.trim() === 'OK';
  }

  /** Close idle bookkeeping; open streams end with their requests. */
  close(): void {
    this.agent.destroy();
  }
}
