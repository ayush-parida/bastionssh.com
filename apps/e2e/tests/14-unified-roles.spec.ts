import { randomInt } from 'node:crypto';
import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from './env.js';
import { expect, fakeClientIp, ownerApi, signInWithPassword, test } from './fixtures.js';

/**
 * Unified roles end to end (unified roles spec §8): a member holding only No
 * access gets the empty home and their account; a "Team leads" role invites
 * and assigns only roles within its own permissions; a module disappears from
 * the sidebar when the last item granted in it goes; and built-in Viewer
 * edited to drop Kubernetes hides it from every viewer, until reset.
 */

interface RoleSummary {
  id: string;
  name: string;
  system: string | null;
}

async function roles(api: APIRequestContext): Promise<RoleSummary[]> {
  const res = await api.get('/api/team/roles');
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as RoleSummary[];
}

async function builtIn(api: APIRequestContext, system: string): Promise<string> {
  return (await roles(api)).find((r) => r.system === system)!.id;
}

/** A member who joins through an invite giving exactly `roleIds`. */
async function memberWithRoles(roleIds: string[], name: string) {
  const email = `${name}-${Date.now()}-${randomInt(1e6)}@e2e.example.com`;
  const password = `pw-${randomInt(1e9)}-${randomInt(1e9)}`;
  const displayName = `E2E ${name}`;
  const owner = await ownerApi();
  const invite = await owner.post('/api/team/invites', { data: { email, roleIds } });
  expect(invite.status(), await invite.text()).toBe(201);
  const { link } = (await invite.json()) as { link: string };
  await owner.dispose();
  const guest = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const accepted = await guest.post(`/api/invites/${new URL(link).pathname.split('/').pop()}/accept`, {
    data: { email, displayName, password },
  });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  const { user } = (await accepted.json()) as { user: { id: string } };
  await guest.dispose();
  return { userId: user.id, email, password, displayName };
}

/** A signed-in page of its own for `member`. */
async function signedIn(browser: Browser, member: { email: string; password: string }): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': fakeClientIp() } });
  const page = await context.newPage();
  await signInWithPassword(page, member.email, member.password);
  return page;
}

const sidebar = (page: Page) => page.locator('aside nav');

test('a member with only No access sees the empty home and their own account', async ({ browser }) => {
  const owner = await ownerApi();
  const none = await builtIn(owner, 'none');
  await owner.dispose();
  const member = await memberWithRoles([none], 'no-access');

  const page = await signedIn(browser, member);
  await expect(page.getByTestId('no-access-home')).toBeVisible();
  await expect(page.getByText("You don't have access to anything yet")).toBeVisible();
  // Nothing in the sidebar but their own settings
  await expect(sidebar(page).getByRole('link')).toHaveCount(1);
  await expect(sidebar(page).getByRole('link', { name: 'Settings' })).toBeVisible();

  // A deep link into a module is not there for them
  await page.goto('/servers');
  await expect(page.getByTestId('module-not-found')).toBeVisible();
  await page.goto('/team');
  await expect(page.getByTestId('module-not-found')).toBeVisible();

  // Their account is theirs: password, passkeys, sessions — and no organization settings
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Providers' })).toHaveCount(0);
  await page.context().close();
});

test('a Team leads role invites and assigns only roles within its own permissions', async ({ page, browser }) => {
  const leadsName = `Team leads ${Date.now().toString(36)}`;

  // ── The owner builds the role in the Modules grid ─────────────────────────
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/team?tab=roles');
  // Built-ins come first, marked as such
  const rows = page.getByTestId('role-row');
  await expect(rows.nth(0)).toContainText('Owner');
  await expect(rows.nth(0)).toContainText('Built-in');
  await expect(rows.nth(0)).toContainText('Locked');
  await expect(rows.nth(4)).toContainText('No access');

  await page.getByRole('button', { name: 'New role' }).click();
  const editor = page.getByRole('dialog', { name: 'New role' });
  await editor.getByLabel('Name', { exact: true }).fill(leadsName);
  await editor.getByRole('radio', { name: 'Members: Operate' }).check();
  await expect(editor.getByTestId('module-hint-team_members')).toContainText('Invite, suspend');
  await editor.getByRole('radio', { name: 'Roles & access: Manage' }).check();
  // A level a module does not use is not offered
  await expect(editor.getByRole('radio', { name: 'Members: Manage' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Role created — now add its members')).toBeVisible();
  await page.getByRole('dialog', { name: `Role ${leadsName}` }).getByRole('button', { name: 'Close', exact: true }).first().click();

  // A viewer who also leads the team, and someone they will give a role to
  const owner = await ownerApi();
  const viewer = await builtIn(owner, 'viewer');
  const operator = await builtIn(owner, 'operator');
  const leads = (await roles(owner)).find((r) => r.name === leadsName)!.id;
  const lead = await memberWithRoles([viewer, leads], 'lead');
  const newcomer = await memberWithRoles([viewer], 'newcomer');

  // ── The lead invites: only roles they hold are offered ────────────────────
  const leadPage = await signedIn(browser, lead);
  await sidebar(leadPage).getByRole('link', { name: 'Team & Access' }).click();
  await leadPage.getByRole('button', { name: 'Invite person' }).click();
  const form = leadPage.locator('form', { has: leadPage.getByRole('button', { name: 'Create invite' }) });
  const offered = form.getByTestId('invite-roles');
  await expect(offered).toContainText('Viewer');
  await expect(offered).toContainText(leadsName);
  await expect(offered.getByLabel('Role Operator', { exact: true })).toHaveCount(0);
  await expect(offered.getByLabel('Role Admin', { exact: true })).toHaveCount(0);
  await form.getByPlaceholder('teammate@example.com').fill(`invited-by-lead-${Date.now()}@e2e.example.com`);
  await form.getByRole('button', { name: 'Create invite' }).click();
  await expect(leadPage.getByText("Copy this link now — it won't be shown again")).toBeVisible();
  // The server holds the line too
  const refused = await leadPage.request.post('/api/team/invites', {
    data: { email: `sneaky-${Date.now()}@e2e.example.com`, roleIds: [operator] },
  });
  expect(refused.status()).toBe(403);

  // ── …and assigns: Viewer and Team leads yes, Operator never ───────────────
  await leadPage.getByRole('button', { name: `Access for ${newcomer.email}` }).click();
  const detail = leadPage.getByRole('dialog', { name: `Access — ${newcomer.displayName}` });
  const add = detail.getByLabel('Role to add');
  await expect(add.locator('option', { hasText: leadsName })).toHaveCount(1);
  await expect(add.locator('option', { hasText: 'Operator' })).toHaveCount(0);
  await expect(add.locator('option', { hasText: 'Admin' })).toHaveCount(0);
  await add.selectOption({ label: leadsName });
  await detail.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(leadPage.getByText('Role added')).toBeVisible();
  await expect(detail.getByTestId('member-roles')).toContainText(leadsName);
  // The Modules section says where their new rights come from
  await expect(detail.getByTestId('effective-modules')).toContainText(`via ${leadsName}`);
  expect((await leadPage.request.post(`/api/team/roles/${operator}/members`, { data: { userId: newcomer.userId } })).status()).toBe(403);
  await owner.dispose();
  await leadPage.context().close();
});

test('removing the last item granted in a module hides it', async ({ page, browser }) => {
  const run = Date.now().toString(36);
  const owner = await ownerApi();
  const server = await owner.post('/api/servers', {
    data: { name: `only-${run}`, host: '192.0.2.30', username: 'deploy', authType: 'password', password: 'unused', tags: [] },
  });
  expect(server.status(), await server.text()).toBe(201);
  const { id: serverId, name: serverName } = (await server.json()) as { id: string; name: string };
  const roleName = `One server ${run}`;
  const created = await owner.post('/api/team/roles', {
    data: {
      name: roleName,
      modulePermissions: { servers: 'view' },
      grants: [{ resourceType: 'server', selector: 'id', resourceId: serverId, level: 'view' }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const role = (await created.json()) as { id: string };
  const member = await memberWithRoles([role.id], 'one-server');
  await owner.dispose();

  const memberPage = await signedIn(browser, member);
  await expect(sidebar(memberPage).getByRole('link', { name: 'Servers' })).toBeVisible();
  await memberPage.goto('/servers');
  await expect(memberPage.getByText(serverName, { exact: true })).toBeVisible();

  // The owner takes the server out of the role
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/team?tab=roles');
  await page.getByRole('button', { name: `Edit role ${roleName}` }).click();
  const editor = page.getByRole('dialog', { name: `Role ${roleName}` });
  await editor.getByRole('button', { name: `Remove ${serverName}` }).click();
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Role saved')).toBeVisible();

  // Nothing left in Servers: the module is gone for them, link and page
  await memberPage.goto('/');
  await expect(memberPage.getByTestId('no-access-home')).toBeVisible();
  await expect(sidebar(memberPage).getByRole('link', { name: 'Servers' })).toHaveCount(0);
  await memberPage.goto('/servers');
  await expect(memberPage.getByTestId('module-not-found')).toBeVisible();
  await memberPage.context().close();
});

test('built-in Viewer edited to drop Kubernetes hides it for viewers, and Reset to default brings it back', async ({ page, browser }) => {
  const owner = await ownerApi();
  const cluster = await owner.post('/api/kube/clusters', {
    data: { name: `viewers-${Date.now().toString(36)}`, apiUrl: 'https://192.0.2.22:6443', token: 'e2e-token' },
  });
  expect(cluster.status(), await cluster.text()).toBe(201);
  const member = await memberWithRoles([await builtIn(owner, 'viewer')], 'viewer-kube');
  await owner.dispose();

  const viewerPage = await signedIn(browser, member);
  await expect(sidebar(viewerPage).getByRole('link', { name: 'Kubernetes' })).toBeVisible();

  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/team?tab=roles');
  await page.getByRole('button', { name: 'Edit role Viewer' }).click();
  const editor = page.getByRole('dialog', { name: 'Role Viewer' });
  // Built-ins keep their names
  await expect(editor.getByLabel('Name', { exact: true })).toBeDisabled();
  await editor.getByRole('radio', { name: 'Kubernetes: None' }).check();
  await expect(editor.getByTestId('module-hint-kubernetes')).toContainText('parked');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Role saved')).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).first().click();
  const row = page.getByTestId('role-row').filter({ hasText: 'Sees every resource' });
  await expect(row).toContainText('Customized');

  await viewerPage.reload();
  await expect(sidebar(viewerPage).getByRole('link', { name: 'Servers' })).toBeVisible();
  await expect(sidebar(viewerPage).getByRole('link', { name: 'Kubernetes' })).toHaveCount(0);
  await viewerPage.goto('/kubernetes');
  await expect(viewerPage.getByTestId('module-not-found')).toBeVisible();

  // Back to its defaults (the other specs share this org)
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset role Viewer to default' }).click();
  await expect(page.getByText('Back to its defaults')).toBeVisible();
  await expect(row).not.toContainText('Customized');
  await viewerPage.goto('/');
  await expect(sidebar(viewerPage).getByRole('link', { name: 'Kubernetes' })).toBeVisible();
  await viewerPage.context().close();
});
