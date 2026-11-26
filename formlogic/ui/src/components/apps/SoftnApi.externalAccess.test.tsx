// @vitest-environment jsdom
/**
 * External API settings: route prefixes, the default path prefix and browser origins. The server
 * keeps only what its rule allows (AppService::sanitizeExternalApi) and drops the rest without a
 * word, as it did the custom headers: a blocked prefix with a space in it was saved, the owner was
 * told so, and the route was never blocked; an origin with a path was never allowed; and with every
 * allowed prefix dropped, every route was allowed. Each box now says what of it is not kept and why
 * while it is typed, and after a save it is held to what the server's answer says it stored.
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
const element = (id: string) => container.querySelector(`#${id}`) as HTMLTextAreaElement | HTMLInputElement;
const noted = (id: string) => [...(container.querySelector(`#${id}-notes`)?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
const notes = (id: string) => container.querySelector(`#${id}-notes`);
const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.type}: ${toast.title}${toast.message ? ` | ${toast.message}` : ''}`);
async function type(id: string, value: string) {
  const node = element(id);
  const setter = Object.getOwnPropertyDescriptor(node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
type Sent = { settings: { externalApi: Record<string, unknown> } };
/** The server's answer to a save: the app as stored, with `stored` in place of what was sent. */
const storing = (stored: Record<string, unknown>) => mocks.updateApp.mockImplementation(async (_id: string, data: Sent) => ({
  data: { app: { ...app, settings: { ...data.settings, externalApi: { ...data.settings.externalApi, ...stored } } } },
}));
const sent = () => (mocks.updateApp.mock.calls[0][1] as Sent).settings.externalApi;
const save = () => press(button(/^Save External API Settings$/));

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

describe('Route prefixes, the path prefix and CORS origins', () => {
  it('say nothing of what the server keeps, and send it as typed', async () => {
    await type('ext-api-allowed-paths', 'api/products\n/api/orders');
    await type('ext-api-blocked-paths', '/api/admin');
    await type('ext-api-cors', 'https://Shop.Example.com/\n*');
    await type('ext-api-prefix', 'api/');
    for (const id of ['ext-api-allowed-paths', 'ext-api-blocked-paths', 'ext-api-cors', 'ext-api-prefix']) {
      expect(notes(id), id).toBeNull();
      expect(element(id).hasAttribute('aria-describedby'), id).toBe(false);
    }
    storing({ allowedPaths: ['/api/products', '/api/orders'], blockedPaths: ['/api/admin'], corsOrigins: ['https://shop.example.com', '*'], defaultPrefix: '/api' });
    await save();
    expect(sent()).toMatchObject({ allowedPaths: ['api/products', '/api/orders'], blockedPaths: ['/api/admin'], corsOrigins: ['https://Shop.Example.com/', '*'], defaultPrefix: 'api/' });
    expect(toasts()).toEqual(['success: External API settings saved | API-key access rules updated.']);
    expect(notes('ext-api-allowed-paths')).toBeNull();
  });

  it('say what is not kept, and why, as it is typed', async () => {
    await type('ext-api-allowed-paths', '/api/products\n/api/site/internal\n/api/../secret');
    expect(element('ext-api-allowed-paths').getAttribute('aria-describedby')).toBe('ext-api-allowed-paths-notes');
    expect(notes('ext-api-allowed-paths')!.getAttribute('role')).toBe('status');
    expect(notes('ext-api-allowed-paths')!.textContent).toContain('These prefixes are not kept:');
    expect(noted('ext-api-allowed-paths')).toEqual([
      '/api/site/internal: routes under /api/site/ are FormLogic’s own to call.',
      '/api/../secret: it holds “..”.',
    ]);
    expect(notes('ext-api-allowed-paths')!.textContent).not.toContain('every route');

    await type('ext-api-blocked-paths', '/api/admin area');
    expect(notes('ext-api-blocked-paths')!.textContent).toContain('This prefix is not kept, and is not blocked:');
    expect(noted('ext-api-blocked-paths')).toEqual(['/api/admin area: it has a space or a control character.']);

    await type('ext-api-cors', 'https://app.example/login\nftp://files.example\nhttps://ok.example');
    expect(notes('ext-api-cors')!.textContent).toContain('These origins are not kept, and are not allowed:');
    expect(noted('ext-api-cors')).toEqual([
      'https://app.example/login: an origin is http:// or https://, a host and at most a port, and nothing after it.',
      'ftp://files.example: an origin is http:// or https://, a host and at most a port, and nothing after it.',
    ]);

    await type('ext-api-prefix', '/api/v1.2');
    expect(element('ext-api-prefix').getAttribute('aria-describedby')).toBe('ext-api-prefix-notes');
    expect(notes('ext-api-prefix')!.textContent).toContain('This path prefix is not kept, and no prefix is added:');
    expect(noted('ext-api-prefix')).toEqual(['/api/v1.2: a prefix is letters, digits, “/”, “_” and “-”.']);

    // Put right, the notes go.
    await type('ext-api-allowed-paths', '/api/products');
    await type('ext-api-blocked-paths', '/api/admin');
    await type('ext-api-cors', 'https://ok.example');
    await type('ext-api-prefix', '/api/v1');
    for (const id of ['ext-api-allowed-paths', 'ext-api-blocked-paths', 'ext-api-cors', 'ext-api-prefix']) expect(notes(id), id).toBeNull();
  });

  it('say so when no allowed prefix is kept, since every route is then allowed', async () => {
    await type('ext-api-allowed-paths', '/api/public area\n/api/site/x');
    expect(notes('ext-api-allowed-paths')!.textContent).toContain('With none of them kept, every route is allowed.');
    storing({ allowedPaths: [] });
    await save();
    expect(toasts()).toEqual([
      'warning: 2 allowed route prefixes were not kept | /api/public area, /api/site/x. With none kept, every route is allowed. Allowed Route Prefixes says why.',
      'success: External API settings saved | API-key access rules updated.',
    ]);
  });

  it('tell the owner at the save what was not kept, field by field', async () => {
    await type('ext-api-allowed-paths', '/api/products\n/api/../x');
    await type('ext-api-blocked-paths', '/api/admin area');
    await type('ext-api-cors', 'https://app.example/login');
    await type('ext-api-prefix', '/my prefix');
    storing({ allowedPaths: ['/api/products'], blockedPaths: [], corsOrigins: [], defaultPrefix: '' });
    await save();
    // Everything typed is sent: the server decides.
    expect(sent()).toMatchObject({ allowedPaths: ['/api/products', '/api/../x'], blockedPaths: ['/api/admin area'], corsOrigins: ['https://app.example/login'], defaultPrefix: '/my prefix' });
    expect(toasts()).toEqual([
      'warning: One allowed route prefix was not kept | /api/../x. Allowed Route Prefixes says why.',
      'warning: One blocked route prefix was not kept | /api/admin area. It is not blocked. Blocked Route Prefixes says why.',
      'warning: One CORS origin was not kept | https://app.example/login. Allowed Browser CORS Origins says why.',
      'warning: The default path prefix was not kept | /my prefix. No prefix is added. Default Path Prefix says why.',
      'success: External API settings saved | API-key access rules updated.',
    ]);
  });

  it('are held to what the server stored, where it keeps less than this page expected', async () => {
    await type('ext-api-allowed-paths', '/api/a\n/api/b');
    await type('ext-api-blocked-paths', '/api/admin');
    await type('ext-api-cors', 'https://a.example');
    await type('ext-api-prefix', '/v2');
    for (const id of ['ext-api-allowed-paths', 'ext-api-blocked-paths', 'ext-api-cors', 'ext-api-prefix']) expect(notes(id), id).toBeNull();
    // A server whose rule has moved on: it kept less of each.
    storing({ allowedPaths: ['/api/a'], blockedPaths: [], corsOrigins: [], defaultPrefix: '' });
    await save();
    expect(noted('ext-api-allowed-paths')).toEqual(['/api/b: the server did not keep it.']);
    expect(noted('ext-api-blocked-paths')).toEqual(['/api/admin: the server did not keep it.']);
    expect(noted('ext-api-cors')).toEqual(['https://a.example: the server did not keep it.']);
    expect(noted('ext-api-prefix')).toEqual(['/v2: the server did not keep it.']);
    expect(toasts()).toHaveLength(5);
    expect(toasts()[1]).toBe('warning: One blocked route prefix was not kept | /api/admin. It is not blocked. Blocked Route Prefixes says why.');
    // What the save found is about the text as it was saved.
    await type('ext-api-blocked-paths', '/api/admin\n/api/setup');
    expect(notes('ext-api-blocked-paths')).toBeNull();
    expect(noted('ext-api-allowed-paths')).toEqual(['/api/b: the server did not keep it.']);
  });

  it('send the rate limit as typed, and say what of it is not kept', async () => {
    // A 0 was sent as 120, and nothing said so.
    await type('ext-api-rate', '0');
    expect(element('ext-api-rate').getAttribute('aria-describedby')).toBe('ext-api-rate-notes');
    expect(notes('ext-api-rate')!.textContent).toContain('This rate limit is not kept:');
    expect(noted('ext-api-rate')).toEqual(['0: a rate limit is from 1 to 600 requests a minute, so 1 is kept.']);
    storing({ rateLimitPerMinute: 1 });
    await save();
    expect(sent().rateLimitPerMinute).toBe(0);
    expect(toasts()).toEqual([
      'warning: The rate limit was not kept | 0. The limit kept is 1 a minute. Rate Limit says why.',
      'success: External API settings saved | API-key access rules updated.',
    ]);

    // A limit the server keeps says nothing, and is sent as it is.
    await type('ext-api-rate', '90');
    expect(notes('ext-api-rate')).toBeNull();
    expect(element('ext-api-rate').hasAttribute('aria-describedby')).toBe(false);
  });

  it('hold the rate limit to what the server stored', async () => {
    await type('ext-api-rate', '300');
    storing({ rateLimitPerMinute: 120 });
    await save();
    expect(sent().rateLimitPerMinute).toBe(300);
    expect(noted('ext-api-rate')).toEqual(['300: the server did not keep it.']);
    expect(toasts()[0]).toBe('warning: The rate limit was not kept | 300. The limit kept is 120 a minute. Rate Limit says why.');
  });

  it('claim nothing when the save failed', async () => {
    await type('ext-api-blocked-paths', '/api/admin');
    mocks.updateApp.mockResolvedValue({ error: 'Server error', status: 500 });
    await save();
    expect(toasts()).toEqual(['error: Update failed | Server error', 'error: Could not save External API settings']);
    expect(notes('ext-api-blocked-paths')).toBeNull();
  });
});
