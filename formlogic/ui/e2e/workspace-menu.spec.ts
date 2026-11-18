import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { sessionHeaders } from './session-request';

// Each browser worker uses fresh contexts for UI state and one local sign-in for this spec.
let sessionCookies: Awaited<ReturnType<BrowserContext['cookies']>>;
async function signIn(context: BrowserContext) {
  if (sessionCookies) {
    await context.addCookies(sessionCookies);
    return;
  }
  const response = await context.request.post('/api/auth/login', {
    headers: sessionHeaders(),
    data: { email: process.env.E2E_EMAIL ?? 'test@example.com', password: process.env.E2E_PASSWORD ?? 'password123' },
  });
  expect(response.status()).toBe(200);
  sessionCookies = await context.cookies();
}

test('signed-out workspace and editor bookmarks keep their complete return address', async ({ page }) => {
  for (const bookmark of ['/apps/new?type=upload', '/settings#security', '/responses/example?sort=latest', '/forms/example/screen/edit']) {
    await page.goto(bookmark);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(bookmark);
  }
});

test('workspace tools stay reachable when the sidebar gives way to the phone menu', async ({ page, context }) => {
  await signIn(context);
  await page.setViewportSize({ width: 320, height: 680 });
  await page.goto('/forms');
  const trigger = page.getByRole('button', { name: 'User menu', exact: true });
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Workspace and account' });
  const tools = panel.getByRole('navigation', { name: 'More tools' });
  await expect(tools.getByRole('link')).toHaveText(['Diagrams', 'Templates', 'Recycle bin']);
  const theme = panel.getByRole('button', { name: /Switch to (light|dark) mode/ });
  const before = await theme.textContent();
  await theme.click();
  await expect(theme).not.toHaveText(before!);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await tools.getByRole('link', { name: 'Recycle bin' }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(panel).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
  await trigger.click();
  await expect(panel.getByRole('navigation', { name: 'More tools' })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Settings' })).toBeVisible();
});

type DockEdge = 'left' | 'right' | 'top' | 'bottom';

async function beginDrag(page: Page, x: number, y: number) {
  const grip = page.locator('[data-nav-grip]:visible');
  await expect(grip).toHaveCount(1);
  const handle = await grip.boundingBox();
  if (!handle) throw new Error('Navigation grip has no visible bounds');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 16 });
}

async function dragMenu(page: Page, x: number, y: number) {
  await beginDrag(page, x, y);
  await page.mouse.up();
}

async function checkDock(page: Page, edge: DockEdge) {
  const dock = page.locator('[data-navigation-placement="' + edge + '"]:visible');
  await expect(dock).toHaveCount(1);
  const main = page.getByRole('main');
  const header = main.locator('header').first();
  const newForm = main.getByRole('button', { name: 'New form', exact: true });

  // Confirm that the panel really occupies the selected side and the workspace
  // title and actions have moved clear of it, including when the header sticks.
  await expect.poll(async () => {
    const rail = await dock.boundingBox();
    const body = await header.boundingBox();
    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    if (!rail || !body) return false;
    switch (edge) {
      case 'left': return rail.x < 2 && rail.x + rail.width <= body.x + 1;
      case 'right': return rail.x + rail.width >= viewport.width - 2 && body.x + body.width <= rail.x + 1;
      case 'top': return rail.y < 2 && rail.y + rail.height <= body.y + 1;
      case 'bottom': return rail.y + rail.height >= viewport.height - 2 && body.y + body.height <= rail.y + 1;
    }
  }).toBe(true);
  await newForm.click({ trial: true });
  if (edge === 'bottom') {
    await main.locator('a[href]:visible, button:visible').last().click({ trial: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function openForms(page: Page) {
  await signIn(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/forms');
  await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
}

test('account and section navigation follow the horizontal dock across workspace screens', async ({ page }) => {
  await openForms(page);
  for (const [edge, width, height] of [['top', 1280, 720], ['bottom', 768, 540]] as const) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Dock position', exact: true }).click();
    await page.getByRole('button', { name: 'Dock ' + edge, exact: true }).click();
    const dock = page.locator('[data-navigation-placement="' + edge + '"]');
    const shortcuts = dock.getByRole('navigation', { name: 'Workspace shortcuts' });
    for (const screen of ['Apps', 'Forms', 'Automations']) {
      await shortcuts.getByRole('link', { name: screen, exact: true }).click();
      await expect(page.getByRole('heading', { name: screen, exact: true, level: 1 })).toBeVisible();
      await expect(shortcuts.getByRole('link', { name: screen, exact: true })).toHaveAttribute('aria-current', 'page');
    }
    const account = dock.getByRole('button', { name: 'User menu' });
    await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(1);
    await account.press('Enter');
    const menu = page.getByRole('region', { name: 'Workspace and account' });
    await expect(menu.getByRole('button', { name: /Switch to (dark|light) mode/ })).toBeInViewport();
    const bounds = (await menu.boundingBox())!;
    const rail = (await dock.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    if (edge === 'top') expect(bounds.y).toBeGreaterThanOrEqual(rail.y + rail.height - 1);
    else expect(bounds.y + bounds.height).toBeLessThanOrEqual(rail.y + 1);
    await menu.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(shortcuts.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('desktop navigation can be dragged from any dock to another edge or into the workspace', async ({ page }) => {
  await openForms(page);
  await checkDock(page, 'left');
  await dragMenu(page, 1436, 450);
  await checkDock(page, 'right');
  await dragMenu(page, 720, 4);
  await checkDock(page, 'top');
  await dragMenu(page, 720, 896);
  await checkDock(page, 'bottom');
  await dragMenu(page, 4, 450);
  await checkDock(page, 'left');

  await dragMenu(page, 620, 410);
  const panel = page.getByRole('region', { name: 'Floating navigation' });
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-navigation-placement="floating"]:visible')).toHaveCount(1);
  const beforeDrag = await panel.boundingBox();
  await beginDrag(page, 990, 300);
  await expect.poll(async () => (await panel.boundingBox())?.x ?? 0).toBeGreaterThan(beforeDrag!.x + 100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => panel.boundingBox()).toEqual(beforeDrag);
  await dragMenu(page, 1436, 450);
  await checkDock(page, 'right');
  await page.reload();
  await checkDock(page, 'right');
});

test('floating navigation keeps its location and visibility across links, history and reloads', async ({ page, context }) => {
  await openForms(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.getByRole('button', { name: 'Float menu', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Floating navigation' });
  const launcher = page.getByRole('button', { name: 'Navigation menu', exact: true });
  await expect(panel.getByRole('button', { name: 'Hide navigation' })).toBeFocused();
  const origin = await panel.boundingBox();
  await panel.getByRole('button', { name: 'Move menu to right' }).press('Enter');
  const moveLeft = panel.getByRole('button', { name: 'Move menu to left' });
  await expect.poll(async () => (await panel.boundingBox())?.x ?? 0).toBeGreaterThan(origin!.x + 100);
  await moveLeft.press('ArrowDown');
  await expect.poll(async () => (await panel.boundingBox())?.y ?? 0).toBeGreaterThan(origin!.y + 15);
  await dragMenu(page, 750, 180);
  await expect.poll(async () => (await panel.boundingBox())?.x ?? 0).toBeGreaterThan(origin!.x + 100);
  const moved = await panel.boundingBox();
  const stable = async () => {
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.boundingBox()).toEqual(moved);
  };

  await panel.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Automations' }).click();
  await expect(page).toHaveURL(/\/flows$/);
  await stable();
  await page.goBack();
  await expect(page).toHaveURL(/\/forms$/);
  await stable();
  await page.goForward();
  await expect(page).toHaveURL(/\/flows$/);
  await stable();
  await page.reload();
  await stable();

  await panel.getByRole('button', { name: 'Hide navigation' }).focus();
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await expect(panel).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/forms$/);
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 1440, height: 900 });
  await reopened.goto('/forms');
  const secondLauncher = reopened.getByRole('button', { name: 'Navigation menu', exact: true });
  await expect(secondLauncher).toHaveAttribute('aria-expanded', 'false');
  await secondLauncher.click();
  await expect.poll(() => reopened.getByRole('region', { name: 'Floating navigation' }).boundingBox()).toEqual(moved);
  await reopened.close();
  await launcher.click();
  await stable();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(launcher).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 600 });
  await expect(panel).toBeVisible();
  const resized = await panel.boundingBox();
  expect(resized!.x + resized!.width).toBeLessThanOrEqual(1024);
  expect(resized!.y + resized!.height).toBeLessThanOrEqual(600);

  // All four choices are available to a keyboard user with no pointer drag.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const picker = page.getByRole('button', { name: 'Dock position', exact: true });
    await picker.press('Enter');
    await page.getByRole('button', { name: 'Dock ' + edge, exact: true }).press('Enter');
    await checkDock(page, edge);
  }
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});
