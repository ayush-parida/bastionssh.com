import type { Page, Route } from '@playwright/test';
import { createMember, expect, signInWithPassword, test } from './fixtures.js';

/**
 * The guided actions (K3) against a stubbed Kubernetes API: the scale
 * slider's current → new rings, the autoscaler warning, the confirmation
 * naming the workload with its "What this does" command, the request it
 * sends, and cancelling sending nothing. What the server does with it is
 * covered by the route tests.
 */

const CLUSTER = 'kube-e2e-actions';

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

const detail = (name: string) => ({
  ref: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name },
  health: 'healthy',
  facts: [{ label: 'Replicas', value: '2 / 2 ready' }],
  labels: { app: name },
  related: [],
});

const revisions = [
  {
    revision: 2,
    replicaSet: 'web-7d9f',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    changeCause: 'release 2.0',
    containers: [{ name: 'app', image: 'shop/web:2.0', envNames: ['MODE', 'NEW'] }],
    replicas: 2,
    current: true,
  },
  {
    revision: 1,
    replicaSet: 'web-5c4b',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
    changeCause: 'release 1.0',
    containers: [{ name: 'app', image: 'shop/web:1.0', envNames: ['MODE'] }],
    replicas: 0,
    current: false,
  },
];

const previews: Record<string, unknown> = {
  web: {
    ref: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'web' },
    actions: ['scale', 'restart'],
    replicas: { desired: 2, ready: 2, updated: 2, available: 2 },
    hpa: null,
    paused: false,
    revisions,
  },
  api: {
    ref: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'api' },
    actions: ['scale', 'restart'],
    replicas: { desired: 3, ready: 3, updated: 3, available: 3 },
    hpa: { name: 'api', minReplicas: 2, maxReplicas: 10 },
    paused: false,
    revisions: [],
  },
  batch: {
    ref: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'batch' },
    actions: ['scale', 'restart'],
    replicas: { desired: 2, ready: 2, updated: 2, available: 2 },
    hpa: null,
    paused: false,
    strategy: 'Recreate',
    revisions: [],
  },
};

/** Answer the Kubernetes API and record the actions posted. */
async function stubKube(page: Page) {
  const posted: { path: string; body: unknown }[] = [];
  await page.route('**/api/kube/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/kube', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/clusters') return json([cluster]);
    if (path === `/clusters/${CLUSTER}`) return json({ cluster, permissions });
    if (path === `/clusters/${CLUSTER}/namespaces`) return json([{ name: 'shop', phase: 'Active', createdAt: null, labels: {} }]);
    if (path === `/clusters/${CLUSTER}/stream`) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'ready' })}\n\n` });
    }
    if (path === `/clusters/${CLUSTER}/overview`) {
      return json({
        clusterId: CLUSTER,
        serverVersion: 'v1.31.5',
        metricsAvailable: false,
        namespaces: ['shop'],
        nodes: [],
        unscheduled: [],
        warnings: [],
        generatedAt: new Date().toISOString(),
      });
    }
    const object = path.match(new RegExp(`^/clusters/${CLUSTER}/objects/deployments/shop/(\\w+)$`));
    if (object) return json(detail(object[1]!));
    const preview = path.match(new RegExp(`^/clusters/${CLUSTER}/actions/preview/deployments/shop/(\\w+)$`));
    if (preview && previews[preview[1]!]) return json(previews[preview[1]!]);
    if (req.method() === 'POST' && path === `/clusters/${CLUSTER}/actions/scale`) {
      const body = req.postDataJSON() as { name: string; replicas: number };
      posted.push({ path, body });
      return json({
        action: 'scale',
        ref: { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: body.name },
        changed: true,
        before: { replicas: 2 },
        after: { replicas: body.replicas },
        message: `Scaled ${body.name} from 2 to ${body.replicas} replicas`,
      });
    }
    return json({ error: `not stubbed: ${req.method()} ${path}` }, 404);
  });
  return posted;
}

test.describe('Kubernetes guided actions', () => {
  let operator: { email: string; password: string };
  test.beforeAll(async () => {
    operator = await createMember('operator', 'kube-actions');
  });

  test('scales with the slider: rings preview the change, the confirmation names the workload and shows the command', async ({ page }) => {
    const posted = await stubKube(page);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/kubernetes/${CLUSTER}/objects/deployments/shop/web`);

    const panel = page.getByTestId('kube-object-panel');
    const scale = panel.getByTestId('scale-slider');
    await expect(scale).toContainText('2 of 2 ready');
    await expect(scale.getByTestId('replicas-now')).toHaveAttribute('data-replicas', '2');
    // Nothing to send until the count changes
    await expect(scale.getByRole('button', { name: 'Scale…' })).toBeDisabled();

    await scale.getByLabel('Replica count').fill('5');
    await expect(scale.getByTestId('replicas-after')).toHaveAttribute('data-replicas', '5');
    await expect(scale.getByTestId('replicas-after').locator('[data-segment="added"]')).toHaveCount(3);
    await expect(scale.getByTestId('replica-delta')).toHaveText('3 new pods will start');
    // The slider follows the number
    await expect(scale.getByRole('slider', { name: 'Replicas' })).toHaveValue('5');
    await expect(scale.getByTestId('hpa-warning')).toHaveCount(0);

    // Cancelling sends nothing
    await scale.getByRole('button', { name: 'Scale…' }).click();
    let dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(posted).toHaveLength(0);

    await scale.getByRole('button', { name: 'Scale…' }).click();
    dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('deployment/web in shop');
    await expect(dialog.getByTestId('replica-delta')).toHaveText('3 new pods will start');
    // The equivalent command, collapsed until asked for
    await expect(dialog.getByTestId('action-command')).toBeHidden();
    await dialog.getByText('What this does').click();
    await expect(dialog.getByTestId('action-command')).toHaveText('kubectl scale deployment/web --replicas=5 -n shop');

    await dialog.getByRole('button', { name: 'Scale web to 5' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(posted).toEqual([
      { path: `/clusters/${CLUSTER}/actions/scale`, body: { kind: 'Deployment', namespace: 'shop', name: 'web', replicas: 5 } },
    ]);
    await expect(page.getByText('Scaled web from 2 to 5 replicas')).toBeVisible();

    // The revision timeline shows for operators, without the admin-only rollback
    const timeline = panel.getByTestId('revision-timeline');
    await expect(timeline.getByTestId('revision')).toHaveCount(2);
    await expect(timeline.locator('[data-current]')).toContainText('Revision 2');
    await expect(timeline.getByRole('button', { name: 'Roll back to this' })).toHaveCount(0);
  });

  test('warns when an autoscaler controls the workload, and scaling to zero is a red confirmation', async ({ page }) => {
    await stubKube(page);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/kubernetes/${CLUSTER}/objects/deployments/shop/api`);

    const scale = page.getByTestId('scale-slider');
    await expect(scale.getByTestId('hpa-warning')).toContainText('The autoscaler api controls this workload (between 2 and 10');
    await scale.getByLabel('Replica count').fill('0');
    await expect(scale.getByTestId('replica-delta')).toHaveText('3 pods will stop — nothing will run');
    await expect(scale.getByTestId('replicas-now').locator('[data-segment="removed"]')).toHaveCount(3);

    await scale.getByRole('button', { name: 'Scale…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByTestId('hpa-warning')).toBeVisible();
    await expect(dialog).toContainText('nothing runs');
    await expect(dialog.getByRole('button', { name: 'Scale api to 0' })).toHaveClass(/bg-red-600/);
  });

  test('a restart of a Recreate Deployment says the app goes down, not "one by one"', async ({ page }) => {
    const posted = await stubKube(page);
    await signInWithPassword(page, operator.email, operator.password);
    await page.goto(`/kubernetes/${CLUSTER}/objects/deployments/shop/batch`);

    const restart = page.getByTestId('restart-rollout');
    await expect(restart).toContainText('the app is down in between');
    await restart.getByRole('button', { name: 'Restart…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByTestId('restart-strategy-warning')).toContainText('will all be stopped first');
    await expect(dialog).not.toContainText('one by one');
    await expect(dialog.getByRole('button', { name: 'Restart batch' })).toHaveClass(/bg-red-600/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(posted).toEqual([]);
  });
});
