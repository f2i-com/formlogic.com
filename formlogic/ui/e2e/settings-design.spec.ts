import { expect, test } from '@playwright/test';

// The page's sections are links under its header (not tabs): each is an address in the #hash, the
// open one is marked aria-current="page", and all five stay in the page with only the open one
// on show. Each section's address is the hash its tab had.
const SECTIONS = [['Account', 'profile'], ['Workspace', 'appearance'], ['AI & devices', 'ai'], ['Security', 'security'], ['Your data', 'your-data']] as const;

for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`Settings sections ${width}px ${theme}`, async ({ page }, testInfo) => {
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
      if (path === '/ai/preferences') return route.fulfill({ json: { aiSource: 'hosted', chatToolMode: 'auto' } });
      return route.fulfill({ json: { keys: [], connections: [], items: [], nodes: [], assignments: [], forms: [], apps: [], notices: [], sources: [], providers: [], vault: null } });
    });
    await page.goto('/settings');
    const sections = page.getByRole('navigation', { name: 'Settings sections' });
    const link = (label: string) => sections.getByRole('link', { name: label, exact: true });
    const shown = (label: string) => page.getByRole('region', { name: label, exact: true });
    const title = page.getByRole('heading', { name: 'Settings', exact: true, level: 1 });
    await expect(link('Account')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved profile draft');
    await expect(page.getByText('You have unsaved profile changes.', { exact: true })).toBeVisible();
    for (const [label, hash] of SECTIONS) {
      await link(label).click();
      await expect(page).toHaveURL(new RegExp(`#${hash}$`));
      await expect(link(label)).toHaveAttribute('aria-current', 'page');
      for (const [other] of SECTIONS) await expect(shown(other)).toBeVisible({ visible: other === label });
      // A section opens from the page's top, with the row of sections in sight and its own link in
      // the row (a phone's row scrolls sideways; a fraction of a pixel may stay under its edge).
      await expect(sections).toBeInViewport();
      await expect(link(label)).toBeInViewport({ ratio: 0.98 });
      // It starts on the title's line and takes the page's width: no centred column.
      const section = shown(label);
      const bounds = (await section.boundingBox())!;
      const main = (await page.getByRole('main').boundingBox())!;
      expect(Math.abs(bounds.x - (await title.boundingBox())!.x)).toBeLessThanOrEqual(1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(main.x + main.width - (bounds.x + bounds.width)).toBeLessThanOrEqual(25);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clippedControls = await section.locator('a, button, input, select').evaluateAll(elements => elements.flatMap(element => {
        if (!element.getClientRects().length) return [];
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < 0 || bounds.right > innerWidth + 1) ? [element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName] : [];
      }));
      expect(clippedControls, `${label} controls fit`).toEqual([]);
      if (label === 'Workspace') await expect(page.getByRole('group', { name: 'Display mode' }).getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`${hash}.png`), fullPage: true });
    }
    // What was typed in a section is still there after a look at the others.
    await link('Account').click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Unsaved profile draft');
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    // The sections are links: the keyboard goes from one to the next with Tab, and Enter opens it.
    await link('Account').focus();
    await page.keyboard.press('Tab');
    await expect(link('Workspace')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#appearance$/);
    await expect(link('Workspace')).toHaveAttribute('aria-current', 'page');
    // A long section links to its panels; a panel lands in view, below the sticky header.
    await link('Your data').click();
    const backup = page.getByRole('heading', { name: 'Backup & restore', exact: true });
    const belowTheHeader = async () => (await backup.boundingBox())!.y >= (await page.locator('header').first().boundingBox())!.height;
    await page.getByRole('navigation', { name: 'Your data on this page' }).getByRole('link', { name: 'Backup & restore', exact: true }).click();
    await expect(page).toHaveURL(/#backup$/);
    await expect(backup).toBeInViewport();
    expect(await belowTheHeader()).toBe(true);
    await page.reload();
    await expect(link('Your data')).toHaveAttribute('aria-current', 'page');
    await expect(backup).toBeInViewport();
    expect(await belowTheHeader()).toBe(true);
    // The addresses other pages hold: each opens its section, with the panel it names in view.
    for (const [hash, label] of [['ai', 'AI & devices'], ['local-runtime', 'AI & devices'], ['linked-desktops', 'AI & devices'], ['security', 'Security'], ['api-keys', 'Security'], ['your-data', 'Your data'], ['backup', 'Your data']] as const) {
      await page.goto(`/settings#${hash}`);
      await expect(link(label)).toHaveAttribute('aria-current', 'page');
      await expect(shown(label)).toBeVisible();
      await expect(page.locator(`#${hash}`)).toBeInViewport();
    }
    await page.goto('/settings#ai');
    await expect(page.getByRole('heading', { name: 'AI assistant', exact: true })).toBeVisible();
    await expect(sections).toBeInViewport();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
