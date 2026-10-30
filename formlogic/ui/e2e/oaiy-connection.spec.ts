import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// The connection to OAIY on this computer, in a real browser, because what it is
// about is what a real browser keeps: localStorage across tabs, sessionStorage not.
// OAIY and the account are both played at the network edge, so nothing here can
// reach a desktop, and OAIY's approval (a click in its own window) is taken as given.

const PAIR_CODE = '7QK2M9';

interface World {
  user: { id: string; email: string; name: string };
  /** The tokens OAIY honours. */
  grants: Set<string>;
  pairingRequests: number;
  /** What reached OAIY's service and plugin routes, and the token each carried. */
  calls: Array<{ method: string; path: string; bearer: string | null }>;
  serviceStatus: string;
}

function newWorld(): World {
  return {
    user: { id: 'alice', email: 'alice@example.test', name: 'Alice' },
    grants: new Set(),
    pairingRequests: 0,
    calls: [],
    serviceStatus: 'running',
  };
}

async function playTheNetwork(context: BrowserContext, world: World) {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api/, '');
    if (url.port === '17972') {
      const bearer = request.headers().authorization?.replace(/^Bearer /, '') ?? null;
      const refused = () => route.fulfill({ status: 403, json: { error: 'origin not allowed' } });
      if (path === '/health') return route.fulfill({ json: { product: 'oaiy-desktop', protocol: 'oaiy-bridge/1', version: '0.1.11', status: 'ok' } });
      if (path === '/bridge/pairing' && request.method() === 'POST') {
        world.pairingRequests += 1;
        return route.fulfill({ json: { pairingId: 'p1', code: PAIR_CODE } });
      }
      if (path === '/bridge/pairing/p1') {
        world.grants.add('granted');
        return route.fulfill({ json: { status: 'approved', token: 'granted' } });
      }
      if (path.startsWith('/services') || path.startsWith('/plugins')) {
        world.calls.push({ method: request.method(), path, bearer });
        if (!bearer || !world.grants.has(bearer)) return refused();
        if (path === '/services') return route.fulfill({ json: { services: [{ id: 'llamacpp', name: 'Local Qwen', category: 'llm', status: world.serviceStatus, port: 8081 }] } });
        if (path === '/plugins') return route.fulfill({ json: { plugins: [{ id: 'aokie', state: 'running', manifest: { name: 'Aokie', version: '1.0.0' } }] } });
        if (path === '/services/llamacpp/stop') world.serviceStatus = 'stopped';
        if (path === '/services/llamacpp/start') world.serviceStatus = 'running';
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { events: [], providers: [], connectors: [], capabilities: [] } });
    }
    if (path === '/auth/me') return route.fulfill({ json: { user: world.user } });
    return route.fulfill({ json: { flows: [], forms: [], apps: [], bindings: [], runs: [], total: 0, connections: [], notices: [], definitions: [], keys: [], items: [], nodes: [] } });
  });
}

const chip = (page: Page) => page.getByRole('button', { name: /^Desktop connection:/ });
const connected = (page: Page) => page.getByRole('button', { name: 'Desktop connection: OAIY connected' });

async function pairFromSettings(page: Page) {
  await page.goto('/settings#local-runtime');
  await page.getByRole('button', { name: 'Connect OAIY Desktop' }).click();
  await expect(page.getByText('Connected on this computer')).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test('one approval is enough: a new tab reconnects by itself, and the control drives OAIY\'s services', async ({ context, page }) => {
  const world = newWorld();
  await playTheNetwork(context, world);
  await pairFromSettings(page);
  expect(world.pairingRequests).toBe(1);

  // A new tab has an empty sessionStorage: this is where a code used to be asked for again.
  const newTab = await context.newPage();
  await newTab.goto('/flows');
  await expect(connected(newTab)).toBeVisible();
  expect(world.pairingRequests).toBe(1);

  await connected(newTab).click();
  const menu = newTab.getByRole('dialog', { name: 'Desktop connection' });
  await expect(menu.getByText('Local Qwen')).toBeVisible();
  await expect(menu.getByText('Aokie')).toBeVisible();
  await expect(newTab).toHaveURL(/\/flows/); // it opens the menu, it does not leave for Settings

  await menu.getByRole('button', { name: 'Stop' }).first().click();
  await expect(menu.getByRole('button', { name: 'Start' }).first()).toBeVisible();
  expect(world.calls).toContainEqual({ method: 'POST', path: '/services/llamacpp/stop', bearer: 'granted' });
});

test('a tab that is already open hears of the connection made in another', async ({ context, page }) => {
  const world = newWorld();
  await playTheNetwork(context, world);
  await page.goto('/flows');
  const other = await context.newPage();
  await pairFromSettings(other);

  // The first tab has seen no OAIY yet, so it asks when the person opens the control.
  await chip(page).click();
  await expect(connected(page)).toBeVisible();
});

test('another account on this browser gets none of it', async ({ context, page }) => {
  const world = newWorld();
  await playTheNetwork(context, world);
  await pairFromSettings(page);

  world.user = { id: 'bob', email: 'bob@example.test', name: 'Bob' };
  world.calls = [];
  await page.goto('/flows');
  await expect(chip(page)).toBeVisible();
  await chip(page).click();
  await expect(page.getByRole('button', { name: 'Desktop connection: Connect OAIY' })).toBeVisible();
  expect(world.calls.filter((call) => call.bearer !== null)).toEqual([]);

  // And Alice, back on the same browser, is asked for nothing.
  world.user = { id: 'alice', email: 'alice@example.test', name: 'Alice' };
  await page.goto('/flows');
  await expect(connected(page)).toBeVisible();
  expect(world.pairingRequests).toBe(1);
});

test('a token revoked in OAIY is let go, and the control says to connect again', async ({ context, page }) => {
  const world = newWorld();
  await playTheNetwork(context, world);
  await pairFromSettings(page);

  world.grants.clear();
  await page.goto('/flows');
  await connected(page).click();
  await expect(page.getByRole('button', { name: 'Desktop connection: Connect OAIY' })).toBeVisible();
  await page.goto('/settings#local-runtime');
  await expect(page.getByRole('button', { name: 'Connect OAIY Desktop' })).toBeVisible();
});
