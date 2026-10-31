import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { sessionHeaders } from './session-request';

// An app with no backend keeps its records in the member's browser and nowhere else, so these are
// the only copy. Each thing here used to lose them, silently: a session ending, which happens
// every day, a rename, and a second tab.
const RUN = Date.now().toString(36);
const PASSWORD = 'browser-data-password-1';
const FRAME = 'iframe[title="Hosted app"]';
const app = (page: Page) => page.frameLocator(FRAME);
const count = (page: Page, notes: number) => expect(app(page).getByText(`Notes: ${notes}`, { exact: true })).toBeVisible({ timeout: 60_000 });
const add = (page: Page) => app(page).getByRole('button', { name: 'Add a note' }).click();

const project = { home: true, access: 'members', assets: {}, files: {
  'manifest.json': JSON.stringify({ id: 'com.formlogic.e2e.browser-data', name: 'Browser data', version: '1.0.0', main: 'ui/main.ui' }),
  'ui/main.ui': '<logic>\nvar notes = [];\nfunction _init() { notes = db.query("notes"); }\nfunction add() { db.create("notes", { title: "Added here" }); notes = db.query("notes"); }\n</logic>\n<Stack padding="24" gap="12"><Text>Notes: {notes.length}</Text><Button onClick={add}>Add a note</Button></Stack>',
} };

async function csrf(context: BrowserContext) {
  return { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
}

const signIn = (context: BrowserContext, email: string) => context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email, password: PASSWORD } });

/** The app's map as it sits in this browser. */
const storedKeys = (page: Page, userId: string, appId: string) => page.evaluate(key => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')), `formlogic:native-member-storage:v1:${userId}:${appId}`);

test('what a member saves in the browser survives a session ending, a rename and a second tab', async ({ page, context }) => {
  test.setTimeout(240_000);
  const email = `browser-data-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: PASSWORD, name: 'Browser data' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const userId = (await registered.json()).user.id;
  const headers = await csrf(context);
  const slug = `browser-data-${RUN}`;
  const { app: created } = await (await context.request.post('/api/apps', { headers, data: { name: slug, slug, settings: { softnApp: true } } })).json();
  expect((await context.request.put(`/api/apps/${created.id}/native`, { headers, data: { project, expectedVersion: 0 } })).ok()).toBe(true);
  expect((await context.request.post(`/api/apps/${created.id}/publish`, { headers })).ok()).toBe(true);

  await page.goto(`/app/${slug}`);
  await count(page, 0);
  await add(page);
  await count(page, 1);

  // Named after the app, not after what it is called today.
  const keys = await storedKeys(page, userId, created.id);
  expect(keys.some(key => key.startsWith(`xdb:native-${created.id}:`))).toBe(true);
  expect(keys.filter(key => key.includes(slug))).toEqual([]);

  // The session ends by itself, and the same person comes back.
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible({ timeout: 30_000 });
  expect((await signIn(context, email)).ok()).toBe(true);
  await page.goto(`/app/${slug}`);
  await count(page, 1);

  // The app is renamed.
  const renamed = `${slug}-renamed`;
  const rename = await context.request.put(`/api/apps/${created.id}`, { headers: await csrf(context), data: { slug: renamed } });
  expect(rename.ok(), await rename.text()).toBe(true);
  await page.goto(`/app/${renamed}`);
  await count(page, 1);

  // Records saved before keys were named after the app, under the slug it had then.
  await page.evaluate(([key, id, oldSlug]) => {
    const map = JSON.parse(localStorage.getItem(key)!);
    const old = Object.fromEntries(Object.entries(map).map(([name, value]) => [name.replace(`native-${id}`, `native-${oldSlug}`), value]));
    localStorage.setItem(key, JSON.stringify(old));
  }, [`formlogic:native-member-storage:v1:${userId}:${created.id}`, created.id, slug]);
  await page.reload();
  await count(page, 1);
  expect((await storedKeys(page, userId, created.id)).filter(key => key.includes(slug))).toEqual([]);

  // Two tabs, each with a snapshot. The second comes back to the latest, then both save.
  const second = await context.newPage();
  await second.goto(`/app/${renamed}`);
  await count(second, 1);
  await add(page);
  await count(page, 2);
  await second.evaluate(() => window.dispatchEvent(new Event('focus')));
  await count(second, 2);
  await add(second);
  await count(second, 3);

  // The first tab has not been looked at since: its save would replace the second tab's record.
  await add(page);
  await expect(page.getByText('This app changed in another tab', { exact: true })).toBeVisible();
  await count(page, 3);
  await add(page);
  await count(page, 4);
  await second.close();

  await page.reload();
  await count(page, 4);
});
