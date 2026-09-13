import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CatalogPack } from '../src/lib/api';
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
        if (path === '/packs/catalog') return route.fulfill({ json: { packs: url.searchParams.get('search') === 'no-match' ? [] : [pack], totalPages: 1, total: 1 } });
        if (path === '/packs/catalog/facets') return route.fulfill({ json: { categories: [], tags: [] } });
        if (path === '/packs/catalog/aokie-receptionist') return route.fulfill({ json: { pack } });
        if (path === '/packs/catalog/aokie-receptionist/ratings') return route.fulfill({ json: { ratings: [], total: 0 } });
        if (path === '/packs/catalog/missing-template') return route.fulfill({ status: 404, json: { message: 'Not found' } });
        return route.fulfill({ json: { apps: [], forms: [], installations: [], notices: [] } });
      });
      const workspaceNavigation = width >= 768 ? page.getByRole('navigation', { name: 'Workspace', exact: true }) : page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Home', exact: true }) });
      await page.goto('/packs');
      if (mode === 'public') {
        await expect(page.getByRole('heading', { name: 'Install a working business app' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByRole('heading', { name: 'Templates for your workspace' })).toBeVisible();
        await expect(workspaceNavigation).toHaveCount(1);
        await expect(page.locator('footer')).toHaveCount(0);
      }
      await page.getByRole('searchbox', { name: 'Search packs' }).or(page.getByRole('textbox', { name: 'Search packs' })).fill('no-match');
      await expect(page.getByText('No apps found', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      const card = page.getByRole('button').filter({ hasText: pack.name }).first();
      await expect(card).toBeVisible();
      await expect(page.locator('[aria-label="Loading apps"]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('gallery.png'), fullPage: true });
      await card.click();
      await expect(page).toHaveURL(/\/packs\/aokie-receptionist$/);
      await expect(page.getByRole('heading', { name: pack.name, exact: true })).toBeVisible();
      await expect(page.getByText('Published Invalid Date')).toHaveCount(0);
      if (mode !== 'public') await expect(workspaceNavigation).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('detail.png'), fullPage: true });
      await page.getByRole('link', { name: mode === 'public' ? 'Marketplace' : 'Templates', exact: true }).last().click();
      await expect(page).toHaveURL(/\/packs$/);
      await page.goto('/packs/missing-template');
      await expect(page.getByText('Template not found', { exact: true })).toBeVisible();
      if (mode !== 'public') await expect(workspaceNavigation).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
}
