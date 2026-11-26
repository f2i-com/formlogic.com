// @vitest-environment jsdom
/**
 * External API settings, Custom Response Headers. The server keeps only the names that speak for
 * the one answer they are on (AppService::sanitizeExternalApi) and drops the rest without a word:
 * the owner saved "Clear-Site-Data", was told the settings were saved, and the header was never
 * sent. The box now says which lines are not kept and why, while they are typed, and after a save
 * it is held to what the server's answer says it stored.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../types/app';

const mocks = vi.hoisted(() => ({ runNativeRequest: vi.fn(), getNativeCalls: vi.fn(), updateApp: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
const { SoftnApi } = await import('./SoftnApi');
const { useAppStore } = await import('../../stores/appStore');
const { useToastStore } = await import('../../stores/toastStore');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const app = { id: 'app-1', name: 'Task board', slug: 'tasks', status: 'published', ownerId: 'u1', settings: { softnApp: true } } as unknown as App;
const MANIFEST = JSON.stringify({ name: 'Task board', main: 'index.html', server: { entry: 'server/main.logic', routes: [{ path: '/api/items', method: 'GET', handler: 'listItems' }] } });

const button = (text: RegExp) => [...container.querySelectorAll('button')].find((node) => text.test(node.textContent ?? '')) as HTMLButtonElement | undefined;
const press = async (node: HTMLElement | undefined) => { await act(async () => node!.click()); await act(async () => {}); };
const box = () => container.querySelector('#ext-api-headers') as HTMLTextAreaElement;
const notes = () => container.querySelector('#ext-api-headers-notes');
const noted = () => [...(notes()?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.type}: ${toast.title}${toast.message ? ` | ${toast.message}` : ''}`);
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(box(), value); box().dispatchEvent(new Event('input', { bubbles: true })); });
}
/** The server's answer to a save: the app with the headers it kept. */
const storing = (customHeaders: Record<string, string> | []) => mocks.updateApp.mockImplementation(async (_id: string, data: { settings: { externalApi: object } }) => ({
  data: { app: { ...app, settings: { ...data.settings, externalApi: { ...data.settings.externalApi, customHeaders } } } },
}));

beforeEach(async () => {
  mocks.getNativeCalls.mockReset().mockResolvedValue({ data: { calls: [], limit: 50, keep: { calls: 500, days: 14 } } });
  mocks.updateApp.mockReset();
  useAppStore.setState({ apps: [app] });
  useToastStore.setState({ toasts: [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<SoftnApi app={app} version={4} manifest={MANIFEST} access="application" dirty={false} readOnly={false} />));
  await act(async () => {});
  await press(button(/^Customize API$/));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState({ apps: [] }); });

describe('Custom Response Headers', () => {
  it('say nothing of headers the server keeps', async () => {
    await type('Cache-Control: public, max-age=60\nX-API-Version: 1.0');
    expect(notes()).toBeNull();
    expect(box().hasAttribute('aria-describedby')).toBe(false);
    storing({ 'Cache-Control': 'public, max-age=60', 'X-API-Version': '1.0' });
    await press(button(/^Save External API Settings$/));
    expect(mocks.updateApp.mock.calls[0][1].settings.externalApi.customHeaders).toEqual({ 'Cache-Control': 'public, max-age=60', 'X-API-Version': '1.0' });
    expect(notes()).toBeNull();
    expect(toasts()).toEqual(['success: External API settings saved | API-key access rules updated.']);
  });

  it('say which lines are not kept, and why, as they are typed', async () => {
    await type('X-API-Version: 1.0\nClear-Site-Data: "*"\nX-Frame-Options: DENY\nnot a header');
    expect(notes()!.getAttribute('role')).toBe('status');
    expect(box().getAttribute('aria-describedby')).toBe('ext-api-headers-notes');
    expect(notes()!.textContent).toContain('These headers are not kept, and are not sent:');
    expect(noted()).toEqual([
      'not a header: it is not written as “Header: Value”.',
      'Clear-Site-Data: a browser or a proxy keeps it for more than the one answer, so only Cache-Control, Expires, Pragma, Content-Language, Deprecation, Sunset and your own X- headers are sent.',
      'X-Frame-Options: browsers or the web server act on this X- header, or FormLogic sets it itself.',
    ]);
    // Put right, the note goes.
    await type('X-API-Version: 1.0');
    expect(notes()).toBeNull();
  });

  it('tell the owner at the save that a header was not kept, and go on saying which', async () => {
    await type('X-API-Version: 1.0\nClear-Site-Data: "*"');
    storing({ 'X-API-Version': '1.0' });
    await press(button(/^Save External API Settings$/));
    // Everything that reads as a header is sent: the server decides.
    expect(mocks.updateApp.mock.calls[0][1].settings.externalApi.customHeaders).toEqual({ 'X-API-Version': '1.0', 'Clear-Site-Data': '"*"' });
    expect(toasts()).toEqual([
      'warning: One header was not kept | Clear-Site-Data. Custom Response Headers says why.',
      'success: External API settings saved | API-key access rules updated.',
    ]);
    expect(notes()!.textContent).toContain('This header is not kept, and is not sent:');
    expect(noted()).toHaveLength(1);
    expect(noted()[0]).toMatch(/^Clear-Site-Data: a browser or a proxy keeps it/);
  });

  it('are held to what the server stored, where it keeps less than this page expected', async () => {
    await type('X-API-Version: 1.0\nX-Trace: on');
    expect(notes()).toBeNull();
    // A server whose rule has moved on: it kept one of the two.
    storing({ 'X-API-Version': '1.0' });
    await press(button(/^Save External API Settings$/));
    expect(toasts()[0]).toBe('warning: One header was not kept | X-Trace. Custom Response Headers says why.');
    expect(noted()).toEqual(['X-Trace: the server did not keep it.']);
    // What the save found is about the text as it was saved.
    await type('X-API-Version: 1.0\nX-Trace: off');
    expect(notes()).toBeNull();

    // With none kept the server answers an empty list.
    storing([]);
    useToastStore.setState({ toasts: [] });
    await press(button(/^Save External API Settings$/));
    expect(toasts()[0]).toBe('warning: 2 headers were not kept | X-API-Version, X-Trace. Custom Response Headers says why.');
  });

  it('say nothing was saved when the save failed, and claim nothing about the headers', async () => {
    await type('X-API-Version: 1.0');
    mocks.updateApp.mockResolvedValue({ error: 'Server error', status: 500 });
    await press(button(/^Save External API Settings$/));
    expect(toasts()).toEqual(['error: Update failed | Server error', 'error: Could not save External API settings']);
    expect(notes()).toBeNull();
  });
});
