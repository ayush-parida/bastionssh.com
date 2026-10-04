import type { Page, Route } from '@playwright/test';
import { createMember, ensureKubernetesShown, expect, signInWithPassword, snap, test } from './fixtures.js';

/**
 * The Kubernetes pages (K1) against a stubbed Kubernetes API, like the Docker
 * specs: what is under test is the browser side — the cluster list with its
 * health dots, the cluster map's node cards and coloured pod tiles, the
 * "Waiting for a node" lane, namespace dimming, the hover card, and a tile
 * opening the pod's panel at its stable URL.
 */

const CLUSTER = 'kube-e2e-cluster';

const permissions = {
  view: true,
  logs: true,
  yaml: true,
  scale: true,
  deletePod: true,
  rollback: true,
  cordon: true,
  exec: true,
  configure: true,
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
  defaultNamespace: 'default',
  namespacesAllowlist: null,
  lastStatus: 'ok',
  lastError: null,
  lastCheckedAt: new Date().toISOString(),
  serverVersion: 'v1.31.5',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function pod(namespace: string, name: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    namespace,
    name,
    status,
    phase: status === 'running' ? 'Running' : status === 'pending' ? 'Pending' : 'Running',
    reason: null,
    restarts: 0,
    readyContainers: status === 'running' ? 1 : 0,
    totalContainers: 1,
    nodeName: 'node-a',
    owner: { kind: 'ReplicaSet', name: `${name.split('-')[0]}-7d9f` },
    message: null,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

const overview = {
  clusterId: CLUSTER,
  serverVersion: 'v1.31.5',
  metricsAvailable: true,
  namespaces: ['default', 'kube-system', 'shop'],
  nodes: [
    {
      name: 'node-a',
      roles: ['control-plane'],
      ready: true,
      unschedulable: false,
      pressures: [],
      kubeletVersion: 'v1.31.5',
      osImage: 'Ubuntu 24.04',
      architecture: 'amd64',
      allocatable: { cpuMillis: 4000, memoryBytes: 8 * 2 ** 30, pods: 110 },
      requested: { cpuMillis: 1000, memoryBytes: 2 * 2 ** 30 },
      usage: { cpuMillis: 500, memoryBytes: 3 * 2 ** 30 },
      pods: [
        pod('shop', 'web-1', 'running'),
        pod('shop', 'web-2', 'running'),
        pod('shop', 'worker-1', 'failing', { reason: 'CrashLoopBackOff', restarts: 37 }),
        pod('kube-system', 'coredns-1', 'running'),
      ],
    },
    {
      name: 'node-b',
      roles: ['worker'],
      ready: false,
      unschedulable: true,
      pressures: ['MemoryPressure'],
      kubeletVersion: 'v1.31.5',
      osImage: 'Ubuntu 24.04',
      architecture: 'amd64',
      allocatable: { cpuMillis: 2000, memoryBytes: 4 * 2 ** 30, pods: 110 },
      requested: { cpuMillis: 1900, memoryBytes: 1 * 2 ** 30 },
      usage: null,
      pods: [pod('shop', 'batch-1', 'completed', { nodeName: 'node-b' }), pod('shop', 'old-1', 'terminating', { nodeName: 'node-b' })],
    },
  ],
  unscheduled: [
    pod('shop', 'too-big', 'pending', {
      nodeName: null,
      reason: 'Unschedulable',
      message: '0/2 nodes are available: 2 Insufficient cpu.',
    }),
  ],
  warnings: [],
  generatedAt: new Date().toISOString(),
};

const podDetail = {
  ref: { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'worker-1' },
  health: 'failing',
  facts: [
    { label: 'Node', value: 'node-a' },
    { label: 'Restarts', value: '37' },
  ],
  labels: { app: 'worker' },
  related: [{ resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'worker', relation: 'owned by' }],
};

/** Answer the Kubernetes API; anything else under /api/kube is a 404 that names the path. */
async function stubKube(page: Page) {
  await page.route('**/api/kube/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/kube', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/clusters') return json([cluster]);
    if (path === '/settings') {
      return json({ operatorsCanExec: true, operatorsCanDeletePods: true, operatorsCanScale: true, showConfigMapValues: true, clusterAlerts: false });
    }
    if (path === `/clusters/${CLUSTER}`) return json({ cluster, permissions });
    if (path === `/clusters/${CLUSTER}/overview`) return json(overview);
    if (path === `/clusters/${CLUSTER}/namespaces`) {
      return json(overview.namespaces.map((name) => ({ name, phase: 'Active', createdAt: null, labels: {} })));
    }
    if (path === `/clusters/${CLUSTER}/stream`) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'ready' })}\n\n` });
    }
    if (path === `/clusters/${CLUSTER}/objects/pods/shop/worker-1`) return json(podDetail);
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Kubernetes cluster map', () => {
  let viewer: { email: string; password: string };
  test.beforeAll(async () => {
    await ensureKubernetesShown();
    viewer = await createMember('viewer', 'kube');
  });

  test('lists clusters and draws the map: nodes, coloured pod tiles, the waiting lane', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.getByRole('link', { name: 'Kubernetes' }).click();
    await expect(page).toHaveURL(/\/kubernetes$/);

    const card = page.getByTestId('cluster-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('shop-prod');
    await expect(card).toContainText('Reachable');
    // Viewers cannot add clusters
    await expect(page.getByRole('button', { name: 'Add cluster' })).toHaveCount(0);

    await card.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}$`));
    await expect(page.getByRole('heading', { name: 'shop-prod' })).toBeVisible();

    // Two node cards; the second is not ready, cordoned and under memory pressure
    const nodes = page.getByTestId('node-card');
    await expect(nodes).toHaveCount(2);
    await expect(nodes.nth(0)).toContainText('node-a');
    await expect(nodes.nth(0)).toContainText('control-plane');
    await expect(nodes.nth(0)).toContainText('25% requested · 13% used');
    await expect(nodes.nth(1)).toContainText('Not ready');
    await expect(nodes.nth(1)).toContainText('Cordoned');
    await expect(nodes.nth(1)).toContainText('Memory pressure');

    // One tile per pod, coloured by status
    const tiles = page.getByTestId('pod-tile');
    await expect(tiles).toHaveCount(7);
    for (const [status, count] of [
      ['running', 3],
      ['failing', 1],
      ['completed', 1],
      ['terminating', 1],
      ['pending', 1],
    ] as const) {
      await expect(page.locator(`[data-testid="pod-tile"][data-status="${status}"]`)).toHaveCount(count);
    }
    await expect(page.locator('[data-status="failing"]')).toHaveClass(/bg-red-500/);
    await expect(page.locator('[data-testid="node-card"] [data-status="terminating"]')).toHaveClass(/bg-violet-500/);

    // Pods no node took wait in their own lane, with the scheduler's reason
    const lane = page.getByTestId('waiting-lane');
    await expect(lane).toContainText('Waiting for a node');
    await expect(lane).toContainText('too-big');
    await expect(lane).toContainText('0/2 nodes are available: 2 Insufficient cpu.');

    // Hover: name, namespace, reason, restarts
    await page.locator('[data-testid="node-card"] [data-status="failing"]').hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('worker-1');
    await expect(tip).toContainText('namespace shop');
    await expect(tip).toContainText('CrashLoopBackOff');
    await expect(tip).toContainText('37 restarts');
    await snap(page, 'cluster-map');
  });

  test('dims pods outside the picked namespace and opens a pod at its own URL', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/kubernetes/${CLUSTER}`);
    await expect(page.getByTestId('node-card')).toHaveCount(2);

    await page.getByTestId('namespace-picker').selectOption('kube-system');
    const coredns = page.getByRole('button', { name: /^kube-system\/coredns-1/ });
    await expect(coredns).not.toHaveClass(/opacity-15/);
    await expect(page.getByRole('button', { name: /^shop\/web-1/ })).toHaveClass(/opacity-15/);
    // The waiting lane only lists pods of the picked namespace
    await expect(page.getByTestId('waiting-lane')).toHaveCount(0);

    await page.getByTestId('namespace-picker').selectOption('');
    await page.getByRole('button', { name: /^shop\/worker-1/ }).click();
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}/objects/pods/shop/worker-1$`));
    const panel = page.getByTestId('kube-object-panel');
    await expect(panel).toContainText('worker-1');
    await expect(panel.getByTestId('object-health')).toHaveText('Failing');
    await expect(panel.getByTestId('object-facts')).toContainText('37');
    await expect(panel.getByRole('link', { name: /Deployment\s*worker/ })).toBeVisible();

    // Closing returns to the map
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}$`));
    await expect(page.getByTestId('kube-object-panel')).toHaveCount(0);
  });
});
