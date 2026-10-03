import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { clientFor } from './service.js';
import {
  dropClusterCache,
  dropIdentityCaches,
  kubeCacheStats,
  limits,
  resetKubeCache,
  snapshotKube,
  subscribeKube,
  type CacheEvent,
  type CacheSource,
} from './cache.js';
import { KubeError } from './errors.js';
import { FAKE_TOKEN, pod, startFakeApi, type FakeApi } from './fake-api.test-helper.js';
import { CA_CERT } from './test-certs.test-helper.js';

/**
 * The watch cache against the fake API server: one list + watch per scope
 * shared by its viewers, changes applied live, `410 Gone` answered with a
 * relist, idle scopes stopped, the memory cap enforced, and scopes dropped
 * when a cluster changes or a user's access does.
 */

const until = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('kube watch cache', () => {
  let api: FakeApi;
  const saved = { ...limits };

  const source = (key = 'c1', identityUserId: string | null = null): CacheSource => ({
    key,
    orgId: 'o1',
    clusterId: 'c1',
    identityUserId,
    client: () =>
      clientFor({
        orgId: 'o1',
        apiUrl: api.url,
        caData: CA_CERT,
        credential: { type: 'token', token: FAKE_TOKEN },
        connectVia: 'direct',
        viaServerId: null,
        viaAgentId: null,
      }),
  });

  beforeAll(async () => {
    api = await startFakeApi();
    api.add('pods', pod('shop', 'web-1'));
    api.add('pods', pod('shop', 'web-2'));
    api.add('pods', pod('other', 'db-1'));
  });

  afterAll(async () => {
    resetKubeCache();
    await api.close();
  });

  afterEach(() => {
    resetKubeCache();
    Object.assign(limits, saved);
  });

  it('lists once, shares the scope between viewers, and applies changes live', async () => {
    const events: CacheEvent[] = [];
    const a = subscribeKube(source(), 'pods', 'shop', (e) => events.push(e));
    const b = subscribeKube(source(), 'pods', 'shop');
    await a.ready;
    await b.ready;
    expect(a.items().map((p) => p.metadata.name).sort()).toEqual(['web-1', 'web-2']);
    expect(kubeCacheStats()).toEqual([expect.objectContaining({ scope: 'pods|shop', viewers: 2, objects: 2, status: 'ready' })]);
    expect(api.requests.filter((r) => r.startsWith('GET /api/v1/namespaces/shop/pods?limit')).length).toBe(1);
    expect(events[0]).toMatchObject({ type: 'ready', resource: 'pods' });

    await until(() => api.watchers() === 1);
    api.add('pods', pod('shop', 'web-3'));
    api.modify('pods', pod('shop', 'web-1', { waiting: 'CrashLoopBackOff' }));
    api.remove('pods', 'shop', 'web-2');
    api.add('pods', pod('other', 'not-mine'));
    await until(() => a.items().length === 2 && a.items().some((p) => p.metadata.name === 'web-3'));
    expect(a.items().map((p) => p.metadata.name).sort()).toEqual(['web-1', 'web-3']);
    expect(events.filter((e) => e.type === 'changed').length).toBeGreaterThanOrEqual(3);
    a.unsubscribe();
    b.unsubscribe();
  });

  it('relists when the watch’s version is too old (410 Gone)', async () => {
    const sub = subscribeKube(source(), 'pods', 'shop');
    await sub.ready;
    await until(() => api.watchers() === 1);
    // The API server restarts its watch cache: history is gone, so resuming gets 410
    api.dropWatches();
    api.compact();
    api.add('pods', pod('shop', 'after-410'));
    api.compact();
    await until(() => sub.items().some((p) => p.metadata.name === 'after-410'));
    expect(api.requests.filter((r) => r.startsWith('GET /api/v1/namespaces/shop/pods?limit')).length).toBeGreaterThanOrEqual(2);
    sub.unsubscribe();
  });

  it('stops a scope’s watch once nobody has looked at it for a while', async () => {
    limits.idleStopMs = 50;
    const sub = subscribeKube(source(), 'pods', 'other');
    await sub.ready;
    await until(() => api.watchers() >= 1);
    sub.unsubscribe();
    await until(() => kubeCacheStats().length === 0);
    await until(() => api.watchers() === 0);
  });

  it('drops the least-viewed scope past the memory cap and tells its viewers why', async () => {
    const events: CacheEvent[] = [];
    const keep = subscribeKube(source(), 'pods', 'shop');
    const keep2 = subscribeKube(source(), 'pods', 'shop');
    await keep.ready;
    limits.maxClusterBytes = 1;
    const victim = subscribeKube(source(), 'pods', 'other', (e) => events.push(e));
    await expect(victim.ready).rejects.toThrow(/too many pods to follow live in other/);
    expect(victim.status).toBe('stopped');
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    keep.unsubscribe();
    keep2.unsubscribe();
  });

  it('reports what the credential may not list, and serves snapshots', async () => {
    api.forbid('nodes');
    try {
      const snap = await snapshotKube(source(), [
        { resource: 'pods', namespace: 'shop' },
        { resource: 'nodes', namespace: null },
      ]);
      expect(snap.items[0]!.length).toBeGreaterThan(0);
      expect(snap.items[1]).toBeNull();
      expect(snap.errors[1]).toBeInstanceOf(KubeError);
      expect((snap.errors[1] as KubeError).statusCode).toBe(403);
    } finally {
      api.forbid('nodes', false);
    }
  });

  it('drops every scope of a changed cluster, and a user’s own scopes on revocation', async () => {
    const events: CacheEvent[] = [];
    const shared = subscribeKube(source(), 'pods', 'shop', (e) => events.push(e));
    const personal = subscribeKube(source('c1:u1', 'u1'), 'pods', 'shop');
    await shared.ready;
    await personal.ready;

    expect(dropIdentityCaches('u1', { orgId: 'o1' })).toBe(1);
    expect(personal.status).toBe('stopped');
    expect(shared.status).toBe('ready');

    expect(dropClusterCache('c1', 'The cluster settings changed')).toBe(1);
    expect(shared.status).toBe('stopped');
    expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.objectContaining({ message: 'The cluster settings changed' }) });
    expect(kubeCacheStats()).toEqual([]);
  });
});
