import { expect, test } from '@playwright/test';

for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`Settings categories ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: false }, version: 0 })), theme);
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^.*\/api/, '');
      if (!['GET', 'OPTIONS'].includes(req.method())) writes.push(`${req.method()} ${path}`);
      if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'settings-review', name: 'Reviewer', email: 'review@example.test', timezone: 'Australia/Sydney' } } });
      if (path === '/auth/mfa') return route.fulfill({ json: { enabled: false, pendingSetup: false, recoveryCodesRemaining: 0, trustedBrowsers: [] } });
      if (path === '/ai/preferences') return route.fulfill({ json: { aiSource: 'hosted', chatToolMode: 'ask' } });
      return route.fulfill({ json: { keys: [], connections: [], items: [], nodes: [], assignments: [], forms: [], apps: [], notices: [], sources: [], providers: [], vault: null } });
    });
    await page.goto('/settings');
    const tabs = page.getByRole('tablist', { name: 'Settings categories' });
    await expect(tabs.getByRole('tab', { name: 'Account', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved profile draft');
    await expect(page.getByText('You have unsaved profile changes.', { exact: true })).toBeVisible();
    for (const [label, section] of [['Account', 'profile'], ['Workspace', 'appearance'], ['AI & devices', 'ai'], ['Security', 'security'], ['Your data', 'your-data']]) {
      await tabs.getByRole('tab', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${section}$`));
      await expect(tabs.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      const panel = page.getByRole('tabpanel');
      const bounds = await panel.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clippedControls = await panel.locator('button, input, select').evaluateAll(elements => elements.flatMap(element => {
        if (!element.getClientRects().length) return [];
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < 0 || bounds.right > innerWidth + 1) ? [element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName] : [];
      }));
      expect(clippedControls, `${label} controls fit`).toEqual([]);
      if (label === 'Workspace') await expect(page.getByRole('group', { name: 'Display mode' }).getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`${section}.png`), fullPage: true });
    }
    await tabs.getByRole('tab', { name: 'Account', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Unsaved profile draft');
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    await tabs.getByRole('tab', { name: 'Account', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Workspace', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(tabs.getByRole('tab', { name: 'Your data', exact: true })).toBeFocused();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Backup & restore', exact: true }).click();
    await expect(page).toHaveURL(/#backup$/);
    await expect(page.getByRole('heading', { name: 'Backup & restore', exact: true })).toBeInViewport();
    await page.reload();
    await expect(tabs.getByRole('tab', { name: 'Your data', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Backup & restore', exact: true })).toBeInViewport();
    await page.goto('/settings#ai');
    await expect(tabs.getByRole('tab', { name: 'AI & devices', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'AI assistant', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
