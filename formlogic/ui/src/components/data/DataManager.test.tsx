// @vitest-environment jsdom
// The data manager against a mocked API: what it asks the server for, what it shows of the
// answers, and what it asks of the page. The page that mounts it owns the address (the table, the
// view and the query string), so a small page here keeps one and follows `onNavigate`.
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeBrowse, NativeBrowseQuery, NativeRecordField, NativeStructure } from '../../lib/nativeHosting';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), browse: vi.fn(), structure: vi.fn(), manage: vi.fn(), deleteMany: vi.fn() }));
vi.mock('../../lib/api', async importOriginal => {
  // The export address is the real one: the page links to it as it is.
  const { api } = await importOriginal<typeof import('../../lib/api')>();
  return { api: {
    getNativeDataSummary: mocks.summary, browseNativeRecords: mocks.browse, getNativeStructure: mocks.structure,
    manageNativeRecord: mocks.manage, deleteNativeRecords: mocks.deleteMany, nativeExportUrl: api.nativeExportUrl.bind(api),
  } };
});
// The full row editor is the studio's own, tested there: here, what it is opened with and what follows its answer.
vi.mock('../studio/NativeRecordEditor', () => ({
  NativeRecordEditor: (props: { table: string; recordKey?: Record<string, string>; fields: NativeRecordField[]; onClose(): void; onSaved(message: string): void }) =>
    <div data-testid="row-editor" data-table={props.table} data-key={props.recordKey ? JSON.stringify(props.recordKey) : 'new'} data-fields={props.fields.map(field => field.name).join(',')}>
      <button type="button" onClick={() => props.onSaved(props.recordKey ? 'Record updated.' : 'Record created.')}>editor saves</button>
      <button type="button" onClick={() => props.onSaved('Record deleted.')}>editor deletes</button>
    </div>,
}));
import { readQuery, writeQuery, NOTHING, type BrowseState } from './address';
import { DataManager, type DataManagerProps, type DataView } from './index';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── What the server answers ────────────────────────────────────────────────────────────────────
const summary = (over: Record<string, unknown> = {}) => ({ data: {
  installed: true, tables: ['bookings', 'customers', 'payments'], readOnly: false,
  summary: { tables: [{ name: 'bookings', rows: 8214, columns: 6 }, { name: 'customers', rows: 1902, columns: 2 }, { name: 'payments', rows: 7950, columns: 2 }], bytes: 3250586, hiddenTables: 2 },
  ...over,
} });
const field = (name: string, type: string, over: Partial<NativeRecordField> = {}): NativeRecordField => ({ name, type, primary: false, required: false, defaultValue: null, auto: false, readOnly: false, ...over });
const bookingFields = [field('id', 'INTEGER', { primary: true, required: true, auto: true }), field('customer_id', 'INTEGER'), field('status', 'TEXT'), field('total', 'REAL'), field('notes', 'TEXT'), field('photo', 'BLOB', { readOnly: true })];
const customerFields = [field('id', 'INTEGER', { primary: true, required: true, auto: true }), field('name', 'TEXT', { required: true })];
const LONG = 'Allergy: nuts. '.repeat(26).trim();
const bookingRows = [
  { id: 8214, customer_id: 1902, status: 'confirmed', total: 0, notes: 'Window seat', photo: null },
  { id: 8213, customer_id: 1865, status: '', total: 118.5, notes: null, photo: '[binary]' },
  { id: 8212, customer_id: null, status: 'paid', total: 12, notes: LONG, photo: null },
];
/** A page of bookings as the server would answer the query it was asked. */
const bookings = (query: NativeBrowseQuery = {}, over: Partial<NativeBrowse> = {}): { data: NativeBrowse } => ({ data: {
  tables: ['bookings', 'customers', 'payments'], columns: bookingFields.map(each => each.name), rows: bookingRows,
  keys: [{ id: '8214' }, { id: '8213' }, { id: '8212' }], stamps: ['s14', 's13', 's12'], cut: { 2: ['notes'] },
  schema: { fields: bookingFields, primaryKey: ['id'], canCreate: true },
  hasMore: true, end: 'more', offset: query.offset ?? 0, limit: query.limit ?? 50, offsetLimit: 100000,
  total: 8214, matching: query.q || query.filters?.length ? 1204 : 8214, sort: query.sort ?? null, hiddenColumns: 1, readOnly: false,
  ...over,
} });
const plain = (table: string, query: NativeBrowseQuery = {}): { data: NativeBrowse } => ({ data: {
  tables: ['bookings', 'customers', 'payments'], columns: ['id', 'name'], rows: [{ id: 1902, name: 'Ada' }, { id: 1865, name: 'Grace' }], keys: [{ id: '1902' }, { id: '1865' }], stamps: ['c1', 'c2'],
  schema: { fields: customerFields, primaryKey: ['id'], canCreate: true },
  hasMore: false, end: 'end', offset: query.offset ?? 0, limit: query.limit ?? 50, offsetLimit: 100000, total: table === 'customers' ? 1902 : 7950, matching: 2, sort: null, hiddenColumns: 0,
} });
const column = (name: string, type: string, over: Partial<NativeStructure['columns'][number]> = {}) => ({ name, type, notNull: true, defaultValue: null, primaryKey: 0, hidden: false, generated: false, ...over });
const bookingsStructure: NativeStructure = {
  table: 'bookings', rows: 8214,
  // As SQLite reports `id INTEGER PRIMARY KEY`: not declared NOT NULL.
  columns: [column('id', 'INTEGER', { primaryKey: 1, notNull: false }), column('customer_id', 'INTEGER'), column('status', 'TEXT', { defaultValue: "'new'" }), column('total', 'REAL', { defaultValue: '0' }),
    column('notes', 'TEXT', { notNull: false }), column('photo', 'BLOB', { notNull: false }), column('manage_token', 'TEXT', { hidden: true })],
  indexes: [{ name: 'idx_bookings_customer', unique: false, origin: 'c', columns: ['customer_id'] }, { name: 'uq_bookings_slot', unique: true, origin: 'c', columns: ['status', 'total'] }],
  foreignKeys: [{ columns: ['customer_id'], table: 'customers', to: ['id'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' }],
  referencedBy: [{ table: 'payments', columns: ['booking_id'], to: ['id'] }],
};
const record = (values: Record<string, string | null>, fields = bookingFields) => ({ data: { record: { values, revision: 'rev-1', fields } } });
const fullRow = { id: '8214', customer_id: '1902', status: 'confirmed', total: '0.0', notes: 'Window seat' };
/** A whole row as a read gives it: text for every value, the whole of a long one, and no binary. */
const whole = (id: string | undefined): Record<string, string | null> => {
  const row = bookingRows.find(each => String(each.id) === id) ?? bookingRows[0];
  return { id: String(row.id), customer_id: row.customer_id === null ? null : String(row.customer_id), status: row.status, total: String(row.total), notes: row.notes === LONG ? `${LONG} And the rest of it.` : row.notes };
};

// ── The page ───────────────────────────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
interface Address { table?: string; view?: DataView; query?: string }
const navigations: (Required<Pick<Address, 'view' | 'query'>> & { table?: string; replace: boolean })[] = [];
let address: (next: Address) => void = () => undefined;

function Page({ query, ...props }: Partial<DataManagerProps>) {
  const [at, setAt] = useState<Address>({ table: props.table, view: props.view, query });
  useEffect(() => { address = setAt; }, []);
  return <DataManager appId="app1" appSlug="booking" version={1} {...props} table={at.table} view={at.view} query={at.query}
    onNavigate={(table, view, next = '', options) => { navigations.push({ table, view, query: next, replace: !!options?.replace }); setAt({ table, view, query: next }); }} />;
}
/** Let the requests that are under way answer, and what they start answer too. */
const settle = () => act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise(resolve => setTimeout(resolve, 0)); });
const mount = async (props: Partial<DataManagerProps> = {}) => { await act(async () => root.render(<Page {...props} />)); await settle(); };
const remount = async (props: Partial<DataManagerProps> = {}) => { await act(async () => root.unmount()); root = createRoot(container); await mount(props); };
/** The address changes under the manager: Back, Forward, a link. */
const visit = async (next: Address) => { await act(async () => address(next)); await settle(); };
const query = (state: Partial<BrowseState>) => writeQuery({ ...NOTHING, ...state });
const phone = () => Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
const tablet = () => Object.defineProperty(window, 'innerWidth', { value: 768, configurable: true, writable: true });

const all = <T extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<T>(selector)];
const one = <T extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<T>(selector);
/** A button by its name: its label, or its text. Dialogs and popovers are outside the container. */
const button = (name: string, within: ParentNode = document.body) => all<HTMLButtonElement>('button', within).find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name);
const click = async (node: Element | null | undefined) => { expect(node, 'something to click').toBeTruthy(); await act(async () => (node as HTMLElement).click()); await settle(); };
const type = async (input: Element | null | undefined, value: string) => {
  const node = input as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')!.set!;
  await act(async () => { set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
};
const choose = async (select: Element | null | undefined, value: string) => {
  const node = select as HTMLSelectElement;
  await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
};
const press = async (node: Element | null | undefined, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { node!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  await settle();
};
const doubleClick = async (node: Element | null | undefined) => { await act(async () => { node!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); await settle(); };

const workspace = () => one('section[aria-label^="Table "]')!;
const grid = () => one<HTMLTableElement>('table[role="grid"]')!;
const cell = (row: number, name: string) => one<HTMLTableCellElement>(`tbody tr:nth-child(${row + 1}) td[data-column="${name}"]`, grid())!;
const header = (name: string) => all<HTMLTableCellElement>('thead th', grid()).find(th => th.textContent === name)!;
const tick = (row: number) => one<HTMLInputElement>(`tbody tr:nth-child(${row + 1}) input[type="checkbox"]`, grid())!;
const tab = (name: string) => all<HTMLButtonElement>('[role="tab"]').find(node => node.textContent === name)!;
const tableButton = (name: string) => all<HTMLButtonElement>('nav[aria-label="Tables"] li button').find(node => node.textContent?.startsWith(name))!;
const pagerText = () => one('[aria-live="polite"]')?.textContent;
const editorBox = (within: ParentNode = document.body) => one<HTMLInputElement | HTMLTextAreaElement>('[data-cell-editor] input, [data-cell-editor] textarea', within);
const details = () => one<HTMLElement>('aside[aria-label^="Row "], [role="dialog"][aria-label^="Row "]', document.body);
const detail = (name: string) => one(`[data-column="${name}"] dd`, details()!)!;
const notice = () => one('[role="status"], [role="alert"]', workspace())?.textContent;
const cards = () => all('ul[aria-label^="Rows of"] > li');
const cardLine = (card: number, name: string) => one(`[data-column="${name}"]`, cards()[card])!;
/** The query of the latest request for a page of rows, and the table it was for. */
const asked = () => mocks.browse.mock.calls.at(-1)![2] as NativeBrowseQuery;
const askedTable = () => mocks.browse.mock.calls.at(-1)![1] as string;
/** Where the page was last asked to go, with its query read back. */
const went = () => { const last = navigations.at(-1)!; return { table: last.table, view: last.view, replace: last.replace, ...readQuery(last.query) }; };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.summary.mockResolvedValue(summary());
  mocks.browse.mockImplementation(async (_app: string, table: string, asking: NativeBrowseQuery) => table === 'bookings' ? bookings(asking) : plain(table, asking));
  mocks.structure.mockImplementation(async (_app: string, table: string) => ({ data: table === 'bookings' ? bookingsStructure : { table, rows: 0, columns: [], indexes: [], foreignKeys: [], referencedBy: [] } }));
  mocks.manage.mockImplementation(async (_app: string, input: { table: string; action: string; key?: Record<string, string> }) => {
    if (input.action !== 'read') return { data: { saved: true } };
    if (input.table !== 'bookings') return { data: { record: { values: { id: input.key?.id ?? '', name: input.key?.id === '1902' ? 'Ada' : 'Grace' }, revision: 'rev-c', fields: customerFields } } };
    return record(whole(input.key?.id));
  });
  navigations.length = 0;
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the table list', () => {
  it('lists the tables with their row counts, the totals, and how many system tables are kept out', async () => {
    await mount();
    expect(mocks.summary).toHaveBeenCalledWith('app1', expect.anything());
    const list = one('nav[aria-label="Tables"]')!;
    expect(all('li button', list).map(node => node.textContent)).toEqual(['bookings, 8,214 rows', 'customers, 1,902 rows', 'payments, 7,950 rows']);
    expect(list.textContent).toContain('3 tables · 18,066 rows · 3.1 MB');
    expect(list.textContent).toContain('2 system tables not shown');
    // The totals stand above the tables, clear of the page's floating button in the bottom corner.
    expect(one('ul', list)!.previousElementSibling!.textContent).toContain('3 tables · 18,066 rows · 3.1 MB');
    // The picker of narrower screens holds the same tables, each with its count.
    expect(all('select[aria-label="Table"] option', list).map(node => node.textContent)).toEqual(['bookings · 8,214 rows', 'customers · 1,902 rows', 'payments · 7,950 rows']);
  });

  it('opens the first table when the address names none, and marks it', async () => {
    await mount();
    expect(askedTable()).toBe('bookings');
    expect(tableButton('bookings').getAttribute('aria-current')).toBe('true');
    expect(tableButton('customers').hasAttribute('aria-current')).toBe(false);
    // Showing the first table is not a change of address.
    expect(navigations).toEqual([]);
  });

  it('finds a table by part of its name', async () => {
    await mount();
    await type(one('input[aria-label="Find a table"]'), 'PAY');
    expect(all('nav[aria-label="Tables"] li button').map(node => node.textContent)).toEqual(['payments, 7,950 rows']);
    await type(one('input[aria-label="Find a table"]'), 'zzz');
    expect(one('nav[aria-label="Tables"] ul')!.textContent).toBe('No table has “zzz” in its name.');
  });

  it('asks the page to open the table that is picked, in the view that is showing, on all of its rows', async () => {
    await mount({ view: 'structure', query: query({ q: 'nuts', filters: [{ column: 'status', op: 'eq', value: 'paid' }], sort: { column: 'total', dir: 'desc' }, offset: 50, row: { id: '8214' } }) });
    await click(tableButton('customers'));
    // The search, the filters, the order, the page and the open row belonged to the table that was left.
    expect(navigations).toEqual([{ table: 'customers', view: 'structure', query: '', replace: false }]);
    expect(mocks.structure).toHaveBeenLastCalledWith('app1', 'customers', expect.anything());
    await choose(one('select[aria-label="Table"]'), 'payments');
    expect(navigations.at(-1)).toEqual({ table: 'payments', view: 'structure', query: '', replace: false });
  });

  it('lists the tables by name alone when the server sends no counts', async () => {
    mocks.summary.mockResolvedValue({ data: { installed: true, tables: ['bookings', 'customers', 'payments'] } });
    await mount();
    const list = one('nav[aria-label="Tables"]')!;
    expect(all('li button', list).map(node => node.textContent)).toEqual(['bookings', 'customers', 'payments']);
    expect(one('ul', list)!.previousElementSibling!.textContent).toBe('3 tables');
    expect(all('select[aria-label="Table"] option', list).map(node => node.textContent)).toEqual(['bookings', 'customers', 'payments']);
    // The open table still says what a page of its rows counted.
    expect(workspace().textContent).toContain('8,214 rows · 6 columns');
  });

  it('keeps a long table name to its place, whole in its title', async () => {
    const long = 'a_table_with_a_name_that_goes_on_and_on_far_past_what_fits_in_the_list';
    mocks.summary.mockResolvedValue(summary({ tables: [long], summary: { tables: [{ name: long, rows: 3, columns: 6 }], bytes: 4096, hiddenTables: 0 } }));
    await mount();
    expect(tableButton(long).title).toBe(long);
    expect(one('span', tableButton(long))!.className).toContain('truncate');
    const heading = one('h2', workspace())!;
    expect(heading.title).toBe(long);
    expect(heading.className).toContain('truncate');
  });

  it('says so when the address names a table the app does not have', async () => {
    await mount({ table: 'ghosts' });
    expect(container.textContent).toContain('This app has no table called ghosts');
    expect(mocks.browse).not.toHaveBeenCalled();
    expect(tableButton('bookings')).toBeTruthy();
  });

  it('loads the tables and the rows again when the app’s version changes', async () => {
    await mount();
    expect(mocks.summary).toHaveBeenCalledTimes(1);
    const rowRequests = mocks.browse.mock.calls.length, shapeRequests = mocks.structure.mock.calls.length;
    await act(async () => root.render(<Page version={2} />));
    await settle();
    expect(mocks.summary).toHaveBeenCalledTimes(2);
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    // A new version may have changed the shape: it is fetched again too.
    expect(mocks.structure.mock.calls.length).toBe(shapeRequests + 1);
  });
});

describe('an open table', () => {
  it('shows its name, its counts, its rows and where they stand', async () => {
    await mount();
    const section = one('section[aria-label="Table bookings"]')!;
    expect(one('h2', section)!.textContent).toBe('bookings');
    expect(section.textContent).toContain('8,214 rows · 6 columns');
    expect(asked()).toEqual({ offset: 0, limit: 25, sort: null, q: '', filters: [] });
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(all('thead th', grid()).map(th => th.textContent)).toEqual(['', 'id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    expect(pagerText()).toBe('Rows 1–3 of 8,214');
    expect(section.textContent).toContain('1 / 329');
    expect(section.textContent).toContain('1 column not shown (looks like a secret)');
    expect(section.textContent).toContain('Double-click a cell to edit');
  });

  it('follows the count a page of rows gives, in the header and in the list', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { total: 8215, matching: 8215 }));
    await mount();
    expect(one('section[aria-label="Table bookings"]')!.textContent).toContain('8,215 rows · 6 columns');
    expect(tableButton('bookings').textContent).toBe('bookings, 8,215 rows');
    expect(one('nav[aria-label="Tables"]')!.textContent).toContain('3 tables · 18,067 rows');
  });

  it('the views are tabs: arrows move between them, and opening one asks the page and keeps what Browse shows', async () => {
    const browsing = query({ q: 'nuts', offset: 25 });
    await mount({ query: browsing });
    expect(all('[role="tab"]').map(node => [node.textContent, node.getAttribute('aria-selected'), node.tabIndex])).toEqual([['Browse', 'true', 0], ['Structure', 'false', -1], ['Export', 'false', -1]]);
    tab('Browse').focus();
    await press(tab('Browse'), 'ArrowRight');
    expect(document.activeElement).toBe(tab('Structure'));
    await press(tab('Structure'), 'End');
    expect(document.activeElement).toBe(tab('Export'));
    // Moving is not opening.
    expect(navigations).toEqual([]);
    await click(tab('Export'));
    expect(navigations).toEqual([{ table: 'bookings', view: 'export', query: browsing, replace: false }]);
    expect(tab('Export').getAttribute('aria-selected')).toBe('true');
    const panel = one('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Export').id);
    expect(tab('Export').getAttribute('aria-controls')).toBe(panel.id);
  });

  it('shows the page’s import panel under Import, and no Import tab without one', async () => {
    await mount({ view: 'import', importPanel: <p>Bring data from where it ran before</p> });
    expect(tab('Import').getAttribute('aria-selected')).toBe('true');
    expect(one('[role="tabpanel"]')!.textContent).toBe('Bring data from where it ran before');
    await remount({ view: 'import' });
    expect(tab('Import')).toBeUndefined();
    expect(tab('Browse').getAttribute('aria-selected')).toBe('true');
  });

  it('says once why the rows of a table with no primary key cannot be opened, ticked or changed', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { keys: [], stamps: [], schema: { fields: bookingFields.map(each => ({ ...each, primary: false })), primaryKey: [], canCreate: true } }));
    await mount();
    expect(all('p', workspace()).filter(node => node.textContent?.includes('no primary key')).map(node => node.textContent)).toEqual(['This table has no primary key, so its rows cannot be opened, ticked or changed here.']);
    expect(all('input[type="checkbox"]', grid())).toHaveLength(0);
    // Nothing opens a row; the links along its foreign keys still lead where they point.
    expect(all('tbody button', grid()).map(node => node.getAttribute('aria-label'))).toEqual(['1902: open customers where id is 1902', '1865: open customers where id is 1865']);
    expect(container.textContent).not.toContain('Double-click a cell to edit');
    await doubleClick(cell(0, 'notes'));
    expect(mocks.manage).not.toHaveBeenCalled();
    // Rows can still be added to it.
    expect(button('Add row')).toBeTruthy();
  });

  it('shows a table of one column, and one whose key is text', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => ({ data: {
      tables: ['bookings'], columns: ['key'], rows: [{ key: 'theme' }, { key: 'time zone' }], keys: [{ key: 'theme' }, { key: 'time zone' }], stamps: ['a', 'b'],
      schema: { fields: [field('key', 'TEXT', { primary: true, required: true })], primaryKey: ['key'], canCreate: true },
      hasMore: false, end: 'end', offset: asking.offset ?? 0, limit: 25, offsetLimit: 100000, total: 2, matching: 2, sort: null, hiddenColumns: 0,
    } }));
    await mount();
    expect(all('thead th', grid()).map(th => th.textContent)).toEqual(['', 'key']);
    expect(tick(1).getAttribute('aria-label')).toBe('Select row time zone');
    await click(button('time zone: open row time zone'));
    expect(went().row).toEqual({ key: 'time zone' });
  });
});

describe('what Browse shows is the address’s to hold', () => {
  it('asks the server for what the address says: the search, the filters, the order and the page', async () => {
    await mount({ table: 'bookings', query: query({ q: 'nuts', filters: [{ column: 'status', op: 'ne', value: 'cancelled' }], sort: { column: 'total', dir: 'desc' }, offset: 50 }) });
    expect(asked()).toEqual({ offset: 50, limit: 25, sort: { column: 'total', dir: 'desc' }, q: 'nuts', filters: [{ column: 'status', op: 'ne', value: 'cancelled' }] });
    expect(one<HTMLInputElement>('input[aria-label="Search this table"]')!.value).toBe('nuts');
    expect(button('Remove the filter: status is not cancelled')).toBeTruthy();
    expect(header('total').getAttribute('aria-sort')).toBe('descending');
    expect(pagerText()).toBe('Rows 51–53 of 1,204 matching');
    // Reading the address asks nothing of the page.
    expect(navigations).toEqual([]);
  });

  it('follows the address when it changes under it: Back, Forward, a link', async () => {
    await mount({ table: 'bookings', query: query({ q: 'nuts', offset: 25 }) });
    await visit({ table: 'bookings', query: query({ sort: { column: 'status', dir: 'asc' } }) });
    expect(asked()).toEqual({ offset: 0, limit: 25, sort: { column: 'status', dir: 'asc' }, q: '', filters: [] });
    // The search box shows the address's search, not the one that was typed before.
    expect(one<HTMLInputElement>('input[aria-label="Search this table"]')!.value).toBe('');
    expect(header('status').getAttribute('aria-sort')).toBe('ascending');
    await visit({ table: 'customers', query: '' });
    expect(askedTable()).toBe('customers');
    expect(navigations).toEqual([]);
  });

  it('ignores a filter and a row it cannot read', async () => {
    await mount({ table: 'bookings', query: 'filter=%7Bnot%20json&row=also%20not&offset=-5&sort=' });
    expect(asked()).toEqual({ offset: 0, limit: 25, sort: null, q: '', filters: [] });
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(details()).toBeNull();
    expect(one('[role="alert"]')).toBeNull();
  });

  it('keeps what else the address’s query holds', async () => {
    await mount({ query: 'from=overview' });
    await click(button('Next page'));
    expect(Object.fromEntries(new URLSearchParams(navigations.at(-1)!.query))).toEqual({ from: 'overview', offset: '25' });
  });

  it('keeps the rows-per-page choice out of the address', async () => {
    await mount();
    await choose(one('select[aria-label="Rows per page"]'), '100');
    expect(asked().limit).toBe(100);
    // Nothing to put right: the page already starts where a page of 100 does.
    expect(navigations).toEqual([]);
  });
});

describe('sorting', () => {
  it('goes ascending, descending, then back to the table’s own order, and says so to a screen reader', async () => {
    await mount();
    expect(header('status').hasAttribute('aria-sort')).toBe(false);
    await click(button('status', header('status')));
    expect(asked()).toMatchObject({ sort: { column: 'status', dir: 'asc' }, offset: 0 });
    expect(went()).toMatchObject({ table: 'bookings', view: 'browse', sort: { column: 'status', dir: 'asc' }, replace: false });
    expect(header('status').getAttribute('aria-sort')).toBe('ascending');
    await click(button('status', header('status')));
    expect(asked()).toMatchObject({ sort: { column: 'status', dir: 'desc' } });
    expect(header('status').getAttribute('aria-sort')).toBe('descending');
    await click(button('status', header('status')));
    expect(asked().sort).toBeNull();
    expect(header('status').hasAttribute('aria-sort')).toBe(false);
    expect(navigations.at(-1)!.query).toBe('');
  });

  it('starts ascending on another column, from the first page', async () => {
    await mount();
    await click(button('Next page'));
    expect(asked().offset).toBe(25);
    await click(button('status', header('status')));
    await click(button('total', header('total')));
    expect(asked()).toMatchObject({ sort: { column: 'total', dir: 'asc' }, offset: 0 });
    expect(header('status').hasAttribute('aria-sort')).toBe(false);
    expect(header('total').getAttribute('aria-sort')).toBe('ascending');
  });
});

describe('searching', () => {
  it('sends the search once the typing has rested for 300 ms, without a new entry in the history', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount();
    const calls = mocks.browse.mock.calls.length;
    const box = one<HTMLInputElement>('input[aria-label="Search this table"]')!;
    box.focus();
    await type(box, 'nu');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await type(box, 'nuts ');
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(mocks.browse.mock.calls.length).toBe(calls);
    expect(navigations).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    expect(navigations).toEqual([{ table: 'bookings', view: 'browse', query: 'q=nuts', replace: true }]);
    expect(mocks.browse.mock.calls.length).toBe(calls + 1);
    expect(asked()).toMatchObject({ q: 'nuts', offset: 0 });
    expect(pagerText()).toBe('Rows 1–3 of 1,204 matching');
    // The box is the same box, with the focus and the text as typed, while the rows came again.
    expect(one('input[aria-label="Search this table"]')).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('nuts ');
    // More typing sends once more, and no sooner.
    await type(box, 'nuts and');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await settle();
    expect(navigations.at(-1)).toEqual({ table: 'bookings', view: 'browse', query: 'q=nuts+and', replace: true });
    expect(box.value).toBe('nuts and');
  });

  it('starts from the first page, and clears with the box', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount({ query: query({ q: 'nuts', offset: 50 }) });
    await type(one('input[aria-label="Search this table"]'), 'nut');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await settle();
    expect(asked()).toMatchObject({ q: 'nut', offset: 0 });
    await type(one('input[aria-label="Search this table"]'), '');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await settle();
    expect(navigations.at(-1)!.query).toBe('');
    expect(pagerText()).toBe('Rows 1–3 of 8,214');
  });

  it('says when nothing matches, and offers the way back', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, asking.filters?.length ? { rows: [], keys: [], stamps: [], cut: {}, matching: 0, end: 'end', hasMore: false } : {}));
    await mount();
    await click(button('Add filter'));
    await type(one('[role="dialog"] input[type="text"]', document.body), 'zzz');
    await click(button('Add filter', one('[role="dialog"]', document.body)!));
    expect(container.textContent).toContain('No rows match.');
    expect(pagerText()).toBe('No rows');
    await click(button('Clear the search and filters'));
    expect(asked()).toMatchObject({ q: '', filters: [] });
    expect(all('tbody tr', grid())).toHaveLength(3);
  });
});

describe('filters', () => {
  it('adds a filter from a column, a rule in plain words and a value, and removes it by its own button', async () => {
    await mount();
    await click(button('Add filter'));
    const dialog = one('[role="dialog"][aria-label="Add a filter"]', document.body)!;
    const [columns, rules] = all<HTMLSelectElement>('select', dialog);
    expect(all('option', columns).map(node => node.textContent)).toEqual(['id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    expect(all('option', rules).map(node => node.textContent)).toEqual(['is', 'is not', 'contains', 'starts with', 'is more than', 'is at least', 'is less than', 'is at most', 'is empty', 'is not empty']);
    await choose(columns, 'total');
    await choose(rules, 'gte');
    // A rule that compares needs something to compare with.
    expect(button('Add filter', dialog)!.disabled).toBe(true);
    await type(one('input[type="text"]', dialog), '100');
    await click(button('Add filter', dialog));
    expect(asked()).toMatchObject({ filters: [{ column: 'total', op: 'gte', value: '100' }], offset: 0 });
    expect(went()).toMatchObject({ filters: [{ column: 'total', op: 'gte', value: '100' }], replace: false });
    expect(container.textContent).toContain('total is at least 100');
    expect(pagerText()).toBe('Rows 1–3 of 1,204 matching');

    await click(button('Remove the filter: total is at least 100'));
    expect(asked().filters).toEqual([]);
    expect(container.textContent).not.toContain('total is at least 100');
    expect(pagerText()).toBe('Rows 1–3 of 8,214');
  });

  it('takes no value for “is empty”', async () => {
    await mount();
    await click(button('Add filter'));
    const dialog = one('[role="dialog"]', document.body)!;
    await choose(all<HTMLSelectElement>('select', dialog)[0], 'notes');
    await choose(all<HTMLSelectElement>('select', dialog)[1], 'empty');
    expect(one('input[type="text"]', dialog)).toBeNull();
    await click(button('Add filter', dialog));
    expect(asked().filters).toEqual([{ column: 'notes', op: 'empty' }]);
    expect(button('Remove the filter: notes is empty')).toBeTruthy();
  });

  it('carries a value with quotes, a percent sign and another alphabet as it was typed', async () => {
    await mount();
    await click(button('Add filter'));
    await choose(all<HTMLSelectElement>('[role="dialog"] select', document.body)[0], 'notes');
    await type(one('[role="dialog"] input[type="text"]', document.body), '50% "off" & café 日本');
    await click(button('Add filter', one('[role="dialog"]', document.body)!));
    expect(asked().filters).toEqual([{ column: 'notes', op: 'contains', value: '50% "off" & café 日本' }]);
    expect(went().filters).toEqual([{ column: 'notes', op: 'contains', value: '50% "off" & café 日本' }]);
  });

  it('keeps the filters where they can be removed when the server refuses them', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => asking.filters?.length ? { error: 'Unknown column: gone', status: 400 } : bookings(asking));
    await mount();
    await click(button('Add filter'));
    await type(one('[role="dialog"] input[type="text"]', document.body), '1');
    await click(button('Add filter', one('[role="dialog"]', document.body)!));
    expect(container.textContent).toContain('Unknown column: gone');
    expect(one('table[role="grid"]')).toBeNull();
    await click(button('Remove the filter: id is 1'));
    expect(all('tbody tr', grid())).toHaveLength(3);
  });
});

describe('cells', () => {
  it('shows NULL, an empty text, a cut preview and a binary value each in its own way', async () => {
    await mount();
    expect(cell(1, 'notes').dataset.kind).toBe('null');
    expect(cell(1, 'notes').textContent).toBe('NULL');
    expect(one('span', cell(1, 'notes'))!.className).toContain('italic');
    // An empty text is not NULL, and does not look like it.
    expect(cell(1, 'status').dataset.kind).toBe('empty');
    expect(cell(1, 'status').textContent).toBe('empty');
    expect(one('span', cell(1, 'status'))!.className).not.toContain('italic');
    expect(cell(1, 'photo').dataset.kind).toBe('binary');
    expect(cell(1, 'photo').textContent).toBe('[binary]');
    // A preview that was cut says the text goes on.
    expect(cell(2, 'notes').dataset.kind).toBe('cut');
    expect(cell(2, 'notes').textContent).toBe(`${LONG}… (the text is longer than the part shown)`);
    expect(one('[title="This text is longer than the part shown."]', cell(2, 'notes'))!.textContent).toBe('…');
    // Long text keeps to its cell, and is whole in the cell's title.
    expect(cell(2, 'notes').className).toContain('max-w-[22rem]');
    expect(cell(2, 'notes').title).toBe(LONG);
    expect(cell(0, 'notes').dataset.kind).toBe('value');
    expect(cell(0, 'notes').textContent).toBe('Window seat');
  });

  it('sets numbers to the right by the column’s declared type, in a monospace face, exactly as stored', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { rows: [{ ...bookingRows[0], total: 1234567.5, notes: '2026-11-14 19:30' }, bookingRows[1], bookingRows[2]] }));
    await mount();
    expect(grid().className).toContain('font-mono');
    for (const name of ['id', 'customer_id', 'total']) expect(cell(0, name).className, name).toContain('text-right');
    for (const name of ['status', 'notes']) expect(cell(0, name).className, name).not.toContain('text-right');
    expect(button('total', header('total'))!.className).toContain('justify-end');
    // No thousands marks, no reading of dates: the value as the database holds it.
    expect(cell(0, 'total').textContent).toBe('1234567.5');
    expect(cell(0, 'notes').textContent).toBe('2026-11-14 19:30');
    expect(cell(1, 'total').textContent).toBe('118.5');
  });

  it('moves between cells with the arrow keys, as one stop in the tab order', async () => {
    await mount();
    const stops = () => all('[tabindex="0"]', grid());
    // The first cell is the stop, and the button in it that opens the row.
    expect(stops()).toEqual([cell(0, 'id'), one('button', cell(0, 'id'))]);
    cell(0, 'id').focus();
    await press(cell(0, 'id'), 'ArrowRight');
    expect(document.activeElement).toBe(cell(0, 'customer_id'));
    expect(stops()).toEqual([cell(0, 'customer_id'), one('button', cell(0, 'customer_id'))]);
    await press(cell(0, 'customer_id'), 'ArrowRight');
    expect(stops()).toEqual([cell(0, 'status')]);
    await press(cell(0, 'status'), 'ArrowDown');
    expect(document.activeElement).toBe(cell(1, 'status'));
    await press(cell(1, 'status'), 'Home');
    expect(document.activeElement).toBe(tick(1));
    await press(tick(1), 'ArrowUp');
    await press(tick(0), 'ArrowUp');
    expect(document.activeElement).toBe(one('thead input[type="checkbox"]', grid()));
    await press(document.activeElement, 'ArrowRight');
    expect(document.activeElement).toBe(button('id', header('id')));
    expect(stops()).toEqual([button('id', header('id'))]);
  });

  it('keeps the columns together at the left: each row ends in an empty cell that takes the width left over, and the keys never land on it', async () => {
    await mount();
    for (const row of all<HTMLTableRowElement>('tr', grid())) {
      const last = row.cells[row.cells.length - 1];
      expect(last.dataset.filler).toBe('');
      expect(last.getAttribute('aria-hidden')).toBe('true');
      expect(last.textContent).toBe('');
      expect(last.className).toContain('w-full');
      expect(last.tabIndex).toBe(-1);
    }
    // It is no column: the headings are the table's columns and nothing more.
    expect(all('thead th', grid()).map(th => th.textContent)).toEqual(['', 'id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    cell(0, 'id').focus();
    await press(cell(0, 'id'), 'End');
    expect(document.activeElement).toBe(cell(0, 'photo'));
    await press(cell(0, 'photo'), 'ArrowRight');
    expect(document.activeElement).toBe(cell(0, 'photo'));
  });
});

describe('a linked id opens the row it points at', () => {
  it('opens the other table on that row alone, with the row open, and one press shows every row again', async () => {
    await mount();
    const link = button('1902: open customers where id is 1902', cell(0, 'customer_id'));
    expect(link!.textContent).toBe('1902');
    // A NULL points nowhere.
    expect(one('button', cell(2, 'customer_id'))).toBeNull();
    expect(mocks.structure).toHaveBeenCalledTimes(1);
    await click(link);
    expect(went()).toEqual({ table: 'customers', view: 'browse', replace: false, q: '', sort: null, offset: 0, filters: [{ column: 'id', op: 'eq', value: '1902' }], row: { id: '1902' } });
    expect(askedTable()).toBe('customers');
    expect(asked().filters).toEqual([{ column: 'id', op: 'eq', value: '1902' }]);
    // The row is open: read whole, by its key.
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'customers', action: 'read', key: { id: '1902' } });
    expect(details()!.getAttribute('aria-label')).toBe('Row id 1902 of customers');
    expect(detail('name').textContent).toBe('Ada');
    // The filter is a chip like any other: removing it shows every row, with the row still open.
    await click(button('Remove the filter: id is 1902'));
    expect(asked().filters).toEqual([]);
    expect(went()).toMatchObject({ table: 'customers', filters: [], row: { id: '1902' } });
    expect(details()).not.toBeNull();
  });

  it('survives the page mounting the manager afresh: the filter and the row are in the address', async () => {
    await mount();
    await click(button('1902: open customers where id is 1902', cell(0, 'customer_id')));
    const { table, query: reached } = navigations.at(-1)!;
    await remount({ table, query: reached });
    expect(askedTable()).toBe('customers');
    expect(asked().filters).toEqual([{ column: 'id', op: 'eq', value: '1902' }]);
    expect(button('Remove the filter: id is 1902')).toBeTruthy();
    expect(details()!.getAttribute('aria-label')).toBe('Row id 1902 of customers');
  });

  it('finds the row by the columns the key points at, where those are not the table’s own key', async () => {
    // A foreign key onto a unique column: the address names the row by that column.
    await mount({ table: 'customers', query: query({ filters: [{ column: 'name', op: 'eq', value: 'Grace' }], row: { name: 'Grace' } }) });
    expect(details()!.getAttribute('aria-label')).toBe('Row id 1865 of customers');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'customers', action: 'read', key: { id: '1865' } });
    // A row the page does not hold is no row to open.
    await visit({ table: 'customers', query: query({ row: { name: 'Nobody' } }) });
    expect(details()).toBeNull();
  });
});

describe('a row’s details', () => {
  const open = async (id = '8212') => { await click(button(`${id}: open row ${id}`)); };

  it('opens from the row’s key, beside the grid, with every column and the whole of each value', async () => {
    await mount();
    await open();
    expect(went()).toMatchObject({ table: 'bookings', view: 'browse', row: { id: '8212' }, replace: false });
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8212' } });
    const panel = details()!;
    expect(panel.tagName).toBe('ASIDE');
    expect(panel.getAttribute('aria-label')).toBe('Row id 8212 of bookings');
    // The grid is still there beside it.
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(one('tbody tr[data-open]', grid())).toBe(all('tbody tr', grid())[2]);
    expect(all('dt', panel).map(node => node.textContent)).toEqual(['id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    // The whole text, where the grid has a preview.
    expect(detail('notes').textContent).toBe(`${LONG} And the rest of it.`);
    expect(one('[data-kind]', detail('notes'))!.className).toContain('whitespace-pre-wrap');
    expect(detail('notes').className).toContain('overflow-y-auto');
    expect(detail('customer_id').textContent).toBe('NULL');
    expect(detail('status').textContent).toBe('paid');
    expect(panel.textContent).toContain('1 column not shown.');
  });

  it('shows NULL, an empty text and a binary value by the same rules, and a foreign key as a link', async () => {
    await mount();
    await open('8213');
    expect(one('[data-kind]', detail('notes'))!.dataset.kind).toBe('null');
    expect(one('[data-kind]', detail('status'))!.dataset.kind).toBe('empty');
    // The read leaves a binary value out: the list's own mark for it stands.
    expect(one('[data-kind]', detail('photo'))!.dataset.kind).toBe('binary');
    await click(button('1865: open customers where id is 1865', details()!));
    expect(went()).toMatchObject({ table: 'customers', filters: [{ column: 'id', op: 'eq', value: '1865' }], row: { id: '1865' } });
  });

  it('lists the tables that point at the row, each a link to the rows that do', async () => {
    await mount();
    await open('8213');
    const usedBy = one('section[aria-label="Used by"]', details()!)!;
    await click(button('payments.booking_id: open payments where booking_id is 8213', usedBy));
    expect(went()).toEqual({ table: 'payments', view: 'browse', replace: false, q: '', sort: null, offset: 0, filters: [{ column: 'booking_id', op: 'eq', value: '8213' }], row: null });
  });

  it('steps to the row before and after on the page, and closes', async () => {
    await mount();
    await open('8213');
    await click(button('Next row on this page'));
    expect(went().row).toEqual({ id: '8212' });
    expect(details()!.getAttribute('aria-label')).toBe('Row id 8212 of bookings');
    expect(button('Next row on this page')!.disabled).toBe(true);
    await click(button('Previous row on this page'));
    await click(button('Previous row on this page'));
    expect(went().row).toEqual({ id: '8214' });
    expect(button('Previous row on this page')!.disabled).toBe(true);
    await click(button('Close this row'));
    expect(went().row).toBeNull();
    expect(details()).toBeNull();
  });

  it('edits the whole row in the row editor, and reads it again after', async () => {
    await mount();
    await open('8214');
    await click(button('Edit', details()!));
    expect(one('[data-testid="row-editor"]')!.dataset.key).toBe('{"id":"8214"}');
    const reads = mocks.manage.mock.calls.length, rowRequests = mocks.browse.mock.calls.length;
    await click(button('editor saves'));
    expect(notice()).toContain('Row saved.');
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(mocks.manage.mock.calls.length).toBe(reads + 1);
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8214' } });
    expect(details()).not.toBeNull();
  });

  it('deletes the row after asking, with the revision it read, then closes and counts again', async () => {
    await mount();
    await open('8213');
    await click(button('Delete', details()!));
    const dialog = one('[role="dialog"]', document.body)!;
    expect(dialog.textContent).toContain('Delete this row?');
    const rowRequests = mocks.browse.mock.calls.length, listRequests = mocks.summary.mock.calls.length;
    await click(button('Delete the row', dialog));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'delete', key: { id: '8213' }, revision: 'rev-1' });
    expect(notice()).toContain('Row deleted.');
    expect(went()).toMatchObject({ row: null, replace: true });
    expect(details()).toBeNull();
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(mocks.summary.mock.calls.length).toBe(listRequests + 1);
  });

  it('says in the panel what the server said when it refuses the delete, and reads the row again', async () => {
    await mount();
    await open('8213');
    mocks.manage.mockResolvedValueOnce({ error: 'This record changed since you opened it. Close the editor and refresh before trying again.', status: 409 });
    await click(button('Delete', details()!));
    await click(button('Delete the row', one('[role="dialog"]', document.body)!));
    expect(one('[role="alert"]', details()!)!.textContent).toContain('This record changed since you opened it.');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8213' } });
    expect(details()).not.toBeNull();
  });

  it('closes on Escape from inside the panel, and leaves the delete’s question its own Escape', async () => {
    await mount();
    await open('8213');
    await click(button('Delete', details()!));
    // Escape in the question closes the question, not the row.
    await press(button('Delete the row', one('[role="dialog"]', document.body)!), 'Escape');
    expect(details()).not.toBeNull();
    expect(mocks.manage).not.toHaveBeenCalledWith('app1', expect.objectContaining({ action: 'delete' }));
    await press(button('Edit', details()!), 'Escape');
    expect(went().row).toBeNull();
    expect(details()).toBeNull();
  });

  it('stays open when another row is deleted in the row editor, and closes when it is the one deleted', async () => {
    await mount();
    await open('8213');
    await click(tick(0));
    // The toolbar's Edit, for the ticked row: not the open row's own.
    await click(button('Edit', one('[role="tabpanel"] > div')!));
    expect(one('[data-testid="row-editor"]')!.dataset.key).toBe('{"id":"8214"}');
    await click(button('editor deletes'));
    expect(notice()).toContain('Row deleted.');
    expect(details()!.getAttribute('aria-label')).toBe('Row id 8213 of bookings');
    await click(button('Edit', details()!));
    await click(button('editor deletes'));
    expect(went()).toMatchObject({ row: null, replace: true });
    expect(details()).toBeNull();
  });

  it('says when the row cannot be read, and tries again', async () => {
    mocks.manage.mockResolvedValueOnce({ error: 'This record no longer exists. Refresh the records.', status: 409 });
    await mount({ table: 'bookings', query: query({ row: { id: '9999' } }) });
    expect(one('[role="alert"]', details()!)!.textContent).toContain('This record no longer exists.');
    expect(button('Delete', details()!)!.disabled).toBe(true);
    await click(button('Try again', details()!));
    expect(one('[role="alert"]', details()!)).toBeNull();
  });

  it('asks for one thing when a row opens: that row, once, and not the page of rows again', async () => {
    await mount({ query: query({ sort: { column: 'status', dir: 'asc' }, filters: [{ column: 'status', op: 'ne', value: 'cancelled' }] }) });
    const rowRequests = mocks.browse.mock.calls.length, tableLists = mocks.summary.mock.calls.length;
    await open('8214');
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    await click(button('Next row on this page'));
    expect(mocks.manage).toHaveBeenCalledTimes(2);
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8213' } });
    await click(button('Close this row', details()!));
    expect(details()).toBeNull();
    // The order and the filter in the address say the same as before each time: nothing else was fetched.
    expect(mocks.browse.mock.calls.length).toBe(rowRequests);
    expect(mocks.summary.mock.calls.length).toBe(tableLists);
    expect(mocks.manage).toHaveBeenCalledTimes(2);
  });

  it('opens a row that is not on the page shown, from the address alone', async () => {
    await mount({ table: 'bookings', query: query({ offset: 25, row: { id: '7000' } }) });
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '7000' } });
    expect(details()!.getAttribute('aria-label')).toBe('Row id 7000 of bookings');
    expect(button('Next row on this page')!.disabled).toBe(true);
  });

  it('is a dialog over the page below a wide screen, with Back, and gives the focus back when it closes', async () => {
    tablet();
    await mount();
    const opener = button('8214: open row 8214')!;
    opener.focus();
    await click(opener);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const sheet = details()!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(container.contains(sheet)).toBe(false);
    expect(sheet.contains(document.activeElement)).toBe(true);
    await click(button('Back', sheet));
    expect(went().row).toBeNull();
    expect(details()).toBeNull();
    expect(document.activeElement).toBe(button('8214: open row 8214'));
  });

  it('in read-only mode shows what the page of rows holds, and asks nothing of the server', async () => {
    await mount({ readOnly: true });
    await open();
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(detail('status').textContent).toBe('paid');
    expect(one('[data-kind]', detail('notes'))!.dataset.kind).toBe('cut');
    expect(details()!.textContent).toContain('Long text is shown in part here.');
    expect(button('Edit', details()!)).toBeUndefined();
    expect(button('Delete', details()!)).toBeUndefined();
    // A row that is not among the rows shown has nothing to show there: it says so, and shows no made-up values.
    await visit({ table: 'bookings', query: query({ row: { id: '7000' } }) });
    expect(details()!.textContent).toContain('This row is not among the rows shown.');
    expect(all('dt', details()!)).toHaveLength(0);
    expect(mocks.manage).not.toHaveBeenCalled();
  });
});

describe('ticked rows', () => {
  it('counts them, edits one alone in the full editor, and ticks the whole page at once', async () => {
    await mount();
    expect(container.textContent).not.toContain('selected');
    await click(tick(0));
    expect(container.textContent).toContain('1 selected');
    expect(tick(0).getAttribute('aria-label')).toBe('Select row 8214');
    await click(button('Edit'));
    const editor = one('[data-testid="row-editor"]')!;
    expect([editor.dataset.table, editor.dataset.key, editor.dataset.fields]).toEqual(['bookings', '{"id":"8214"}', 'id,customer_id,status,total,notes,photo']);
    await click(button('editor saves'));
    expect(one('[data-testid="row-editor"]')).toBeNull();
    expect(notice()).toContain('Row saved.');

    await click(one('thead input[type="checkbox"]', grid()));
    expect(container.textContent).toContain('3 selected');
    expect([tick(0).checked, tick(1).checked, tick(2).checked]).toEqual([true, true, true]);
    // Edit is for one row.
    expect(button('Edit')!.disabled).toBe(true);
    await click(one('thead input[type="checkbox"]', grid()));
    expect(container.textContent).not.toContain('selected');
  });

  it('draws its own tick boxes, for both themes', async () => {
    await mount();
    // The browser's own box is white on the dark theme: this one has a light and a dark look.
    for (const name of ['appearance-none', 'bg-white', 'dark:bg-slate-900', 'checked:bg-primary-600', 'dark:checked:bg-primary-500']) expect(tick(0).className, name).toContain(name);
  });

  it('deletes them together, after asking, with each row’s key and stamp', async () => {
    mocks.deleteMany.mockResolvedValue({ data: { saved: true, deleted: 2 } });
    await mount({ query: query({ offset: 25 }) });
    await click(tick(0));
    await click(tick(2));
    await click(button('Delete'));
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    const dialog = one('[role="dialog"]', document.body)!;
    expect(dialog.textContent).toContain('Delete 2 rows?');
    // After the delete the server counts two fewer.
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { total: 8212, matching: 8212 }));
    mocks.summary.mockResolvedValue(summary({ summary: { tables: [{ name: 'bookings', rows: 8212, columns: 6 }, { name: 'customers', rows: 1902, columns: 2 }, { name: 'payments', rows: 7948, columns: 2 }], bytes: 3250586, hiddenTables: 2 } }));
    const rowRequests = mocks.browse.mock.calls.length, listRequests = mocks.summary.mock.calls.length;
    await click(button('Delete 2 rows', dialog));
    expect(mocks.deleteMany).toHaveBeenCalledWith('app1', 'bookings', [{ key: { id: '8214' }, stamp: 's14' }, { key: { id: '8212' }, stamp: 's12' }]);
    expect(notice()).toContain('2 rows deleted.');
    // The same page of rows again, and the tables counted again: the rows a delete took with it in other tables too.
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(asked().offset).toBe(25);
    expect(mocks.summary.mock.calls.length).toBe(listRequests + 1);
    expect(container.textContent).not.toContain('selected');
    expect(pagerText()).toBe('Rows 26–28 of 8,212');
    expect(workspace().textContent).toContain('8,212 rows · 6 columns');
    expect(tableButton('payments').textContent).toBe('payments, 7,948 rows');
  });

  it('says what the server said when the rows changed, and shows the page as it is now', async () => {
    mocks.deleteMany.mockResolvedValue({ error: '1 row changed since this page loaded. Refresh and try again.', status: 409 });
    await mount();
    await click(tick(1));
    await click(button('Delete'));
    const rowRequests = mocks.browse.mock.calls.length;
    await click(button('Delete the row', one('[role="dialog"]', document.body)!));
    expect(mocks.deleteMany).toHaveBeenCalledWith('app1', 'bookings', [{ key: { id: '8213' }, stamp: 's13' }]);
    expect(one('[role="alert"]')!.textContent).toContain('1 row changed since this page loaded. Refresh and try again.');
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    // The row is still ticked, with the stamp of the page that just loaded.
    expect(tick(1).checked).toBe(true);
  });

  it('leaves a row without a key unticked: there is nothing to find it by', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { keys: [{ id: '8214' }, null, { id: '8212' }], stamps: ['s14', null, 's12'] }));
    await mount();
    expect(all('tbody input[type="checkbox"]', grid())).toHaveLength(2);
    await click(one('thead input[type="checkbox"]', grid()));
    expect(container.textContent).toContain('2 selected');
  });

  it('forgets the ticks on another page of rows, and keeps them when a row is opened', async () => {
    await mount();
    await click(tick(0));
    await click(button('8213: open row 8213'));
    expect(tick(0).checked).toBe(true);
    await click(button('Next page'));
    expect(container.textContent).not.toContain('selected');
    expect(tick(0).checked).toBe(false);
  });

  it('ticks rows whose key is two columns', async () => {
    mocks.deleteMany.mockResolvedValue({ data: { saved: true, deleted: 1 } });
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, {
      keys: [{ id: '8214', status: 'confirmed' }, { id: '8213', status: '' }, { id: '8212', status: 'paid' }],
      schema: { fields: bookingFields.map(each => each.name === 'status' ? { ...each, primary: true } : each), primaryKey: ['id', 'status'], canCreate: true },
    }));
    await mount();
    expect(tick(2).getAttribute('aria-label')).toBe('Select row 8212, paid');
    await click(tick(2));
    await click(button('Delete'));
    await click(button('Delete the row', one('[role="dialog"]', document.body)!));
    expect(mocks.deleteMany).toHaveBeenCalledWith('app1', 'bookings', [{ key: { id: '8212', status: 'paid' }, stamp: 's12' }]);
    // Either column of the key opens the row.
    await click(button('paid: open row 8212, paid'));
    expect(went().row).toEqual({ id: '8212', status: 'paid' });
    expect(details()!.getAttribute('aria-label')).toBe('Row id 8212 · status paid of bookings');
  });
});

describe('editing a cell in place', () => {
  it('reads the row, then saves the cell with the row’s revision, and stays on the same page', async () => {
    mocks.manage.mockResolvedValueOnce(record({ ...fullRow, notes: 'Window seat, by the door' })).mockResolvedValueOnce({ data: { saved: true } });
    await mount({ query: query({ offset: 25 }) });
    await doubleClick(cell(0, 'notes'));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8214' } });
    // The whole value, not the preview in the grid.
    expect(editorBox()!.value).toBe('Window seat, by the door');
    expect(editorBox()!.getAttribute('aria-label')).toBe('notes, row 8214');
    expect(document.activeElement).toBe(editorBox());
    await type(editorBox(), 'Quiet table');
    const rowRequests = mocks.browse.mock.calls.length;
    await press(editorBox(), 'Enter');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'update', key: { id: '8214' }, revision: 'rev-1', values: { notes: 'Quiet table' } });
    expect(editorBox()).toBeNull();
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(asked().offset).toBe(25);
    expect(pagerText()).toBe('Rows 26–28 of 8,214');
    // Nothing was asked of the page: the address is where it was.
    expect(navigations).toEqual([]);
    // The focus is back on the cell, for the arrow keys.
    expect(document.activeElement).toBe(cell(0, 'notes'));
  });

  it('starts from Enter on the cell that has the focus', async () => {
    await mount();
    cell(0, 'status').focus();
    await press(cell(0, 'status'), 'Enter');
    expect(mocks.manage).toHaveBeenCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8214' } });
    expect(editorBox()!.value).toBe('confirmed');
  });

  it('cancels on Escape and saves nothing', async () => {
    await mount();
    await doubleClick(cell(0, 'notes'));
    await type(editorBox(), 'Changed my mind');
    await press(editorBox(), 'Escape');
    expect(editorBox()).toBeNull();
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    expect(cell(0, 'notes').textContent).toBe('Window seat');
    expect(document.activeElement).toBe(cell(0, 'notes'));
  });

  it('shows the server’s sentence in the cell when it refuses, and keeps the text that was typed', async () => {
    mocks.manage.mockResolvedValueOnce(record(fullRow)).mockResolvedValueOnce({ error: 'total must be a number.', status: 400 }).mockResolvedValueOnce({ data: { saved: true } });
    await mount();
    await doubleClick(cell(0, 'total'));
    await type(editorBox(), 'twelve');
    const rowRequests = mocks.browse.mock.calls.length;
    await press(editorBox(), 'Enter');
    expect(one('[role="alert"]', cell(0, 'total'))!.textContent).toBe('total must be a number.');
    expect(editorBox()!.value).toBe('twelve');
    expect(editorBox()!.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.browse.mock.calls.length).toBe(rowRequests);
    // The text can be put right and sent again.
    await type(editorBox(), '12');
    await press(editorBox(), 'Enter');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'update', key: { id: '8214' }, revision: 'rev-1', values: { total: '12' } });
    expect(editorBox()).toBeNull();
  });

  it('shows the rows as they are now when the row changed under the edit', async () => {
    mocks.manage.mockResolvedValueOnce(record(fullRow)).mockResolvedValueOnce({ error: 'This record changed since you opened it. Close the editor and refresh before trying again.', status: 409 });
    await mount();
    await doubleClick(cell(0, 'notes'));
    await type(editorBox(), 'Mine');
    const rowRequests = mocks.browse.mock.calls.length;
    await press(editorBox(), 'Enter');
    expect(one('[role="alert"]', cell(0, 'notes'))!.textContent).toContain('This record changed since you opened it.');
    expect(editorBox()!.value).toBe('Mine');
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
  });

  it('gives a long or many-line text a taller box, where Shift+Enter starts a line and Enter saves', async () => {
    mocks.manage.mockResolvedValueOnce(record({ ...fullRow, notes: 'Line one\nLine two' })).mockResolvedValueOnce({ data: { saved: true } });
    await mount();
    await doubleClick(cell(0, 'notes'));
    expect(editorBox()!.tagName).toBe('TEXTAREA');
    expect(cell(0, 'notes').textContent).toContain('Shift+Enter starts a new line');
    await type(editorBox(), 'Line one\nLine two\nLine three');
    await press(editorBox(), 'Enter', { shiftKey: true });
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    await press(editorBox(), 'Enter');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', expect.objectContaining({ action: 'update', values: { notes: 'Line one\nLine two\nLine three' } }));
  });

  it('does not save an empty box on a column that may hold no value without asking which is meant', async () => {
    await mount();
    await doubleClick(cell(0, 'notes'));
    await type(editorBox(), '');
    await press(editorBox(), 'Enter');
    // Nothing is saved yet: an empty text and NULL are different values.
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    const choice = one('[role="group"][aria-label="The box is empty"]', cell(0, 'notes'))!;
    expect(choice.textContent).toBe('The box is empty. Savean empty textorNULL');
    await click(button('an empty text', choice));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', expect.objectContaining({ action: 'update', values: { notes: '' } }));

    await doubleClick(cell(0, 'status'));
    await type(editorBox(), '');
    await press(editorBox(), 'Enter');
    await click(button('NULL', one('[role="group"]', cell(0, 'status'))!));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', expect.objectContaining({ action: 'update', values: { status: null } }));
  });

  it('offers Set to NULL on a column that may hold no value, and not on one that may not', async () => {
    await mount();
    await doubleClick(cell(0, 'notes'));
    await click(button('Set to NULL', cell(0, 'notes')));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'update', key: { id: '8214' }, revision: 'rev-1', values: { notes: null } });

    await visit({ table: 'customers' });
    await doubleClick(cell(0, 'name'));
    expect(editorBox()!.value).toBe('Ada');
    expect(button('Set to NULL', cell(0, 'name'))).toBeUndefined();
    // Emptied, a column that must hold a value is sent the empty text: the database's rules answer.
    await type(editorBox(), '');
    await press(editorBox(), 'Enter');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', expect.objectContaining({ table: 'customers', action: 'update', values: { name: '' } }));
  });

  it('saves nothing when the value is as it was, and empties a number to no value', async () => {
    mocks.manage.mockResolvedValueOnce(record({ ...fullRow, notes: null })).mockResolvedValueOnce(record(fullRow)).mockResolvedValueOnce({ data: { saved: true } });
    await mount();
    // A NULL opens as an empty box that says so; choosing NULL for it changes nothing.
    await doubleClick(cell(1, 'notes'));
    expect(editorBox()!.value).toBe('');
    expect(editorBox()!.placeholder).toBe('NULL');
    await press(editorBox(), 'Enter');
    await click(button('NULL', one('[role="group"]', cell(1, 'notes'))!));
    expect(editorBox()).toBeNull();
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    // A number column holds no empty text: cleared, it holds no value.
    await doubleClick(cell(0, 'total'));
    await type(editorBox(), '');
    await press(editorBox(), 'Enter');
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', expect.objectContaining({ action: 'update', values: { total: null } }));
  });

  it('does not offer a key, a column the database works out, or a binary value', async () => {
    await mount();
    for (const name of ['id', 'photo']) {
      expect(cell(0, name).getAttribute('aria-readonly'), name).toBe('true');
      await doubleClick(cell(0, name));
    }
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(editorBox()).toBeNull();
    // The reason is said in the cell that was pressed, and only there.
    expect(one('[role="alert"]', cell(0, 'photo'))!.textContent).toContain('photo cannot be changed here');
    await doubleClick(cell(0, 'id'));
    expect(all('[role="alert"]').map(node => node.textContent)).toEqual(['A row’s key cannot be changed.']);
    expect(one('[role="alert"]', cell(0, 'id'))).toBeTruthy();

    // A binary value in a column that is not declared so: the row itself says it cannot be edited.
    mocks.manage.mockResolvedValueOnce(record({ id: '8213', customer_id: '1865', status: '', total: '118.5' }, bookingFields.map(each => each.name === 'notes' ? { ...each, readOnly: true } : each)));
    await doubleClick(cell(1, 'notes'));
    expect(editorBox()).toBeNull();
    expect(one('[role="alert"]', cell(1, 'notes'))!.textContent).toContain('notes cannot be changed here');
    expect(mocks.manage).toHaveBeenCalledTimes(1);
    // It goes when the page of rows is loaded again.
    await click(button('Next page'));
    expect(one('[role="alert"]')).toBeNull();
  });

  it('says in the cell when the row could not be read', async () => {
    mocks.manage.mockResolvedValueOnce({ error: 'This record no longer exists. Refresh the records.', status: 409 });
    await mount();
    await doubleClick(cell(2, 'status'));
    expect(editorBox()).toBeNull();
    expect(one('[role="alert"]', cell(2, 'status'))!.textContent).toBe('This record no longer exists. Refresh the records.');
    // Trying again opens it.
    await doubleClick(cell(2, 'status'));
    expect(editorBox()!.value).toBe('paid');
    expect(one('[role="alert"]')).toBeNull();
  });

  it('closes an untouched box when the focus leaves it, and keeps one that holds new text', async () => {
    await mount();
    await doubleClick(cell(0, 'notes'));
    await act(async () => editorBox()!.blur());
    expect(editorBox()).toBeNull();

    await doubleClick(cell(0, 'notes'));
    await type(editorBox(), 'Not saved yet');
    await act(async () => editorBox()!.blur());
    expect(editorBox()!.value).toBe('Not saved yet');
    // Another cell is not opened over it: the text would be lost.
    await doubleClick(cell(0, 'status'));
    expect(all('[data-cell-editor]')).toHaveLength(1);
    expect(document.activeElement).toBe(editorBox());
  });
});

describe('the pager', () => {
  it('steps through the pages, and to the first and the last, each a step in the history', async () => {
    await mount();
    expect(button('First page')!.disabled).toBe(true);
    expect(button('Previous page')!.disabled).toBe(true);
    await click(button('Next page'));
    expect(asked().offset).toBe(25);
    expect(navigations).toEqual([{ table: 'bookings', view: 'browse', query: 'offset=25', replace: false }]);
    expect(pagerText()).toBe('Rows 26–28 of 8,214');
    expect(container.textContent).toContain('2 / 329');
    await click(button('Last page'));
    expect(asked().offset).toBe(8200);
    await click(button('Previous page'));
    expect(asked().offset).toBe(8175);
    await click(button('First page'));
    expect(asked().offset).toBe(0);
    expect(navigations.at(-1)).toEqual({ table: 'bookings', view: 'browse', query: '', replace: false });
  });

  it('remembers the rows-per-page choice in this browser', async () => {
    await mount({ query: query({ offset: 75 }) });
    expect(all('select[aria-label="Rows per page"] option').map(node => node.textContent)).toEqual(['25', '50', '100', '250']);
    expect(asked()).toMatchObject({ offset: 75, limit: 25 });
    await choose(one('select[aria-label="Rows per page"]'), '50');
    // The page that holds the row the person was on, put right in the address without a step in the history.
    expect(asked()).toMatchObject({ offset: 50, limit: 50 });
    expect(navigations).toEqual([{ table: 'bookings', view: 'browse', query: 'offset=50', replace: true }]);
    expect(window.localStorage.getItem('formlogic.data.rowsPerPage')).toBe('50');

    await remount();
    expect(asked()).toMatchObject({ offset: 0, limit: 50 });
    expect(one<HTMLSelectElement>('select[aria-label="Rows per page"]')!.value).toBe('50');
  });

  it('works where storage is refused', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await mount();
    expect(asked().limit).toBe(25);
    await choose(one('select[aria-label="Rows per page"]'), '100');
    expect(asked().limit).toBe(100);
  });

  it('follows the offset the server used and stops where its window ends', async () => {
    // A request past the window is answered from the window's last page.
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, (asking.offset ?? 0) >= 100000
      ? { offset: 100000, end: 'limit', hasMore: false, total: 250000, matching: 250000 } : { total: 250000, matching: 250000 }));
    await mount();
    expect(container.textContent).toContain('1 / 4,001');
    await click(button('Last page'));
    expect(asked().offset).toBe(100000);
    expect(pagerText()).toBe('Rows 100,001–100,003 of 250,000');
    expect(container.textContent).toContain('4,001 / 4,001');
    expect(button('Next page')!.disabled).toBe(true);
    expect(button('Last page')!.disabled).toBe(true);
    expect(container.textContent).toContain('Paging reaches the first 100,025 rows.');
    await click(button('Previous page'));
    expect(asked().offset).toBe(99975);
  });

  it('goes back to the last page that has rows when the page asked for has none, never showing an empty table', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, (asking.offset ?? 0) >= 50
      ? { rows: [], keys: [], stamps: [], cut: {}, total: 28, matching: 28, end: 'end', hasMore: false } : { total: 28, matching: 28, end: (asking.offset ?? 0) === 0 ? 'more' : 'end' }));
    await mount({ table: 'bookings', query: query({ offset: 75 }) });
    // The address is put right in place: Back does not return to the empty page.
    expect(navigations).toEqual([{ table: 'bookings', view: 'browse', query: 'offset=25', replace: true }]);
    expect(asked().offset).toBe(25);
    expect(pagerText()).toBe('Rows 26–28 of 28');
    expect(container.textContent).not.toContain('No rows');
  });

  it('pages without a count from a server that sends none', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { total: undefined, matching: undefined, end: undefined, hasMore: true, stamps: undefined }));
    await mount();
    expect(pagerText()).toBe('Rows 1–3');
    expect(container.textContent).toContain('Page 1');
    expect(button('Next page')!.disabled).toBe(false);
    expect(button('Last page')!.disabled).toBe(true);
  });
});

describe('the structure view', () => {
  it('lists the columns, the indexes and the tables that point here, and says the shape is not changed here', async () => {
    await mount();
    await click(tab('Structure'));
    expect(navigations).toEqual([{ table: 'bookings', view: 'structure', query: '', replace: false }]);
    const panel = one('[role="tabpanel"]')!;
    const rows = all('tbody tr', panel).map(row => all('td, th', row).map(node => node.textContent));
    expect(all('thead th', panel).map(th => th.textContent)).toEqual(['#', 'Column', 'Type', 'May be empty', 'Default', 'Key', 'Links to']);
    expect(rows).toEqual([
      // A column of the primary key is never empty, though SQLite does not report it NOT NULL.
      ['1', 'id', 'INTEGER', 'no', 'next number', 'Primary', ''],
      ['2', 'customer_id', 'INTEGER', 'no', '', 'Index', 'customers.id · on delete: cascade'],
      ['3', 'status', 'TEXT', 'no', "'new'", 'Unique (1)', ''],
      ['4', 'total', 'REAL', 'no', '0', 'Unique (2)', ''],
      ['5', 'notes', 'TEXT', 'yes', 'NULL', '', ''],
      ['6', 'photo', 'BLOB', 'yes', 'NULL', '', ''],
      // A secret column is named, and its values are never shown.
      ['7', 'manage_token · values never shown', 'TEXT', 'no', '', '', ''],
    ]);
    const indexes = one('section[aria-label="Indexes"]', panel)!;
    expect(all('p', indexes).map(node => node.textContent)).toEqual(['PRIMARY (id)', 'idx_bookings_customer (customer_id)', 'uq_bookings_slot (status, total) · unique']);
    const usedBy = one('section[aria-label="Used by"]', panel)!;
    expect(usedBy.textContent).toContain('payments.booking_id · 7,950 rows');
    expect(usedBy.textContent).toContain('The shape is read-only here: tables and columns change through the app’s own migrations.');

    await click(button('payments.booking_id: open payments', usedBy));
    expect(navigations.at(-1)).toEqual({ table: 'payments', view: 'browse', query: '', replace: false });
  });

  it('is fetched once for a table, whichever view asks first', async () => {
    await mount();
    await click(tab('Structure'));
    await click(tab('Browse'));
    await click(tableButton('customers'));
    await click(tableButton('bookings'));
    await click(tab('Structure'));
    expect(mocks.structure.mock.calls.map(call => call[1])).toEqual(['bookings', 'customers']);
    expect(one('[role="tabpanel"]')!.textContent).toContain('manage_token');
  });

  it('follows a column’s link to the table it points at', async () => {
    await mount({ view: 'structure' });
    await click(button('customers.id: open customers'));
    expect(navigations).toEqual([{ table: 'customers', view: 'browse', query: '', replace: false }]);
  });

  it('says when it could not be loaded, and tries again', async () => {
    mocks.structure.mockResolvedValueOnce({ error: 'The database is busy. Please try again.', status: 409 });
    await mount({ view: 'structure' });
    expect(one('[role="tabpanel"]')!.textContent).toContain('The database is busy. Please try again.');
    await click(button('Try again'));
    expect(one('[role="tabpanel"]')!.textContent).toContain('manage_token');
  });
});

describe('the export view', () => {
  const download = () => all<HTMLAnchorElement>('[role="tabpanel"] a').find(node => node.textContent === 'Download')!;
  const option = (text: string) => all<HTMLLabelElement>('[role="tabpanel"] label').find(node => node.textContent?.startsWith(text))!;

  it('downloads the table from the export address, as CSV or JSON', async () => {
    await mount({ view: 'export', readOnly: true });
    expect(option('This table').textContent).toBe('This table, all 8,214 rows');
    expect(download().getAttribute('href')).toBe('/api/apps/app1/native/records?table=bookings&export=csv');
    expect(download().getAttribute('download')).toBe('booking-bookings.csv');
    await click(one('input', option('JSON')));
    expect(download().getAttribute('href')).toBe('/api/apps/app1/native/records?table=bookings&export=json');
    expect(one('[role="tabpanel"]')!.textContent).toContain('Secret columns and binary values are left out of every export.');
    // Nothing is asked of the server until the link is followed.
    expect(mocks.browse).not.toHaveBeenCalled();
  });

  it('exports every table as JSON', async () => {
    await mount({ view: 'export' });
    await click(one('input', option('Every table')));
    expect(option('Every table').textContent).toBe('Every table (3), as JSON');
    expect(download().getAttribute('href')).toBe('/api/apps/app1/native/records?table=*&export=json');
    expect(one<HTMLInputElement>('input', option('CSV'))!.disabled).toBe(true);
    expect(one<HTMLInputElement>('input', option('JSON'))!.checked).toBe(true);
  });

  it('offers the rows matching the search and filters the address holds, in its order', async () => {
    await mount({ view: 'export' });
    expect(option('The 1,204 rows')).toBeUndefined();
    await visit({ table: 'bookings', view: 'export', query: query({ q: 'nuts', filters: [{ column: 'status', op: 'contains', value: 'paid' }], sort: { column: 'status', dir: 'asc' }, offset: 50, row: { id: '8214' } }) });
    expect(option('The 1,204 rows').textContent).toBe('The 1,204 rows matching the search and filters');
    await click(one('input', option('The 1,204 rows')));
    // The page and the open row are no part of an export.
    expect(Object.fromEntries(new URL(download().href).searchParams)).toEqual({ table: 'bookings', export: 'csv', sort: 'status', dir: 'asc', q: 'nuts', filter: '[{"column":"status","op":"contains","value":"paid"}]' });
    // Back in Browse the search and the filter are as the address has them.
    await click(tab('Browse'));
    expect(button('Remove the filter: status contains paid')).toBeTruthy();
    expect(one<HTMLInputElement>('input[aria-label="Search this table"]')!.value).toBe('nuts');
  });

  it('says when a table holds more rows than one file takes', async () => {
    mocks.summary.mockResolvedValue(summary({ summary: { tables: [{ name: 'bookings', rows: 250000, columns: 6 }], bytes: 1, hiddenTables: 0 }, tables: ['bookings'] }));
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { total: 250000, matching: 250000 }));
    await mount({ view: 'export' });
    expect(one('[role="tabpanel"]')!.textContent).toContain('A file holds the first 100,000 rows of a table.');
  });
});

describe('adding a row', () => {
  it('opens the full editor on a new row, then shows the page again and counts the tables again', async () => {
    await mount();
    await click(button('Add row'));
    const editor = one('[data-testid="row-editor"]')!;
    expect([editor.dataset.table, editor.dataset.key]).toEqual(['bookings', 'new']);
    const rowRequests = mocks.browse.mock.calls.length, listRequests = mocks.summary.mock.calls.length;
    await click(button('editor saves'));
    expect(notice()).toContain('Row added.');
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(mocks.summary.mock.calls.length).toBe(listRequests + 1);
  });

  it('is the same in every view: offered where rows can be made here, and the reason given where they cannot', async () => {
    for (const view of ['browse', 'structure', 'export'] as const) {
      await remount({ view });
      expect(button('Add row'), view).toBeTruthy();
    }
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { schema: { fields: bookingFields, primaryKey: ['id'], canCreate: false } }));
    for (const view of ['browse', 'structure', 'export'] as const) {
      await remount({ view });
      expect(button('Add row'), view).toBeUndefined();
      expect(workspace().textContent, view).toContain('Add rows in the app: a required column here is secret or binary.');
    }
  });

  it('opens the row editor from Structure too, with the table’s columns', async () => {
    await mount({ view: 'structure' });
    // The table was asked once what it holds, though its rows are not showing.
    expect(mocks.browse).toHaveBeenCalledTimes(1);
    await click(button('Add row'));
    expect(one('[data-testid="row-editor"]')!.dataset.fields).toBe('id,customer_id,status,total,notes,photo');
    await click(tab('Export'));
    expect(mocks.browse).toHaveBeenCalledTimes(1);
  });
});

describe('read-only', () => {
  const expectReadOnly = async () => {
    expect(one('section[aria-label="Table bookings"]')!.textContent).toContain('Read-only');
    expect(all('input[type="checkbox"]', grid())).toHaveLength(0);
    expect(button('Add row')).toBeUndefined();
    expect(grid().getAttribute('aria-readonly')).toBe('true');
    await doubleClick(cell(0, 'notes'));
    cell(0, 'notes').focus();
    await press(cell(0, 'notes'), 'Enter');
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Double-click a cell to edit');
    // The rows are still there to read, sort, search and open.
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(one('input[aria-label="Search this table"]')).toBeTruthy();
    expect(button('8214: open row 8214')).toBeTruthy();
  };

  it('offers no ticks, no editing and no Add row when the page says so', async () => {
    await mount({ readOnly: true });
    await expectReadOnly();
  });

  it('does the same when it is the server that says so', async () => {
    mocks.summary.mockResolvedValue(summary({ readOnly: true }));
    await mount();
    await expectReadOnly();
  });

  it('and when only the page of rows says so', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { readOnly: true }));
    await mount();
    await expectReadOnly();
  });
});

describe('on a phone', () => {
  beforeEach(phone);

  it('shows each row as a card: its key as the title, the next columns as name and value, the rest behind a toggle', async () => {
    await mount();
    expect(one('table[role="grid"]')).toBeNull();
    expect(cards()).toHaveLength(3);
    expect(one('h3', cards()[0])!.textContent).toBe('id8214');
    expect(all('dt', cards()[0]).map(node => node.textContent)).toEqual(['customer_id', 'status', 'total', 'notes']);
    expect(cards()[0].textContent).not.toContain('photo');
    const more = button('Show all 6 columns', cards()[0])!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await click(more);
    expect(all('dt', cards()[0]).map(node => node.textContent)).toEqual(['customer_id', 'status', 'total', 'notes', 'photo']);
    expect(button('Show fewer columns', cards()[0])!.getAttribute('aria-expanded')).toBe('true');
    // The other cards stay as they were.
    expect(all('dt', cards()[1])).toHaveLength(4);
  });

  it('shows every value by the same rules as the grid', async () => {
    await mount();
    expect(one('dd', cardLine(1, 'notes'))!.dataset.kind).toBe('null');
    expect(one('dd', cardLine(1, 'notes'))!.textContent).toBe('NULL');
    expect(one('dd', cardLine(1, 'status'))!.dataset.kind).toBe('empty');
    expect(one('dd', cardLine(1, 'status'))!.textContent).toBe('empty');
    expect(one('dd', cardLine(2, 'notes'))!.dataset.kind).toBe('cut');
    expect(one('dd', cardLine(2, 'notes'))!.textContent).toBe(`${LONG}… (the text is longer than the part shown)`);
    await click(button('Show all 6 columns', cards()[1]));
    expect(one('dd', cardLine(1, 'photo'))!.dataset.kind).toBe('binary');
    expect(one('dd', cardLine(1, 'total'))!.textContent).toBe('118.5');
    // A foreign key is a link to the row it points at; a NULL one is not.
    await click(button('1865: open customers where id is 1865', cards()[1]));
    expect(went()).toMatchObject({ table: 'customers', filters: [{ column: 'id', op: 'eq', value: '1865' }], row: { id: '1865' } });
  });

  it('sorts from a select and a direction button, with the same request as a header press', async () => {
    await mount();
    const sortBy = one<HTMLSelectElement>('select[aria-label="Sort by"]')!;
    expect(all('option', sortBy).map(node => node.textContent)).toEqual(['its own order', 'id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    expect(button('Smallest first. Change to largest first.')!.disabled).toBe(true);
    await choose(sortBy, 'status');
    expect(asked()).toEqual({ offset: 0, limit: 25, sort: { column: 'status', dir: 'asc' }, q: '', filters: [] });
    expect(navigations.at(-1)).toEqual({ table: 'bookings', view: 'browse', query: 'sort=status', replace: false });
    await click(button('Smallest first. Change to largest first.'));
    expect(asked().sort).toEqual({ column: 'status', dir: 'desc' });
    expect(navigations.at(-1)!.query).toBe('sort=status&dir=desc');
    // The button now says what it shows and what pressing it does.
    expect(button('Largest first. Change to smallest first.')!.disabled).toBe(false);
    await choose(sortBy, '');
    expect(asked().sort).toBeNull();
    expect(navigations.at(-1)!.query).toBe('');
  });

  it('edits a value from its card: read, then update, in a box with Save and Cancel', async () => {
    mocks.manage.mockResolvedValueOnce(record({ ...fullRow, notes: 'Window seat, by the door' })).mockResolvedValueOnce({ data: { saved: true } });
    await mount({ query: query({ offset: 25 }) });
    // A card comes as a summary; opened out, each value has its Edit.
    await click(button('Show all 6 columns', cards()[0]));
    await click(button('Edit notes of row 8214'));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'read', key: { id: '8214' } });
    const box = editorBox(cards()[0])!;
    expect(box.value).toBe('Window seat, by the door');
    expect(box.getAttribute('aria-label')).toBe('notes, row 8214');
    expect(button('Save', cards()[0])).toBeTruthy();
    expect(button('Cancel', cards()[0])).toBeTruthy();
    await type(box, 'Quiet table');
    const rowRequests = mocks.browse.mock.calls.length;
    await click(button('Save', cards()[0]));
    expect(mocks.manage).toHaveBeenLastCalledWith('app1', { table: 'bookings', action: 'update', key: { id: '8214' }, revision: 'rev-1', values: { notes: 'Quiet table' } });
    expect(editorBox()).toBeNull();
    expect(mocks.browse.mock.calls.length).toBe(rowRequests + 1);
    expect(asked().offset).toBe(25);
    // The focus is back on the button the edit began from.
    expect(document.activeElement).toBe(button('Edit notes of row 8214'));
  });

  it('cancels from the card, keeps the text when the server refuses, and asks about an empty box', async () => {
    mocks.manage.mockResolvedValueOnce(record(fullRow)).mockResolvedValueOnce(record(fullRow)).mockResolvedValueOnce({ error: 'The database rejected this change. Check required fields, unique values, references, and table rules.', status: 422 });
    await mount();
    await click(button('Show all 6 columns', cards()[0]));
    await click(button('Edit status of row 8214'));
    await type(editorBox(), 'Changed my mind');
    await click(button('Cancel', cards()[0]));
    expect(editorBox()).toBeNull();
    expect(mocks.manage).toHaveBeenCalledTimes(1);

    await click(button('Edit status of row 8214'));
    await type(editorBox(), 'seated');
    await click(button('Save', cards()[0]));
    expect(one('[role="alert"]', cards()[0])!.textContent).toContain('The database rejected this change.');
    expect(editorBox()!.value).toBe('seated');
    await type(editorBox(), '');
    await click(button('Save', cards()[0]));
    expect(mocks.manage).toHaveBeenCalledTimes(3);
    expect(one('[role="group"][aria-label="The box is empty"]', cards()[0])).toBeTruthy();
    expect(button('Set to NULL', cards()[0])).toBeTruthy();
  });

  it('says on the card why a value did not open, and keeps one edit open at a time', async () => {
    mocks.manage.mockResolvedValueOnce({ error: 'The database is busy. Please try again.', status: 409 });
    await mount();
    await click(button('Show all 6 columns', cards()[0]));
    await click(button('Show all 6 columns', cards()[1]));
    await click(button('Edit status of row 8213'));
    expect(one('[role="alert"]', cardLine(1, 'status'))!.textContent).toBe('The database is busy. Please try again.');
    expect(editorBox()).toBeNull();

    await click(button('Edit status of row 8214'));
    await type(editorBox(), 'seated');
    // Another value's Edit goes back to the one that is open: its text is not lost.
    await click(button('Edit total of row 8214'));
    expect(all('[data-cell-editor]')).toHaveLength(1);
    expect(editorBox()!.value).toBe('seated');
    expect(document.activeElement).toBe(editorBox());
  });

  it('says in the bar of ticked rows why they were not deleted', async () => {
    mocks.deleteMany.mockResolvedValue({ error: '1 row changed since this page loaded. Refresh and try again.', status: 409 });
    await mount();
    await click(one('input[aria-label="Select row 8213"]'));
    await click(button('Delete', one('[role="group"][aria-label="Ticked rows"]', document.body)!));
    await click(button('Delete the row', one('[role="dialog"]', document.body)!));
    const bar = one('[role="group"][aria-label="Ticked rows"]', document.body)!;
    expect(one('[role="alert"]', bar)!.textContent).toBe('1 row changed since this page loaded. Refresh and try again.');
    expect(bar.textContent).toContain('1 selected');
  });

  it('offers no Edit for a key or a binary value, and none at all in read-only mode', async () => {
    await mount();
    await click(button('Show all 6 columns', cards()[0]));
    expect(all('button[data-edit]', cards()[0]).map(node => node.getAttribute('aria-label'))).toEqual(['Edit customer_id of row 8214', 'Edit status of row 8214', 'Edit total of row 8214', 'Edit notes of row 8214']);
    await remount({ readOnly: true });
    expect(all('button[data-edit]')).toHaveLength(0);
    expect(all('input[type="checkbox"]')).toHaveLength(0);
    expect(cards()).toHaveLength(3);
  });

  it('ticks cards, all of the page at once, and deletes them with the same request', async () => {
    mocks.deleteMany.mockResolvedValue({ data: { saved: true, deleted: 2 } });
    await mount();
    const boxes = () => all<HTMLInputElement>('input[type="checkbox"]', one('ul[aria-label^="Rows of"]')!);
    expect(boxes().map(node => node.getAttribute('aria-label'))).toEqual(['Select row 8214', 'Select row 8213', 'Select row 8212']);
    // Each tick sits in a finger-sized target.
    expect(boxes()[0].closest('label')!.className).toContain('h-11 w-11');
    await click(boxes()[0]);
    await click(boxes()[2]);
    // The ticked rows' buttons stay in reach over the page, above its bottom navigation.
    const bar = one('[role="group"][aria-label="Ticked rows"]', document.body)!;
    expect(container.contains(bar)).toBe(false);
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('bottom-[calc(var(--fl-mobile-nav-h,0px)+0.5rem)]');
    expect(bar.textContent).toContain('2 selected');
    await click(button('Delete', bar));
    await click(button('Delete 2 rows', one('[role="dialog"]', document.body)!));
    expect(mocks.deleteMany).toHaveBeenCalledWith('app1', 'bookings', [{ key: { id: '8214' }, stamp: 's14' }, { key: { id: '8212' }, stamp: 's12' }]);
    expect(one('[role="group"][aria-label="Ticked rows"]', document.body)).toBeNull();

    await click(one('input[aria-label="Select every row on this page"]'));
    expect(one('[role="group"][aria-label="Ticked rows"]', document.body)!.textContent).toContain('3 selected');
    await click(button('Untick every row'));
    expect(boxes().some(node => node.checked)).toBe(false);
  });

  it('opens a row from its card’s title, as a sheet over the page with Back', async () => {
    await mount();
    await click(button('Open row 8212'));
    expect(went().row).toEqual({ id: '8212' });
    const sheet = details()!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(detail('notes').textContent).toBe(`${LONG} And the rest of it.`);
    await click(button('Back', sheet));
    expect(details()).toBeNull();
  });

  it('shows each column of the structure as a small card', async () => {
    await mount({ view: 'structure' });
    const panel = one('[role="tabpanel"]')!;
    expect(one('table', panel)).toBeNull();
    const columns = all('ul[aria-label="Columns of bookings"] > li', panel);
    expect(columns).toHaveLength(7);
    expect(columns[0].textContent).toBe('1idINTEGERMay be emptynoDefaultnext numberKeyPrimary');
    expect(columns[1].textContent).toBe('2customer_idINTEGERMay be emptynoKeyIndexLinks tocustomers.id · on delete: cascade');
    expect(columns[4].textContent).toBe('5notesTEXTMay be emptyyesDefaultNULL');
    expect(columns[6].textContent).toContain('Values never shown.');
    expect(one('section[aria-label="Indexes"]', panel)).toBeTruthy();
    expect(one('section[aria-label="Used by"]', panel)).toBeTruthy();
  });

  it('says how to edit there, and keeps the pager and the search', async () => {
    await mount();
    expect(container.textContent).toContain('Open a row out to edit its values');
    // The summary has nothing to edit; the card opened out has an Edit beside each value it may change.
    expect(all('button[data-edit]')).toHaveLength(0);
    expect(all('dl', cards()[0])[0].className).toContain('grid-cols-2');
    expect(container.textContent).not.toContain('Double-click');
    expect(pagerText()).toBe('Rows 1–3 of 8,214');
    await click(button('Next page'));
    expect(asked().offset).toBe(25);
    expect(one('input[aria-label="Search this table"]')).toBeTruthy();
    expect(button('Add filter')).toBeTruthy();
  });

  it('titles a card by its first column when the table has no key, and offers nothing to press on it', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { keys: [], stamps: [], schema: { fields: bookingFields.map(each => ({ ...each, primary: false })), primaryKey: [], canCreate: true } }));
    await mount();
    expect(one('h3', cards()[0])!.textContent).toBe('id8214');
    expect(all('button', cards()[0]).map(node => node.getAttribute('aria-label'))).toEqual(['Show all 6 columns', '1902: open customers where id is 1902']);
    expect(container.textContent).toContain('This table has no primary key');
  });
});

describe('what there is to show', () => {
  it('says an app with no database keeps its data in each person’s browser', async () => {
    mocks.summary.mockResolvedValue({ data: { installed: true, tables: [], backend: false } });
    await mount();
    expect(container.textContent).toContain('This app keeps its data in each person’s browser');
    expect(mocks.browse).not.toHaveBeenCalled();
    expect(one('nav[aria-label="Tables"]')).toBeNull();
  });

  it('says when the app has no tables yet, or nothing installed', async () => {
    mocks.summary.mockResolvedValue({ data: { installed: true, tables: [], summary: { tables: [], bytes: 4096, hiddenTables: 1 } } });
    await mount();
    expect(container.textContent).toContain('No tables yet');
    expect(container.textContent).toContain('1 system table is not shown.');
    mocks.summary.mockResolvedValue({ data: { installed: false, tables: [] } });
    await remount();
    expect(container.textContent).toContain('This app has no version installed yet');
  });

  it('says a table has no rows yet', async () => {
    mocks.browse.mockImplementation(async (_app: string, _table: string, asking: NativeBrowseQuery) => bookings(asking, { rows: [], keys: [], stamps: [], cut: {}, total: 0, matching: 0, end: 'end', hasMore: false }));
    await mount();
    expect(container.textContent).toContain('No rows in this table yet. Add row puts the first one in.');
    // The columns are still there to read.
    expect(all('thead th', grid()).map(th => th.textContent)).toEqual(['id', 'customer_id', 'status', 'total', 'notes', 'photo']);
    expect(pagerText()).toBe('No rows');
  });

  it('says when the tables could not be loaded, and tries again', async () => {
    mocks.summary.mockResolvedValueOnce({ error: 'Too many requests. Please try again later.', status: 429 });
    await mount();
    expect(container.textContent).toContain('Too many requests. Please try again later.');
    await click(button('Try again'));
    expect(tableButton('bookings')).toBeTruthy();
  });

  it('says when the rows could not be loaded, never showing the page before as if it were current, and tries again', async () => {
    await mount();
    mocks.browse.mockResolvedValueOnce({ error: 'The database is busy. Please try again.', status: 409 });
    await click(button('Next page'));
    expect(container.textContent).toContain('The database is busy. Please try again.');
    expect(one('table[role="grid"]')).toBeNull();
    await click(button('Try again'));
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(asked().offset).toBe(25);
  });

  it('keeps the rows it has, dimmed, while the next page is on its way', async () => {
    await mount();
    let answer!: (value: { data: NativeBrowse }) => void;
    mocks.browse.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await click(button('Next page'));
    expect(all('tbody tr', grid())).toHaveLength(3);
    expect(grid().getAttribute('aria-busy')).toBe('true');
    expect(grid().className).toContain('opacity-60');
    expect(button('Next page')!.disabled).toBe(true);
    await act(async () => answer(bookings({ offset: 25, limit: 25 })));
    expect(grid().hasAttribute('aria-busy')).toBe(false);
    expect(pagerText()).toBe('Rows 26–28 of 8,214');
  });

  it('drops an answer that comes after another table was opened', async () => {
    await mount();
    let late!: (value: { data: NativeBrowse }) => void;
    mocks.browse.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    await click(button('Next page'));
    await click(tableButton('customers'));
    await act(async () => late(bookings({ offset: 25, limit: 25 })));
    expect(one('section[aria-label="Table customers"]')).toBeTruthy();
    expect(all('thead th', grid()).map(th => th.textContent)).toEqual(['', 'id', 'name']);
    expect(pagerText()).toBe('Rows 1–2 of 2');
  });

  it('fills the height the page gives it on a wide screen, and scrolls inside itself', async () => {
    await mount();
    const outer = container.firstElementChild as HTMLElement;
    for (const name of ['lg:h-full', 'lg:min-h-0', 'lg:flex-row']) expect(outer.className, name).toContain(name);
    // No height of its own making: the page's box is the measure.
    expect(container.innerHTML).not.toMatch(/100dvh|max-h-\[/);
    expect(one('nav[aria-label="Tables"] ul')!.className).toContain('overflow-y-auto');
    expect(one('nav[aria-label="Tables"] ul')!.className).toContain('pb-12');
    expect(grid().parentElement!.className).toContain('lg:overflow-y-auto');
    // The pager keeps clear of the page's floating button in the bottom right corner.
    expect(one('[aria-live="polite"]')!.parentElement!.className).toContain('lg:pr-20');
  });
});
