import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CatalogPack } from '../src/lib/api';
test.use({ serviceWorkers: 'block' });
const starterCatalog = JSON.parse(readFileSync(new URL('../src/data/starter-catalog.json', import.meta.url), 'utf8')) as CatalogPack[];
const pack = { ...starterCatalog.find(p => p.slug === 'aokie-receptionist')!, versions: [] };
for (const mode of ['public', 'signed-in', 'demo']) {
  for (const width of [1440, 390]) {
    test(`packs navigation ${mode} ${width}px`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme: 'dark', sidebarCollapsed: false }, version: 0 })));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname.replace(/^.*\/api/, '');
        if (path === '/auth/me') return route.fulfill({ status: mode === 'public' ? 401 : 200, json: mode === 'public' ? { message: 'Sign in' } : { user: { id: 'packs-review', email: 'review@example.test', name: 'Reviewer', isDemo: mode === 'demo' } } });
        if (path === '/packs/catalog') {
          const found = url.searchParams.get('search') !== 'no-match';
          return route.fulfill({ json: { packs: found ? [pack] : [], totalPages: found ? 2 : 1, total: found ? 13 : 0 } });
        }
        if (path === '/packs/catalog/facets') return route.fulfill({ json: { categories: [{ name: 'Business apps', count: 13 }], tags: [{ name: 'calls', count: 13 }] } });
        if (path === '/packs/catalog/aokie-receptionist') return route.fulfill({ json: { pack } });
        if (path === '/packs/catalog/aokie-receptionist/ratings') return route.fulfill({ json: { ratings: [], total: 0 } });
        if (path === '/packs/catalog/missing-template') return route.fulfill({ status: 404, json: { message: 'Not found' } });
        return route.fulfill({ json: { apps: [], forms: [], installations: [], notices: [] } });
      });
      const workspaceNavigation = width >= 768 ? page.getByRole('navigation', { name: 'Workspace', exact: true }) : page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Home', exact: true }) });
      await page.goto('/packs');
      if (mode === 'public') {
        await expect(page.getByRole('heading', { name: 'Template library' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toHaveCount(0);
      } else {
        // Inside the workspace the catalogue is a workspace page: the Header names it.
        await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
        await expect(workspaceNavigation).toHaveCount(1);
        await expect(page.locator('footer')).toHaveCount(0);
      }
      const search = page.getByRole('searchbox', { name: 'Search templates' });
      await search.fill('no-match');
      await expect(page.getByText('No matching templates', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await search.fill('aokie');
      await page.getByRole('combobox', { name: 'Sort by' }).selectOption('name');
      await page.getByRole('combobox', { name: 'Category' }).selectOption('Business apps');
      await page.getByRole('combobox', { name: 'Tag', exact: true }).selectOption('calls');
      await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByText('Page 2 of 2')).toBeVisible();
      const resultsUrl = new URL(page.url());
      expect([...resultsUrl.searchParams]).toEqual([['q', 'aokie'], ['sort', 'name'], ['tag', 'calls'], ['page', '2']]);
      const card = page.getByRole('link', { name: pack.name, exact: true });
      await expect(card).toBeVisible();
      await expect(page.locator('[aria-label="Loading templates"]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('gallery.png'), fullPage: true });
      await card.click();
      await expect(page).toHaveURL(new URL('/packs/aokie-receptionist' + resultsUrl.search, resultsUrl).href);
      await expect(page.getByRole('heading', { name: pack.name, exact: true })).toBeVisible();
      await expect(page.getByText('Published Invalid Date')).toHaveCount(0);
      if (mode !== 'public') await expect(workspaceNavigation).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('detail.png'), fullPage: true });
      // The public page leads back by its breadcrumb, the workspace page by its Header.
      if (mode === 'public') await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Marketplace' }).click();
      else await page.getByRole('button', { name: 'Back to templates', exact: true }).click();
      await expect(page).toHaveURL(resultsUrl.href);
      await expect(search).toHaveValue('aokie');
      await expect(page.getByText('Page 2 of 2')).toBeVisible();
      await page.goto('/packs/missing-template');
      await expect(page.getByText('Template not found', { exact: true })).toBeVisible();
      if (mode !== 'public') await expect(workspaceNavigation).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
}
