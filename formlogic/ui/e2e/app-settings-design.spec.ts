import { expect, test } from '@playwright/test';

for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`App settings ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: false }, version: 0 })), theme);
    let app = { id: 'settings-review', ownerId: 'review', name: 'Customer hub', slug: 'customer-hub', description: 'Customers and appointments in one place.', status: 'draft', settings: { landingPage: 'dashboard', services: { reception: { title: 'Reception service', description: 'Connect calls to the app.', enabled: true } } }, navConfig: [], theme: { primaryColor: '#6366f1' }, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' };
    const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
    const errors: string[] = [];
    let failSave = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
      if (!['GET', 'OPTIONS'].includes(request.method())) {
        writes.push({ method: request.method(), path, body: request.postDataJSON() });
        if (path === '/apps/settings-review') {
          if (failSave) return route.fulfill({ status: 500, json: { message: 'Review save failed' } });
          app = { ...app, ...request.postDataJSON() };
          return route.fulfill({ json: { app } });
        }
      }
      if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'review', name: 'Reviewer', email: 'review@example.test' } } });
      if (path === '/apps') return route.fulfill({ json: { apps: [app] } });
      if (path === '/apps/settings-review/forms') return route.fulfill({ json: { forms: [{ id: 'attachment', appId: app.id, formId: 'appointments', displayName: 'Appointments', settings: {}, sortOrder: 0, isVisible: true }] } });
      if (path === '/apps/settings-review/roles') return route.fulfill({ json: { roles: [{ id: 'member', appId: app.id, name: 'Member', sortOrder: 1 }] } });
      return route.fulfill({ json: { apps: [], forms: [], flows: [], roles: [], items: [], connections: [], keys: [], nodes: [], users: [], invitations: [], groups: [] } });
    });
    await page.goto('/apps/settings-review/settings');
    const tabs = page.getByRole('tablist', { name: 'App settings sections' });
    const tab = (name: string) => tabs.getByRole('tab', { name, exact: true });
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await expect(save).toBeDisabled();
    await page.getByLabel('App name', { exact: true }).fill('Customer hub draft');
    for (const [label, id] of [['General', 'general'], ['Appearance', 'theme'], ['Navigation', 'menu'], ['Access', 'access'], ['Manage', 'manage']]) {
      await tab(label).click();
      await expect(tab(label)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: label, exact: true, level: 2 })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('tab')).toBe(id === 'general' ? null : id);
      await expect(page.getByText('You have unsaved changes', { exact: true })).toBeVisible();
      await expect(save).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clipped = await page.getByRole('tabpanel').locator('input, select, button').evaluateAll(elements => elements.flatMap(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width && (bounds.left < 0 || bounds.right > innerWidth + 1) ? [element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName] : [];
      }));
      expect(clipped, `${label} controls fit`).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`${id}.png`), fullPage: true });
    }
    // Tab selection survives keyboard navigation and drafts are held by the page.
    await tab('Manage').focus();
    await page.keyboard.press('Home');
    await expect(tab('General')).toBeFocused();
    await expect(page.getByLabel('App name', { exact: true })).toHaveValue('Customer hub draft');
    await page.keyboard.press('ArrowRight');
    await expect(tab('Appearance')).toBeFocused();
    await page.getByLabel('Accent color hex value').fill('#0284c7');
    await tab('Navigation').click();
    await page.getByRole('combobox', { name: 'Starting screen' }).selectOption('appointments');
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Help');
    await page.getByLabel('Link', { exact: true }).fill('https://example.test/help');
    await page.getByRole('button', { name: 'Manage forms', exact: true }).click();
    const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Help');
    await tab('Access').click();
    await page.getByRole('switch', { name: 'Let people join from the app link', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Default role for new members' })).toBeVisible();
    // Invalid details should return to General from any tab, with focus on the field.
    await tab('General').click();
    await page.getByLabel('App name', { exact: true }).fill('X');
    await tab('Access').click();
    await save.click();
    await expect(tab('General')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('App name', { exact: true })).toBeFocused();
    expect(writes).toEqual([]);
    await page.getByLabel('App name', { exact: true }).fill('Customer hub draft');
    await tab('Manage').click();
    await page.getByRole('button', { name: 'Delete app', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete app', exact: true });
    await expect(deletion).toBeVisible();
    await deletion.getByRole('button', { name: 'Cancel' }).click();
    failSave = true;
    await save.click();
    await expect(page.getByText('Review save failed', { exact: true })).toBeVisible();
    await expect(save).toBeEnabled();
    await expect(page.getByText('You have unsaved changes', { exact: true })).toBeVisible();
    failSave = false;
    await save.click();
    await expect(save).toBeDisabled();
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1].body).toMatchObject({ name: 'Customer hub draft', theme: { primaryColor: '#0284c7' }, settings: { landingPage: 'appointments', allowSelfRegistration: true, services: app.settings.services }, navConfig: [{ displayName: 'Help', url: 'https://example.test/help' }] });
    expect(writes[1].body).not.toHaveProperty('status');
    await page.reload();
    await expect(tab('Manage')).toHaveAttribute('aria-selected', 'true');
    await tab('Navigation').click();
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Help');
    await expect(page.getByRole('combobox', { name: 'Starting screen' })).toHaveValue('appointments');
    // Subpages share a leading Back button and return to the originating settings tab.
    for (const [section, action, destination] of [['Access', 'Users', 'Users & access'], ['Access', 'Roles', 'Roles & permissions'], ['Manage', 'Forms', 'Manage forms'], ['Manage', 'Relations', 'Relations'], ['Manage', 'Records', 'Records'], ['Manage', 'Deploy', 'Deploy & share']]) {
      await tab(section).click();
      await page.getByRole('tabpanel').getByRole('button', { name: new RegExp(`^${action}\\b`) }).click();
      const header = page.locator('header');
      const title = header.getByRole('heading', { name: destination, exact: true });
      await expect(title).toBeVisible();
      const back = header.getByRole('button', { name: 'Back to App settings', exact: true });
      await expect(back).toBeInViewport();
      const buttonBounds = (await back.boundingBox())!;
      const titleBounds = (await title.boundingBox())!;
      expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(titleBounds.x);
      expect(buttonBounds.height).toBeGreaterThanOrEqual(44);
      expect(titleBounds.width).toBeGreaterThan(30);
      if (destination === 'Deploy & share') {
        const installName = page.getByRole('textbox', { name: 'Install name', exact: true });
        const original = await installName.inputValue();
        await installName.fill('New name');
        await back.click();
        const warning = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await expect(warning).toBeVisible();
        await warning.getByRole('button', { name: 'Cancel' }).click();
        await installName.fill(original);
      }
      await back.click();
      await expect(tab(section)).toHaveAttribute('aria-selected', 'true');
    }
    // The settings Back action also retains its unsaved-change guard in the new position.
    await tab('General').click();
    await page.getByLabel('App name', { exact: true }).fill('Another draft');
    await page.locator('header').getByRole('button', { name: 'Back to apps', exact: true }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel' }).click();
    expect(errors).toEqual([]);
  });
}
