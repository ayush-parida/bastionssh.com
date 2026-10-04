import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { createMember, expect, fakeClientIp, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * Custom roles end to end (custom roles spec §10): an owner builds a role in
 * Team & Access → Roles from a server tag and a cluster narrowed to one
 * namespace, adds a viewer and takes their Viewer role away, so the new role
 * is all they hold; they then see exactly those resources. The access
 * checker says why.
 */

test('a role with a tag selector and a cluster namespace gives a member exactly those resources', async ({ page, browser }) => {
  const run = Date.now().toString(36);
  const tag = `frontend-${run}`;
  const roleName = `Web team ${run}`;

  // Servers and a cluster to grant, through the API (nothing connects to them)
  const owner = await ownerApi();
  const server = async (name: string, tags: string[]) => {
    const res = await owner.post('/api/servers', {
      data: { name, host: '192.0.2.10', username: 'deploy', authType: 'password', password: 'unused', tags },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: string; name: string };
  };
  const web1 = await server(`web-1-${run}`, [tag]);
  const web2 = await server(`web-2-${run}`, [tag, 'linux']);
  const db1 = await server(`db-1-${run}`, ['backend']);
  const clusterRes = await owner.post('/api/kube/clusters', {
    data: { name: `shop-prod-${run}`, apiUrl: 'https://192.0.2.20:6443', token: 'e2e-token' },
  });
  expect(clusterRes.status(), await clusterRes.text()).toBe(201);
  const cluster = (await clusterRes.json()) as { id: string; name: string };
  await owner.dispose();

  const member = await createMember('viewer', 'roles');

  // ── The owner builds the role ─────────────────────────────────────────────
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Team & Access' }).click();
  await page.getByRole('tab', { name: 'Roles' }).click();
  await page.getByRole('button', { name: 'New role' }).click();

  const editor = page.getByRole('dialog', { name: 'New role' });
  await editor.getByLabel('Name', { exact: true }).fill(roleName);

  // Servers by tag, with a live count of the servers carrying it
  await editor.getByLabel('Add Servers').fill(tag);
  const tagOption = editor.getByRole('option', { name: new RegExp(`Servers tagged ${tag}`) });
  await expect(tagOption).toContainText('2 servers');
  await tagOption.click();
  await editor.getByLabel(`Level for Servers tagged ${tag}`).selectOption('operate');

  // The cluster, narrowed to the shop namespace
  await editor.getByLabel('Add Kubernetes clusters').fill(cluster.name);
  await editor.getByRole('option', { name: new RegExp(cluster.name) }).click();
  await editor.getByLabel('Add namespace').fill('shop');
  await editor.getByLabel('Add namespace').press('Enter');

  // The plain-language preview
  const preview = editor.getByTestId('grant-preview');
  await expect(preview).toContainText(`open terminals and files on 2 servers (${web1.name} via tag ${tag}, ${web2.name} via tag ${tag})`);
  await expect(preview).toContainText(`view namespace shop on ${cluster.name}`);

  await snap(page, 'roles-editor');
  await editor.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Role created — now add its members')).toBeVisible();

  // Members, from the same editor
  const saved = page.getByRole('dialog', { name: `Role ${roleName}` });
  await saved.getByLabel('Member to add').selectOption({ label: `${member.displayName} (${member.email})` });
  await saved.getByRole('button', { name: 'Add member' }).click();
  await expect(saved.getByText(member.email)).toBeVisible();
  await saved.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByText(`tag ${tag} · operate`)).toBeVisible();

  // Limit the member to what the role gives them: take Viewer away, leaving the role
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByRole('button', { name: `Access for ${member.email}` }).click();
  const detail = page.getByRole('dialog', { name: `Access — ${member.displayName}` });
  await expect(detail.getByTestId('member-roles')).toContainText('Viewer');
  await detail.getByRole('button', { name: 'Remove role Viewer' }).click();
  await expect(page.getByText('Role removed — what only it gave is closed')).toBeVisible();
  await expect(detail.getByTestId('member-roles')).not.toContainText('Viewer');
  // The role turned on the modules of what it grants
  await expect(detail.getByTestId('effective-modules')).toContainText(`via ${roleName}`);
  // Effective access, with where it comes from
  await expect(detail.getByTestId('effective-server')).toContainText(web1.name);
  await expect(detail.getByTestId('effective-server')).toContainText(`via ${roleName}`);
  await expect(detail.getByTestId('effective-server')).not.toContainText(db1.name);
  // The picture shows the effective access panel, further down the dialog
  await detail.getByText('Effective access', { exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await snap(page, 'member-access');
  await detail.getByRole('button', { name: 'Close' }).click();

  // ── The member sees only those resources ──────────────────────────────────
  const memberContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const memberPage = await memberContext.newPage();
  await signInWithPassword(memberPage, member.email, member.password);
  await memberPage.goto('/servers');
  await expect(memberPage.getByText(web1.name, { exact: true })).toBeVisible();
  await expect(memberPage.getByText(web2.name, { exact: true })).toBeVisible();
  await expect(memberPage.getByText(db1.name, { exact: true })).toHaveCount(0);
  // A viewer raised to operate by the role may open a terminal there; the AI
  // Assistant is a module of its own, which this role does not turn on
  await expect(memberPage.getByRole('button', { name: 'Connect' })).toHaveCount(2);
  await expect(memberPage.getByRole('link', { name: 'AI Assistant' })).toHaveCount(0);

  const clusters = (await (await memberPage.request.get('/api/kube/clusters')).json()) as { id: string }[];
  expect(clusters.map((c) => c.id)).toEqual([cluster.id]);
  await memberPage.goto('/kubernetes');
  await expect(memberPage.getByText(cluster.name).first()).toBeVisible();
  expect((await memberPage.request.get(`/api/servers/${db1.id}`)).status()).toBe(404);
  await memberContext.close();

  // ── The checker says why ──────────────────────────────────────────────────
  await page.getByRole('tab', { name: 'Access checker' }).click();
  await expect(page.getByRole('tab', { name: 'Access checker' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'false');
  await page.getByLabel('Member', { exact: true }).selectOption({ label: `${member.displayName} (${member.email})` });
  await page.getByLabel('Resource', { exact: true }).selectOption({ label: web2.name });
  const result = page.getByTestId('access-check-result');
  await expect(result).toContainText('Operate');
  await expect(result).toContainText(`via ${roleName}, tag: ${tag}`);
  await snap(page, 'access-checker');

  await page.getByLabel('Resource', { exact: true }).selectOption({ label: db1.name });
  await expect(result).toContainText('No access');
  await expect(result).toContainText('No role or personal grant covers it');
});

test('a member who can operate nothing is not offered the AI assistant', async ({ browser }) => {
  const member = await createMember('viewer', 'no-ai');
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const page = await context.newPage();
  await signInWithPassword(page, member.email, member.password);
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'AI Assistant' })).toHaveCount(0);
  // Straight to the page: not there for them, as the server answers, with a way to ask
  await page.goto('/ai');
  await expect(page.getByTestId('module-not-found')).toBeVisible();
  await context.close();
});

test('a member asks for namespaces of a cluster; the approver narrows them and only those are granted', async ({ page, browser }) => {
  const run = Date.now().toString(36);
  const owner = await ownerApi();
  const clusterRes = await owner.post('/api/kube/clusters', {
    data: { name: `ns-request-${run}`, apiUrl: 'https://192.0.2.21:6443', token: 'e2e-token' },
  });
  expect(clusterRes.status(), await clusterRes.text()).toBe(201);
  const cluster = (await clusterRes.json()) as { id: string; name: string };
  // A viewer: they see the cluster, and may ask for more on it
  const member = await createMember('viewer', 'ns-request');
  const members = (await (await owner.get('/api/team/members')).json()) as { userId: string; email: string }[];
  const memberId = members.find((m) => m.email === member.email)!.userId;

  // ── The member asks for two namespaces ─────────────────────────────────────
  const memberContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const memberPage = await memberContext.newPage();
  await signInWithPassword(memberPage, member.email, member.password);
  await memberPage.goto('/team');
  await memberPage.getByRole('button', { name: 'Request access' }).click();
  const dialog = memberPage.getByRole('form', { name: 'Request access' });
  await dialog.getByLabel('Type').selectOption('cluster');
  await dialog.getByLabel('Level').selectOption('operate');
  await dialog.getByRole('checkbox', { name: new RegExp(cluster.name) }).check();
  for (const ns of ['shop', 'web']) {
    await dialog.getByLabel('Add a namespace to ask for').fill(ns);
    await dialog.getByLabel('Add a namespace to ask for').press('Enter');
  }
  await expect(dialog.getByTestId('request-namespaces')).toContainText('shop');
  await expect(dialog.getByTestId('request-namespaces')).toContainText('web');
  await dialog.getByLabel('Reason').fill('fix the shop rollout');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(memberPage.getByText('Request sent — admins have been notified')).toBeVisible();
  await memberContext.close();

  // ── The owner keeps only `shop` and approves ───────────────────────────────
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/team');
  const row = page.getByTestId('access-request').filter({ hasText: member.email }).filter({ hasText: cluster.name });
  await expect(row).toContainText('in namespaces shop, web (operate)');
  await row.getByLabel('Grant namespace web').uncheck();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Access granted')).toBeVisible();
  await expect(page.getByTestId('access-request').filter({ hasText: member.email }).filter({ hasText: cluster.name })).toContainText(
    'in namespace shop (asked for shop, web) (operate)',
  );

  // Operate in `shop` only; the rest of the cluster stays at view
  const levelIn = async (namespace: string) =>
    ((await (await owner.get(`/api/team/access/explain?userId=${memberId}&type=cluster&id=${cluster.id}&namespace=${namespace}`)).json()) as {
      level: string | null;
    }).level;
  expect(await levelIn('shop')).toBe('operate');
  expect(await levelIn('web')).toBe('view');
  await owner.dispose();
});
