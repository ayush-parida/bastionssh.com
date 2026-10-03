import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AIAgentEvent, KubeCluster, KubeExplainEvent, KubeFleetOverview } from '@smt/shared';

/**
 * Kubernetes integrations (K5) end to end against the fake API server: the
 * fleet overview (partial results, deadlines, access), the AI assistant's
 * read-only Kubernetes tools (redaction, the §7 matrix, cluster access and
 * the namespace allowlist, auditing), "Explain" (what reaches the provider)
 * and the opt-in cluster alerts through the notification pipeline.
 */
const ai = vi.hoisted(() => ({
  script: [] as Array<{ name: string; input: Record<string, unknown> }>,
  nextId: 0,
  /** Messages each `chat` call was given. */
  prompts: [] as Array<Array<{ role: string; content: string }>>,
}));
const notify = vi.hoisted(() => ({ events: [] as import('../../notifications/index.js').AlertEvent[] }));

vi.mock('../../ai/registry.js', () => ({
  getAIProvider: () => ({
    async *chat(messages: Array<{ role: string; content: string }>) {
      ai.prompts.push(messages);
      yield 'The app ';
      yield 'keeps crashing.';
    },
    async *agentLoop(
      _messages: unknown,
      _tools: unknown,
      execute: (name: string, input: Record<string, unknown>, id: string) => Promise<string>,
    ) {
      for (const call of ai.script) {
        const id = `call-${++ai.nextId}`;
        yield { type: 'tool_call', id, name: call.name, input: call.input };
        let output: string;
        let isError = false;
        try {
          output = await execute(call.name, call.input, id);
        } catch (err) {
          output = (err as Error).message;
          isError = true;
        }
        yield { type: 'tool_result', id, name: call.name, output, isError };
      }
      yield { type: 'done' };
    },
  }),
}));

vi.mock('../../notifications/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../notifications/index.js')>();
  return {
    ...actual,
    notifyAlertsChanged: (events: import('../../notifications/index.js').AlertEvent[]) => notify.events.push(...events),
  };
});

import net from 'node:net';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { auditLog, kubeClusters } from '../../db/schema.js';
import { vault } from '../../vault/index.js';
import { AGENT_TOOLS, ToolExecutor } from '../../ai/tools.js';
import { resetKubeCache } from '../../kube/cache.js';
import { kubeFleetLimits } from '../../kube/fleet.js';
import { clusterAlertLimits, forgetClusterAlerts, openClusterAlerts, sweepClusterAlerts } from '../../kube/alerts.js';
import { REDACTED } from '../../kube/redact.js';
import { activeKubeStreamCount } from '../../kube/sse.js';
import { FAKE_TOKEN, deployment, fakeKubeconfig, node, pod, startFakeApi, type FakeApi } from '../../kube/fake-api.test-helper.js';
import { seedOrg, seedUser } from './test-utils.js';

type Who = ReturnType<typeof seedUser>;

const SECRET_VALUE = 'aHVudGVyMg==';

function parseEvents<T>(body: string): T[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)) as T);
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('kube integrations (K5)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: FakeApi;
  let silent: net.Server;
  let base: string;
  let orgId: string;
  let owner: Who;
  let admin: Who;
  let operator: Who;
  let viewer: Who;
  let restricted: Who;
  let prod: string;
  let narrow: string;
  let dead: string;
  let slow: string;

  const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: who.headers });
  const send = (who: Who, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: who.headers, ...(payload && { payload }) });

  /** A cluster row pointing elsewhere, with the fake API's CA and token. */
  async function extraCluster(name: string, apiUrl: string): Promise<string> {
    const template = getDb().select().from(kubeClusters).where(eq(kubeClusters.id, prod)).get()!;
    const id = nanoid();
    getDb()
      .insert(kubeClusters)
      .values({ ...template, id, name, apiUrl, encryptedCredential: await vault.encrypt(FAKE_TOKEN, id) })
      .run();
    return id;
  }

  const audited = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.orgId, orgId)))
      .all()
      .map((r) => ({ ...r, metadata: JSON.parse(r.metadata ?? '{}') as Record<string, unknown> }));

  const chat = (who: Who) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: who.headers,
      payload: { messages: [{ role: 'user', content: 'what is wrong?' }], agentMode: true },
    });

  async function explain(who: Who, clusterId: string, body: object) {
    const res = await fetch(`${base}/api/kube/clusters/${clusterId}/explain`, {
      method: 'POST',
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    await runMigrations();
    kubeFleetLimits.timeoutMs = 2_000;
    clusterAlertLimits.timeoutMs = 2_000;
    api = await startFakeApi();
    api.add('nodes', node('cp-1', { roles: ['control-plane'] }));
    api.add('nodes', node('worker-2', { ready: false }));
    api.add('namespaces', { kind: 'Namespace', metadata: { name: 'shop' }, status: { phase: 'Active' } });
    api.add('deployments', deployment('shop', 'web', { replicas: 1, ready: 1 }));
    api.add('deployments', deployment('shop', 'api', { replicas: 3, ready: 0 }));
    api.add('pods', pod('shop', 'web-1', { node: 'cp-1', labels: { app: 'web' }, secretEnv: { secret: 'db', key: 'password' } }));
    api.add('pods', pod('shop', 'web-2', { node: 'cp-1', labels: { app: 'web' }, waiting: 'CrashLoopBackOff', restarts: 12 }));
    api.add('pods', pod('shop', 'huge', { unschedulable: '0/2 nodes are available: 2 Insufficient memory.' }));
    api.add('pods', pod('kube-system', 'coredns-1', { node: 'cp-1' }));
    api.add('secrets', {
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'db',
        namespace: 'shop',
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': `{"data":{"password":"${SECRET_VALUE}"}}` },
      },
      data: { password: SECRET_VALUE },
    });
    api.add('events', {
      kind: 'Event',
      metadata: { name: 'web-2.17a', namespace: 'shop' },
      involvedObject: { kind: 'Pod', name: 'web-2', namespace: 'shop' },
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container app in pod web-2',
      count: 37,
      lastTimestamp: '2026-10-03T11:59:00Z',
    });
    api.add('events', {
      kind: 'Event',
      metadata: { name: 'huge.1', namespace: 'shop' },
      involvedObject: { kind: 'Pod', name: 'huge', namespace: 'shop' },
      type: 'Warning',
      reason: 'FailedScheduling',
      message: '0/2 nodes are available: 2 Insufficient memory.',
      lastTimestamp: '2026-10-03T11:58:00Z',
    });
    // Accepts connections and never answers: a cluster that hangs
    silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));

    orgId = seedOrg('org-kube-k5');
    owner = seedUser(orgId, 'owner');
    admin = seedUser(orgId, 'admin');
    operator = seedUser(orgId, 'operator');
    viewer = seedUser(orgId, 'viewer');
    restricted = seedUser(orgId, 'operator');

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const created = await send(admin, 'POST', '/api/kube/clusters', { name: 'prod', kubeconfig: fakeKubeconfig(api, { namespace: 'shop' }) });
    expect(created.statusCode).toBe(201);
    prod = (created.json() as KubeCluster).id;
    const narrowed = await send(admin, 'POST', '/api/kube/clusters', {
      name: 'narrow',
      kubeconfig: fakeKubeconfig(api),
      defaultNamespace: 'kube-system',
      namespacesAllowlist: ['kube-system'],
    });
    expect(narrowed.statusCode).toBe(201);
    narrow = (narrowed.json() as KubeCluster).id;
    dead = await extraCluster('dead', `https://127.0.0.1:${await closedPort()}`);
    slow = await extraCluster('slow', `https://127.0.0.1:${(silent.address() as net.AddressInfo).port}`);

    const provider = await send(admin, 'POST', '/api/ai/providers', { name: 'stub', provider: 'anthropic', model: 'm', apiKey: 'k', isDefault: true });
    expect(provider.statusCode).toBe(201);
    const grant = await send(admin, 'PUT', `/api/team/members/${restricted.userId}/access`, {
      serverAccess: 'restricted',
      serverIds: [],
      clusterIds: [prod],
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    resetKubeCache();
    forgetClusterAlerts();
    await app.close();
    await api.close();
    silent.close();
  });

  beforeEach(() => {
    ai.script = [];
    ai.prompts.length = 0;
    notify.events.length = 0;
  });

  describe('fleet overview', () => {
    it('answers with every accessible cluster, the broken and hanging ones as error rows', async () => {
      const started = Date.now();
      const res = await get(viewer, '/api/kube/overview');
      expect(res.statusCode).toBe(200);
      const overview = res.json() as KubeFleetOverview;
      expect(overview.alertsEnabled).toBe(false);
      expect(overview.clusters.map((c) => c.name)).toEqual(['dead', 'narrow', 'prod', 'slow']);
      const byName = Object.fromEntries(overview.clusters.map((c) => [c.name, c]));

      expect(byName.prod).toMatchObject({
        ok: true,
        nodes: { total: 2, ready: 1, cordoned: 0 },
        pods: { running: 2, pending: 1, failing: 1, completed: 0, terminating: 0 },
        workloads: { healthy: 1, failed: 1 },
      });
      expect(byName.prod!.problems[0]).toMatchObject({ ref: { kind: 'Node', name: 'worker-2' }, severity: 'critical', reason: 'NotReady' });
      expect(byName.prod!.problems).toContainEqual(
        expect.objectContaining({ ref: expect.objectContaining({ kind: 'Pod', namespace: 'shop', name: 'web-2' }), reason: 'CrashLoopBackOff' }),
      );
      expect(byName.prod!.problems).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ kind: 'Deployment', name: 'api' }) }));

      // The allowlist applies: only kube-system is counted
      expect(byName.narrow).toMatchObject({ ok: true, pods: { running: 1, pending: 0, failing: 0 }, workloads: {} });

      expect(byName.dead).toMatchObject({ ok: false, clusterId: dead, nodes: { total: 0 } });
      expect(byName.dead!.error).toMatch(/Could not reach|ECONNREFUSED|refused/i);
      expect(byName.slow).toMatchObject({ ok: false, clusterId: slow });
      expect(byName.slow!.error).toMatch(/No answer within 2 s|did not answer in time|timed out/);
      // Five at a time, each with its own deadline: the hanging cluster does not hold up the rest for long
      expect(Date.now() - started).toBeLessThan(kubeFleetLimits.timeoutMs * 2 + 2_000);
    }, 20_000);

    it('shows a restricted member only their granted clusters', async () => {
      const overview = (await get(restricted, '/api/kube/overview')).json() as KubeFleetOverview;
      expect(overview.clusters.map((c) => c.clusterId)).toEqual([prod]);
    });
  });

  describe('AI tools', () => {
    const executor = (who: Who) => new ToolExecutor(orgId, who.userId);

    it('are offered as read-only tools, and say Secret values stay redacted', () => {
      for (const name of ['kube_list_workloads', 'kube_describe', 'kube_events', 'kube_pod_logs']) {
        const tool = AGENT_TOOLS.find((t) => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool!.description).toMatch(/read-only/i);
      }
      expect(AGENT_TOOLS.find((t) => t.name === 'kube_describe')!.description).toMatch(/Secret values are always removed/);
    });

    it('list, describe, read events and logs without approval, each read audited against the cluster', async () => {
      ai.script = [
        { name: 'kube_list_workloads', input: { cluster_id: prod, namespace: 'shop' } },
        { name: 'kube_describe', input: { cluster_id: prod, resource: 'secrets', namespace: 'shop', name: 'db' } },
        { name: 'kube_describe', input: { cluster_id: prod, resource: 'pods', namespace: 'shop', name: 'web-1' } },
        { name: 'kube_events', input: { cluster_id: prod, resource: 'pods', namespace: 'shop', name: 'web-2' } },
        { name: 'kube_pod_logs', input: { cluster_id: prod, namespace: 'shop', pod: 'web-2', tail: 20, previous: true } },
      ];
      const res = await chat(operator);
      const events = parseEvents<AIAgentEvent>(res.body);
      expect(events.some((e) => e.type === 'approval_required')).toBe(false);
      const results = events.filter((e): e is Extract<AIAgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
      expect(results.map((r) => r.isError)).toEqual([false, false, false, false, false]);
      const [list, secret, webPod, podEvents, logs] = results.map((r) => r.output);

      expect(list).toMatch(/shop\/Deployment api: failed — 0 of 3 ready/);
      expect(list).toMatch(/shop\/web-2: failing \(CrashLoopBackOff\), 12 restarts/);
      expect(list).toMatch(/shop\/huge: pending \(Unschedulable\)/);

      expect(secret).toContain('password');
      expect(secret).toContain(REDACTED);
      expect(secret).not.toContain(SECRET_VALUE);
      expect(secret).not.toContain('last-applied-configuration');
      // The env reference is kept; there is no value to leak
      expect(webPod).toMatch(/secretKeyRef/);
      expect(webPod).toMatch(/Health: running/);

      expect(podEvents).toMatch(/Warning BackOff Pod\/web-2: Back-off restarting failed container app in pod web-2 \(×37\)/);
      expect(podEvents).not.toMatch(/FailedScheduling/);

      expect(logs!.length).toBeGreaterThan(0);
      expect(api.requests).toContainEqual(expect.stringMatching(/\/api\/v1\/namespaces\/shop\/pods\/web-2\/log\?previous=true&tailLines=20&limitBytes=\d+/));

      const rows = audited('ai.kube_read');
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.resourceType === 'kube_cluster' && r.resourceId === prod && r.resourceName === 'prod')).toBe(true);
      expect(rows.map((r) => r.metadata.tool)).toEqual(['kube_list_workloads', 'kube_describe', 'kube_describe', 'kube_events', 'kube_pod_logs']);
      // What was read, never what came back
      expect(JSON.stringify(rows)).not.toContain(SECRET_VALUE);
    });

    it('keep viewers to what the UI shows them: no YAML-like describe, no logs', async () => {
      const tools = executor(viewer);
      await expect(tools.execute('kube_list_workloads', { cluster_id: prod })).resolves.toMatch(/Workloads:/);
      await expect(tools.execute('kube_describe', { cluster_id: prod, resource: 'pods', namespace: 'shop', name: 'web-1' })).rejects.toThrow(/operator/);
      await expect(tools.execute('kube_pod_logs', { cluster_id: prod, namespace: 'shop', pod: 'web-2' })).rejects.toThrow(/operator/);
    });

    it('answer "not found" for clusters the member may not use, and respect the namespace allowlist', async () => {
      const tools = executor(restricted);
      await expect(tools.execute('kube_list_workloads', { cluster_id: narrow })).rejects.toThrow('Cluster not found');
      await expect(tools.execute('kube_list_workloads', { cluster_id: 'nope' })).rejects.toThrow('Cluster not found');
      await expect(tools.execute('kube_list_workloads', {})).rejects.toThrow(/cluster_id/);

      const op = executor(operator);
      await expect(op.execute('kube_describe', { cluster_id: narrow, resource: 'pods', namespace: 'shop', name: 'web-1' })).rejects.toThrow(
        'Not found',
      );
      await expect(op.execute('kube_pod_logs', { cluster_id: narrow, namespace: 'shop', pod: 'web-2' })).rejects.toThrow('Not found');
      await expect(op.execute('kube_list_workloads', { cluster_id: narrow, namespace: 'shop' })).rejects.toThrow('Namespace not found');
      const listed = await op.execute('kube_list_workloads', { cluster_id: narrow });
      expect(listed).not.toContain('shop/');
      // Bad names never reach a URL
      await expect(op.execute('kube_describe', { cluster_id: prod, resource: 'pods', namespace: 'shop', name: '../x' })).rejects.toThrow(
        'Invalid object name',
      );
      await expect(op.execute('kube_describe', { cluster_id: prod, resource: 'clusterroles', name: 'x' })).rejects.toThrow(/Unknown/);
    });

    it('list the clusters the member may use in the system prompt', async () => {
      const { buildSystemPrompt } = await import('../../ai/tools.js');
      const all = buildSystemPrompt({ orgId, userId: operator.userId });
      expect(all).toContain(`prod (id: ${prod})`);
      expect(all).toContain(`narrow (id: ${narrow})`);
      const granted = buildSystemPrompt({ orgId, userId: restricted.userId });
      expect(granted).toContain(`prod (id: ${prod})`);
      expect(granted).not.toContain(narrow);
    });
  });

  describe('explain', () => {
    it('sends the redacted object, its events and a log tail, and streams the answer back', async () => {
      const { status, text } = await explain(operator, prod, { resource: 'pods', namespace: 'shop', name: 'web-2' });
      expect(status).toBe(200);
      const events = parseEvents<KubeExplainEvent>(text);
      expect(events[0]).toEqual({
        type: 'context',
        context: expect.objectContaining({
          ref: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'web-2' },
          provider: 'stub',
          pods: 0,
        }),
      });
      const context = (events[0] as Extract<KubeExplainEvent, { type: 'context' }>).context;
      expect(context.events).toBe(1);
      expect(context.logLines).toBeGreaterThan(0);
      expect(events.filter((e) => e.type === 'delta').map((e) => (e as { content: string }).content).join('')).toBe('The app keeps crashing.');
      expect(events.at(-1)).toEqual({ type: 'done' });

      const [system, user] = ai.prompts[0]!;
      expect(system!.content).toMatch(/cannot perform actions/);
      expect(user!.content).toMatch(/CrashLoopBackOff/);
      expect(user!.content).toMatch(/Back-off restarting failed container/);
      expect(user!.content).toMatch(/Last log lines of web-2\/app \(previous run/);

      const [row] = audited('kube.ai_explain');
      expect(row).toMatchObject({ resourceId: prod, resourceName: 'prod' });
      expect(row!.metadata).toMatchObject({ resource: 'pods', namespace: 'shop', name: 'web-2', provider: 'stub', events: 1 });
      expect(activeKubeStreamCount()).toBe(0);
    });

    it('explains a workload from its troubled pods, and never sends a Secret value', async () => {
      const workload = await explain(operator, prod, { resource: 'deployments', namespace: 'shop', name: 'web' });
      expect(workload.status).toBe(200);
      expect(ai.prompts[0]![1]!.content).toMatch(/- web-2: failing \(CrashLoopBackOff\), 12 restarts/);

      const secret = await explain(operator, prod, { resource: 'secrets', namespace: 'shop', name: 'db' });
      expect(secret.status).toBe(200);
      const prompt = ai.prompts[1]![1]!.content;
      expect(prompt).toContain('password');
      expect(prompt).not.toContain(SECRET_VALUE);
      expect(secret.text).not.toContain(SECRET_VALUE);
    });

    it('is for operators and up, on clusters and namespaces they may see', async () => {
      expect((await explain(viewer, prod, { resource: 'pods', namespace: 'shop', name: 'web-2' })).status).toBe(403);
      expect((await explain(restricted, narrow, { resource: 'pods', namespace: 'kube-system', name: 'coredns-1' })).status).toBe(404);
      expect((await explain(operator, narrow, { resource: 'pods', namespace: 'shop', name: 'web-2' })).status).toBe(404);
      expect((await explain(operator, prod, { resource: 'pods', namespace: 'shop', name: 'nope' })).status).toBe(404);
      expect((await explain(operator, prod, { resource: 'pods', namespace: 'Shop!', name: 'web-2' })).status).toBe(400);
      const noProvider = await explain(operator, prod, { resource: 'pods', namespace: 'shop', name: 'web-2', providerId: 'nope' });
      expect(noProvider.status).toBe(400);
      expect(ai.prompts).toHaveLength(0);
    });
  });

  describe('cluster alerts', () => {
    it('stay off until an admin turns them on', async () => {
      await sweepClusterAlerts();
      expect(openClusterAlerts(prod)).toEqual([]);
      expect(notify.events).toEqual([]);
    });

    it('raise node, workload, crash-loop and pending alerts once, through the notification pipeline', async () => {
      expect((await send(owner, 'PATCH', '/api/kube/settings', { clusterAlerts: true })).statusCode).toBe(200);
      await sweepClusterAlerts();
      const types = openClusterAlerts(prod).map((a) => `${a.type} ${a.object}`).sort();
      expect(types).toEqual([
        'kube_node_not_ready Node worker-2',
        'kube_pod_crashloop shop/Pod web-2',
        'kube_pod_pending shop/Pod huge',
        'kube_workload_unavailable shop/Deployment api',
      ]);
      const opened = notify.events.filter((e) => e.serverId === prod);
      expect(opened).toHaveLength(4);
      expect(opened.every((e) => e.kind === 'opened' && e.subject?.name === 'prod')).toBe(true);
      // The allowlisted cluster only looks at kube-system: its node alert, nothing from shop
      expect(openClusterAlerts(narrow).map((a) => a.type)).toEqual(['kube_node_not_ready']);
      // Not yet unreachable: one failed read is a hiccup
      expect(openClusterAlerts(dead)).toEqual([]);

      notify.events.length = 0;
      await sweepClusterAlerts();
      expect(notify.events.filter((e) => e.serverId === prod)).toEqual([]);

      // The fleet overview shows them
      const overview = (await get(operator, '/api/kube/overview')).json() as KubeFleetOverview;
      expect(overview.alertsEnabled).toBe(true);
      expect(overview.clusters.find((c) => c.clusterId === prod)!.alerts).toHaveLength(4);
    }, 20_000);

    it('resolve when the problem goes away, and are forgotten quietly when turned off', async () => {
      api.modify('nodes', node('worker-2'));
      // The watch cache follows the change
      await new Promise((r) => setTimeout(r, 200));
      await sweepClusterAlerts();
      expect(openClusterAlerts(prod).map((a) => a.type)).not.toContain('kube_node_not_ready');
      expect(notify.events).toContainEqual(expect.objectContaining({ kind: 'resolved', serverId: prod, type: 'kube_node_not_ready' }));

      notify.events.length = 0;
      await send(owner, 'PATCH', '/api/kube/settings', { clusterAlerts: false });
      await sweepClusterAlerts();
      expect(openClusterAlerts(prod)).toEqual([]);
      expect(notify.events).toEqual([]);
    }, 20_000);
  });
});
