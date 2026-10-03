import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * Inside a pod (K4) against a stubbed Kubernetes API: the pod panel's
 * lifecycle strip and container lanes (init → sidecar → app, state colours,
 * restarts, the previous run), usage bars against requests and limits, the
 * Logs tab (container picker, previous run, search), the read-only YAML, and
 * "Open shell" landing on the terminal page for the pod.
 */

const CLUSTER = 'kube-e2e-pods';
const POD = `/kubernetes/${CLUSTER}/objects/pods/shop/worker-1`;

const permissions = {
  view: true,
  logs: true,
  yaml: true,
  scale: true,
  deletePod: true,
  rollback: false,
  cordon: false,
  exec: true,
  configure: false,
};

const cluster = {
  id: CLUSTER,
  name: 'shop-prod',
  apiUrl: 'https://k8s.example.com:6443',
  connectVia: 'direct',
  viaServerId: null,
  viaServerName: null,
  viaAgentId: null,
  viaAgentName: null,
  hasCa: true,
  authType: 'token',
  credentialHint: 'token ending …abcd',
  impersonate: false,
  defaultNamespace: 'shop',
  namespacesAllowlist: null,
  lastStatus: 'ok',
  lastError: null,
  lastCheckedAt: new Date().toISOString(),
  serverVersion: 'v1.31.5',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const none = { cpuMillis: null, memoryBytes: null };

function container(name: string, role: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    role,
    image: `shop/${name}:1.4.2`,
    state: 'running',
    reason: null,
    message: null,
    since: new Date(Date.now() - 3_600_000).toISOString(),
    exitCode: null,
    ready: true,
    restarts: 0,
    lastTermination: null,
    requests: none,
    limits: none,
    usage: null,
    ports: [],
    ...extra,
  };
}

const podDetail = {
  namespace: 'shop',
  name: 'worker-1',
  phase: 'Running',
  nodeName: 'node-a',
  podIP: '10.42.0.17',
  startedAt: new Date().toISOString(),
  containers: [
    container('migrate', 'init', { state: 'terminated', reason: 'Completed', exitCode: 0, ready: false }),
    container('proxy', 'sidecar', { requests: { cpuMillis: 50, memoryBytes: 32 * 2 ** 20 }, usage: { cpuMillis: 10, memoryBytes: 20 * 2 ** 20 } }),
    container('worker', 'app', {
      state: 'waiting',
      reason: 'CrashLoopBackOff',
      message: 'back-off 5m0s restarting failed container',
      since: null,
      ready: false,
      restarts: 37,
      lastTermination: { reason: 'OOMKilled', exitCode: 137, finishedAt: new Date().toISOString() },
      requests: { cpuMillis: 100, memoryBytes: 128 * 2 ** 20 },
      limits: { cpuMillis: 500, memoryBytes: 256 * 2 ** 20 },
    }),
    container('web', 'app', {
      requests: { cpuMillis: 200, memoryBytes: 128 * 2 ** 20 },
      limits: { cpuMillis: 1000, memoryBytes: 512 * 2 ** 20 },
      usage: { cpuMillis: 950, memoryBytes: 100 * 2 ** 20 },
      ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    }),
  ],
  lifecycle: [
    { id: 'scheduled', label: 'Scheduled', status: 'done', at: new Date().toISOString(), detail: null },
    { id: 'initialized', label: 'Initialized', status: 'done', at: new Date().toISOString(), detail: null },
    { id: 'started', label: 'Started', status: 'failed', at: null, detail: 'worker: CrashLoopBackOff — back-off 5m0s restarting failed container' },
    { id: 'ready', label: 'Ready', status: 'pending', at: null, detail: null },
  ],
  defaultContainer: 'web',
  metricsAvailable: true,
};

const objectDetail = {
  ref: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'worker-1' },
  health: 'failing',
  facts: [{ label: 'Node', value: 'node-a' }],
  labels: { app: 'worker' },
  related: [],
};

const yaml = [
  'apiVersion: v1',
  'kind: Pod',
  'metadata:',
  '  name: worker-1',
  'spec:',
  '  containers:',
  '    - name: worker',
  '      env:',
  '        - name: PASSWORD',
  '          valueFrom:',
  '            secretKeyRef:',
  '              name: worker-secret',
  '              key: password',
  '',
].join('\n');

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** Answer the Kubernetes API; `logs` records each log request's query. */
async function stubKube(page: Page, logs: URLSearchParams[]) {
  await page.route('**/api/kube/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/kube', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const base = `/clusters/${CLUSTER}`;

    if (path === base) return json({ cluster, permissions });
    if (path === `${base}/namespaces`) return json([{ name: 'shop', phase: 'Active', createdAt: null, labels: {} }]);
    if (path === `${base}/overview`) {
      return json({ clusterId: CLUSTER, serverVersion: 'v1.31.5', metricsAvailable: true, namespaces: ['shop'], nodes: [], unscheduled: [], warnings: [], generatedAt: new Date().toISOString() });
    }
    if (path === `${base}/stream`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse([{ type: 'ready' }]) });
    if (path === `${base}/objects/pods/shop/worker-1`) return json(objectDetail);
    if (path === `${base}/objects/pods/shop/worker-1/yaml`) return json({ yaml, redacted: false });
    if (path === `${base}/pods/shop/worker-1`) return json(podDetail);
    if (path === `${base}/pods/shop/worker-1/logs`) {
      logs.push(url.searchParams);
      const name = url.searchParams.get('container') ?? 'web';
      const previous = url.searchParams.get('previous') === '1';
      const lines = previous
        ? [{ text: 'loading 2GB cache' }, { text: 'Killed' }]
        : [{ text: `${name}: listening on :8080` }, { text: `${name}: GET /healthz 200` }, { text: `${name}: GET /orders 500` }];
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([{ type: 'ready', container: name, previous }, { type: 'logs', lines }, { type: 'end' }]),
      });
    }
    if (path === `${base}/pods/shop/worker-1/exec` && req.method() === 'POST') {
      const body = req.postDataJSON() as { container?: string };
      return json(
        {
          sessionId: 'pod-shell-e2e',
          wsUrl: 'ws://localhost/api/ssh-sessions/pod-shell-e2e/ws',
          pod: { clusterId: CLUSTER, clusterName: 'shop-prod', namespace: 'shop', name: 'worker-1', container: body.container ?? 'web' },
          cmd: ['/bin/sh'],
          recording: { id: 'rec-1', inputRecorded: false },
        },
        201,
      );
    }
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Kubernetes pod panel', () => {
  let operator: { email: string; password: string };
  test.beforeAll(async () => {
    operator = await createMember('operator', 'kube-pods');
  });

  test('shows the lifecycle, containers as lanes and usage against limits', async ({ page }) => {
    await stubKube(page, []);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(POD);

    const panel = page.getByTestId('kube-object-panel');
    const steps = panel.getByTestId('pod-lifecycle').locator('li[data-status]');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(2)).toHaveAttribute('data-status', 'failed');
    await expect(panel.getByTestId('pod-lifecycle')).toContainText('worker: CrashLoopBackOff');

    // Init, then sidecar, then the app containers, each coloured by state
    const lanes = panel.getByTestId('container-lane');
    await expect(lanes).toHaveCount(4);
    await expect(lanes.nth(0)).toHaveAttribute('data-role', 'init');
    await expect(lanes.nth(0)).toHaveAttribute('data-tone', 'done');
    await expect(lanes.nth(1)).toHaveAttribute('data-role', 'sidecar');
    await expect(lanes.nth(2)).toHaveAttribute('data-tone', 'bad');
    await expect(lanes.nth(2)).toContainText('CrashLoopBackOff');
    await expect(lanes.nth(2)).toContainText('37 restarts');
    await expect(lanes.nth(2).getByTestId('last-termination')).toContainText('OOMKilled (exit 137)');
    await expect(lanes.nth(3)).toHaveAttribute('data-tone', 'ok');

    // 950m of a 1-core limit: near it, so amber/red; the request is marked
    const cpu = lanes.nth(3).getByTestId('usage-cpu');
    await expect(cpu).toContainText('950m of 1');
    await expect(cpu).toContainText('asked 200m');
    await expect(cpu.locator('.bg-red-500')).toHaveCount(1);

    // A crash-looping container offers no shell; a running one does
    await expect(lanes.nth(2).getByRole('button', { name: 'Shell' })).toHaveCount(0);
    await expect(lanes.nth(3).getByRole('button', { name: 'Shell' })).toBeVisible();
  });

  test('reads logs: the picked container, the previous run, search', async ({ page }) => {
    const logs: URLSearchParams[] = [];
    await stubKube(page, logs);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(POD);

    const panel = page.getByTestId('kube-object-panel');
    // "its logs" on the crashed run opens the previous run of that container
    await panel.getByTestId('container-lane').nth(2).getByRole('button', { name: 'its logs' }).click();
    const lines = panel.getByTestId('log-lines');
    await expect(lines).toContainText('Killed');
    await expect(panel.getByTestId('pod-logs')).toContainText('it ended with OOMKilled (exit 137)');
    expect(logs.at(-1)?.get('container')).toBe('worker');
    expect(logs.at(-1)?.get('previous')).toBe('1');
    expect(logs.at(-1)?.get('follow')).toBeNull();

    // Back to the current run of another container, followed
    await panel.getByTestId('log-container').selectOption('web');
    await expect(lines).toContainText('web: GET /orders 500');
    expect(logs.at(-1)?.get('container')).toBe('web');
    expect(logs.at(-1)?.get('follow')).toBe('1');
    expect(logs.at(-1)?.get('previous')).toBeNull();

    await panel.getByLabel('Search the log').fill('500');
    await expect(lines.locator('mark')).toHaveText(['500']);
    await expect(panel.getByTestId('pod-logs')).toContainText('1 of 3 lines');
  });

  test('shows the YAML read-only, with env from Secrets as a reference', async ({ page }) => {
    await stubKube(page, []);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(POD);

    const panel = page.getByTestId('kube-object-panel');
    await panel.getByRole('button', { name: 'YAML', exact: true }).click();
    const view = panel.getByTestId('yaml-view');
    await expect(view).toContainText('Read-only');
    await expect(view).toContainText('secretKeyRef');
    await view.getByLabel('Find in YAML').fill('secret');
    await expect(view).toContainText('2 lines');
  });

  test('opens a shell in a container on the terminal page for the pod', async ({ page }) => {
    await stubKube(page, []);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(POD);

    await page.getByTestId('open-pod-shell').click();
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}/shell$`));
    const target = page.getByTestId('pod-shell-target');
    await expect(target).toContainText('web');
    await expect(target).toContainText('shop/worker-1');
    await expect(target).toContainText('shop-prod');
    await expect(page.getByText('REC', { exact: true })).toBeVisible();
    // No server files or AI assistant inside a pod
    await expect(page.getByRole('button', { name: 'Files' })).toHaveCount(0);
  });

  test('gives viewers neither logs, YAML nor a shell', async ({ page }) => {
    const viewer = await createMember('viewer', 'kube-pods-viewer');
    await stubKube(page, []);
    // Registered last, so it answers first
    await page.route(`**/api/kube/clusters/${CLUSTER}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cluster, permissions: { ...permissions, logs: false, yaml: false, exec: false, scale: false, deletePod: false } }),
      }),
    );
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(POD);

    const panel = page.getByTestId('kube-object-panel');
    await expect(panel.getByTestId('container-lane')).toHaveCount(4);
    await expect(panel.getByRole('button', { name: 'Logs', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'YAML', exact: true })).toHaveCount(0);
    await expect(panel.getByTestId('open-pod-shell')).toHaveCount(0);
  });
});
