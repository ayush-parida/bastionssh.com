import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { KubeCluster, KubeExplainEvent, KubeFleetOverview } from '@smt/shared';

/**
 * K5 (AI tools, Explain, fleet overview, cluster alerts) against a real,
 * throwaway k3s cluster — never one from ~/.kube. Uses the same setup as
 * kube.integration.test.ts:
 *
 *   eval "$(apps/server/scripts/kube-it.sh up | sed 's/^/export /')"
 *   pnpm vitest run src/kube/kube-integrations.integration.test.ts
 *   apps/server/scripts/kube-it.sh down
 *
 * The AI provider is a stub that records what it was sent; everything else
 * (routes, client, cache, the log subresource, events) is real.
 */

const kubeconfigPath = process.env.SMT_TEST_KUBE_KUBECONFIG;

const ai = vi.hoisted(() => ({ prompts: [] as Array<Array<{ role: string; content: string }>> }));
vi.mock('../ai/registry.js', () => ({
  getAIProvider: () => ({
    async *chat(messages: Array<{ role: string; content: string }>) {
      ai.prompts.push(messages);
      yield 'explained';
    },
  }),
}));

const { buildApp } = await import('../api/app.js');
const { runMigrations } = await import('../db/migrate.js');
const { getDb } = await import('../db/index.js');
const { kubeClusters } = await import('../db/schema.js');
const { seedOrg, seedUser } = await import('../api/routes/test-utils.js');
const { ToolExecutor } = await import('../ai/tools.js');
const { openClusterAlerts, sweepCluster, forgetClusterAlerts } = await import('./alerts.js');
const { resetKubeCache } = await import('./cache.js');
const { eq } = await import('drizzle-orm');

const SECRET = 'hunter2-smt-it';

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 120_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > ms) return value;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe.skipIf(!kubeconfigPath)('kubernetes integrations against a live k3s cluster', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let orgId: string;
  let admin: ReturnType<typeof seedUser>;
  let operator: ReturnType<typeof seedUser>;
  let cluster: KubeCluster;

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('kube-it-k5');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const kubeconfig = readFileSync(kubeconfigPath!, 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/api/kube/clusters',
      headers: admin.headers,
      payload: { kubeconfig, context: 'default', name: 'k3s-k5' },
    });
    expect(res.statusCode).toBe(201);
    cluster = res.json();
    const provider = await app.inject({
      method: 'POST',
      url: '/api/ai/providers',
      headers: admin.headers,
      payload: { name: 'stub', provider: 'anthropic', model: 'm', apiKey: 'k', isDefault: true },
    });
    expect(provider.statusCode).toBe(201);
  }, 60_000);

  afterAll(async () => {
    forgetClusterAlerts();
    resetKubeCache();
    await app?.close();
  });

  it('shows the cluster on the fleet overview with its crash-looping and waiting pods', async () => {
    const overview = await eventually(
      async () => (await app.inject({ method: 'GET', url: '/api/kube/overview', headers: operator.headers })).json() as KubeFleetOverview,
      (o) => o.clusters[0]?.problems.some((p) => p.ref.name === 'crasher') ?? false,
    );
    const [row] = overview.clusters;
    expect(row).toMatchObject({ ok: true, nodes: { total: 1, ready: 1 } });
    expect(row!.problems.map((p) => p.ref.name)).toEqual(expect.arrayContaining(['crasher', 'too-big']));
    expect(row!.workloads.healthy).toBeGreaterThanOrEqual(1);
  }, 150_000);

  it('gives the assistant workloads, redacted objects, events and logs', async () => {
    const tools = new ToolExecutor(orgId, operator.userId);
    const list = await tools.execute('kube_list_workloads', { cluster_id: cluster.id, namespace: 'smt-it' });
    expect(list).toMatch(/smt-it\/Deployment web: healthy — 2 of 2 ready/);
    expect(list).toMatch(/smt-it\/crasher: failing/);

    const secret = await tools.execute('kube_describe', { cluster_id: cluster.id, resource: 'secrets', namespace: 'smt-it', name: 'web-secret' });
    expect(secret).toContain('password');
    expect(secret).not.toContain(SECRET);
    expect(secret).not.toContain(Buffer.from(SECRET).toString('base64'));

    const events = await eventually(
      () => tools.execute('kube_events', { cluster_id: cluster.id, namespace: 'smt-it', resource: 'pods', name: 'crasher' }),
      (text) => /BackOff|Started|Pulled/.test(text),
    );
    expect(events).toMatch(/Pod\/crasher/);

    const logs = await eventually(
      () => tools.execute('kube_pod_logs', { cluster_id: cluster.id, namespace: 'smt-it', pod: 'crasher', previous: true, tail: 10 }).catch((e: Error) => e.message),
      (text) => text.includes('starting'),
    );
    expect(logs).toContain('starting');
  }, 150_000);

  it('explains the crash-looping pod from its state, events and previous run’s logs', async () => {
    const res = await fetch(`${base}/api/kube/clusters/${cluster.id}/explain`, {
      method: 'POST',
      headers: { ...operator.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'pods', namespace: 'smt-it', name: 'crasher' }),
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as KubeExplainEvent);
    const context = events.find((e): e is Extract<KubeExplainEvent, { type: 'context' }> => e.type === 'context')!.context;
    expect(context.events).toBeGreaterThan(0);
    expect(context.logLines).toBeGreaterThan(0);
    const prompt = ai.prompts.at(-1)![1]!.content;
    expect(prompt).toMatch(/previous run/);
    expect(prompt).toContain('starting');

    // A workload whose pods take a value from a Secret: the value never goes
    await fetch(`${base}/api/kube/clusters/${cluster.id}/explain`, {
      method: 'POST',
      headers: { ...operator.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'deployments', namespace: 'smt-it', name: 'web' }),
    }).then((r) => r.text());
    expect(ai.prompts.at(-1)![1]!.content).not.toContain(SECRET);
  }, 60_000);

  it('raises a crash-loop alert for the pod once alerts are on', async () => {
    const row = getDb().select().from(kubeClusters).where(eq(kubeClusters.id, cluster.id)).get()!;
    const alerts = await eventually(
      async () => {
        await sweepCluster(row);
        return openClusterAlerts(cluster.id);
      },
      (open) => open.some((a) => a.type === 'kube_pod_crashloop'),
    );
    expect(alerts).toContainEqual(expect.objectContaining({ type: 'kube_pod_crashloop', object: 'smt-it/Pod crasher', severity: 'critical' }));
    expect(alerts.map((a) => a.type)).not.toContain('kube_node_not_ready');
  }, 150_000);
});
