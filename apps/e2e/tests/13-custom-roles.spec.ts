import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { createMember, expect, fakeClientIp, ownerApi, signInWithPassword, snap, test } from './fixtures.js';

/**
 * Custom roles end to end (custom roles spec §10): an owner builds a role in
 * Team & Access → Roles from a server tag and a cluster narrowed to one
 * namespace, adds a viewer limited to "only resources from roles", and that
 * viewer then sees exactly those resources. The access checker says why.
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

  // Limit the member to what roles give them
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByRole('button', { name: `Access for ${member.email}` }).click();
  const detail = page.getByRole('dialog', { name: `Access — ${member.displayName}` });
  await detail.getByLabel('Only resources from roles').click();
  await expect(page.getByText('Scope updated')).toBeVisible();
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
  // A viewer raised to operate by the role may open a terminal there
  await expect(memberPage.getByRole('button', { name: 'Connect' })).toHaveCount(2);

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
