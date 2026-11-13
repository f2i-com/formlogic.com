// Capture the real Home page, and the Connect your AI wizard, with fictional data. Run with the
// UI dev server running. No account, backend, AI provider or desktop runtime is contacted.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:5173';
const output = new URL('../public/images/dashboard-demo/', import.meta.url);
await mkdir(output, { recursive: true });
const docsOutput = new URL('../public/images/docs/', import.meta.url);
await mkdir(docsOutput, { recursive: true });
const readmeOutput = new URL('../../../docs/images/', import.meta.url);
await mkdir(readmeOutput, { recursive: true });
const user = { id: 'studio-preview', name: 'Alex Morgan', email: 'alex@example.test', mfaEnabled: true };
const now = Date.now();
const ago = (days) => new Date(now - days * 86400000).toISOString();
const forms = [
  ['Customer enquiries', 'New projects and questions from your customers', 48],
  ['Project feedback', 'Keep feedback connected to the work', 24],
  ['Consultation bookings', 'Arrange a time to talk through the next project', 28],
].map(([title, description, responseCount], i) => ({
  id: `studio-form-${i}`, title, description, responseCount, status: 'published',
  fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: true }],
  settings: {}, createdAt: ago(30), updatedAt: ago(i),
}));
// Two apps made of forms and one hosted app with a backend of its own, as the apps list tells them apart.
const apps = [
  ['Client portal', 'client-portal', '#6366f1', { appKind: 'client' }, [0, 1]],
  ['Studio bookings', 'studio-bookings', '#0d9488', { appKind: 'public' }, [2]],
  ['Pottery classes', 'pottery-classes', '#b4532a', { softnApp: true }, []],
].map(([name, slug, primaryColor, settings, attached], i) => ({
  id: `studio-app-${i}`, name, slug, ownerId: user.id,
  role: 'owner', isOwner: true, status: 'published', formCount: attached.length,
  theme: { primaryColor }, settings, navConfig: [], attached,
  createdAt: ago(30), updatedAt: ago(i),
}));
// What GET /api/apps/summary adds to each row: who can use the app and what it holds.
const formsApp = (members) => ({ softn: false, installed: false, version: null, access: null, backend: false, tables: null, bytes: null, domain: null, members });
const summaries = {
  'studio-app-0': formsApp(6),
  'studio-app-1': formsApp(2),
  'studio-app-2': { softn: true, installed: true, version: 3, access: 'application', backend: true, tables: 2, bytes: 28672, domain: null, members: 0 },
};
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 1000]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(({ theme, userId }) => {
        localStorage.setItem('formlogic_storage_mode', 'api');
        localStorage.setItem('formlogic-forms', JSON.stringify({ state: { forms: [], storageMode: 'api', pendingDeletions: [] }, version: 0 }));
        localStorage.setItem(`formlogic_onboarding_dismissed:${userId}`, '1');
        localStorage.setItem('formlogic-ui-storage', JSON.stringify({ state: { theme }, version: 0 }));
      }, { theme, userId: user.id });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        const path = url.pathname;
        if (!path.startsWith('/api/')) return route.continue();
        assert.equal(route.request().method(), 'GET', `Unexpected mutation: ${path}`);
        let json;
        if (path === '/api/health') json = { status: 'ok', plans: { paymentsEnabled: false, siteAiEnabled: false } };
        else if (path === '/api/auth/me') json = { user };
        else if (path === '/api/notices') json = { notices: [], maintenance: false };
        else if (path === '/api/forms') json = { forms, count: forms.length };
        else if (path === '/api/apps') json = { apps, count: apps.length };
        else if (path === '/api/apps/summary') json = { apps: summaries };
        else if (/^\/api\/apps\/studio-app-\d\/forms$/.test(path)) {
          const app = apps.find(app => path === `/api/apps/${app.id}/forms`);
          assert(app, `Unknown app: ${path}`);
          json = { forms: app.attached.map(index => ({ formId: forms[index].id })) };
        } else if (path.endsWith('/analytics')) {
          const form = forms.find(form => path.includes(`/${form.id}/`));
          assert(form, `Unknown form: ${path}`);
          json = { analytics: { totalResponses: form.responseCount, responsesByDate: [1, 3, 2, 4, 2, 5, 3].map((count, i) => ({ date: ago(6 - i).slice(0, 10), count })) } };
        } else if (path.endsWith('/responses')) {
          const form = forms.find(form => path.includes(`/${form.id}/`));
          assert(form, `Unknown form: ${path}`);
          json = { responses: [{ id: `response-${form.id}`, formId: form.id, submittedAt: ago(forms.indexOf(form) / 24 + 1 / 144), data: { name: 'Sample customer' } }], count: form.responseCount };
        } else return route.fulfill({ status: 503, json: { error: 'Not available in the screenshot fixture' } });
        return route.fulfill({ json });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const settled = async () => {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState('networkidle');
        assert.deepEqual(errors, []);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      };
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
      // The headline is drawn once the apps' summary has answered: it says what the hosted app holds.
      await page.getByText(/All 3 apps are live, holding 2 tables/).waitFor();
      await page.getByText('48 total responses', { exact: true }).waitFor();
      await page.getByText('Pottery classes', { exact: true }).first().waitFor();
      await settled();
      await page.screenshot({ path: fileURLToPath(new URL(`${device}-${theme}.jpg`, output)), type: 'jpeg', quality: 90, animations: 'disabled' });
      if (theme === 'dark') await copyFile(new URL(`${device}-${theme}.jpg`, output), new URL(`dashboard-${device}.jpg`, readmeOutput));
      console.log(`Captured real Home page: ${device} / ${theme}`);
      // The documentation's picture of the connection wizard: the same fictional account, nothing connected.
      if (theme === 'dark' && device === 'desktop') {
        await page.goto(`${origin}/connect-ai`);
        await page.getByRole('heading', { name: 'Your AI, ready in three steps', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'How would you like to connect?', exact: true }).waitFor();
        await settled();
        await page.screenshot({ path: fileURLToPath(new URL('connect-ai.jpg', docsOutput)), type: 'jpeg', quality: 90, animations: 'disabled' });
        await copyFile(new URL('connect-ai.jpg', docsOutput), new URL('connect-ai-desktop.jpg', readmeOutput));
        console.log('Captured Connect your AI: desktop / dark');
      }
      await context.close();
    }
  }
} finally { await browser.close(); }
