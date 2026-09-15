/**
 * The embedded-editor round trip, end to end in a real browser (FL-S09 lane 5b):
 *
 *   import a .softn project → Visual Builder edit → acknowledged draft (not
 *   published) → AI Studio opens on that draft → Studio edit → publish → the
 *   live hosted run shows both edits → download the editable project → import
 *   it into a second app → same source.
 *
 * Then two live editors: two browser sessions open the same app draft from one
 * installed version, both edit in the Visual Builder, both publish; the second
 * sees the server's explicit conflict and keeps its unsaved draft.
 *
 * Runs against the seeded golden-path account (E2E_EMAIL / E2E_PASSWORD, as
 * the CI job seeds it) and the real backend; the AI provider is the only thing
 * stubbed, exactly as app-editors.spec.ts stubs it, so Studio's own
 * apply-and-review path runs without a paid provider. Each test creates its own
 * apps and deletes them.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strToU8, unzipSync, zipSync } from 'fflate';

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';
const STARTER = JSON.parse(readFileSync('../backend/resources/native-app-starter.json', 'utf8')) as { files: Record<string, string> };

/** The starter as the .softn file a user would import (source only, as the owner export is). */
function starterBundle(): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(STARTER.files).map(([path, source]) => [path, strToU8(source)]))));
}

/**
 * A client-only app (interface only, no server entry), built from the starter
 * rather than read from a sibling checkout: the manifest without its `server`
 * block and the server files left out.
 */
function clientOnlyBundle(): Buffer {
  const manifest = JSON.parse(STARTER.files['manifest.json']) as Record<string, unknown> & { config?: Record<string, unknown> };
  delete manifest.server;
  if (manifest.config && typeof manifest.config === 'object') delete (manifest.config as Record<string, unknown>).server;
  const files: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) };
  for (const [path, source] of Object.entries(STARTER.files)) if (path.startsWith('ui/')) files[path] = strToU8(source);
  return Buffer.from(zipSync(files));
}

async function login(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBe(true);
  const csrf = (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value;
  return { 'X-CSRF-Token': csrf };
}

async function createApp(context: BrowserContext, headers: Record<string, string>, name: string) {
  const r = await context.request.post('/api/apps', { headers, data: { name } });
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  return (body.app ?? body) as { id: string; slug: string; name: string };
}

async function deleteApp(context: BrowserContext, headers: Record<string, string>, id: string) {
  await context.request.delete(`/api/apps/${id}`, { headers }).catch(() => {});
}

async function nativeProject(context: BrowserContext, id: string) {
  return (await (await context.request.get(`/api/apps/${id}/native`)).json()).project as { version: number; files: Record<string, string> } | null;
}

async function openHosting(page: Page, appId: string) {
  await page.goto(`/apps/${appId}/records`);
  await page.getByRole('button', { name: 'Native app hosting', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Native app hosting', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import .softn project', exact: true })).toBeEnabled({ timeout: 60000 }); // ready
  return dialog;
}

/** Open the Visual Builder on the current draft, change the button label, hand the draft back (acknowledged, not published). */
async function builderEdit(page: Page, label: string) {
  // The panel offers the editors once the project and the native preflight have loaded (Node is spawned once per host).
  await expect(page.getByRole('button', { name: 'Open Visual Builder', exact: true })).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Open Visual Builder', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Visual Builder', exact: true });
  await expect(editor.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled({ timeout: 90000 });
  const frame = page.frameLocator('iframe[title="App visual editor"]');
  await frame.getByRole('button', { name: 'Design', exact: true }).click();
  await frame.getByRole('treeitem', { name: 'Select Button component', exact: true }).click();
  await frame.getByLabel('Text Content', { exact: true }).fill(label);
  await frame.getByLabel('Text Content', { exact: true }).press('Tab');
  await editor.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Native app hosting', exact: true });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(dialog.getByText('Editor changes returned to your draft', { exact: false })).toBeVisible({ timeout: 15000 });
  return dialog;
}

test.describe('embedded editors: round trip and live conflict', () => {
  test('import → Builder → acknowledged draft → Studio → publish → live run → export → reimport', async ({ page, context }) => {
    test.setTimeout(420_000);
    page.on('pageerror', e => console.log('PAGE ERROR', e.message));
    const headers = await login(context);
    const app = await createApp(context, headers, 'Round trip source');
    const twin = await createApp(context, headers, 'Round trip reimport');
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const dialog = await openHosting(page, app.id);

      // A client-only bundle (no server entry) is refused by the native import with its reason.
      await dialog.getByLabel('Import native app').setInputFiles({ name: 'client-only.softn', mimeType: 'application/zip', buffer: clientOnlyBundle() });
      await expect(dialog.getByRole('alert')).toContainText('no native server entry');

      // 1. Import the starter project through the file input and install it (version 1).
      await dialog.getByLabel('Import native app').setInputFiles({ name: 'starter.softn', mimeType: 'application/zip', buffer: starterBundle() });
      await expect(dialog.getByText('Imported as a draft', { exact: false })).toBeVisible({ timeout: 15000 });
      await dialog.getByRole('button', { name: 'Install app project', exact: true }).click();
      await expect(dialog.getByText('Installed. The app uses its private SQLite database', { exact: false })).toBeVisible({ timeout: 60000 });
      expect((await nativeProject(context, app.id))!.version).toBe(1);

      // 2. Visual Builder edit, handed back as an acknowledged, unpublished draft.
      await builderEdit(page, 'Save round-trip item');
      await expect(page.getByText(/Unsaved draft|Unpublished draft/)).toBeVisible();
      expect((await nativeProject(context, app.id))!.files['ui/main.ui']).not.toContain('Save round-trip item'); // not published

      // 3. AI Studio opens on that draft: its export of the project carries the Builder edit.
      await page.route('**/api/ai/preferences', route => route.fulfill({ json: { data: { aiSource: 'site', chatToolMode: 'off' } } }));
      await page.route('**/api/ai/chat', async route => {
        const current = (await nativeProject(context, app.id))!.files['ui/main.ui'].replace('Save example item', 'Save round-trip item');
        const source = current.replace('My app', 'Studio edited app');
        await route.fulfill({ json: { data: { content: `Updated the heading.\n<softn-file path="ui/main.ui">${source}</softn-file>` } } });
      });
      await page.getByRole('button', { name: 'Open AI Studio', exact: true }).click();
      const studio = page.getByRole('dialog', { name: 'AI Studio', exact: true });
      await expect(studio.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled({ timeout: 90000 });
      const studioFrame = page.frameLocator('iframe[title="App AI editor"]');
      const [exported] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        studioFrame.getByTitle('Export bundle: download the project as a .softn file').click(),
      ]);
      const studioBundle = unzipSync(new Uint8Array(readFileSync(await exported.path())));
      expect(Buffer.from(studioBundle['ui/main.ui']).toString('utf8')).toContain('Save round-trip item');
      await studioFrame.getByRole('button', { name: 'AI', exact: true }).click();
      await studioFrame.getByRole('textbox', { name: 'Message to AI' }).fill('Update the heading to Studio edited app, preserving all other files.');
      await studioFrame.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(studioFrame.getByText('Updated the heading.', { exact: true })).toBeVisible({ timeout: 60000 });
      await studio.getByRole('button', { name: 'Review changes', exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 30000 });

      // 4. Publish: both edits land in version 2 and the live hosted run shows them.
      await dialog.getByRole('button', { name: 'Publish changes', exact: true }).click();
      await expect(dialog.getByText('Installed. The app uses its private SQLite database', { exact: false })).toBeVisible({ timeout: 60000 });
      const published = (await nativeProject(context, app.id))!;
      expect(published.version).toBe(2);
      expect(published.files['ui/main.ui']).toContain('Save round-trip item');
      expect(published.files['ui/main.ui']).toContain('Studio edited app');
      expect(published.files['server/main.logic']).toBe(STARTER.files['server/main.logic']);
      // The panel's own "Open installed app" link: /app/<slug>/native (the import left "Use this app as the website home" unchecked).
      await page.goto(`/app/${app.slug}/native`);
      const runtime = page.frameLocator('iframe[title="Hosted app"]');
      await expect(runtime.getByText('Studio edited app', { exact: true })).toBeVisible({ timeout: 90000 });
      await expect(runtime.getByRole('button', { name: 'Save round-trip item', exact: true })).toBeVisible();

      // 5. Export the editable project and import it into a second app: same source.
      const dialog2 = await openHosting(page, app.id);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        dialog2.getByRole('button', { name: 'Download editable project', exact: true }).click(),
      ]);
      const exportedPath = await download.path();
      const exportedFiles = unzipSync(new Uint8Array(readFileSync(exportedPath)));
      expect(Object.keys(exportedFiles).sort()).toEqual(Object.keys(published.files).sort()); // source and media only
      await page.keyboard.press('Escape');
      const twinDialog = await openHosting(page, twin.id);
      await twinDialog.getByLabel('Import native app').setInputFiles({ name: `${app.slug}.softn`, mimeType: 'application/zip', buffer: readFileSync(exportedPath) });
      await expect(twinDialog.getByText('Imported as a draft', { exact: false })).toBeVisible({ timeout: 15000 });
      await twinDialog.getByRole('button', { name: 'Install app project', exact: true }).click();
      await expect(twinDialog.getByText('Installed. The app uses its private SQLite database', { exact: false })).toBeVisible({ timeout: 60000 });
      const reimported = (await nativeProject(context, twin.id))!;
      expect(reimported.version).toBe(1);
      expect(reimported.files).toEqual(published.files);
    } finally {
      await deleteApp(context, headers, app.id);
      await deleteApp(context, headers, twin.id);
    }
  });

  test('two live editors on one installed version: the second publish is an explicit conflict that keeps its draft', async ({ browser }) => {
    test.setTimeout(420_000);
    const a = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const b = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const headersA = await login(a);
    await login(b); // context B signs in; its own headers are not needed, the pages carry the session
    const app = await createApp(a, headersA, 'Two editors');
    try {
      const install = await a.request.put(`/api/apps/${app.id}/native`, { headers: headersA, data: { project: { version: 0, files: STARTER.files, assets: {}, access: 'application' }, expectedVersion: 0 } });
      expect(install.ok(), await install.text()).toBe(true);
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await openHosting(pageA, app.id);
      await openHosting(pageB, app.id);
      const dialogA = await builderEdit(pageA, 'Saved by editor A');
      const dialogB = await builderEdit(pageB, 'Saved by editor B');

      await dialogA.getByRole('button', { name: 'Publish changes', exact: true }).click();
      await expect(dialogA.getByText('Installed. The app uses its private SQLite database', { exact: false })).toBeVisible({ timeout: 60000 });
      expect((await nativeProject(a, app.id))!.version).toBe(2);

      await dialogB.getByRole('button', { name: 'Publish changes', exact: true }).click();
      await expect(dialogB.getByRole('alert')).toContainText('The project changed', { timeout: 60000 });
      // B's draft is kept, unpublished, and the stored version is still A's.
      await expect(dialogB.getByRole('button', { name: 'Publish changes', exact: true })).toBeEnabled();
      await expect(pageB.getByText(/Unsaved draft|Unpublished draft/)).toBeVisible();
      const stored = (await nativeProject(b, app.id))!;
      expect(stored.version).toBe(2);
      expect(stored.files['ui/main.ui']).toContain('Saved by editor A');
      expect(stored.files['ui/main.ui']).not.toContain('Saved by editor B');
      await dialogB.getByRole("tab", { name: /screens/i }).click();
      await expect(dialogB.getByRole('region', { name: 'Interface source editor' })).toContainText('Saved by editor B');
    } finally {
      await deleteApp(a, headersA, app.id);
      await a.close();
      await b.close();
    }
  });
});
