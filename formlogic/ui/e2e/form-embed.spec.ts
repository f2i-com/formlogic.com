import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { sessionHeaders } from './session-request';

// A customer's own page, under a name of its own, with the Share dialog's iframe in it. The form
// page allows that, but the browser checks every ancestor of every frame, and on a reload the
// service worker answers instead of the server: each of those has left an embed blank before.
const RUN = Date.now().toString(36);

test('a form with a custom screen shows in someone else\'s page, and again after a reload', async ({ browser, context, baseURL }) => {
  const email = `embed-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: 'embed-e2e-password-1', name: 'Owner' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const csrf = { 'X-CSRF-Token': (await context.cookies()).find((cookie) => cookie.name === 'formlogic_csrf')!.value };
  const created = await context.request.post('/api/forms', {
    headers: csrf,
    data: {
      title: `Embed ${RUN}`,
      status: 'published',
      fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: false }],
      customScreen: { enabled: true, html: '<h1>The custom screen is here</h1>' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const body = await created.json();
  const form = body.data?.form ?? body.form ?? body;

  // On localhost, another site to 127.0.0.1: a made-up public name may not frame a local address.
  const customer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>A customer</title><iframe id="embed" src="${baseURL}/form/${form.id}" width="900" height="600"></iframe>`);
  });
  await new Promise<void>((done) => customer.listen(0, 'localhost', done));
  const visitor = await browser.newContext({ baseURL });
  const page = await visitor.newPage();
  try {
    await page.goto(`http://localhost:${(customer.address() as AddressInfo).port}/`);
    const screen = page.frameLocator('#embed').frameLocator('iframe').first();
    await expect(screen.getByText('The custom screen is here')).toBeVisible({ timeout: 20000 });

    // With the worker installed in this partition it answers the next load.
    const embed = page.frames().find((frame) => frame.url().includes('/form/'))!;
    await embed.evaluate(() => Promise.race([navigator.serviceWorker?.ready, new Promise((done) => setTimeout(done, 5000))]));
    await page.reload();
    await expect(screen.getByText('The custom screen is here')).toBeVisible({ timeout: 20000 });
  } finally {
    await visitor.close();
    customer.close();
  }
});
