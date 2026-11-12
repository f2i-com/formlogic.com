// Setting up AI for apps from nothing, in a real browser against the real stack, using only the
// checklist in Admin → Platform → AI for apps:
//
// 1. on the administrator's own computer: a one-time code links an OAIY server (the stand-in,
//    backend/tests/Support/stub-oaiy-computer.php, redeems it as OAIY would), "Use this computer",
//    apps allowed, the picture model picked from the computer's own list, and a test picture drawn
//    through the real worker and the sealed lane. Then an app's owner follows "This app can use AI.
//    Set it up", turns the site's AI on for the app and tests a picture there;
// 2. on the provider in the server's settings: Site AI turned on, apps allowed, the model typed, and
//    a test picture from the stand-in for Studio's gateway.
//
// Needs the App AI stack (see app-ai-payments.spec.ts): one origin that answers several requests at
// once (a request that waits for the computer must not hold up the computer's own answer),
// bin/app-ai-worker.php --watch started from the code being tested (a worker from before an update
// is refused the test, and the card says to restart it), AI_BASE_URL at backend/tests/Support/stub-images-server.php (the
// second test is skipped without it), and an administrator account of its own (E2E_APP_AI_EMAIL,
// E2E_APP_AI_PASSWORD): the tests unlink that account's computers to start from nothing. PHP_BIN
// names the php that runs the stand-in computer (`php` by default), and E2E_STUB_OAIY its script
// when the tests do not run from formlogic/ui. These tests change the site's AI settings: run them
// one at a time with any other spec that uses those (`--workers=1`). Each run makes one of an app
// owner's ten tests an hour and three of the administrator's twenty, which no setting lifts: a
// seventh run within the hour is told "Too many requests".
import { expect, test, type Page } from '@playwright/test';
import { EMAIL, PASSWORD, nothingSetUp, signIn, startComputer, type StandInComputer } from './app-ai-stack';

const COMPUTER = 'Studio PC';

let computer: StandInComputer | null = null;
const stopComputer = () => { computer?.stop(); computer = null; };

/** The page asks an administrator for their password before its first change to the site. */
async function confirmIfAsked(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it\'s you' });
  try { await dialog.waitFor({ state: 'visible', timeout: 3000 }); } catch { return; }
  await dialog.getByLabel('Your password').fill(PASSWORD!);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
}

const step = (page: Page, number: number) => page.getByTestId(`ai-setup-step-${number}`);

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ context }) => {
  stopComputer();
  if (!EMAIL || !PASSWORD) return;
  // Leave the site as the other App AI spec expects it: no computer chosen, none of this account's linked.
  const admin = await signIn(context);
  await nothingSetUp(admin);
});

test('An administrator sets up AI for apps on their own computer, using only the checklist', async ({ context, page }) => {
  test.setTimeout(240_000);
  test.skip(!EMAIL || !PASSWORD, 'Requires the App AI stack and an administrator account (see the header).');
  const admin = await signIn(context);
  await nothingSetUp(admin);

  await page.goto('/admin/platform#app-ai');
  const summary = page.getByTestId('ai-setup-summary');
  await expect(summary).toHaveText(/^[34] steps left before apps can make pictures\./);
  await expect(step(page, 2)).toHaveAttribute('data-done', 'no');
  // The stack's worker runs, and runs the code that is there: the card has nothing to say of it.
  await expect(page.getByTestId('ai-setup-worker')).toHaveCount(0);

  // 1. A computer: a one-time code, typed on the server (here, given to the stand-in).
  await step(page, 1).getByRole('button', { name: 'Connect an OAIY server' }).click();
  await step(page, 1).getByLabel('Name (optional)').fill(COMPUTER);
  await step(page, 1).getByRole('button', { name: 'Make a code' }).click();
  const code = (await step(page, 1).getByTestId('oaiy-link-code').innerText()).trim();
  expect(code).not.toBe('');
  computer = startComputer(code, COMPUTER);

  // 2. It shows up by itself once it has started; one click makes it the site's AI.
  const use = step(page, 2).getByRole('button', { name: 'Use this computer' });
  await expect(use).toBeVisible({ timeout: 60_000 });
  await expect(step(page, 1)).toContainText(`${COMPUTER} (online) is linked.`);
  await use.click();
  await confirmIfAsked(page);
  await expect(step(page, 2)).toHaveAttribute('data-done', 'yes');
  await expect(step(page, 2)).toContainText(`This site's AI runs on ${COMPUTER}.`);

  // 3. Apps may use it.
  await step(page, 3).getByRole('switch', { name: 'Apps may use the site\'s AI' }).click();
  await confirmIfAsked(page);
  await expect(step(page, 3)).toHaveAttribute('data-done', 'yes');

  // 4. The picture model, from the computer's own list: FLUX 3 Klein is suggested, though not listed first.
  const model = step(page, 4).getByLabel(/picture/i);
  await expect(model).toHaveValue('flux-3-image-klein', { timeout: 30_000 });
  await expect(model.locator('option')).toHaveText(['None: no pictures', 'Stub XL (stub-image-xl)', 'FLUX 3 Klein (flux-3-image-klein)']);
  await step(page, 4).getByRole('button', { name: 'Use this model' }).click();
  await confirmIfAsked(page);
  await expect(step(page, 4)).toHaveAttribute('data-done', 'yes');
  await expect(summary).toHaveText(`Ready: apps can make pictures with flux-3-image-klein on ${COMPUTER}.`);

  // 5. A real test picture, through the worker and the computer, then a test chat.
  await step(page, 5).getByRole('button', { name: 'Make a test picture' }).click();
  await confirmIfAsked(page);
  const result = step(page, 5).getByTestId('ai-test');
  await expect(result).toContainText('Test picture: It works', { timeout: 90_000 });
  await expect(result).toContainText(/Made in \d+\.\d s · with flux-3-image-klein/);
  const picture = result.getByRole('img', { name: 'The test picture' });
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(step(page, 5)).toHaveAttribute('data-done', 'yes');
  await step(page, 5).getByRole('button', { name: 'Test chat' }).click();
  await expect(result).toContainText('Test chat: It works', { timeout: 90_000 });
  await expect(result).toContainText('Hello from the stub computer.');
  // Opened again, the checklist still says the test worked.
  await page.reload();
  await expect(summary).toHaveText(`Ready: apps can make pictures with flux-3-image-klein on ${COMPUTER}.`);
  await expect(step(page, 5)).toHaveAttribute('data-done', 'yes');
  await expect(page.getByTestId('ai-setup-last-test')).toContainText(/The last test worked at .+, made in \d+\.\d s with flux-3-image-klein\./);

  // An app that asks for AI, and has it off: its owner is told once, and led to its settings.
  const slug = `logo-maker-${Date.now()}`;
  const created = await admin.api.post('/api/apps', { headers: { 'X-CSRF-Token': admin.csrf }, data: { name: 'Logo maker (e2e)', slug, settings: { softnApp: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const app = (await created.json()).app;
  const manifest = {
    id: 'com.formlogic.e2e.logo-maker', name: 'Logo maker', version: '1.0.0', main: 'ui/main.ui',
    server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql', 'crypto'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: [{ path: '/api/site/ai/deliver', method: 'POST', handler: 'deliver', transaction: 'write', authorization: 'anonymous' }],
    },
    formlogicAi: { uses: ['pictures'], purpose: 'Draws a logo from your words.', jobs: { table: 'ai_jobs', deliver: '/api/site/ai/deliver' } },
  };
  const project = { home: true, access: 'application', assets: {}, files: {
    'manifest.json': JSON.stringify(manifest),
    'ui/main.ui': '<Stack padding="24"><Text>Logo maker</Text></Stack>',
    'server/main.logic': 'function deliver(req) { return { status: 200, body: { ok: true } }; }',
    'server/migrations/001.sql': 'CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT, status TEXT);',
  } };
  const installed = await admin.api.put(`/api/apps/${app.id}/native`, { headers: { 'X-CSRF-Token': admin.csrf }, data: { project, expectedVersion: 0 } });
  expect(installed.ok(), await installed.text()).toBe(true);

  await page.goto(`/apps/${app.id}/softn`);
  const prompt = page.getByTestId('app-ai-prompt');
  await expect(prompt).toContainText('This app can use AI.');
  await prompt.getByRole('button', { name: 'Set it up' }).click();
  const panel = page.getByTestId('app-ai-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('app-ai-status')).toContainText('Off.');
  await panel.getByRole('radio', { name: /Use this site's AI/ }).check();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByTestId('app-ai-saved')).toContainText('Saved. Ready.');
  await panel.getByRole('button', { name: 'Test a picture' }).click();
  await expect(panel.getByTestId('ai-test')).toContainText('Test picture: It works', { timeout: 90_000 });
  await expect(panel.getByTestId('ai-test').getByRole('img', { name: 'The test picture' })).toBeVisible();
  // Its AI is on now: the line is not shown again.
  await page.goto(`/apps/${app.id}/softn`);
  await expect(page.getByRole('navigation', { name: 'App sections' })).toBeVisible();
  await expect(page.getByTestId('app-ai-prompt')).toHaveCount(0);

  expect((await admin.api.delete(`/api/apps/${app.id}`, { headers: { 'X-CSRF-Token': admin.csrf } })).ok()).toBe(true);
});

test('An administrator sets up AI for apps on the provider in the server\'s settings', async ({ context, page }) => {
  test.setTimeout(180_000);
  test.skip(!EMAIL || !PASSWORD, 'Requires the App AI stack and an administrator account (see the header).');
  const admin = await signIn(context);
  await nothingSetUp(admin);
  const setup = (await (await admin.api.get('/api/admin/app-ai', { headers: admin.headers })).json()).data.setup;
  test.skip(!setup.provider.named, 'This server names no AI provider in its settings (AI_BASE_URL or AI_API_KEY).');

  await page.goto('/admin/platform#app-ai');
  const summary = page.getByTestId('ai-setup-summary');
  await expect(summary).toHaveText('3 steps left before apps can make pictures.');
  await expect(step(page, 1)).toContainText('the AI provider in your server settings');

  await step(page, 2).getByRole('button', { name: 'Turn on Site AI' }).click();
  await confirmIfAsked(page);
  await expect(step(page, 2)).toHaveAttribute('data-done', 'yes');
  await step(page, 3).getByRole('switch', { name: 'Apps may use the site\'s AI' }).click();
  await confirmIfAsked(page);
  await expect(step(page, 3)).toHaveAttribute('data-done', 'yes');
  await expect(summary).toHaveText('1 step left before apps can make pictures. Chat already works.');

  // No computer to list models: the name is typed.
  await step(page, 4).getByLabel(/picture/i).fill('stub-image');
  await step(page, 4).getByRole('button', { name: 'Use this model' }).click();
  await expect(summary).toHaveText('Ready: apps can make pictures with stub-image on the AI provider in your server settings.');

  await step(page, 5).getByRole('button', { name: 'Make a test picture' }).click();
  const result = step(page, 5).getByTestId('ai-test');
  await expect(result).toContainText('Test picture: It works', { timeout: 90_000 });
  await expect(result.getByRole('img', { name: 'The test picture' })).toBeVisible();
});
