import { sessionHeaders } from './session-request';
/**
 * The data manager of a hosted SoftN app (its page's Data section), end to end in a real browser
 * against the real backend and a real app database:
 *
 *   - On a wide screen: the table list with its counts, a page of rows and the pager, the order
 *     from a column heading, the search, a row opened beside the grid, a cell edited in place, and
 *     ticked rows deleted together. What is shown is in the address, so a reload and Back return
 *     to it, and the page is not loaded again from one table view to the next.
 *   - Structure and Export: the columns as the database has them, and the file the Export view
 *     links to holds the rows.
 *   - On a phone: a card for each row, the row as a sheet over the page, nothing wider than the
 *     screen, and the whole of it reachable with a finger.
 *
 * Each test makes its own app from the server's starter (one table, `items`: id and title), fills
 * it through the same records API the page uses, and deletes the app afterwards.
 * Runs against the seeded golden-path account (E2E_EMAIL / E2E_PASSWORD).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL || 'test@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'password123';
const ROWS = 30;
/** Row n's title: "Row 01" … "Row 30", so the order by title is the order by number. */
const title = (n: number) => `Row ${String(n).padStart(2, '0')}`;

let created: string[] = [];
let headers: Record<string, string> = {};

async function login(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { headers: sessionHeaders(), data: { email: EMAIL, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBe(true);
  const csrf = (await context.cookies()).find(c => c.name === 'formlogic_csrf')!.value;
  headers = { 'X-CSRF-Token': csrf };
}

/** A SoftN app from the starter, with ROWS rows in its `items` table. */
async function appWithRows(context: BrowserContext): Promise<string> {
  const made = await context.request.post('/api/apps', { headers, data: { name: `Data Desk ${Date.now()}`, settings: { softnApp: true } } });
  expect(made.ok(), await made.text()).toBe(true);
  const body = await made.json();
  const id = (body.app ?? body.data?.app ?? body).id as string;
  created.push(id);
  const starter = await context.request.post(`/api/apps/${id}/native/starter`, { headers, data: {} });
  expect(starter.ok(), await starter.text()).toBe(true);
  for (let n = 1; n <= ROWS; n += 1) {
    const row = await context.request.post(`/api/apps/${id}/native/records`, { headers, data: { table: 'items', action: 'create', values: { title: title(n) } } });
    expect(row.ok(), await row.text()).toBe(true);
  }
  return id;
}

const dataSection = (page: Page) => page.getByRole('region', { name: 'Data', exact: true });
const grid = (page: Page) => dataSection(page).getByRole('grid', { name: 'Rows of items' });
/** The titles on the page of rows, top to bottom. */
const titles = (page: Page) => grid(page).locator('tbody td[data-column="title"]').allInnerTexts();
const pagerText = (page: Page) => dataSection(page).locator('[aria-live="polite"]').first();
/** The requests the page makes for the app's records, as "GET ?query" or "POST action". */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', request => {
    const at = request.url().indexOf('/native/records');
    if (at < 0) return;
    seen.push(request.method() === 'GET' ? `GET ${decodeURIComponent(request.url().slice(at + '/native/records'.length))}` : `POST ${(request.postDataJSON() as { action?: string } | null)?.action ?? ''}`);
  });
  return seen;
}

test.describe('the data manager of a SoftN app', () => {
  test.beforeEach(async ({ context }) => { created = []; await login(context); });
  test.afterEach(async ({ context }) => {
    for (const id of created) {
      const r = await context.request.delete(`/api/apps/${id}`, { headers }).catch((e: Error) => e);
      if (r instanceof Error || !r.ok()) console.log('CLEANUP FAILED: app', id, 'was not deleted:', r instanceof Error ? r.message : r.status());
    }
  });

  test('on a wide screen: browse, order, search, open a row, edit a cell and delete ticked rows, with the address holding what is shown', async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const appId = await appWithRows(context);
    const requests = recordRequests(page);
    await page.goto(`/apps/${appId}/softn/data`);
    const data = dataSection(page);

    // The table list says how many rows each table holds; the first table is open on its first page.
    await expect(data.getByRole('navigation', { name: 'Tables' }).getByRole('button', { name: /^items/ })).toContainText(String(ROWS));
    await expect(pagerText(page)).toHaveText(`Rows 1–25 of ${ROWS}`);
    expect(await titles(page)).toEqual(Array.from({ length: 25 }, (_, i) => title(i + 1)));

    // The manager fills the height the page has, and the page itself does not scroll: the list and
    // the rows scroll inside it, and the pager stays in view.
    const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight - document.documentElement.clientHeight, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(fit.sideways).toBe(0);
    expect(fit.page).toBeLessThanOrEqual(1);
    const box = (await data.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(900 - 24);
    await expect(data.getByRole('button', { name: 'Next page', exact: true })).toBeInViewport();

    // The next page, at an address of its own.
    await data.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(pagerText(page)).toHaveText(`Rows 26–${ROWS} of ${ROWS}`);
    await expect(page).toHaveURL(/\/softn\/data\/items\?offset=25$/);
    expect(await titles(page)).toEqual(Array.from({ length: 5 }, (_, i) => title(i + 26)));

    // A column heading orders the table, from the first page: once for smallest first, again for largest.
    const heading = grid(page).locator('thead th', { hasText: 'title' }).getByRole('button');
    await heading.click();
    await expect(grid(page).locator('thead th[aria-sort="ascending"]')).toHaveText(/title/);
    await heading.click();
    await expect(grid(page).locator('thead th[aria-sort="descending"]')).toHaveText(/title/);
    await expect(page).toHaveURL(/\/softn\/data\/items\?sort=title&dir=desc$/);
    await expect(grid(page).locator('tbody td[data-column="title"]').first()).toHaveText(title(ROWS));

    // The search finds rows by what any column holds, and keeps the focus while it does.
    const search = data.getByRole('searchbox', { name: 'Search this table' });
    await search.fill('Row 2');
    await expect(pagerText(page)).toHaveText('Rows 1–10 of 10 matching');
    await expect(search).toBeFocused();
    expect(await titles(page)).toEqual(Array.from({ length: 10 }, (_, i) => title(29 - i)));

    // A reload returns to the same rows in the same order: the address is the one copy of it.
    await page.reload();
    await expect(pagerText(page)).toHaveText('Rows 1–10 of 10 matching');
    await expect(data.getByRole('searchbox', { name: 'Search this table' })).toHaveValue('Row 2');
    await expect(grid(page).locator('tbody td[data-column="title"]').first()).toHaveText(title(29));

    // A row opens from its key, beside the grid, and asks for that row alone: the page of rows is not fetched again.
    const openKey = (await grid(page).locator('tbody tr').nth(1).locator('td[data-column="id"]').innerText()).trim();
    const before = requests.length;
    await grid(page).getByRole('button', { name: `${openKey}: open row ${openKey}`, exact: true }).click();
    const details = data.getByRole('complementary', { name: `Row id ${openKey} of items` });
    await expect(details).toBeVisible();
    await expect(details.locator('[data-column="title"] dd')).toHaveText(title(28));
    await expect(page).toHaveURL(new RegExp(`row=${encodeURIComponent(JSON.stringify({ id: openKey }))}$`));
    expect(requests.slice(before)).toEqual(['POST read']);
    await details.getByRole('button', { name: 'Close this row', exact: true }).click();
    await expect(details).toHaveCount(0);

    // A cell is edited where it is: a double click, the new text, Enter. The app's database holds it.
    const cell = grid(page).locator('tbody tr').first().locator('td[data-column="title"]');
    await cell.dblclick();
    const editor = grid(page).locator('[data-cell-editor] input, [data-cell-editor] textarea');
    await expect(editor).toHaveValue(title(29));
    await editor.fill('Row 29, renamed');
    await editor.press('Enter');
    await expect(cell).toHaveText('Row 29, renamed');
    const stored = await (await context.request.get(`/api/apps/${appId}/native/records?table=items&q=${encodeURIComponent('Row 29, renamed')}`)).json();
    expect(stored.matching).toBe(1);

    // Ticked rows are deleted together, after the page asks; the counts follow.
    await search.fill('');
    await expect(pagerText(page)).toHaveText(`Rows 1–25 of ${ROWS}`);
    const [first, second] = [(await titles(page))[0], (await titles(page))[1]];
    await grid(page).locator('tbody tr').nth(0).getByRole('checkbox').check({ force: true });
    await grid(page).locator('tbody tr').nth(1).getByRole('checkbox').check({ force: true });
    await expect(data.getByRole('status').filter({ hasText: '2 selected' })).toBeVisible();
    await data.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: 'Delete 2 rows?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete 2 rows', exact: true }).click();
    await expect(pagerText(page)).toHaveText(`Rows 1–25 of ${ROWS - 2}`);
    expect(await titles(page)).not.toContain(first);
    expect(await titles(page)).not.toContain(second);
    await expect(data.getByRole('navigation', { name: 'Tables' }).getByRole('button', { name: /^items/ })).toContainText(String(ROWS - 2));

    // Back goes to what was shown before: the row that was open, in the search it was found by
    // (typing in the search box adds no step of its own, closing a row does).
    await page.goBack();
    await expect(data.getByRole('complementary', { name: `Row id ${openKey} of items` })).toBeVisible();
    await expect(search).toHaveValue('Row 2');
  });

  test('Structure and Export: the columns as the database has them, and a file of the rows', async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const appId = await appWithRows(context);
    await page.goto(`/apps/${appId}/softn/data/items`);
    const data = dataSection(page);
    await expect(pagerText(page)).toHaveText(`Rows 1–25 of ${ROWS}`);
    const requests = recordRequests(page);

    // Structure, at its own address, without the list of tables or the rows being asked for again.
    await data.getByRole('tab', { name: 'Structure', exact: true }).click();
    await expect(page).toHaveURL(/\/softn\/data\/items\/structure$/);
    const structure = data.getByRole('tabpanel');
    await expect(structure.locator('tbody tr').nth(0)).toContainText(/id\s*INTEGER[\s\S]*Primary/);
    await expect(structure.locator('tbody tr').nth(1)).toContainText(/title\s*TEXT/);
    expect(requests.filter(each => each.includes('summary=1') || each.includes('offset='))).toEqual([]);

    // Export links to the file itself. It is fetched here with the page's own session.
    await data.getByRole('tab', { name: 'Export', exact: true }).click();
    await expect(page).toHaveURL(/\/softn\/data\/items\/export$/);
    const link = data.locator('a[href*="export="]').first();
    await expect(link).toHaveAttribute('href', new RegExp(`/api/apps/${appId}/native/records\\?table=items&export=csv$`));
    const file = await context.request.get((await link.getAttribute('href'))!);
    expect(file.ok()).toBe(true);
    expect(file.headers()['content-disposition']).toContain('attachment');
    const lines = (await file.text()).trim().split(/\r?\n/);
    // A spreadsheet's byte order mark, if the file starts with one, is not part of the first column's name.
    expect(lines[0].split(String.fromCharCode(0xFEFF)).join('').replace(/"/g, '')).toBe('id,title');
    expect(lines).toHaveLength(ROWS + 1);
    expect(lines[1].replace(/"/g, '')).toMatch(/,Row 01$/);

    // Back in Browse the rows are as they were left.
    await data.getByRole('tab', { name: 'Browse', exact: true }).click();
    await expect(page).toHaveURL(/\/softn\/data\/items$/);
    await expect(pagerText(page)).toHaveText(`Rows 1–25 of ${ROWS}`);
  });

  for (const [width, height] of [[360, 780], [430, 932]] as const) {
    test(`on a phone ${width} wide: a card for each row, the row as a sheet, and nothing wider than the screen`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      try {
        await login(context);
        const appId = await appWithRows(context);
        const page = await context.newPage();
        await page.goto(`/apps/${appId}/softn/data/items`);
        const data = dataSection(page);
        const cards = data.getByRole('list', { name: 'Rows of items' }).getByRole('listitem');
        await expect(cards).toHaveCount(25);
        await expect(data.getByRole('grid')).toHaveCount(0);
        await expect(cards.first()).toContainText(title(1));
        const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(await sideways()).toBe(0);

        // Several rows to a screen: a card is a summary, not a form.
        const card = (await cards.first().boundingBox())!;
        expect(card.height).toBeLessThan(140);

        // What a finger presses is a finger tall: the row's title, its tick, the pager.
        for (const target of [cards.first().getByRole('button', { name: /^Open row / }), data.getByRole('button', { name: 'Next page', exact: true }), data.getByRole('tab', { name: 'Structure', exact: true })]) {
          await target.scrollIntoViewIfNeeded();
          const size = (await target.boundingBox())!;
          expect(size.height, await target.innerText().catch(() => '')).toBeGreaterThanOrEqual(40);
        }

        // The order comes from a select, since there are no headings to press.
        await data.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
        await data.getByRole('button', { name: 'Smallest first. Change to largest first.', exact: true }).click();
        await expect(cards.first()).toContainText(title(ROWS));
        await expect(page).toHaveURL(/\?sort=title&dir=desc$/);

        // A row opens as a sheet over the page, with the whole row, and Back closes it.
        await cards.first().getByRole('button', { name: /^Open row / }).click();
        const sheet = page.getByRole('dialog', { name: /^Row id \d+ of items$/ });
        await expect(sheet).toBeVisible();
        await expect(sheet.locator('[data-column="title"] dd')).toHaveText(title(ROWS));
        expect(await sideways()).toBe(0);
        await sheet.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(sheet).toHaveCount(0);

        // A card opens out to every column, and there a value is edited from its pencil.
        await cards.first().getByRole('button', { name: /^Show all \d+ columns$/ }).click();
        await cards.first().getByRole('button', { name: /^Edit title of row / }).click();
        const box = cards.first().locator('[data-cell-editor] input, [data-cell-editor] textarea');
        await expect(box).toHaveValue(title(ROWS));
        // Named so that it stays first in the order shown.
        await box.fill('Row 99, renamed on a phone');
        await cards.first().getByRole('button', { name: 'Save', exact: true }).click();
        await expect(cards.first()).toContainText('Row 99, renamed on a phone');

        // Structure is a list of small cards there, not a table to scroll sideways.
        await data.getByRole('tab', { name: 'Structure', exact: true }).click();
        await expect(data.getByRole('list', { name: 'Columns of items' }).getByRole('listitem')).toHaveCount(2);
        expect(await sideways()).toBe(0);
      } finally {
        for (const id of created) await context.request.delete(`/api/apps/${id}`, { headers }).catch(() => undefined);
        created = [];
        await context.close();
      }
    });
  }
});
