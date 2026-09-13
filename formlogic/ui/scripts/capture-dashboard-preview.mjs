// Capture the real dashboard with fictional data. Run with the UI dev server running.
// No account, backend, AI provider or desktop runtime is contacted.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:5173';
const output = new URL('../public/images/dashboard-demo/', import.meta.url);
await mkdir(output, { recursive: true });
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
const apps = [
  ['Client portal', 'client', '#6366f1', 2],
  ['Studio bookings', 'public', '#0d9488', 1],
].map(([name, appKind, primaryColor, formCount], i) => ({
  id: `studio-app-${i}`, name, slug: `studio-app-${i}`, ownerId: user.id,
  role: 'owner', isOwner: true, status: 'published', formCount,
  theme: { primaryColor }, settings: { appKind }, navConfig: [],
  createdAt: ago(30), updatedAt: ago(i),
}));
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
        else if (/^\/api\/apps\/studio-app-\d\/forms$/.test(path)) json = { forms: forms.filter((_, i) => path.includes('studio-app-0') ? i < 2 : i === 2).map(form => ({ formId: form.id })) };
        else if (path.endsWith('/analytics')) {
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
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Your workspace, at a glance.' }).waitFor();
      await page.getByText('48 total responses', { exact: true }).waitFor();
      await page.getByText('Client portal', { exact: true }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: fileURLToPath(new URL(`${device}-${theme}.jpg`, output)), type: 'jpeg', quality: 90, animations: 'disabled' });
      if (theme === 'dark') await copyFile(new URL(`${device}-${theme}.jpg`, output), new URL(`dashboard-${device}.jpg`, readmeOutput));
      console.log(`Captured real dashboard: ${device} / ${theme}`);
      await context.close();
    }
  }
} finally { await browser.close(); }
