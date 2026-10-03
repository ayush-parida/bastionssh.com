import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { CA_CERT, SERVER_CERT, SERVER_KEY } from './test-certs.test-helper.js';

/**
 * An in-process Kubernetes API server for tests: HTTPS with the test CA
 * (test-certs.test-helper.ts), bearer-token or client-certificate auth, and
 * just enough of the API for the client, cache and views — list (with
 * `limit`/`continue`, label and field selectors), get, watch (with
 * `resourceVersion`, bookmarks, and `410 Gone` once history is compacted),
 * `/version`, `/api`, metrics on demand and SelfSubjectRulesReview — and,
 * for the guided actions, patch (merge, strategic as merge, JSON patch), the
 * `scale` subresource, delete and create, each recorded in `writes`.
 *
 * It records each TLS connection's SNI so tests can assert what the client
 * sent, whatever route the bytes took.
 */

export const FAKE_TOKEN = 'fake-token-0123456789abcdef';

type Obj = Record<string, unknown> & { metadata: Record<string, unknown> & { name: string; namespace?: string } };

interface Watcher {
  resource: string;
  namespace: string | null;
  res: ServerResponse;
}

interface HistoryEntry {
  rv: number;
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  resource: string;
  object: Obj;
}

const CLUSTER_SCOPED = new Set(['nodes', 'namespaces', 'persistentvolumes', 'storageclasses']);

export interface FakeApi {
  port: number;
  url: string;
  /** Server names (SNI) the client sent, one per TLS connection; '' for none. */
  sni: string[];
  /** Request paths with their query, in order. */
  requests: string[];
  /** Every PATCH, DELETE and create, with its content type and parsed body. */
  writes: FakeWrite[];
  /** Watches open right now. */
  watchers(): number;
  add(resource: string, object: Obj): Obj;
  modify(resource: string, object: Obj): Obj;
  remove(resource: string, namespace: string | null, name: string): void;
  /** Forget watch history: a watch from an older version gets `410 Gone`. */
  compact(): void;
  /** Answer 403 for this resource (and list/watch of it). */
  forbid(resource: string, forbidden?: boolean): void;
  /** Serve metrics.k8s.io. */
  metrics: { nodes: Record<string, { cpu: string; memory: string }> } | null;
  /** The rules SelfSubjectRulesReview answers with. */
  rules: { verbs: string[]; apiGroups: string[]; resources: string[] }[];
  /** Close every open watch (as an API server restart would). */
  dropWatches(): void;
  close(): Promise<void>;
}

export interface FakeWrite {
  method: string;
  path: string;
  contentType: string | null;
  body: unknown;
}

const key = (o: Obj) => `${o.metadata.namespace ?? ''}/${o.metadata.name}`;

/** `/api/v1/namespaces/shop/pods/web` → its parts; null for paths that are not resource paths. */
function parsePath(path: string): { resource: string; namespace: string | null; name: string | null; subresource: string | null } | null {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let rest: string[];
  if (parts[0] === 'api' && parts[1] === 'v1') rest = parts.slice(2);
  else if (parts[0] === 'apis' && parts.length >= 3) rest = parts.slice(3);
  else return null;
  if (rest[0] === 'namespaces' && rest.length >= 3) {
    return { namespace: rest[1]!, resource: rest[2]!, name: rest[3] ?? null, subresource: rest[4] ?? null };
  }
  if (!rest.length) return null;
  return { namespace: null, resource: rest[0]!, name: rest[1] ?? null, subresource: rest[2] ?? null };
}

function matchesLabels(o: Obj, selector: string | null): boolean {
  if (!selector) return true;
  const labels = (o.metadata.labels ?? {}) as Record<string, string>;
  return selector.split(',').every((part) => {
    const [k, v] = part.split('=');
    return labels[k!] === v;
  });
}

function matchesFields(o: Obj, selector: string | null): boolean {
  if (!selector) return true;
  return selector.split(',').every((part) => {
    const [k, v] = part.split('=');
    if (k === 'spec.nodeName') return (o.spec as Record<string, unknown> | undefined)?.nodeName === v;
    if (k === 'metadata.name') return o.metadata.name === v;
    return true;
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function status(code: number, reason: string, message: string) {
  return { kind: 'Status', apiVersion: 'v1', status: 'Failure', message, reason, code };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** RFC 7386 merge patch (the fake applies strategic merge patches the same way). */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlain(patch)) return patch;
  const out: Record<string, unknown> = isPlain(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** RFC 6902 JSON patch: `test`, `add`, `replace`, `remove` on object members. Throws on a failed test. */
function jsonPatch(target: Obj, ops: { op: string; path: string; value?: unknown }[]): Obj {
  const doc = structuredClone(target) as Record<string, unknown>;
  for (const op of ops) {
    const parts = op.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop()!;
    let parent: Record<string, unknown> = doc;
    for (const p of parts) {
      if (!isPlain(parent[p])) parent[p] = {};
      parent = parent[p] as Record<string, unknown>;
    }
    if (op.op === 'test') {
      if (JSON.stringify(parent[last]) !== JSON.stringify(op.value)) throw new Error(`test failed for ${op.path}`);
    } else if (op.op === 'remove') delete parent[last];
    else if (op.op === 'replace' && !(last in parent)) throw new Error(`replace of missing ${op.path}`);
    else parent[last] = structuredClone(op.value);
  }
  return doc as Obj;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function startFakeApi(opts: { token?: string; clientCa?: string } = {}): Promise<FakeApi> {
  const token = opts.token ?? FAKE_TOKEN;
  const store = new Map<string, Map<string, Obj>>();
  const history: HistoryEntry[] = [];
  let rv = 100;
  let oldestRv = rv;
  const forbidden = new Set<string>();
  const watchers = new Set<Watcher>();
  const sni: string[] = [];
  const requests: string[] = [];
  const writes: FakeWrite[] = [];

  const table = (resource: string) => {
    let t = store.get(resource);
    if (!t) store.set(resource, (t = new Map()));
    return t;
  };

  const notify = (entry: HistoryEntry) => {
    history.push(entry);
    for (const w of watchers) {
      if (w.resource !== entry.resource) continue;
      if (w.namespace && entry.object.metadata.namespace !== w.namespace) continue;
      w.res.write(JSON.stringify({ type: entry.type, object: entry.object }) + '\n');
    }
  };

  const write = (resource: string, object: Obj, type: 'ADDED' | 'MODIFIED') => {
    rv += 1;
    const stored: Obj = {
      ...object,
      metadata: { creationTimestamp: '2026-10-01T00:00:00Z', uid: `uid-${key(object)}`, ...object.metadata, resourceVersion: String(rv) },
    };
    table(resource).set(key(stored), stored);
    notify({ rv, type, resource, object: stored });
    return stored;
  };

  const api: FakeApi = {
    port: 0,
    url: '',
    sni,
    requests,
    writes,
    watchers: () => watchers.size,
    add: (resource, object) => write(resource, object, 'ADDED'),
    modify: (resource, object) => write(resource, object, 'MODIFIED'),
    remove: (resource, namespace, name) => {
      const t = table(resource);
      const k = `${namespace ?? ''}/${name}`;
      const existing = t.get(k);
      if (!existing) return;
      t.delete(k);
      rv += 1;
      notify({ rv, type: 'DELETED', resource, object: { ...existing, metadata: { ...existing.metadata, resourceVersion: String(rv) } } });
    },
    compact: () => {
      history.length = 0;
      oldestRv = rv;
    },
    forbid: (resource, on = true) => (on ? forbidden.add(resource) : forbidden.delete(resource)),
    metrics: null,
    rules: [{ verbs: ['get', 'list', 'watch'], apiGroups: ['*'], resources: ['*'] }],
    dropWatches: () => {
      for (const w of [...watchers]) w.res.destroy();
    },
    close: async () => {
      api.dropWatches();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const authorized = (req: IncomingMessage) => {
    const socket = req.socket as TLSSocket;
    if (opts.clientCa && socket.authorized && socket.getPeerCertificate()?.subject) return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'https://fake');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/version') {
      return send(res, 200, { major: '1', minor: '31', gitVersion: 'v1.31.2+fake', platform: 'linux/arm64' });
    }
    if (!authorized(req)) return send(res, 401, status(401, 'Unauthorized', 'Unauthorized'));
    if (url.pathname === '/api' || url.pathname === '/apis') return send(res, 200, { kind: 'APIVersions', versions: ['v1'] });
    if (url.pathname === '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews' && req.method === 'POST') {
      return send(res, 201, {
        kind: 'SelfSubjectRulesReview',
        status: { resourceRules: api.rules, nonResourceRules: [], incomplete: false },
      });
    }
    if (url.pathname.startsWith('/apis/metrics.k8s.io/v1beta1')) {
      if (!api.metrics) return send(res, 404, status(404, 'NotFound', 'the server could not find the requested resource'));
      if (url.pathname.endsWith('/nodes')) {
        return send(res, 200, {
          items: Object.entries(api.metrics.nodes).map(([name, usage]) => ({ metadata: { name }, usage })),
        });
      }
      return send(res, 200, { kind: 'APIResourceList' });
    }
    const parsed = parsePath(url.pathname);
    if (!parsed) return send(res, 404, status(404, 'NotFound', 'the server could not find the requested resource'));
    const { resource, name } = parsed;
    const namespace = CLUSTER_SCOPED.has(resource) ? null : parsed.namespace;
    // A namespace object itself: /api/v1/namespaces/<name>
    if (forbidden.has(resource)) {
      return send(res, 403, status(403, 'Forbidden', `${resource} is forbidden: User "fake" cannot list resource "${resource}"`));
    }
    const t = table(resource);

    if (req.method === 'PATCH' || req.method === 'DELETE' || (req.method === 'POST' && !name)) {
      void readJson(req).then((body) => {
        writes.push({ method: req.method!, path: url.pathname, contentType: req.headers['content-type'] ?? null, body });
        const k = `${namespace ?? ''}/${name}`;
        if (req.method === 'POST') {
          const object = body as Obj;
          if (t.has(`${namespace ?? ''}/${object.metadata.name}`)) {
            return send(res, 409, status(409, 'AlreadyExists', `${resource} "${object.metadata.name}" already exists`));
          }
          return send(res, 201, write(resource, { ...object, metadata: { ...object.metadata, ...(namespace && { namespace }) } }, 'ADDED'));
        }
        const existing = t.get(k);
        if (!existing) return send(res, 404, status(404, 'NotFound', `${resource} "${name}" not found`));
        if (req.method === 'DELETE') {
          api.remove(resource, namespace, name!);
          return send(res, 200, existing);
        }
        if (parsed.subresource === 'scale') {
          const replicas = (body as { spec?: { replicas?: number } } | null)?.spec?.replicas;
          const updated = write(resource, { ...existing, spec: { ...(existing.spec as object), replicas } }, 'MODIFIED');
          return send(res, 200, { kind: 'Scale', metadata: { name, namespace }, spec: { replicas: (updated.spec as { replicas?: number }).replicas } });
        }
        let next: Obj;
        try {
          next =
            req.headers['content-type'] === 'application/json-patch+json'
              ? jsonPatch(existing, body as { op: string; path: string; value?: unknown }[])
              : (mergePatch(existing, body) as Obj);
        } catch (err) {
          return send(res, 422, status(422, 'Invalid', (err as Error).message));
        }
        return send(res, 200, write(resource, next, 'MODIFIED'));
      });
      return;
    }

    if (name) {
      const object = t.get(`${namespace ?? ''}/${name}`);
      if (!object) return send(res, 404, status(404, 'NotFound', `${resource} "${name}" not found`));
      if (parsed.subresource === 'scale') {
        const replicas = (object.spec as { replicas?: number } | undefined)?.replicas ?? 1;
        return send(res, 200, { kind: 'Scale', metadata: { name, namespace }, spec: { replicas }, status: { replicas } });
      }
      return send(res, 200, object);
    }

    const all = [...t.values()].filter(
      (o) =>
        (!namespace || o.metadata.namespace === namespace) &&
        matchesLabels(o, url.searchParams.get('labelSelector')) &&
        matchesFields(o, url.searchParams.get('fieldSelector')),
    );

    if (url.searchParams.get('watch') === '1') {
      const from = Number(url.searchParams.get('resourceVersion') ?? '0');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      if (from < oldestRv) {
        res.end(JSON.stringify({ type: 'ERROR', object: status(410, 'Expired', `too old resource version: ${from} (${oldestRv})`) }) + '\n');
        return;
      }
      for (const entry of history) {
        if (entry.rv <= from || entry.resource !== resource) continue;
        if (namespace && entry.object.metadata.namespace !== namespace) continue;
        res.write(JSON.stringify({ type: entry.type, object: entry.object }) + '\n');
      }
      res.write(JSON.stringify({ type: 'BOOKMARK', object: { kind: 'Pod', metadata: { resourceVersion: String(rv) } } }) + '\n');
      const watcher: Watcher = { resource, namespace, res };
      watchers.add(watcher);
      res.on('close', () => watchers.delete(watcher));
      return;
    }

    // Paged lists: `continue` is the index to start from
    const limit = Number(url.searchParams.get('limit') ?? '0') || all.length || 1;
    const start = Number(url.searchParams.get('continue') ?? '0');
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : undefined;
    return send(res, 200, {
      kind: 'List',
      apiVersion: 'v1',
      metadata: { resourceVersion: String(rv), ...(next && { continue: next }) },
      items: page.map(({ kind: _kind, ...rest }) => rest),
    });
  };

  const server = https.createServer(
    {
      cert: SERVER_CERT,
      key: SERVER_KEY,
      ...(opts.clientCa && { ca: opts.clientCa, requestCert: true, rejectUnauthorized: false }),
    },
    handle,
  );
  server.on('secureConnection', (socket: TLSSocket) => {
    sni.push((socket as TLSSocket & { servername?: string | false }).servername || '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.port = (server.address() as AddressInfo).port;
  api.url = `https://127.0.0.1:${api.port}`;
  return api;
}

/** A kubeconfig for the fake server (token auth, CA embedded). */
export function fakeKubeconfig(api: Pick<FakeApi, 'port'>, opts: { host?: string; context?: string; namespace?: string } = {}): string {
  const context = opts.context ?? 'fake';
  return [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${context}`,
    'clusters:',
    `- name: ${context}-cluster`,
    '  cluster:',
    `    server: https://${opts.host ?? '127.0.0.1'}:${api.port}`,
    `    certificate-authority-data: ${Buffer.from(CA_CERT).toString('base64')}`,
    'users:',
    `- name: ${context}-user`,
    '  user:',
    `    token: ${FAKE_TOKEN}`,
    'contexts:',
    `- name: ${context}`,
    '  context:',
    `    cluster: ${context}-cluster`,
    `    user: ${context}-user`,
    ...(opts.namespace ? [`    namespace: ${opts.namespace}`] : []),
    '',
  ].join('\n');
}

// ── Sample objects ───────────────────────────────────────────

export function node(name: string, opts: { ready?: boolean; roles?: string[]; cpu?: string; memory?: string } = {}): Obj {
  return {
    kind: 'Node',
    metadata: {
      name,
      labels: Object.fromEntries((opts.roles ?? []).map((r) => [`node-role.kubernetes.io/${r}`, 'true'])),
    },
    spec: {},
    status: {
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
      allocatable: { cpu: opts.cpu ?? '4', memory: opts.memory ?? '8Gi', pods: '110' },
      nodeInfo: { kubeletVersion: 'v1.31.2', osImage: 'Debian', architecture: 'arm64' },
    },
  };
}

export function pod(
  namespace: string,
  name: string,
  opts: {
    node?: string | null;
    phase?: string;
    ready?: boolean;
    waiting?: string;
    restarts?: number;
    labels?: Record<string, string>;
    owner?: { kind: string; name: string };
    unschedulable?: string;
    cpu?: string;
    memory?: string;
    secretEnv?: { secret: string; key: string };
  } = {},
): Obj {
  const phase = opts.phase ?? (opts.unschedulable ? 'Pending' : 'Running');
  return {
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: opts.labels ?? {},
      ...(opts.owner && { ownerReferences: [{ ...opts.owner, controller: true, apiVersion: 'apps/v1', uid: 'x' }] }),
    },
    spec: {
      ...(opts.node !== null && !opts.unschedulable && { nodeName: opts.node ?? 'node-1' }),
      containers: [
        {
          name: 'app',
          image: 'shop/web:1.4.2',
          resources: { requests: { cpu: opts.cpu ?? '100m', memory: opts.memory ?? '128Mi' } },
          ...(opts.secretEnv && {
            env: [{ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: opts.secretEnv.secret, key: opts.secretEnv.key } } }],
          }),
        },
      ],
    },
    status: {
      phase,
      ...(opts.unschedulable && {
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: opts.unschedulable }],
      }),
      ...(!opts.unschedulable && {
        containerStatuses: [
          {
            name: 'app',
            ready: opts.ready ?? !opts.waiting,
            restartCount: opts.restarts ?? 0,
            state: opts.waiting ? { waiting: { reason: opts.waiting, message: 'back-off restarting failed container' } } : { running: {} },
          },
        ],
      }),
    },
  };
}

export function deployment(namespace: string, name: string, opts: { replicas?: number; ready?: number } = {}): Obj {
  const replicas = opts.replicas ?? 2;
  const ready = opts.ready ?? replicas;
  return {
    kind: 'Deployment',
    metadata: { name, namespace, generation: 1, labels: { app: name } },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      strategy: { type: 'RollingUpdate' },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'app', image: `shop/${name}:1.0` }] } },
    },
    status: { observedGeneration: 1, replicas, readyReplicas: ready, updatedReplicas: replicas, availableReplicas: ready },
  };
}
