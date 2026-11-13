import { sessionJsonHeaders } from '../../../scripts/session-request.mjs';
// Real local UI captures of the two kinds of app FormLogic hosts from files: a JavaScript app (a
// web app already built, uploaded as the zip of its build) and a SoftN app. The script makes both
// from the fictional projects in capture-fixtures/, in an account kept for these pictures, and
// makes them afresh on every run; it touches no other app.
// Run from ui against the BUILT site with its API (a hosted app's frame is not served by the dev
// server), with FORMLOGIC_REVIEW_PASSWORD set. The account is admin@formlogic.local unless
// FORMLOGIC_REVIEW_EMAIL names another. Only the page's own area is photographed, never the
// sidebar, so no picture shows the account's app list.
import { chromium, expect } from '@playwright/test';
import { zipSync } from 'fflate';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use the local review server.');
assert(process.env.FORMLOGIC_REVIEW_PASSWORD, 'Set the local review password in the environment.');
const docs = new URL('../public/images/docs/', import.meta.url);
const landing = new URL('../public/images/hosted-app/', import.meta.url);
await mkdir(docs, { recursive: true });
await mkdir(landing, { recursive: true });

const SITE = 'Pottery classes';
const SOFTN = 'Studio jobs';
/** A fixture project's files, by their path in the project. */
const fixture = async (name) => {
  const root = fileURLToPath(new URL(`./capture-fixtures/${name}/`, import.meta.url));
  const files = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    files[relative(root, path).replaceAll('\\', '/')] = await readFile(path);
  }
  return files;
};

const browser = await chromium.launch();
// The build's zip is chosen from disk, as a person chooses it: written here, removed at the end.
const scratch = await mkdtemp(join(tmpdir(), 'formlogic-capture-'));
try {
  const shared = { baseURL: origin, reducedMotion: 'reduce', serviceWorkers: 'block' };
  const errors = [];
  const context = await browser.newContext({ ...shared, viewport: { width: 1440, height: 900 } });
  const login = await context.request.post('/api/auth/login', { headers: sessionJsonHeaders(origin), data: { email: process.env.FORMLOGIC_REVIEW_EMAIL || 'admin@formlogic.local', password: process.env.FORMLOGIC_REVIEW_PASSWORD } });
  assert(login.ok(), 'The review account must be available.');
  const headers = { ...sessionJsonHeaders(origin), 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf').value };
  const session = await context.storageState();
  /** A page of the signed-in account, in the theme and at the size given. */
  const open = async (theme, viewport, deviceScaleFactor = 1) => {
    const made = await browser.newContext({ ...shared, storageState: session, viewport, deviceScaleFactor });
    // The page's own storage only: this also runs in the hosted app's frame, which has none to set.
    await made.addInitScript(theme => { if (window.top === window) localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme, sidebarCollapsed: false }, version: 0 })); }, theme);
    const page = await made.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return page;
  };
  /** What a picture of a workspace page keeps: the page beside the sidebar, or all of a phone's screen. */
  const pageArea = async (page) => {
    const main = await page.locator('#main-content').boundingBox();
    const { width, height } = page.viewportSize();
    return { x: main.x, y: 0, width: width - main.x, height };
  };
  const capture = async (page, target, clip) => {
    await page.evaluate(() => document.fonts.ready);
    // 85, not the 90 of the older captures: these are new files in the repository, kept small.
    await page.screenshot({ path: fileURLToPath(target), type: 'jpeg', quality: 85, animations: 'disabled', ...(clip ? { clip } : {}) });
    console.log(`Captured ${fileURLToPath(target).split(/[\\/]/).slice(-2).join('/')}`);
  };

  // Each run starts from no earlier copy of its two apps, so the pictures do not depend on the last run.
  for (const app of (await (await context.request.get('/api/apps')).json()).apps) {
    if ((app.name !== SITE && app.name !== SOFTN) || app.settings?.softnApp !== true) continue;
    const removed = await context.request.delete(`/api/apps/${app.id}`, { headers });
    assert(removed.ok(), await removed.text());
  }

  // ── A JavaScript app: Create app with the kind chosen, the app on its page, the app as a visitor has it.
  const project = await fixture('pottery-classes');
  const zip = join(scratch, 'pottery-classes.zip');
  await writeFile(zip, zipSync(project));
  const page = await open('dark', { width: 1440, height: 900 });
  await page.goto('/apps/new?type=site');
  await page.getByLabel('App name').fill(SITE);
  await page.locator('#site-app-build').setInputFiles(zip);
  await expect(page.getByText('pottery-classes.zip', { exact: true })).toBeVisible();
  await capture(page, new URL('javascript-app-create.jpg', docs), await pageArea(page));
  await page.getByRole('button', { name: 'Create from this build', exact: true }).click();
  await page.waitForURL(/\/apps\/[^/]+\/softn\/edit$/);
  const siteId = /\/apps\/([^/]+)\/softn/.exec(page.url())[1];
  /** The app's own page with the app running in it: its timetable is read from its backend. */
  const running = async (shown) => {
    await shown.goto(`/apps/${siteId}/softn/edit`);
    await expect(shown.getByRole('button', { name: 'Upload a new build (.zip)', exact: true })).toBeVisible();
    await expect(shown.getByTestId('softn-app-preview').frameLocator('iframe').locator('.class')).toHaveCount(4, { timeout: 30000 });
    assert(await shown.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  };
  // While the app is a draft: the landing page's figure in both themes, on a desktop and a phone.
  // The documentation shows the dark desktop one.
  for (const theme of ['dark', 'light']) {
    const desktop = await open(theme, { width: 1440, height: 900 }, 1.5);
    await running(desktop);
    await capture(desktop, new URL(`desktop-${theme}.jpg`, landing), await pageArea(desktop));
    await desktop.context().close();
    const phone = await open(theme, { width: 390, height: 900 }, 2);
    await running(phone);
    await capture(phone, new URL(`mobile-${theme}.jpg`, landing));
    await phone.context().close();
  }
  // Open to anyone with the link, and live: what someone who is not signed in gets at its address.
  await page.goto(`/apps/${siteId}/softn/settings`);
  await page.getByText('Anyone with the link', { exact: true }).click();
  await expect(page.getByText('Now anyone with the link can use it.')).toBeVisible({ timeout: 20000 });
  await page.goto(`/apps/${siteId}/softn`);
  await page.getByRole('button', { name: 'Publish', exact: true }).first().click();
  await expect(page.getByText(/^Live, version \d+$/)).toBeVisible({ timeout: 30000 });
  const { slug } = (await (await context.request.get(`/api/apps/${siteId}`)).json()).app;
  const visitor = await browser.newContext({ ...shared, viewport: { width: 390, height: 720 }, deviceScaleFactor: 2 });
  const visit = await visitor.newPage();
  visit.on('pageerror', error => errors.push(error.message));
  await visit.goto(`/app/${slug}`);
  await expect(visit.frameLocator('iframe').locator('.class')).toHaveCount(4, { timeout: 30000 });
  await capture(visit, new URL('javascript-app-visitor.jpg', docs));
  await visitor.close();

  // ── A SoftN app: its own page, and its files in the Source code editor.
  const created = await context.request.post('/api/apps', { headers, data: { name: SOFTN, settings: { softnApp: true } } });
  assert(created.ok(), await created.text());
  const softn = (await created.json()).app;
  const files = Object.fromEntries(Object.entries(await fixture('studio-jobs')).map(([path, bytes]) => [path, bytes.toString('utf8')]));
  const installed = await context.request.put(`/api/apps/${softn.id}/native`, { headers, data: { project: { version: 0, home: true, access: 'members', assets: {}, files }, expectedVersion: 0 } });
  assert(installed.ok(), await installed.text());
  await page.goto(`/apps/${softn.id}/softn/edit`);
  await expect(page.getByTestId('softn-app-preview').frameLocator('iframe').getByText('4 jobs to do', { exact: true })).toBeVisible({ timeout: 40000 });
  await capture(page, new URL('softn-app-page.jpg', docs), await pageArea(page));
  await page.getByRole('button', { name: 'Edit the source code', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Source code', exact: true });
  await expect(source.locator('.view-lines')).toContainText('Studio jobs');
  await page.waitForLoadState('networkidle');
  await capture(page, new URL('softn-source-editor.jpg', docs), await source.boundingBox());
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
