// @vitest-environment jsdom
// Connect an OAIY server: a one-time code, AI only unless asked, shown once with the command to run,
// and the page follows it to linked (or tells the person it ran out).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ConnectOaiyServer } from './ConnectOaiyServer';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
const code = { id: 'c1', code: 'K7QM-2WXR-9DFT', expiresAt: new Date(Date.now() + 600_000).toISOString(), scope: 'ai' as const, baseUrl: 'https://formlogic.example', command: 'oaiy-server link --code K7QM-2WXR-9DFT --base-url https://formlogic.example' };

async function mount(onLinked?: (id: string) => void) {
  root = createRoot(container);
  await act(async () => root!.render(<ConnectOaiyServer onLinked={onLinked} />));
  await act(async () => button('Connect an OAIY server')!.click());
}

it('makes an AI-only code unless asked, shows it once with its command, and follows it to linked', async () => {
  const create = vi.spyOn(api, 'createDesktopLinkCode').mockResolvedValue({ data: code });
  const status = vi.spyOn(api, 'getDesktopLinkCode')
    .mockResolvedValueOnce({ data: { id: 'c1', scope: 'ai', expiresAt: code.expiresAt, status: 'waiting' } })
    .mockResolvedValueOnce({ data: { id: 'c1', scope: 'ai', expiresAt: code.expiresAt, status: 'linked', connectionId: 'dc-1', deviceName: 'OAIY server on rack-2' } });
  const linked = vi.fn();
  await mount(linked);
  await act(async () => button('Make a code')!.click());
  expect(create).toHaveBeenCalledWith({ scope: 'ai', deviceName: undefined });
  expect(container.querySelector('[data-testid="oaiy-link-code"]')?.textContent).toBe('K7QM-2WXR-9DFT');
  expect(container.textContent).toContain(code.command);
  expect(container.textContent).toContain('It may answer AI requests only.');
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(status).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Waiting for the server');
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(container.textContent).toContain('Linked: OAIY server on rack-2');
  expect(linked).toHaveBeenCalledWith('dc-1');
  await act(async () => { vi.advanceTimersByTime(9000); });
  expect(status).toHaveBeenCalledTimes(2);
});

it('asks for everything a desktop can do only when chosen, and offers a new code when one runs out', async () => {
  const create = vi.spyOn(api, 'createDesktopLinkCode').mockResolvedValue({ data: { ...code, scope: 'all' } });
  vi.spyOn(api, 'getDesktopLinkCode').mockResolvedValue({ data: { id: 'c1', scope: 'all', expiresAt: code.expiresAt, status: 'expired', message: 'That code has run out. Make a new one.' } });
  await mount();
  const everything = [...container.querySelectorAll('input[type="radio"]')][1] as HTMLInputElement;
  await act(async () => everything.click());
  const name = container.querySelector('input:not([type])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Studio server');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Make a code')!.click());
  expect(create).toHaveBeenCalledWith({ scope: 'all', deviceName: 'Studio server' });
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(container.textContent).toContain('That code ran out. Make a new one.');
  expect(button('Make a code')).toBeTruthy();
});

it('says why a code could not be made', async () => {
  vi.spyOn(api, 'createDesktopLinkCode').mockResolvedValue({ error: 'You already have 3 codes waiting. Use one, or wait ten minutes.', status: 409 });
  await mount();
  await act(async () => button('Make a code')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('3 codes waiting');
});
