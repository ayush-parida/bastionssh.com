import type { Page, Route } from '@playwright/test';
import { createMember, ensureKubernetesShown, expect, signInWithPassword, snap, test } from './fixtures.js';

/**
 * The K2 views against a stubbed Kubernetes API: the topology graph (node
 * and edge counts, health colours, dashed red broken links with their
 * reasons, a replica ring that expands into pods), the diagnosis panel of an
 * object opened from the graph, the "needs attention" list on the map, and
 * the events timeline with repeats collapsed.
 */

const CLUSTER = 'kube-e2e-graph';

const permissions = { view: true, logs: false, yaml: false, scale: false, deletePod: false, rollback: false, cordon: false, exec: false, configure: false };

const now = new Date().toISOString();
const cluster = {
  id: CLUSTER,
  name: 'shop-graph',
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
  lastCheckedAt: now,
  serverVersion: 'v1.31.5',
  createdAt: now,
  updatedAt: now,
};

const ref = (resource: string, kind: string, name: string) => ({ resource, kind, namespace: 'shop', name });

function tile(name: string, status: string, reason: string | null = null) {
  return {
    namespace: 'shop',
    name,
    status,
    phase: 'Running',
    reason,
    restarts: status === 'failing' ? 37 : 0,
    readyContainers: status === 'running' ? 1 : 0,
    totalContainers: 1,
    nodeName: 'node-a',
    owner: { kind: 'ReplicaSet', name: 'web-7d4' },
    message: null,
    createdAt: now,
  };
}

const node = (id: string, kind: string, name: string, health: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  name,
  namespace: 'shop',
  ref: health === 'missing' || kind === 'Pods' ? null : ref(`${kind.toLowerCase()}s`, kind, name),
  health,
  summary,
  problems: 0,
  ...extra,
});

const edge = (source: string, target: string, relation: string, broken: boolean, explanation: string) => ({
  id: `${relation}:${source}->${target}`,
  source,
  target,
  relation,
  broken,
  explanation,
});

const graph = {
  namespace: 'shop',
  nodes: [
    node('Ingress/shop/shop', 'Ingress', 'shop', 'failing', 'shop.example.com'),
    node('Service/shop/web', 'Service', 'web', 'healthy', 'ClusterIP · 80→8080'),
    node('Service/shop/search', 'Service', 'search', 'failing', 'ClusterIP · 9200', { problems: 1 }),
    node('Deployment/shop/web', 'Deployment', 'web', 'warning', '2 of 3 ready', { ref: ref('deployments', 'Deployment', 'web'), problems: 1 }),
    node('pods:Deployment/shop/web', 'Pods', 'web', 'failing', '2 of 3 ready', {
      pods: {
        ready: 2,
        total: 3,
        desired: 3,
        counts: { running: 2, pending: 0, failing: 1, completed: 0, terminating: 0 },
        pods: [tile('web-3', 'failing', 'CrashLoopBackOff'), tile('web-1', 'running'), tile('web-2', 'running')],
      },
    }),
    node('ConfigMap/shop/web-config', 'ConfigMap', 'web-config', 'healthy', '2 keys', { ref: ref('configmaps', 'ConfigMap', 'web-config') }),
    node('Secret/shop/db-creds', 'Secret', 'db-creds', 'healthy', 'Opaque · values never shown', { ref: ref('secrets', 'Secret', 'db-creds') }),
    node('missing:Service/shop/admin', 'Service', 'admin', 'missing', 'Does not exist'),
    node('missing:Pods/shop/search-selector', 'Pods', 'No pods match app=serach', 'missing', 'Traffic goes nowhere'),
  ],
  edges: [
    edge('Ingress/shop/shop', 'Service/shop/web', 'routes', false, 'Routes shop.example.com/ to Service `web` port 80'),
    edge('Ingress/shop/shop', 'missing:Service/shop/admin', 'routes', true, 'This Ingress sends shop.example.com/admin to Service `admin`, which does not exist.'),
    edge('Service/shop/web', 'Deployment/shop/web', 'selects', false, 'Sends traffic to the ready pods labelled `app=web`'),
    edge('Service/shop/search', 'missing:Pods/shop/search-selector', 'selects', true, 'This Service selects `app=serach`, but no pod has these labels — traffic goes nowhere.'),
    edge('Deployment/shop/web', 'pods:Deployment/shop/web', 'owns', false, 'Runs 3 pods'),
    edge('Deployment/shop/web', 'ConfigMap/shop/web-config', 'mounts', false, 'Its pods mount ConfigMap `web-config`'),
    edge('Deployment/shop/web', 'Secret/shop/db-creds', 'env', false, 'Its pods read settings from Secret `db-creds`'),
  ],
  warnings: [],
  generatedAt: now,
};

const crash = {
  id: 'crash-loop',
  severity: 'critical',
  subject: ref('pods', 'Pod', 'web-3'),
  owner: ref('deployments', 'Deployment', 'web'),
  headline: 'The app starts and crashes repeatedly (exit code 1).',
  cause: 'Container `app` exited with code 1 — the app reported an error and quit; it has restarted 37 times and Kubernetes now waits longer before each new start.',
  nextStep: 'Check its logs from the last run for the error it printed before exiting.',
  evidence: [
    { type: 'fact', label: 'Container app', detail: 'CrashLoopBackOff, restarted 37 times', ref: null },
    { type: 'object', label: 'Deployment web', detail: 'runs this pod', ref: ref('deployments', 'Deployment', 'web') },
  ],
  affected: 1,
  since: now,
};

const noEndpoints = {
  id: 'service-no-endpoints',
  severity: 'critical',
  subject: ref('services', 'Service', 'search'),
  owner: null,
  headline: 'This Service selects `app=serach` but no ready pods match — traffic goes nowhere.',
  cause: "No pod in `shop` has these labels — a typo in the selector or in the pods' labels, or nothing is running yet.",
  nextStep: 'Compare the selector with the labels of the pods it should reach, or start the workload behind it.',
  evidence: [{ type: 'fact', label: 'Selector', detail: 'app=serach', ref: null }],
  affected: 1,
  since: null,
};

const deploymentDetail = {
  ref: ref('deployments', 'Deployment', 'web'),
  health: 'degraded',
  facts: [{ label: 'Status', value: '2 of 3 ready' }],
  labels: { app: 'web' },
  related: [],
};

const deploymentInsight = {
  diagnoses: [{ ...crash, subject: ref('pods', 'Pod', 'web-3') }],
  events: [
    { type: 'Normal', reason: 'ScalingReplicaSet', message: 'Scaled up replica set web-7d4 to 3', count: 1, firstSeen: now, lastSeen: now, source: 'deployment-controller' },
  ],
  rollout: {
    current: 2,
    inProgress: false,
    replicas: { desired: 3, updated: 3, ready: 2, available: 2 },
    revisions: [
      { revision: 2, replicaSet: 'web-7d4', images: ['shop/web:1.4.2'], containers: [{ name: 'app', image: 'shop/web:1.4.2', envNames: [] }], changeCause: 'release 1.4.2', createdAt: now, replicas: 3, readyReplicas: 2, current: true },
      { revision: 1, replicaSet: 'web-5c8', images: ['shop/web:1.4.1'], containers: [{ name: 'app', image: 'shop/web:1.4.1', envNames: [] }], changeCause: null, createdAt: now, replicas: 0, readyReplicas: 0, current: false },
    ],
  },
};

const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
const events = {
  groups: [
    {
      object: ref('pods', 'Pod', 'web-3'),
      warnings: 37,
      lastSeen: now,
      events: [
        { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container app', count: 37, firstSeen: twentyMinAgo, lastSeen: now, source: 'kubelet' },
        { type: 'Normal', reason: 'Pulled', message: 'Container image "shop/web:1.4.2" already present', count: 1, firstSeen: twentyMinAgo, lastSeen: twentyMinAgo, source: 'kubelet' },
      ],
    },
  ],
  warnings: [],
  generatedAt: now,
};

const storage = {
  claims: [
    {
      ref: ref('persistentvolumeclaims', 'PersistentVolumeClaim', 'data-db-0'),
      phase: 'Pending',
      requested: '10Gi',
      capacity: null,
      storageClass: 'fast',
      accessModes: ['ReadWriteOnce'],
      volume: null,
      usedBy: [{ ref: ref('statefulsets', 'StatefulSet', 'db'), how: ['mounts'] }],
      problem: {
        id: 'pvc-pending',
        severity: 'critical',
        subject: ref('persistentvolumeclaims', 'PersistentVolumeClaim', 'data-db-0'),
        owner: null,
        headline: 'Storage was requested but not provisioned — no StorageClass `fast` or no capacity.',
        cause: 'There is no StorageClass `fast` in this cluster.',
        nextStep: "Use one of the cluster's StorageClasses (or create `fast`), then recreate the claim.",
        evidence: [],
        affected: 1,
        since: now,
      },
      createdAt: now,
    },
    {
      ref: ref('persistentvolumeclaims', 'PersistentVolumeClaim', 'uploads'),
      phase: 'Bound',
      requested: '5Gi',
      capacity: '5Gi',
      storageClass: null,
      accessModes: ['ReadWriteOnce'],
      volume: { name: 'pvc-1234', phase: 'Bound', reclaimPolicy: 'Delete', exists: true },
      usedBy: [{ ref: ref('deployments', 'Deployment', 'web'), how: ['mounts'] }],
      problem: null,
      createdAt: now,
    },
  ],
  volumes: [{ ref: { resource: 'persistentvolumes', kind: 'PersistentVolume', namespace: null, name: 'pv-old' }, phase: 'Released', capacity: '1Gi', storageClass: null, reclaimPolicy: 'Retain', claim: { namespace: 'shop', name: 'gone' } }],
  classes: [{ name: 'local-path', provisioner: 'rancher.io/local-path', isDefault: true, reclaimPolicy: 'Delete', bindingMode: 'WaitForFirstConsumer', claims: 1 }],
  warnings: [],
  generatedAt: now,
};

const config = {
  configMaps: [
    { ref: ref('configmaps', 'ConfigMap', 'web-config'), type: null, keys: ['LEVEL', 'PORT'], usedBy: [{ ref: ref('deployments', 'Deployment', 'web'), how: ['env'] }], createdAt: now },
    { ref: ref('configmaps', 'ConfigMap', 'kube-root-ca.crt'), type: null, keys: ['ca.crt'], usedBy: [], createdAt: now },
  ],
  secrets: [{ ref: ref('secrets', 'Secret', 'db-creds'), type: 'Opaque', keys: ['password', 'user'], usedBy: [{ ref: ref('deployments', 'Deployment', 'web'), how: ['env', 'mounts'] }], createdAt: now }],
  missing: [{ kind: 'ConfigMap', namespace: 'shop', name: 'feature-flags', usedBy: [{ ref: ref('deployments', 'Deployment', 'web'), how: ['env'] }] }],
  warnings: [],
  generatedAt: now,
};

async function stubKube(page: Page) {
  await page.route('**/api/kube/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/kube', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const c = `/clusters/${CLUSTER}`;

    if (path === '/clusters') return json([cluster]);
    if (path === c) return json({ cluster, permissions });
    if (path === `${c}/namespaces`) return json([{ name: 'shop', phase: 'Active', createdAt: null, labels: {} }]);
    if (path === `${c}/stream`) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'ready' })}\n\n` });
    }
    if (path === `${c}/graph`) return json(graph);
    if (path === `${c}/attention`) return json({ items: [crash, noEndpoints], warnings: [], generatedAt: now });
    if (path === `${c}/events`) return json(events);
    if (path === `${c}/storage`) return json(storage);
    if (path === `${c}/config`) return json(config);
    if (path === `${c}/overview`) {
      return json({ clusterId: CLUSTER, serverVersion: 'v1.31.5', metricsAvailable: false, namespaces: ['shop'], nodes: [], unscheduled: [], warnings: [], generatedAt: now });
    }
    if (path === `${c}/objects/deployments/shop/web`) return json(deploymentDetail);
    if (path === `${c}/objects/deployments/shop/web/insight`) return json(deploymentInsight);
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
}

test.describe('Kubernetes topology and diagnoses', () => {
  let viewer: { email: string; password: string };
  test.beforeAll(async () => {
    await ensureKubernetesShown();
    viewer = await createMember('viewer', 'kube-graph');
  });

  test('draws the app graph: nodes coloured by health, broken links dashed red, a ring that opens', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/kubernetes/${CLUSTER}/apps`);

    const graphBox = page.getByTestId('topology-graph');
    await expect(graphBox).toBeVisible();
    await expect(page.getByTestId('graph-node')).toHaveCount(8);
    await expect(page.getByTestId('graph-ring')).toHaveCount(1);
    await expect(page.getByTestId('graph-edge')).toHaveCount(7);
    await expect(page.getByTestId('graph-counts')).toHaveText('9 objects · 7 links · 2 broken');

    // Colours follow health
    await expect(page.locator('[data-testid="graph-node"][data-id="Service/shop/web"]')).toHaveClass(/border-emerald-500/);
    await expect(page.locator('[data-testid="graph-node"][data-id="Deployment/shop/web"]')).toHaveClass(/border-amber-500/);
    await expect(page.locator('[data-testid="graph-node"][data-id="Ingress/shop/shop"]')).toHaveClass(/border-red-500/);
    await expect(page.locator('[data-testid="graph-node"][data-health="missing"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="graph-node"][data-id="Deployment/shop/web"] [data-testid="graph-problems"]')).toHaveText('1');

    // Links that lead nowhere: dashed and red, with the reason
    const broken = page.locator('[data-testid="graph-edge"][data-broken="true"]');
    await expect(broken).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const path = broken.nth(i).locator('path.react-flow__edge-path');
      await expect(path).toHaveCSS('stroke-dasharray', '6px, 4px');
      await expect(path).toHaveCSS('stroke', 'rgb(239, 68, 68)');
    }
    await expect(page.locator('[data-testid="graph-edge"][data-broken="false"] path.react-flow__edge-path').first()).toHaveCSS('stroke-dasharray', 'none');
    const reasons = page.getByTestId('broken-links');
    await expect(reasons).toContainText('2 links lead nowhere');
    await expect(reasons).toContainText('Service admin, which does not exist');
    await expect(reasons).toContainText('no pod has these labels — traffic goes nowhere');

    // The replica ring: 2 of 3 ready; click to see each pod
    const ring = page.getByTestId('graph-ring');
    await expect(ring).toContainText('2/3');
    await expect(ring.getByTestId('ring-summary')).toContainText('1 failing');
    await ring.click();
    await expect(ring).toHaveAttribute('data-expanded', 'true');
    await expect(ring.getByTestId('ring-pod')).toHaveCount(3);
    await expect(ring.locator('[data-testid="ring-pod"][data-status="failing"]')).toHaveClass(/bg-red-500/);
    await snap(page, 'topology-graph');
  });

  test('opens an object from the graph with its diagnosis, rollout and events', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/kubernetes/${CLUSTER}/apps`);
    await page.locator('[data-testid="graph-node"][data-id="Deployment/shop/web"]').click();
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}/objects/deployments/shop/web$`));

    const panel = page.getByTestId('kube-object-panel');
    const diagnosis = panel.getByTestId('diagnosis');
    await expect(diagnosis).toHaveCount(1);
    await expect(diagnosis).toHaveAttribute('data-severity', 'critical');
    await expect(diagnosis.getByTestId('diagnosis-headline')).toHaveText('The app starts and crashes repeatedly (exit code 1).');
    await expect(diagnosis.getByTestId('diagnosis-cause')).toContainText('restarted 37 times');
    await expect(diagnosis.getByTestId('diagnosis-next')).toHaveText('Check its logs from the last run for the error it printed before exiting.');
    await expect(diagnosis).toContainText('CrashLoopBackOff, restarted 37 times');
    await expect(diagnosis.getByRole('link', { name: /Pod shop\/web-3/ })).toBeVisible();

    await expect(panel.getByTestId('revision')).toHaveCount(2);
    await expect(panel.locator('[data-testid="revision"][data-current="true"]')).toContainText('web:1.4.2');
    await expect(panel.getByTestId('rollout-bar')).toContainText('3 desired · 3 updated · 2 ready · 2 available');
    await expect(panel.getByTestId('object-events')).toContainText('ScalingReplicaSet');
    await snap(page, 'diagnosis-panel');

    // Closing returns to the graph
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/kubernetes/${CLUSTER}/apps$`));
  });

  test('ranks problems on the map and collapses repeated events', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/kubernetes/${CLUSTER}`);
    const attention = page.getByTestId('attention-list');
    await expect(attention).toContainText('Needs attention');
    await expect(attention).toContainText('2 problems, 2 critical');
    await expect(attention.getByTestId('diagnosis')).toHaveCount(2);
    await expect(attention.getByTestId('diagnosis-headline').nth(1)).toHaveText(
      'This Service selects app=serach but no ready pods match — traffic goes nowhere.',
    );

    await page.goto(`/kubernetes/${CLUSTER}/events`);
    const group = page.getByTestId('event-group');
    await expect(group).toHaveCount(1);
    await expect(group).toContainText('37 warnings');
    const backoff = page.locator('[data-testid="event-line"][data-type="Warning"]');
    await expect(backoff).toContainText('Back-off restarting failed container app');
    await expect(backoff.getByTestId('event-count')).toHaveText('×37 in 20 min');
    await page.getByLabel('Warnings only').check();
    await expect(page.getByTestId('event-line')).toHaveCount(1);
  });

  test('draws storage as chains and lists config by key, never a value', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto(`/kubernetes/${CLUSTER}/storage`);

    const claims = page.getByTestId('storage-claim');
    await expect(claims).toHaveCount(2);
    const pending = page.locator('[data-testid="storage-claim"][data-phase="Pending"]');
    await expect(pending).toContainText('No storage');
    await expect(pending).toContainText('No volume yet');
    await expect(pending.getByRole('link', { name: /StatefulSet db/ })).toBeVisible();
    await expect(pending.getByTestId('diagnosis-headline')).toContainText('no StorageClass fast or no capacity');
    const bound = page.locator('[data-testid="storage-claim"][data-phase="Bound"]');
    await expect(bound).toContainText('Has storage · 5Gi');
    await expect(bound).toContainText('Data deleted with the claim');
    await expect(page.getByTestId('storage-classes')).toContainText('creates storage when a pod first uses it');
    await expect(page.getByTestId('storage-volumes')).toContainText('Its claim was deleted; the data is kept');
    await snap(page, 'storage-tab');

    await page.goto(`/kubernetes/${CLUSTER}/config`);
    await expect(page.getByTestId('config-missing')).toContainText('feature-flags in shop does not exist');
    // Kubernetes' own CA bundle is hidden until asked for
    await expect(page.locator('[data-testid="config-item"][data-kind="ConfigMap"]')).toHaveCount(1);
    await page.getByLabel(/made by Kubernetes or Helm/).check();
    await expect(page.locator('[data-testid="config-item"][data-kind="ConfigMap"]')).toHaveCount(2);
    const secret = page.locator('[data-testid="config-item"][data-kind="Secret"]');
    await expect(secret).toContainText('password');
    await expect(secret).toContainText('values are never shown');
    await expect(secret).toContainText('as environment variables + as files');
    await snap(page, 'config-tab');
  });
});
