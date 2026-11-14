// @vitest-environment jsdom
/**
 * The API section of an app's page: the live app's routes as a table (what each runs, who may call
 * it, what it does to the data) and its database changes; Try it, which checks a query and a body
 * before it sends them as the owner to the live app, asks first before a route that can change the
 * data, and shows the status, the time and the answer; and the latest calls, asked for again every
 * ten seconds while the tab is in view. Each state is told apart: a backend not live yet, unpublished
 * changes, no calls yet, a read that failed, a refresh that failed, the shared demo.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeCall, NativeCallList } from '../../lib/appApi';
import type { App } from '../../types/app';

const mocks = vi.hoisted(() => ({ runNativeRequest: vi.fn(), getNativeCalls: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
const { SoftnApi, CALLS_EVERY_SECONDS } = await import('./SoftnApi');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const app = { id: 'app-1', name: 'Task board', slug: 'tasks', status: 'published', ownerId: 'u1' } as App;

const MANIFEST = JSON.stringify({
  name: 'Task board', main: 'index.html',
  server: {
    entry: 'server/main.logic',
    database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'] },
    routes: [
      { path: '/api/items', method: 'GET', handler: 'listItems', transaction: 'read', authorization: 'anonymous' },
      { path: '/api/items', method: 'POST', handler: 'createItem', transaction: 'write', authorization: 'anonymous' },
      { path: '/api/backup', method: 'GET', handler: 'backup', authorization: 'host-token' },
    ],
  },
});
const call = (id: number, over: Partial<NativeCall> = {}): NativeCall => ({ id, at: new Date(Date.now() - 5_000).toISOString(), method: 'GET', path: '/api/items', status: 200, ms: 14, error: null, caller: 'owner', ...over });
const listOf = (calls: NativeCall[], over: Partial<NativeCallList> = {}): NativeCallList => ({ calls, limit: 50, keep: { calls: 500, days: 14 }, ...over });

async function mount(props: Partial<{ manifest: string | undefined; access: 'members' | 'application'; dirty: boolean; readOnly: boolean }> = {}) {
  const all = { manifest: MANIFEST, access: 'application' as const, dirty: false, readOnly: false, ...props };
  await act(async () => root.render(<SoftnApi app={app} access={all.access} manifest={all.manifest} version={4} dirty={all.dirty} readOnly={all.readOnly} />));
  await act(async () => {});
}
const panel = (title: string) => [...container.querySelectorAll('section')].find(node => node.querySelector('h2')?.textContent === title) as HTMLElement | undefined;
const button = (text: RegExp, within: ParentNode = document.body) => [...within.querySelectorAll('button')].find(node => text.test(node.textContent ?? '') || text.test(node.getAttribute('aria-label') ?? '')) as HTMLButtonElement | undefined;
const dialog = () => document.body.querySelector('[role="dialog"]');
const rows = (title: string) => [...(panel(title)?.querySelectorAll('tbody tr') ?? [])] as HTMLTableRowElement[];
/** Type into a field as a person does: React reads the value from the input event. */
async function type(field: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
const press = async (node: HTMLElement | undefined) => { await act(async () => node!.click()); await act(async () => {}); };

beforeEach(() => {
  mocks.runNativeRequest.mockReset().mockResolvedValue({ data: { result: { status: 200, body: { items: [{ id: 1, title: 'Buy milk', done: 0 }] } } } });
  mocks.getNativeCalls.mockReset().mockResolvedValue({ data: listOf([call(3, { method: 'POST', status: 422, ms: 31, error: 'Give a title of 1 to 200 characters', caller: 'visitor' }), call(2, { caller: 'member' }), call(1)]) });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('the routes', () => {
  it('are a table of what each runs, who may call it and what it does to the data', async () => {
    await mount();
    const table = rows('Routes').map(row => [...row.querySelectorAll('th, td')].map(cell => cell.textContent?.replace(/\s+/g, ' ').trim()));
    expect(table[0]).toEqual(['GET', 'GET/api/items', 'RunslistItems', 'Who may call itAnyone with the link', 'DataReads it', 'Try it']);
    expect(table[1]).toEqual(['POST', 'POST/api/items', 'RunscreateItem', 'Who may call itAnyone with the link', 'DataChanges it', 'Try it']);
    // A route this server does not serve says why, and cannot be tried.
    expect(table[2][1]).toContain('Not served here. It asks for a host key, which this server does not hold.');
    expect(table[2][3]).toBe('Who may call itNo one here');
    expect(rows('Routes')[2].querySelector('button')).toBeNull();
    expect(panel('Routes')!.textContent).toContain('Anyone who opens the app can call its routes.');
  });

  it('are said to be yours alone while the app is not published', async () => {
    await act(async () => root.render(<SoftnApi app={{ ...app, status: 'draft' } as App} access="application" manifest={MANIFEST} version={1} dirty={false} readOnly={false} />));
    await act(async () => {});
    expect(rows('Routes')[0].textContent).toContain('Only you, until it is published');
    expect(panel('Routes')!.textContent).toContain('The app is not published yet, so only you can open it and call its routes.');
    expect(panel('Routes')!.textContent).not.toContain('Anyone who opens the app');
  });

  it('say who may call them in the words Settings uses, for an app only invited people use', async () => {
    await mount({ access: 'members' });
    expect(rows('Routes')[0].textContent).toContain('Only people you invite');
    expect(panel('Routes')!.textContent).toContain('Only you and the people you invite can open the app and call its routes.');
  });

  it('list the database changes in the order they ran', async () => {
    await mount();
    expect([...panel('Database changes')!.querySelectorAll('li')].map(item => item.textContent)).toEqual(['1001.sql', '2002.sql']);
    expect(panel('Database changes')!.querySelector('li')!.getAttribute('title')).toBe('server/migrations/001.sql');
  });

  it('are those of the live app: an unpublished backend is not listed, and unpublished changes are said', async () => {
    await mount({ manifest: JSON.stringify({ name: 'Notes', main: 'index.html' }) });
    expect(container.textContent).toContain('The app’s backend is not live yet. Publish your changes, and its routes are listed here.');
    expect(panel('Try it')).toBeUndefined();
    expect(mocks.getNativeCalls).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount({ dirty: true });
    expect(container.textContent).toContain('You have changes that are not live yet. This is the live app, version 4');
  });

  it('lead to Try it, with the route chosen and the keyboard there', async () => {
    vi.useFakeTimers();
    await mount();
    await press(button(/^Try it: POST \/api\/items$/));
    expect((container.querySelector('#api-try-route') as HTMLSelectElement).value).toBe('POST /api/items');
    expect(container.querySelector('#api-try-body')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(document.activeElement?.id).toBe('api-try-route');
  });

  it('keep the routes under /api/site/ to the site: listed as its own, never offered to Try it', async () => {
    // An app using App AI declares where its answers are delivered; only the site calls that.
    await mount({ manifest: JSON.stringify({ name: 'Notes', main: 'index.html', server: { entry: 'server/main.logic', routes: [
      { path: '/api/notes', method: 'GET', handler: 'list' },
      { path: '/api/site/jobs/deliver', method: 'POST', handler: 'deliver' },
    ] } }) });
    const site = rows('Routes')[1];
    expect(site.textContent).toContain('This site only');
    expect(site.textContent).toContain('The site calls it with App AI’s answers and camera checks. The app’s pages and Try it cannot.');
    expect(site.querySelector('button')).toBeNull();
    expect([...(container.querySelector('#api-try-route') as HTMLSelectElement).options].map(option => option.value)).toEqual(['GET /api/notes']);
  });
});

describe('Try it', () => {
  it('sends a route that reads at once, as the owner to the live app, and shows the status, the time and the answer', async () => {
    await mount();
    expect([...(container.querySelector('#api-try-route') as HTMLSelectElement).options].map(option => option.value)).toEqual(['GET /api/items', 'POST /api/items']);
    // A GET has no body to give.
    expect(container.querySelector('#api-try-body')).toBeNull();
    await type(container.querySelector('#api-try-query') as HTMLTextAreaElement, '{"page": 2}');
    mocks.getNativeCalls.mockClear();
    await press(button(/^Send$/));
    expect(dialog()).toBeNull();
    expect(mocks.runNativeRequest).toHaveBeenCalledWith('tasks', { path: '/api/items', method: 'GET', query: { page: '2' }, headers: {}, body: {} });
    const answer = container.querySelector('section[aria-label="Answer"]')!;
    expect(answer.textContent).toContain('200 OK');
    expect(answer.textContent).toMatch(/\d+ ms/);
    expect(container.querySelector('[data-testid="api-answer"]')!.textContent).toBe('{\n  "items": [\n    {\n      "id": 1,\n      "title": "Buy milk",\n      "done": 0\n    }\n  ]\n}');
    // The call it made is asked for at once among the latest.
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(1);
  });

  it('asks before a route that can change the live app’s data, and sends nothing until it is told to', async () => {
    await mount();
    await type(container.querySelector('#api-try-route') as HTMLSelectElement, 'POST /api/items');
    await type(container.querySelector('#api-try-body') as HTMLTextAreaElement, '{"title": "Buy milk"}');
    await press(button(/^Send$/));
    expect(dialog()!.textContent).toContain('Send this to the live app?');
    expect(dialog()!.textContent).toContain('POST /api/items can change Task board’s data. It runs on the live app, as you, and what it changes stays changed');
    await press(button(/^Cancel$/, dialog()!));
    expect(dialog()).toBeNull();
    expect(mocks.runNativeRequest).not.toHaveBeenCalled();

    mocks.runNativeRequest.mockResolvedValue({ data: { result: { status: 201, body: { id: 2, title: 'Buy milk', done: 0 } } } });
    await press(button(/^Send$/));
    await press(button(/^Send it$/, dialog()!));
    expect(mocks.runNativeRequest).toHaveBeenCalledWith('tasks', { path: '/api/items', method: 'POST', query: {}, headers: {}, body: { title: 'Buy milk' } });
    expect(dialog()).toBeNull();
    expect(container.querySelector('section[aria-label="Answer"]')!.textContent).toContain('201 Created');
  });

  it('checks the query and the body before anything is sent, and says what is wrong', async () => {
    await mount();
    await type(container.querySelector('#api-try-query') as HTMLTextAreaElement, '{page: 2}');
    await press(button(/^Send$/));
    expect(container.querySelector('#api-try-problem')!.textContent).toMatch(/^The query is not valid JSON/);
    expect(container.querySelector('#api-try-query')!.getAttribute('aria-invalid')).toBe('true');
    await type(container.querySelector('#api-try-query') as HTMLTextAreaElement, '{"tags": ["a"]}');
    await press(button(/^Send$/));
    expect(container.querySelector('#api-try-problem')!.textContent).toBe('In the query, "tags" is not text or a number: an address cannot carry a list or an object.');
    await type(container.querySelector('#api-try-query') as HTMLTextAreaElement, '');
    await type(container.querySelector('#api-try-route') as HTMLSelectElement, 'POST /api/items');
    await type(container.querySelector('#api-try-body') as HTMLTextAreaElement, '"Buy milk"');
    await press(button(/^Send$/));
    expect(container.querySelector('#api-try-problem')!.textContent).toBe('The body is a JSON object or list, such as {"title": "Buy milk"}.');
    expect(dialog()).toBeNull();
    expect(mocks.runNativeRequest).not.toHaveBeenCalled();
  });

  it('forgets what was wrong with one route’s text when another is chosen from its row', async () => {
    await mount();
    await type(container.querySelector('#api-try-query') as HTMLTextAreaElement, '{page: 2}');
    await press(button(/^Send$/));
    expect(container.querySelector('#api-try-problem')).not.toBeNull();
    await press(button(/^Try it: POST \/api\/items$/));
    expect(container.querySelector('#api-try-problem')).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it('shows an answer the app gave as it came, and one FormLogic gave as FormLogic’s', async () => {
    await mount();
    mocks.runNativeRequest.mockResolvedValue({ data: { result: { status: 503, body: 'The service is resting' } } });
    await press(button(/^Send$/));
    expect(container.querySelector('section[aria-label="Answer"]')!.textContent).toContain('503 Unavailable');
    expect(container.querySelector('[data-testid="api-answer"]')!.textContent).toBe('The service is resting');

    mocks.runNativeRequest.mockResolvedValue({ error: 'Too many requests. Please try again later.', status: 429, retryAfter: 2 });
    await press(button(/^Send$/));
    const refused = container.querySelector('section[aria-label="Answer"]')!.textContent;
    expect(refused).toContain('429 Too many calls');
    expect(refused).toContain('FormLogic answered, not the app: Too many requests. Please try again later.');
    expect(container.querySelector('[data-testid="api-answer"]')).toBeNull();

    mocks.runNativeRequest.mockResolvedValue({ error: 'Failed to fetch', transportFailure: true });
    await press(button(/^Send$/));
    const unsent = container.querySelector('section[aria-label="Answer"]')!.textContent;
    expect(unsent).toContain('No answer');
    expect(unsent).toContain('The call could not be sent. Check your connection and try again.');
    expect(unsent).not.toContain('FormLogic answered');
  });

  it('sends nothing on the shared demo, whose apps’ backends do not run', async () => {
    await mount({ readOnly: true });
    expect(panel('Try it')!.textContent).toContain('This is the shared demo: its apps’ backends do not run here, so nothing can be sent.');
    expect(button(/Try it/, panel('Routes')!)).toBeUndefined();
    expect(button(/^Send$/)).toBeUndefined();
    // The latest calls are still read: there are none.
    expect(mocks.getNativeCalls).toHaveBeenCalledWith('app-1', 20);
  });
});

describe('the latest calls', () => {
  it('are listed newest first, with their answer, the time they took, who made them and why one failed', async () => {
    await mount();
    expect(mocks.getNativeCalls).toHaveBeenCalledWith('app-1', 20);
    const calls = rows('Recent calls');
    expect(calls).toHaveLength(3);
    expect(calls[0].textContent).toContain('POST/api/items');
    expect(calls[0].textContent).toContain('Give a title of 1 to 200 characters');
    expect(calls[0].textContent).toContain('422 Not accepted');
    expect(calls[0].textContent).toContain('31 ms');
    expect(calls[0].textContent).toContain('A visitor');
    expect(calls[1].textContent).toContain('A member');
    expect(calls[2].textContent).toContain('You');
    expect(calls[0].querySelector('time')!.textContent).toBe('just now');
    expect(panel('Recent calls')!.textContent).toContain('The newest 500 calls of the last 14 days are kept');
    // What is kept, said as it is: an app's own error can repeat what a call sent.
    expect(panel('Recent calls')!.textContent).toContain('Never its body, query or headers. A failed call keeps the first words of the error the app answered with, which can repeat what was sent.');
  });

  it('say "an address the app does not have" where a stranger asked for one, and show no words of theirs', async () => {
    mocks.getNativeCalls.mockResolvedValue({ data: listOf([call(2, { path: '', status: 404, error: 'Endpoint not found.', caller: 'visitor' }), call(1, { path: '/api/items/7', status: 404, error: 'Endpoint not found.' })]) });
    await mount();
    const [stranger, mine] = rows('Recent calls');
    expect(stranger.textContent).toContain('An address the app does not have');
    expect(stranger.querySelector('.font-mono:not([class*="rounded"])')).toBeNull();
    // The owner's own call keeps the address they asked for.
    expect(mine.textContent).toContain('/api/items/7');
  });

  it('say so when there are none yet', async () => {
    mocks.getNativeCalls.mockResolvedValue({ data: listOf([]) });
    await mount();
    expect(panel('Recent calls')!.textContent).toContain('No calls in the last 14 days. They appear here as the app’s pages use its backend, and as you try a route.');
  });

  it('are asked for again every ten seconds while the tab is in view, and at once when it comes back', async () => {
    vi.useFakeTimers();
    await mount();
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(CALLS_EVERY_SECONDS * 1000); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(2);
    // Out of view: nothing is asked.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { vi.advanceTimersByTime(CALLS_EVERY_SECONDS * 3000); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(3);
    hidden.mockRestore();
    // Gone from the page: nothing more is asked.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => { vi.advanceTimersByTime(CALLS_EVERY_SECONDS * 3000); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(3);
  });

  it('that could not be read are said to be that, never "no calls", and a refresh that fails keeps the list', async () => {
    mocks.getNativeCalls.mockResolvedValue({ error: 'The app’s calls could not be read just now.', status: 503 });
    await mount();
    expect(panel('Recent calls')!.textContent).toContain('The app’s calls could not be loaded');
    expect(panel('Recent calls')!.textContent).not.toContain('No calls');
    mocks.getNativeCalls.mockResolvedValue({ data: listOf([call(1)]) });
    await press(button(/^Try again$/, panel('Recent calls')!));
    expect(rows('Recent calls')).toHaveLength(1);
    mocks.getNativeCalls.mockResolvedValue({ error: 'Server error', status: 500 });
    await press(button(/^Refresh the calls$/));
    expect(rows('Recent calls')).toHaveLength(1);
    expect(panel('Recent calls')!.textContent).toContain('Could not refresh just now: these are the calls as they were.');
  });

  it('are read at once after Try it sends a call, and again a moment later (it may be written just after its answer)', async () => {
    vi.useFakeTimers();
    await mount();
    mocks.getNativeCalls.mockClear();
    await press(button(/^Send$/));
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(2);
  });

  it('wait for a slow read rather than throw it away at the next ten seconds, and show it when it comes', async () => {
    vi.useFakeTimers();
    // Each read takes fifteen seconds: longer than the ten between refreshes.
    mocks.getNativeCalls.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ data: listOf([call(1)]) }), 15_000)));
    await mount();
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(CALLS_EVERY_SECONDS * 1000); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(1);
    expect(panel('Recent calls')!.textContent).toContain('Loading the calls…');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(rows('Recent calls')).toHaveLength(1);
    // The next tick asks again, once the first has come.
    await act(async () => { vi.advanceTimersByTime(CALLS_EVERY_SECONDS * 1000); });
    expect(mocks.getNativeCalls).toHaveBeenCalledTimes(2);
  });

  it('show twenty at first, a hundred at Show more, and then all that is kept', async () => {
    const full = (limit: number) => ({ data: listOf(Array.from({ length: limit }, (_, index) => call(limit - index)), { limit }) });
    mocks.getNativeCalls.mockImplementation(async (_app: string, limit: number) => full(limit));
    await mount();
    expect(rows('Recent calls')).toHaveLength(20);
    await press(button(/^Show more$/));
    expect(mocks.getNativeCalls).toHaveBeenLastCalledWith('app-1', 100);
    expect(rows('Recent calls')).toHaveLength(100);
    await press(button(/^Show more$/));
    expect(mocks.getNativeCalls).toHaveBeenLastCalledWith('app-1', 500);
    // All that is kept is shown: nothing more to offer.
    expect(button(/^Show more$/)).toBeUndefined();
  });

  it('offer no more when fewer came than were asked for', async () => {
    mocks.getNativeCalls.mockResolvedValue({ data: listOf([call(2), call(1)], { limit: 20 }) });
    await mount();
    expect(button(/^Show more$/)).toBeUndefined();
  });
});
