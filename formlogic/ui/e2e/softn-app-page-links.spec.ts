import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { sessionHeaders } from './session-request';

// A SoftN app written as more than one page file. SoftN v0.0.40's frame shows a link to another
// page of the app in place and says where the app is; before it, the link took the frame to an
// address of this site and the app was stopped. The app's page keeps the place after the # of its
// own address (NativeAppView), and an address that carries one opens the app there.
const RUN = Date.now().toString(36);
const PASSWORD = 'page-links-password-1';
const FRAME = 'iframe[title="Hosted app"]';
const app = (page: Page) => page.frameLocator(FRAME);
const shows = (page: Page, words: string) => expect(app(page).getByText(words, { exact: true })).toBeVisible({ timeout: 60_000 });
const place = (page: Page, hash: string) => expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(hash);
const html = (title: string, body: string) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

const project = { home: true, access: 'members', assets: {}, files: {
  'manifest.json': JSON.stringify({ id: 'com.formlogic.e2e.page-links', name: 'Page links', version: '1.0.0', main: 'index.html' }),
  'index.html': html('Home', '<h1>Home page</h1>\n<p><a href="about.html">About this app</a></p>\n<p><a href="docs/guide.html">The guide</a></p>\n<p><button id="go" type="button">Guide by code</button></p>\n<p><a href="missing.html">A page that is not there</a></p>\n<script>\n  document.getElementById("go").addEventListener("click", function () { location.href = "docs/guide.html"; });\n</script>'),
  'about.html': html('About', '<h1>About page</h1>\n<p><a href="index.html">Back to the start</a></p>'),
  'docs/guide.html': html('Guide', '<import Links from="../parts/links.html" />\n<h1>Guide page</h1>\n<p><a href="../about.html">About from the guide</a></p>\n<p><a href="/index.html">The start, from the app’s root</a></p>\n<Links />'),
  // A part two pages bring in: its link is read from the page that shows it, so it is written for the
  // guide's folder here.
  'parts/links.html': '<p><a href="../about.html">About from a part</a></p>\n',
} };

async function csrf(context: BrowserContext) {
  return { 'X-CSRF-Token': (await context.cookies()).find(cookie => cookie.name === 'formlogic_csrf')!.value };
}

test('a link between a SoftN app’s page files opens the page in place, and the address keeps where the app is', async ({ page, context }) => {
  test.setTimeout(240_000);
  const email = `page-links-${RUN}@e2e-apps.com`;
  const registered = await context.request.post('/api/auth/register', { headers: sessionHeaders(), data: { email, password: PASSWORD, name: 'Page links' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const headers = await csrf(context);
  const slug = `page-links-${RUN}`;
  const { app: created } = await (await context.request.post('/api/apps', { headers, data: { name: slug, slug, settings: { softnApp: true } } })).json();
  const installed = await context.request.put(`/api/apps/${created.id}/native`, { headers, data: { project, expectedVersion: 0 } });
  expect(installed.ok(), await installed.text()).toBe(true);
  expect((await context.request.post(`/api/apps/${created.id}/publish`, { headers })).ok()).toBe(true);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));

  // The app at its own address: its main page, and an address that says no more than the app.
  await page.goto(`/app/${slug}`);
  await shows(page, 'Home page');
  await place(page, '');

  // A link to another page file shows it, and the address says so.
  await app(page).getByRole('link', { name: 'About this app' }).click();
  await shows(page, 'About page');
  await place(page, '#/about.html');
  // Written in place of the address shown, never as a step back of the browser's.
  expect(await page.evaluate(() => window.history.length)).toBeLessThanOrEqual(2);

  // That address, opened afresh, opens the app there.
  await page.goto('about:blank');
  await page.goto(`/app/${slug}#/about.html`);
  await shows(page, 'About page');

  // Back to the main page, whose place is the app alone.
  await app(page).getByRole('link', { name: 'Back to the start' }).click();
  await shows(page, 'Home page');
  await place(page, '');

  // The page's own code going to a page of the app, one in a folder.
  await app(page).getByRole('button', { name: 'Guide by code' }).click();
  await shows(page, 'Guide page');
  await place(page, '#/docs/guide.html');
  // A link written from that folder finds its page.
  await app(page).getByRole('link', { name: 'About from the guide' }).click();
  await shows(page, 'About page');
  await place(page, '#/about.html');
  // So does one written from the app's root, and one in a part the page brings in, which is read
  // from the page showing it and not from the part's own folder.
  await page.goto('about:blank');
  await page.goto(`/app/${slug}#/docs/guide.html`);
  await shows(page, 'Guide page');
  await app(page).getByRole('link', { name: 'The start, from the app’s root' }).click();
  await shows(page, 'Home page');
  await place(page, '');
  await page.goto('about:blank');
  await page.goto(`/app/${slug}#/docs/guide.html`);
  await shows(page, 'Guide page');
  await app(page).getByRole('link', { name: 'About from a part' }).click();
  await shows(page, 'About page');
  await place(page, '#/about.html');

  // A link that is to no page of the app is the browser's, and the app is stopped: said, not a blank frame.
  await page.goto('about:blank');
  await page.goto(`/app/${slug}`);
  await shows(page, 'Home page');
  await app(page).getByRole('link', { name: 'A page that is not there' }).click();
  await expect(page.getByText('This app tried to navigate away and was stopped')).toBeVisible({ timeout: 30_000 });

  // An address that names no page of the app, or is no place at all, opens its main page.
  for (const hash of ['#/no-such-page.html', '#//elsewhere.example/x']) {
    await page.goto('about:blank');
    await page.goto(`/app/${slug}${hash}`);
    await shows(page, 'Home page');
  }

  // The preview inside the app's own page follows the links too, and that page keeps its address.
  await page.goto(`/apps/${created.id}/softn/edit`);
  const preview = page.getByTestId('softn-app-preview').frameLocator(FRAME);
  await expect(preview.getByText('Home page', { exact: true })).toBeVisible({ timeout: 60_000 });
  await preview.getByRole('link', { name: 'About this app' }).click();
  await expect(preview.getByText('About page', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(`/apps/${created.id}/softn/edit`);
  await place(page, '');

  expect(problems).toEqual([]);
});
