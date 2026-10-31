import { expect, test } from '@playwright/test';
import { sessionHeaders } from './session-request';

// A visitor who has never signed in has storage mode 'local' by default, and that used to be read
// as "this is a device-only form": the server's refusal was swallowed and they saw "Thank you", and
// the owner got nothing. Each of these is a real visitor in a browser with no session.
const RUN = Date.now().toString(36);

test('a visitor whose answers the server refused is not told they were received', async ({ browser, context, baseURL }) => {
  const email = `refused-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: 'refused-e2e-password-1', name: 'Owner' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const csrf = { 'X-CSRF-Token': (await context.cookies()).find((cookie) => cookie.name === 'formlogic_csrf')!.value };
  const created = await context.request.post('/api/forms', {
    headers: csrf,
    data: {
      title: `Refused ${RUN}`,
      status: 'published',
      settings: { displayMode: 'classic' },
      fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: false }],
      logicScript: 'function onSubmit(ctx) { return { reject: true, message: "We are not taking entries today." }; }',
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const form = (await created.json()).data?.form ?? (await created.json()).form ?? (await created.json());
  const accepted = await context.request.post('/api/forms', {
    headers: csrf,
    data: { title: `Taken ${RUN}`, status: 'published', settings: { displayMode: 'classic' }, fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: false }] },
  });
  const open = (await accepted.json()).data?.form ?? (await accepted.json()).form ?? (await accepted.json());

  const visitor = await browser.newContext({ baseURL });
  const page = await visitor.newPage();
  try {
    await page.goto(`/form/${form.id}`);
    await page.getByLabel(/Your name/).fill('Ada');
    await page.getByRole('button', { name: /Submit/ }).click();
    await expect(page.getByText('We are not taking entries today.')).toBeVisible();
    await expect(page.getByText(/submitted successfully|Thank you/i)).toHaveCount(0);

    // And one the server takes still thanks them, and leaves nothing in the browser.
    await page.goto(`/form/${open.id}`);
    await page.getByLabel(/Your name/).fill('Ada Lovelace');
    await page.getByRole('button', { name: /Submit/ }).click();
    await expect(page.getByText(/submitted successfully|Thank you/i).first()).toBeVisible();
    const kept = await page.evaluate(() => localStorage.getItem('formlogic-responses') ?? '');
    expect(kept).not.toContain('Ada Lovelace');
  } finally {
    await visitor.close();
  }
});
