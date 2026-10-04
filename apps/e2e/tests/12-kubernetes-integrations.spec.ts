import type { Page, Route } from '@playwright/test';
import { createMember, ensureKubernetesShown, expect, signInWithPassword, test } from './fixtures.js';

/**
 * Kubernetes integrations (K5) against a stubbed API: the fleet overview
 * across clusters (node squares, the pod bar, problems linking to their
 * objects, open alerts, a cluster that did not answer) and the AI "Explain"
 * dialog on an object's panel (what was sent, the streamed answer; viewers
 * do not get the button).
 */

const PROD = 'kube-e2e-prod';
const EDGE = 'kube-e2e-edge';

const permissions = {
  view: true,
  logs: true,
  yaml: true,
  scale: true,
  deletePod: true,
  rollback: true,
  cordon: true,
  exec: true,
  configure: false,
};

/** What a viewer may do: look, nothing more. */
const viewerPermissions = {
  view: true,
  logs: false,
  yaml: false,
  scale: false,
  deletePod: false,
  rollback: false,
  cordon: false,
  exec: false,
  configure: false,
};

function cluster(id: string, name: string) {
  return {
    id,
    name,
    apiUrl: `https://${name}.example.com:6443`,
    connectVia: 'direct',
    viaServerId: null,
    viaServerName: null,
    viaAgentId: null,
    viaAgentName: null,
    hasCa: true,
    authType: 'token',
    credentialHint: 'token ending …abcd',
    impersonate: false,
    defaultNamespace: 'default',
    namespacesAllowlist: null,
    lastStatus: 'ok',
    lastError: null,
    lastCheckedAt: new Date().toISOString(),
    serverVersion: 'v1.31.5',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const fleet = {
  alertsEnabled: true,
  generatedAt: new Date().toISOString(),
  clusters: [
    {
      clusterId: EDGE,
      name: 'edge',
      ok: false,
      error: 'No answer within 10 s',
      durationMs: 10_000,
      serverVersion: null,
      nodes: { total: 0, ready: 0, cordoned: 0 },
      pods: { running: 0, pending: 0, failing: 0, completed: 0, terminating: 0 },
      workloads: {},
      problems: [],
      alerts: [],
      warnings: [],
    },
    {
      clusterId: PROD,
      name: 'shop-prod',
      ok: true,
      durationMs: 120,
      serverVersion: 'v1.31.5',
      nodes: { total: 3, ready: 2, cordoned: 0 },
      pods: { running: 12, pending: 1, failing: 2, completed: 3, terminating: 0 },
      workloads: { healthy: 4, failed: 1 },
      problems: [
        { ref: { resource: 'nodes', kind: 'Node', namespace: null, name: 'node-c' }, severity: 'critical', reason: 'NotReady' },
        { ref: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'worker-1' }, severity: 'critical', reason: 'CrashLoopBackOff' },
      ],
      alerts: [
        {
          type: 'kube_pod_crashloop',
          severity: 'critical',
          object: 'shop/Deployment worker',
          message: 'shop/Deployment worker: 1 pod crash-looping — worker-1: CrashLoopBackOff, restarted 37 times',
          openedAt: new Date().toISOString(),
        },
      ],
      warnings: [],
    },
  ],
};

const podDetail = {
  ref: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'worker-1' },
  health: 'failing',
  facts: [{ label: 'Restarts', value: '37' }],
  labels: { app: 'worker' },
  related: [],
  yaml: 'apiVersion: v1\nkind: Pod\n',
};

const explanation = [
  {
    type: 'context',
    context: { ref: podDetail.ref, events: 3, logLines: 42, pods: 0, provider: 'Claude' },
  },
  { type: 'delta', content: '**The app starts and crashes repeatedly.** ' },
  { type: 'delta', content: 'Its last log line says the database is unreachable.' },
  { type: 'done' },
];

/** The cluster view's permissions: an operator's by default; `namespacePermissions` for a member narrowed to some namespaces. */
async function stubKube(page: Page, view: { permissions?: typeof permissions; namespacePermissions?: Record<string, typeof permissions> } = {}) {
  const explained: unknown[] = [];
  await page.route('**/api/kube/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/kube', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/clusters') return json([cluster(EDGE, 'edge'), cluster(PROD, 'shop-prod')]);
    if (path === '/overview') return json(fleet);
    if (path === `/clusters/${PROD}`) {
      return json({ cluster: cluster(PROD, 'shop-prod'), permissions: view.permissions ?? permissions, ...(view.namespacePermissions && { namespacePermissions: view.namespacePermissions }) });
    }
    if (path === `/clusters/${PROD}/overview`) {
      return json({ clusterId: PROD, serverVersion: 'v1.31.5', metricsAvailable: false, namespaces: ['shop'], nodes: [], unscheduled: [], warnings: [], generatedAt: new Date().toISOString() });
    }
    if (path === `/clusters/${PROD}/namespaces`) return json([{ name: 'shop', phase: 'Active', createdAt: null, labels: {} }]);
    if (path === `/clusters/${PROD}/stream`) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'ready' })}\n\n` });
    }
    if (path === `/clusters/${PROD}/objects/pods/shop/worker-1`) return json(podDetail);
    if (path === `/clusters/${PROD}/objects/pods/ops/tool-1`) {
      return json({ ...podDetail, ref: { ...podDetail.ref, namespace: 'ops', name: 'tool-1' } });
    }
    if (path === `/clusters/${PROD}/explain` && req.method() === 'POST') {
      explained.push(req.postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: explanation.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
      });
    }
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
  return explained;
}

test.describe('Kubernetes integrations', () => {
  let viewer: { email: string; password: string };
  let operator: { email: string; password: string };
  test.beforeAll(async () => {
    await ensureKubernetesShown();
    viewer = await createMember('viewer', 'kube-k5');
    operator = await createMember('operator', 'kube-k5');
  });

  test('the fleet overview shows every cluster at a glance, and the one that did not answer', async ({ page }) => {
    await stubKube(page, { permissions: viewerPermissions });
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto('/kubernetes');
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page).toHaveURL(/\/kubernetes\/overview$/);
    await expect(page.getByRole('heading', { name: 'Kubernetes overview' })).toBeVisible();

    const cards = page.getByTestId('fleet-cluster');
    await expect(cards).toHaveCount(2);
    // Worst first: the failing cluster leads, the unreachable one is grey with its reason
    const prod = cards.nth(0);
    await expect(prod).toContainText('shop-prod');
    await expect(prod).toContainText('2 of 3 ready');
    await expect(prod.getByTestId('fleet-nodes').locator('span')).toHaveCount(3);
    await expect(prod.getByTestId('fleet-nodes').locator('span.bg-red-500')).toHaveCount(1);
    await expect(prod.getByTestId('fleet-pods').locator('div')).toHaveCount(4);
    await expect(prod).toContainText('2 failing');
    await expect(prod).toContainText('1 failing');
    await expect(prod.getByTestId('fleet-alerts')).toContainText('1 open alert');
    await expect(cards.nth(1)).toContainText('edge');
    await expect(cards.nth(1)).toContainText('No answer within 10 s');

    // A problem opens its object at its stable URL
    await prod.getByTestId('fleet-problems').getByRole('link', { name: /worker-1/ }).click();
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${PROD}/objects/pods/shop/worker-1$`));
    await expect(page.getByTestId('kube-object-panel')).toContainText('worker-1');
    // Viewers get no Explain button
    await expect(page.getByTestId('kube-explain')).toHaveCount(0);
  });

  test('Explain streams a plain-language answer and says what was sent', async ({ page }) => {
    const explained = await stubKube(page);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/kubernetes/${PROD}/objects/pods/shop/worker-1`);
    const panel = page.getByTestId('kube-object-panel');
    await expect(panel).toContainText('worker-1');

    await panel.getByTestId('kube-explain').click();
    const dialog = page.getByRole('dialog', { name: 'Explanation of worker-1' });
    await expect(dialog.getByTestId('kube-explanation')).toContainText('Sent to Claude: the Pod with Secret values removed, 3 events, the last 42 log lines.');
    await expect(dialog.locator('strong')).toHaveText('The app starts and crashes repeatedly.');
    await expect(dialog).toContainText('the database is unreachable');
    await expect(dialog).toContainText('It never changes the cluster.');
    expect(explained).toEqual([{ resource: 'pods', namespace: 'shop', name: 'worker-1' }]);

    // Escape closes the dialog first, leaving the panel open
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
  });

  test('shows Explain, Logs and YAML in the namespaces a member operates in, and nowhere else', async ({ page }) => {
    // A viewer whose role lets them operate in `shop` only: the cluster as a whole is view
    await stubKube(page, { permissions: viewerPermissions, namespacePermissions: { shop: permissions } });
    await signInWithPassword(page, viewer.email, viewer.password);

    await page.goto(`/kubernetes/${PROD}/objects/pods/shop/worker-1`);
    const panel = page.getByTestId('kube-object-panel');
    await expect(panel).toContainText('worker-1');
    await expect(panel.getByTestId('kube-explain')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Logs', exact: true }).first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'YAML', exact: true })).toBeVisible();

    await page.goto(`/kubernetes/${PROD}/objects/pods/ops/tool-1`);
    await expect(panel).toContainText('tool-1');
    await expect(page.getByTestId('kube-explain')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Logs', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'YAML', exact: true })).toHaveCount(0);
  });
});
