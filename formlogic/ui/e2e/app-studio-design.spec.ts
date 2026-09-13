import { test, expect } from '@playwright/test';

const sections = [
  ['plan', 'Overview'], ['data', 'Data & forms'], ['screens', 'Screens'],
  ['automations', 'Automations'], ['access', 'Users & roles'], ['publish', 'Review & publish'],
];
for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`App Studio sections ${width}px ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: false }, version: 0 })), theme);
    const app = { id: 'studio-review', ownerId: 'review', name: 'Customer hub', slug: 'customer-hub', description: 'Manage customers, appointments and follow-ups in one place.', status: 'draft', settings: { landingPage: 'dashboard' }, navConfig: [], theme: { primaryColor: '#6366f1' }, publishedVersion: 0, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' };
    const form = { id: 'customers', title: 'Customers', status: 'draft', responseCount: 0, settings: {}, theme: {}, fields: [{ id: 'name', label: 'Name', type: 'short_text', required: true, order: 0, properties: {} }], createdAt: app.createdAt, updatedAt: app.updatedAt };
    const appointmentForm = { ...form, id: 'appointments', title: 'Bookings' };
    const fixtures = [form, appointmentForm];
    let mutations = 0;
    let appLoads = 0;
    await page.addInitScript(() => {
      const state = window as typeof window & { studioInitialHeadings: string[] };
      state.studioInitialHeadings = [];
      new MutationObserver(() => {
        const heading = document.querySelector('h2')?.textContent;
        if (heading && state.studioInitialHeadings.at(-1) !== heading) state.studioInitialHeadings.push(heading);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
      if (!['GET', 'OPTIONS'].includes(route.request().method())) mutations++;
      if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'review', name: 'Reviewer', email: 'review@example.test' } } });
      if (path === '/apps/studio-review') { appLoads++; return route.fulfill({ json: { app } }); }
      if (path === '/apps') return route.fulfill({ json: { apps: [app] } });
      if (path === '/apps/studio-review/forms') {
        // Deliberately stagger app metadata and forms to exercise the initial loading boundary.
        await new Promise(resolve => setTimeout(resolve, 250));
        return route.fulfill({ json: { forms: fixtures.map((item, index) => ({ id: `attachment-${index}`, appId: app.id, formId: item.id, displayName: index ? 'Appointments' : 'Customers', sortOrder: index, isVisible: true, settings: {} })) } });
      }
      const requestedForm = fixtures.find(item => path === `/forms/${item.id}`);
      if (requestedForm) return route.fulfill({ json: { form: requestedForm } });
      if (path === '/apps/studio-review/roles') return route.fulfill({ json: { roles: [{ id: 'owner', appId: app.id, name: 'Owner', isSystem: true, sortOrder: 0 }] } });
      return route.fulfill({ json: { forms: [], flows: [], bindings: [], roles: [], permissions: [], users: [], invitations: [], groups: [], versions: [], domains: [], blueprints: [], notices: [], apps: [], count: 0, total: 0, deployment: null, installations: [], connections: [] } });
    });
    await page.goto('/apps/studio-review/studio/plan');
    await expect(page.getByRole('heading', { name: 'Overview', level: 2, exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { studioInitialHeadings: string[] }).studioInitialHeadings)).not.toContain('Data & forms');
    expect(appLoads).toBe(1);
    const nav = page.getByRole('navigation', { name: 'App Studio sections', exact: true });
    for (const [, label] of sections) {
      const button = nav.getByRole('button', { name: label, exact: true });
      await expect(button).toBeInViewport();
      await expect(button.locator('span').filter({ hasText: label }).first()).toBeVisible();
    }
    for (const [id, label] of sections) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/studio/${id}$`));
      await expect(page.getByRole('heading', { name: label, level: 2, exact: true })).toBeVisible();
      await expect(nav.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (id === 'data') {
        const search = page.getByRole('searchbox', { name: 'Search app forms' });
        await search.fill('  BOOKINGS  ');
        const formsPanel = page.locator('section').filter({ has: search });
        await expect(formsPanel.getByRole('button', { name: /Appointments/ })).toBeVisible();
        await expect(formsPanel.getByRole('button', { name: /Customers/ })).toHaveCount(0);
        await formsPanel.getByRole('button', { name: /Appointments/ }).click();
        await search.fill('does not exist');
        await expect(page.getByText('No matching forms', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Clear search', exact: true }).click();
        await expect(formsPanel.getByRole('button', { name: /Appointments/ })).toHaveAttribute('aria-current', 'true');
        const fieldsTab = page.getByRole('tab', { name: 'Fields', exact: true });
        await fieldsTab.focus();
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name: 'Relationships', exact: true })).toBeFocused();
        await expect(page.getByRole('tab', { name: 'Relationships', exact: true })).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Home');
        await expect(fieldsTab).toBeFocused();
        await page.getByRole('button', { name: 'Add field', exact: true }).click();
        await page.getByRole('textbox', { name: 'Field name' }).fill('Appointment time');
        await page.getByRole('combobox', { name: 'Answer type' }).selectOption('date');
        await expect(page.getByRole('button', { name: 'Save field', exact: true })).toBeEnabled();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath('add-field.png'), fullPage: true });
        await page.getByRole('button', { name: 'Close field editor', exact: true }).click();

      }
      if (id === 'publish') {
        const passed = page.getByRole('button', { name: /Show \d+ passed checks?/ });
        await expect(passed).toHaveAttribute('aria-expanded', 'false');
        await passed.click();
        await expect(page.getByRole('button', { name: 'Hide passed checks', exact: true })).toHaveAttribute('aria-expanded', 'true');
        await page.getByRole('button', { name: 'Hide passed checks', exact: true }).click();
        if (width < 1000) {
          const checks = await page.locator('#studio-publish-checks').boundingBox();
          const sharing = await page.getByText('App link', { exact: true }).boundingBox();
          expect(checks!.y).toBeLessThan(sharing!.y);
        }
        await page.getByRole('button', { name: 'Publish app', exact: true }).filter({ hasText: /^Publish app$/ }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText(/Makes Customer hub available at its app link/)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('publish-dialog.png') });
        await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
        await expect(dialog).toBeHidden();
        const publishCards = page.locator('#studio-publish-checks').locator('../..');
        const bounds = await publishCards.boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 10);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      if (id === 'screens') {
        const tools = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Hosting & app tools' }) });
        await expect(tools).not.toHaveAttribute('open', '');
        await tools.locator('summary').click();
        await expect(tools.getByRole('heading', { name: 'Bring another app into this one' })).toBeVisible();
        await tools.locator('summary').click();
        if (width < 1000) {
          const picker = page.getByLabel('Screen to edit', { exact: true });
          await picker.selectOption('form:appointments');
          await page.getByRole('button', { name: 'Screen settings', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Screen settings', exact: true })).toBeFocused();
          await expect(page.getByRole('heading', { name: 'Screen settings', exact: true })).toBeInViewport();
          await expect(page.getByRole('region', { name: /app preview$/ }).getByRole('heading', { name: 'Appointments', exact: true })).toBeVisible();
          await picker.selectOption('home');
        } else {
          await expect(page.getByRole('heading', { name: 'App screens', exact: true })).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Edit home screen', exact: true })).toBeVisible();
        await expect(page.getByText('Current home screen', { exact: true })).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        const previewCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Screen preview', exact: true }) });
        const previewBounds = await previewCard.boundingBox();
        expect(previewBounds!.x + previewBounds!.width).toBeLessThanOrEqual(width - 10);
        if (width === 1440) {
          const screenList = page.locator('section').filter({ has: page.getByRole('heading', { name: 'App screens', exact: true }) });
          const listBounds = await screenList.boundingBox();
          expect(listBounds!.width).toBeLessThan(previewBounds!.width / 2);
          expect(listBounds!.height).toBeLessThan(previewBounds!.height);
          const settingsBounds = await page.getByRole('heading', { name: 'Home settings', exact: true }).boundingBox();
          expect(settingsBounds!.y).toBeGreaterThan(previewBounds!.y + previewBounds!.height);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`${id}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Previous: Users & roles', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/access$/);
    await expect(page.getByRole('heading', { name: 'Users & roles', level: 2, exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Next: Review & publish', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/publish$/);
    await expect(page.getByRole('heading', { name: 'Review & publish', level: 2, exact: true })).toBeInViewport();
    expect(mutations).toBe(0);
    expect(errors).toEqual([]);
  });
}
