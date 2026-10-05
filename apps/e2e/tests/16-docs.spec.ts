import { createMember, expect, signInWithPassword, snap, test } from './fixtures.js';

/**
 * The in-app docs: open from the sidebar, search, read a page with its code
 * blocks and table of contents, and land on a heading from a deep link. No
 * API is involved — the pages are part of the web app.
 */

test.describe('Docs', () => {
  let viewer: { email: string; password: string };

  test.beforeAll(async () => {
    viewer = await createMember('viewer', 'docs');
  });

  test('searches the docs and opens the static site page', async ({ page }) => {
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.locator('aside nav').getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { name: 'Docs', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Deployments' })).toContainText('Deploy a static site');

    await page.getByLabel('Search the docs').fill('static');
    const results = page.getByRole('listbox', { name: 'Search results' });
    const first = results.getByRole('option').first();
    await expect(first).toContainText('Deploy a static site');
    // The words found are marked
    await expect(first.locator('mark').first()).toHaveText(/static/i);
    await snap(page, 'docs-search');
    await first.click();

    await expect(page).toHaveURL(/\/docs\/deployments\/static-site/);
    await expect(page.getByRole('heading', { name: 'Deploy a static site', level: 1 })).toBeVisible();
    await expect(results).toHaveCount(0);
    // Code blocks can be copied; callouts are styled notes
    await expect(page.getByRole('button', { name: 'Copy code' }).first()).toBeVisible();
    await expect(page.locator('[data-callout="warning"]').first()).toBeVisible();
    // Where this page sits among the others
    await expect(page.getByRole('navigation', { name: 'Docs' }).getByRole('link', { name: 'Deploy a static site' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Previous and next' }).getByRole('link', { name: /Next/ })).toContainText('Deploy a dynamic Next.js app');
    await snap(page, 'docs-static-site');
  });

  test('copies a code block, follows a link between pages, and opens deep links at their heading', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signInWithPassword(page, viewer.email, viewer.password);
    await page.goto('/docs/deployments/static-site');
    await page.getByRole('button', { name: 'Copy code' }).first().click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("output: 'export'");

    // The table of contents lists the page's sections
    await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Which folder to upload' })).toHaveAttribute('href', '#which-folder-to-upload');

    // Links between pages stay in the app
    await page.getByRole('article').getByRole('link', { name: 'Troubleshooting' }).first().click();
    await expect(page).toHaveURL(/\/docs\/deployments\/troubleshooting/);

    await page.goto('/docs/deployments/troubleshooting#build-ran-out-of-memory');
    await expect(page.getByRole('heading', { name: 'Build ran out of memory' })).toBeInViewport();

    await page.goto('/docs/deployments/no-such-page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
