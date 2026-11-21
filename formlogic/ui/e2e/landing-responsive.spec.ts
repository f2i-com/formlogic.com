import { expect, test } from '@playwright/test';

test('the landing demo link has a useful destination when the site has no live demos', async ({ page }) => {
  await page.route('**/api/demo/apps', route => route.fulfill({ json: { apps: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live-demo');
  const templates = page.getByRole('link', { name: 'Browse the marketplace' });
  await expect(templates).toBeInViewport();
  await templates.click();
  await expect(page.getByRole('heading', { name: 'Featured', exact: true })).toBeVisible();
});

test('landing bookmarks open their section and respect reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/demo/apps', route => route.fulfill({ json: { apps: [] } }));
  for (const [fragment, heading] of [['product', 'Everything you need to run connected apps.'], ['live-demo', 'Find a starting point.']]) {
    await page.goto('about:blank');
    await page.goto('/#' + fragment);
    const target = page.getByRole('heading', { name: heading, exact: true });
    await expect(target).toBeInViewport();
    await expect.poll(async () => (await target.boundingBox())?.y ?? Infinity).toBeLessThan(220);
  }
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
});

test('a web app link keeps its encoded subpath, query and fragment without the native runtime', async ({ page }) => {
  await page.goto('/open/app/field-notes/view/weekly%20report?sort=recent#notes');
  await expect(page).toHaveURL(/\/app\/field-notes\/view\/weekly%20report\?sort=recent#notes$/);
});

test('privacy sections can be reached by keyboard and have shareable addresses', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page).toHaveTitle('Privacy Policy · FormLogic');
  const summary = page.getByText('Jump to a section', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  const sectionLink = page.getByRole('link', { name: 'Your Rights', exact: true });
  await sectionLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/privacy#your-rights$/);
  await expect(page.getByRole('heading', { name: 'Your Rights' })).toBeInViewport();
  await page.goto('/terms');
  await page.goto('/privacy#your-rights');
  await expect(page.getByRole('heading', { name: 'Your Rights' })).toBeInViewport();
});

test('landing navigation fits phone widths and keeps signup reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'FormLogic primary navigation' });
  await expect(nav).toBeVisible();

  // Resize the mounted desktop header: a fresh mobile load alone misses
  // responsive layout and open-menu state changes.
  for (const width of [390, 375, 320, 640, 899]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const bounds = await nav.locator('.lv2-nav__actions').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 16);
    const menu = nav.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    await expect(nav.getByRole('link', { name: 'Start free', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  }

  await nav.getByRole('button', { name: 'Open navigation' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(nav.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  await expect(nav.getByRole('link', { name: 'Product', exact: true })).toBeVisible();
});

test('the landing notebook keeps the form and records in sync without sending notes to a server', async ({ page }) => {
  await page.goto('/');
  const example = page.getByRole('figure', { name: 'Interactive Field Ops app, shared database and charts sample' });
  const field = example.getByLabel('Add a job note — updates SQLite, charts & flows live');
  const add = example.getByRole('button', { name: 'Add note' });
  const note = 'Review the front desk handover';
  const outgoing = new Set<string>();
  page.on('request', request => {
    if ((request.postData() ?? '').includes(note) || decodeURIComponent(request.url()).includes(note)) outgoing.add(request.url());
  });

  await expect(add).toBeDisabled();
  await field.fill('   ');
  await expect(add).toBeDisabled();
  await field.fill(note);
  await field.press('Enter');
  await expect(example.getByRole('listitem').first()).toContainText(note);
  const notebook = example.getByRole('tab', { name: 'App' });
  await notebook.focus();
  await page.keyboard.press('ArrowRight');
  const records = example.getByRole('tab', { name: 'Shared SQLite' });
  await expect(records).toBeFocused();
  await expect(records).toHaveAttribute('aria-selected', 'true');
  await expect(example.getByRole('cell', { name: note, exact: true })).toBeVisible();
  await records.press('ArrowLeft');
  await expect(field).toBeEmpty();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(example.getByRole('listitem')).toHaveCount(3);
  await expect(example.getByText(note)).toHaveCount(0);
  expect([...outgoing]).toEqual([]);
});
