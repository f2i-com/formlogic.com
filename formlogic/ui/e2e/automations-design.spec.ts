import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`automation creation and library ${width}px ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => {
      localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: false }, version: 0 }));
      sessionStorage.setItem('oaiy.token:http://127.0.0.1:17972', 'fixture-only');
    }, theme);
    const flows = Array.from({ length: 23 }, (_, i) => ({
      id: `flow-${i + 1}`, ownerUserId: 'review', appId: i < 17 ? null : 'app-one',
      name: `Follow up ${String(i + 1).padStart(2, '0')}`, slug: i === 0 ? 'a'.repeat(60) : `follow-up-${i + 1}`,
      description: 'Keep customers informed after a form submission.', engine: 'f2i',
      flowJson: { nodes: [{ id: 'input', type: 'input', data: {}, position: { x: 0, y: 0 } }], edges: [] },
      version: 1, enabled: true, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    }));
    let creations = 0;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^.*\/api/, '');
      if (url.port === '17972') {
        if (path === '/health') return route.fulfill({ json: { product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: 'test', status: 'ok' } });
        if (path === '/services') return route.fulfill({ json: { services: [{ id: 'llamacpp', name: 'Local Qwen', category: 'llm', status: 'running', port: 8081 }] } });
        return route.fulfill({ json: { events: [], providers: [], connectors: [] } });
      }
      if (path === '/auth/me') return route.fulfill({ json: { user: { id: 'review', email: 'review@example.test', name: 'Reviewer' } } });
      if (path === '/flows' && route.request().method() === 'POST') {
        creations++;
        if (creations === 1) return route.fulfill({ status: 500, json: { message: 'Temporary test failure' } });
        const input = route.request().postDataJSON();
        expect(input.slug).toBe(`${'a'.repeat(58)}-2`);
        const flow = { ...flows[0], ...input, id: 'created-flow', appId: null };
        flows.unshift(flow);
        return route.fulfill({ json: { flow } });
      }
      if (path === '/flows/created-flow' && route.request().method() === 'PUT') {
        const flow = flows.find(f => f.id === 'created-flow')!;
        Object.assign(flow, route.request().postDataJSON());
        return route.fulfill({ json: { flow } });
      }
      if (path === '/flows') return route.fulfill({ json: { flows: flows.filter(f => f.appId === null) } });
      if (path === '/apps/app-one/flows') return route.fulfill({ json: { flows: flows.filter(f => f.appId) } });
      if (path === '/apps') return route.fulfill({ json: { apps: [{ id: 'app-one', name: 'Customer hub', slug: 'customer-hub', navConfig: [] }] } });
      return route.fulfill({ json: { flows: [], forms: [], bindings: [], runs: [], total: 0, connections: [], notices: [], definitions: [] } });
    });
    await page.goto('/flows');
    await expect(page.getByRole('heading', { name: 'Create a new flow' })).toBeVisible();
    expect(creations).toBe(0);
    await page.getByLabel('Automation name').fill('a'.repeat(60));
    await page.screenshot({ path: testInfo.outputPath('create.png'), fullPage: true });
    const navigation = page.getByRole('navigation', { name: 'Automation workspace' });
    await navigation.getByRole('button', { name: /Existing flows/ }).click();
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('1–8 of 23 flows');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('9–16 of 23 flows');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('17–23 of 23 flows');
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await page.getByLabel('Search flows').fill('Follow up 23');
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('1–1 of 1 flows');
    await page.getByLabel('Search flows').fill('missing');
    await expect(page.getByText('No flows match "missing".')).toBeVisible();
    await page.getByLabel('Search flows').fill('');
    await page.getByLabel('Show automations from').selectOption('app-one');
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('1–6 of 6 flows');
    await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await navigation.getByRole('button', { name: 'Create a flow', exact: true }).click();
    await expect(page.getByLabel('Automation name')).toHaveValue('a'.repeat(60));
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    await expect(page.getByText('Failed to create flow', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Automation name')).toHaveValue('a'.repeat(60));
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    await expect(page.locator('.react-flow').first()).toBeVisible();
    expect(creations).toBe(2);
    await expect(page.getByRole('button', { name: 'Test run', exact: true })).toBeInViewport();
    await expect.poll(() => page.locator('.react-flow').evaluate(canvas => {
      const bounds = canvas.getBoundingClientRect();
      return [...canvas.querySelectorAll('.react-flow__node')].every(node => {
        const box = node.getBoundingClientRect();
        const card = node.firstElementChild!.getBoundingClientRect();
        return Math.abs(box.width - card.width) < 1 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('editor.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Test run', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run in browser', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('test-panel.png'), fullPage: true });
    await page.getByRole('button', { name: /^Close test run$/i }).click();
    if (width < 768) {
      await expect(page.getByRole('button', { name: 'Triggers', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: 'History', exact: true })).toBeInViewport();
    }
    await expect(page.getByRole('button', { name: 'Arrange steps', exact: true })).toBeInViewport();
    if (await page.getByRole('button', { name: 'Add node', exact: true }).isVisible()) await page.getByRole('button', { name: 'Add node', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search flow nodes', exact: true }).fill('Template');
    await expect(page.getByRole('button', { name: 'Add Template node', exact: true })).toContainText('text');
    await page.screenshot({ path: testInfo.outputPath('step-picker.png'), fullPage: true });
    await page.getByRole('button', { name: 'Add Template node', exact: true }).click();
    await expect(page.locator('.react-flow__node-template')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('step-settings.png'), fullPage: true });
    await page.getByRole('button', { name: width < 768 ? 'Close Template settings' : 'Close step settings', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.react-flow__node-template')).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('.react-flow__node-template')).toHaveCount(1);
    if (await page.getByRole('button', { name: /Close (Template settings|step settings)/ }).isVisible()) await page.getByRole('button', { name: /Close (Template settings|step settings)/ }).click();
    await page.getByRole('button', { name: 'Arrange steps', exact: true }).click();
    await page.getByRole('button', { name: 'Back to flows', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Flow pages' })).toContainText('of 24 flows');
    await page.getByRole('button', { name: 'Open AI services', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'OAIY services', exact: true })).toBeVisible();
    await expect(page.getByText('Local Qwen', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('oaiy-services.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}
