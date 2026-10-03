import type { KubeResource } from '@smt/shared';
import logger from '../logger.js';
import type { KubeClient, KubeObject, WatchEvent } from './client.js';
import { KubeError } from './errors.js';
import { trimForCache } from './redact.js';

/**
 * The watch cache (spec §2.9): one list + watch per (cluster, resource,
 * namespace scope) that at least one viewer is using, kept in memory and
 * shared by everyone looking at the same thing, informer-style:
 *
 * 1. list (paged) → every object and the collection's resourceVersion;
 * 2. watch from that version, applying ADDED / MODIFIED / DELETED, moving
 *    the version forward on BOOKMARKs; when the API server ends the watch
 *    (it does every few minutes) watch again from where it stopped;
 * 3. `410 Gone` (the version is too old) → relist and carry on;
 * 4. any other failure keeps the last known objects, reports the error to
 *    viewers, and retries with backoff (or at once when a new viewer comes).
 *
 * Viewers hold a {@link CacheSubscription}; the scope's watch stops
 * {@link IDLE_STOP_MS} after the last one lets go. Objects are trimmed on
 * the way in (redact.ts: no managedFields, Secret values never stored).
 * Each cluster's cache is capped at {@link limits}.maxClusterBytes; past it
 * the least-viewed scope is dropped and its viewers told why.
 *
 * With impersonation on, what a credential may see depends on who is asking,
 * so the cache key includes the user (CacheSource.key) and revoking that
 * user's access drops their scopes ({@link dropIdentityCaches}).
 */

export const IDLE_STOP_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

export const limits = {
  /** Estimated bytes (serialized size) of everything cached for one cluster key. */
  maxClusterBytes: 96 * 1024 * 1024,
  idleStopMs: IDLE_STOP_MS,
};

/** Where a scope's data comes from. */
export interface CacheSource {
  /** The cluster id, plus the impersonated user's id when impersonation is on. */
  key: string;
  orgId: string;
  clusterId: string;
  /** The impersonated user, when the cache is per user. */
  identityUserId: string | null;
  /** A client for the cluster (one per running scope; closed when it stops). */
  client: () => KubeClient;
}

export type CacheEvent =
  | { type: 'ready'; resource: KubeResource; namespace: string | null }
  | { type: 'changed'; resource: KubeResource; namespace: string | null }
  | { type: 'error'; resource: KubeResource; namespace: string | null; error: Error };

export type CacheListener = (event: CacheEvent) => void;

export type ScopeStatus = 'syncing' | 'ready' | 'error' | 'stopped';

export interface CacheSubscription {
  readonly resource: KubeResource;
  readonly namespace: string | null;
  /** Resolves once the first list has arrived; rejects when it failed. */
  readonly ready: Promise<void>;
  readonly status: ScopeStatus;
  readonly error: Error | null;
  /** The cached objects, in no particular order. */
  items(): KubeObject[];
  unsubscribe(): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const d: Deferred = {
    promise: new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: () => {
      if (d.settled) return;
      d.settled = true;
      resolve();
    },
    reject: (err) => {
      if (d.settled) return;
      d.settled = true;
      reject(err);
    },
    settled: false,
  };
  // Nobody may be waiting; a rejection must not crash the process
  d.promise.catch(() => {});
  return d;
}

interface Scope {
  cluster: ClusterCache;
  id: string;
  resource: KubeResource;
  namespace: string | null;
  objects: Map<string, KubeObject>;
  sizes: Map<string, number>;
  bytes: number;
  resourceVersion: string | null;
  status: ScopeStatus;
  error: Error | null;
  hasData: boolean;
  viewers: number;
  listeners: Set<CacheListener>;
  lastUsed: number;
  abort: AbortController;
  /** Cancels a backoff wait, so a new viewer retries at once. */
  wake: (() => void) | null;
  ready: Deferred;
  idleTimer?: NodeJS.Timeout;
  client: KubeClient | null;
}

interface ClusterCache {
  source: CacheSource;
  scopes: Map<string, Scope>;
}

const clusters = new Map<string, ClusterCache>();

const scopeId = (resource: KubeResource, namespace: string | null) => `${resource}|${namespace ?? '*'}`;
const objectKey = (o: KubeObject) => `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`;

function emit(scope: Scope, event: CacheEvent) {
  for (const listener of [...scope.listeners]) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ err }, 'Kubernetes cache listener threw');
    }
  }
}

function clusterBytes(cluster: ClusterCache): number {
  let total = 0;
  for (const s of cluster.scopes.values()) total += s.bytes;
  return total;
}

function put(scope: Scope, object: KubeObject) {
  const trimmed = trimForCache(object as unknown as Record<string, unknown>) as unknown as KubeObject;
  const key = objectKey(trimmed);
  const size = JSON.stringify(trimmed).length;
  scope.bytes += size - (scope.sizes.get(key) ?? 0);
  scope.sizes.set(key, size);
  scope.objects.set(key, trimmed);
}

function remove(scope: Scope, object: KubeObject) {
  const key = objectKey(object);
  scope.bytes -= scope.sizes.get(key) ?? 0;
  scope.sizes.delete(key);
  scope.objects.delete(key);
}

/** Stop a scope's watch and forget it; viewers still subscribed get `error` with `why`. */
function stopScope(scope: Scope, why?: Error) {
  if (scope.status === 'stopped') return;
  scope.status = 'stopped';
  clearTimeout(scope.idleTimer);
  scope.abort.abort();
  scope.wake?.();
  scope.client?.close();
  scope.client = null;
  if (scope.cluster.scopes.get(scope.id) === scope) scope.cluster.scopes.delete(scope.id);
  if (scope.cluster.scopes.size === 0 && clusters.get(scope.cluster.source.key) === scope.cluster) {
    clusters.delete(scope.cluster.source.key);
  }
  scope.objects.clear();
  scope.sizes.clear();
  scope.bytes = 0;
  if (why) {
    scope.error = why;
    scope.ready.reject(why);
    emit(scope, { type: 'error', resource: scope.resource, namespace: scope.namespace, error: why });
  }
  scope.listeners.clear();
}

/** Over the memory cap: drop the least-viewed scopes (oldest first) until under it. */
function enforceCap(cluster: ClusterCache) {
  while (clusterBytes(cluster) > limits.maxClusterBytes && cluster.scopes.size) {
    const victim = [...cluster.scopes.values()].sort((a, b) => a.viewers - b.viewers || a.lastUsed - b.lastUsed)[0]!;
    logger.warn(
      { clusterId: cluster.source.clusterId, resource: victim.resource, namespace: victim.namespace, bytes: victim.bytes },
      'Kubernetes cache over its memory cap; dropping a scope',
    );
    stopScope(
      victim,
      new KubeError(
        `There are too many ${victim.resource} to follow live${victim.namespace ? ` in ${victim.namespace}` : ''}; pick a namespace to narrow the view`,
        507,
      ),
    );
  }
}

function sleep(scope: Scope, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      scope.wake = null;
      resolve();
    }
    scope.wake = done;
  });
}

/** Read through a function so TypeScript does not narrow it across awaits. */
const stopped = (scope: Scope) => scope.status === 'stopped';

async function relist(scope: Scope, client: KubeClient, signal: AbortSignal) {
  const list = await client.list(scope.resource, { namespace: scope.namespace, signal });
  if (signal.aborted) return;
  scope.objects.clear();
  scope.sizes.clear();
  scope.bytes = 0;
  for (const item of list.items) put(scope, item);
  scope.resourceVersion = list.resourceVersion || null;
  // Too big to keep: dropped (and its viewers told) before anyone reads it
  enforceCap(scope.cluster);
  if (stopped(scope)) return;
  const first = !scope.hasData;
  scope.hasData = true;
  scope.status = 'ready';
  scope.error = null;
  scope.ready.resolve();
  emit(scope, { type: first ? 'ready' : 'changed', resource: scope.resource, namespace: scope.namespace });
}

const isGone = (err: unknown) => err instanceof KubeError && err.statusCode === 410;

async function run(scope: Scope) {
  const client = scope.cluster.source.client();
  scope.client = client;
  let backoff = 1_000;
  while (!stopped(scope)) {
    const started = Date.now();
    try {
      if (!scope.resourceVersion) await relist(scope, client, scope.abort.signal);
      if (stopped(scope)) break;
      // A 410 inside the stream ends this watch only; the loop relists
      const thisWatch = new AbortController();
      let gone = false;
      await client.watch(
        scope.resource,
        {
          namespace: scope.namespace,
          resourceVersion: scope.resourceVersion ?? '',
          signal: AbortSignal.any([scope.abort.signal, thisWatch.signal]),
        },
        (event: WatchEvent) => {
          if (stopped(scope)) return;
          if (event.type === 'ERROR') {
            const code = (event.object as unknown as { code?: number }).code;
            if (code === 410) gone = true;
            thisWatch.abort();
            return;
          }
          const rv = event.object.metadata?.resourceVersion;
          if (rv) scope.resourceVersion = rv;
          if (event.type === 'BOOKMARK') return;
          if (event.type === 'DELETED') remove(scope, event.object);
          else put(scope, event.object);
          emit(scope, { type: 'changed', resource: scope.resource, namespace: scope.namespace });
          enforceCap(scope.cluster);
        },
      );
      if (gone) {
        scope.resourceVersion = null;
        continue;
      }
      backoff = 1_000;
      // A watch the server ends at once, over and over, must not spin
      if (Date.now() - started < 1_000 && !stopped(scope)) await sleep(scope, 1_000);
    } catch (err) {
      if (stopped(scope)) break;
      if (isGone(err)) {
        scope.resourceVersion = null;
        continue;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      scope.error = error;
      if (!scope.hasData) {
        scope.status = 'error';
        scope.ready.reject(error);
        // Whoever subscribes next waits for the retry, not this failure
        scope.ready = deferred();
      }
      emit(scope, { type: 'error', resource: scope.resource, namespace: scope.namespace, error });
      await sleep(scope, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

function startScope(cluster: ClusterCache, resource: KubeResource, namespace: string | null): Scope {
  const scope: Scope = {
    cluster,
    id: scopeId(resource, namespace),
    resource,
    namespace,
    objects: new Map(),
    sizes: new Map(),
    bytes: 0,
    resourceVersion: null,
    status: 'syncing',
    error: null,
    hasData: false,
    viewers: 0,
    listeners: new Set(),
    lastUsed: Date.now(),
    abort: new AbortController(),
    wake: null,
    ready: deferred(),
    client: null,
  };
  cluster.scopes.set(scope.id, scope);
  void run(scope).catch((err: unknown) => logger.error({ err }, 'Kubernetes watch loop failed'));
  return scope;
}

/**
 * Follow `resource` (in `namespace`, or cluster-wide when null) for as long
 * as the returned subscription is held. `listener` hears `ready`, `changed`
 * (once per applied event — coalesce before sending anywhere) and `error`.
 */
export function subscribeKube(
  source: CacheSource,
  resource: KubeResource,
  namespace: string | null,
  listener?: CacheListener,
): CacheSubscription {
  let cluster = clusters.get(source.key);
  if (!cluster) {
    cluster = { source, scopes: new Map() };
    clusters.set(source.key, cluster);
  }
  // A newer client factory (credentials just saved) wins for scopes started from now on
  cluster.source = source;
  let scope = cluster.scopes.get(scopeId(resource, namespace));
  if (!scope) scope = startScope(cluster, resource, namespace);
  else if (scope.status === 'error' && !scope.hasData) scope.wake?.();

  const held = scope;
  held.viewers += 1;
  held.lastUsed = Date.now();
  clearTimeout(held.idleTimer);
  if (listener) held.listeners.add(listener);
  let done = false;

  return {
    resource,
    namespace,
    get ready() {
      return held.ready.promise;
    },
    get status() {
      return held.status;
    },
    get error() {
      return held.error;
    },
    items: () => [...held.objects.values()],
    unsubscribe: () => {
      if (done) return;
      done = true;
      if (listener) held.listeners.delete(listener);
      held.viewers = Math.max(0, held.viewers - 1);
      held.lastUsed = Date.now();
      if (held.viewers === 0 && held.status !== 'stopped') {
        clearTimeout(held.idleTimer);
        held.idleTimer = setTimeout(() => {
          if (held.viewers === 0) stopScope(held);
        }, limits.idleStopMs);
        held.idleTimer.unref?.();
      }
    },
  };
}

export interface ScopeSpec {
  resource: KubeResource;
  namespace: string | null;
}

export interface Snapshot {
  /** Objects per spec, in the order asked. Null when that scope failed. */
  items: (KubeObject[] | null)[];
  /** Per spec: why it has no items, when it has none. */
  errors: (Error | null)[];
}

/**
 * The current objects of several scopes at once, for a JSON view: each is
 * subscribed, its first list awaited (up to `timeoutMs`), read, and let go —
 * the watch keeps running for {@link IDLE_STOP_MS}, so the next view (or the
 * stream that follows) is served from memory.
 */
export async function snapshotKube(source: CacheSource, specs: ScopeSpec[], timeoutMs = 25_000): Promise<Snapshot> {
  const subs = specs.map((s) => subscribeKube(source, s.resource, s.namespace));
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs);
      t.unref?.();
    });
    const settled = await Promise.all(
      subs.map((sub) =>
        Promise.race([sub.ready.then(() => null as Error | null, (err: unknown) => err as Error), timeout]).then((r) =>
          r === 'timeout' ? new KubeError('The Kubernetes API did not answer in time', 504) : r,
        ),
      ),
    );
    return {
      items: subs.map((sub, i) => (settled[i] ? null : sub.items())),
      errors: settled,
    };
  } finally {
    for (const sub of subs) sub.unsubscribe();
  }
}

/** Drop every scope of a cluster (credentials or route changed, or it was removed). */
export function dropClusterCache(clusterId: string, why = 'The cluster was changed'): number {
  let dropped = 0;
  for (const cluster of [...clusters.values()]) {
    if (cluster.source.clusterId !== clusterId) continue;
    for (const scope of [...cluster.scopes.values()]) {
      stopScope(scope, new KubeError(why, 409));
      dropped++;
    }
    clusters.delete(cluster.source.key);
  }
  return dropped;
}

/**
 * Drop the per-user (impersonated) scopes of `userId` — in one org when
 * `orgId` is given, sparing clusters in `keepClusterIds`. Shared scopes stay:
 * the user's streams on them are ended separately (kube/index.ts).
 */
export function dropIdentityCaches(userId: string, scope: { orgId?: string; keepClusterIds?: Iterable<string> } = {}): number {
  const keep = new Set(scope.keepClusterIds ?? []);
  let dropped = 0;
  for (const cluster of [...clusters.values()]) {
    const src = cluster.source;
    if (src.identityUserId !== userId) continue;
    if (scope.orgId && src.orgId !== scope.orgId) continue;
    if (keep.has(src.clusterId)) continue;
    for (const s of [...cluster.scopes.values()]) {
      stopScope(s, new KubeError('Your access has changed.', 403));
      dropped++;
    }
    clusters.delete(src.key);
  }
  return dropped;
}

/** What is cached (tests and diagnostics). */
export function kubeCacheStats(): { key: string; scope: string; viewers: number; objects: number; bytes: number; status: ScopeStatus }[] {
  const out = [];
  for (const cluster of clusters.values()) {
    for (const s of cluster.scopes.values()) {
      out.push({ key: cluster.source.key, scope: s.id, viewers: s.viewers, objects: s.objects.size, bytes: s.bytes, status: s.status });
    }
  }
  return out;
}

/** Stop everything (tests, shutdown). */
export function resetKubeCache(): void {
  for (const cluster of [...clusters.values()]) {
    for (const s of [...cluster.scopes.values()]) stopScope(s);
  }
  clusters.clear();
}
