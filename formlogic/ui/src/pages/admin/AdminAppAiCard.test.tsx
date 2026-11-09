// @vitest-environment jsdom
// Admin → Platform → AI for apps: the site's settings, the computer's picture models listed live,
// the warnings the server gives, and a stop for one app.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppAiAdminView } from '../../lib/appAi';
import { AdminAppAiCard } from './AdminAppAiCard';

vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
const settings = { allowApps: false, paused: false, pictureModel: null, chatModel: null, defaults: { perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500 }, siteDay: 2000, words: ['badword'] };
const adminView = (over: Partial<AppAiAdminView> = {}): AppAiAdminView => ({
  settings,
  apps: [{ appId: 'app-1', name: 'Five Cent Designs', ownerEmail: 'owner@example.com', mode: 'site', jobsToday: 12, failedToday: 1, blocked: false, blockedReason: null, pausedUntil: null }],
  warnings: [{ code: 'trusted_proxies_unset', message: 'This site is reached through Cloudflare, but TRUSTED_PROXIES is not set.' }],
  ...over,
});

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<AdminAppAiCard />));
}

it('shows the settings, the warnings and every app, and lists the computer\'s picture models', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue({ data: { current: { connectionId: 'dc-1', deviceName: 'Studio PC', fingerprint: 'AAAA', chosenAt: null, yours: true }, candidates: [], engineProvider: 'oaiy-engine' } });
  const models = vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: [{ id: 'nanbeige', name: 'nanbeige' }, { id: 'flux-3-image-klein', name: 'flux-3-image-klein', type: 'image' }, { id: 'ltx-2.5', name: 'ltx-2.5', type: 'video' }] } });
  await mount();
  expect(container.textContent).toContain('your OAIY on Studio PC');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('TRUSTED_PROXIES is not set');
  expect(container.textContent).toContain('Five Cent Designs');
  expect(container.textContent).toContain('12, 1 failed');
  await act(async () => button('List the computer\'s picture models')!.click());
  expect(models).toHaveBeenCalledWith('dc-1', 'oaiy-engine');
  const options = [...container.querySelectorAll('select option')].map((o) => o.textContent);
  expect(options).toEqual(['None: no pictures', 'flux-3-image-klein']);
});

it('saves the whole settings object, the words one a line', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue({ data: { current: null, candidates: [] } });
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: adminView({ settings: { ...settings, allowApps: true } }) });
  await mount();
  const allow = [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')][0];
  await act(async () => allow.click());
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'badword\n  worse phrase \n\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save')!.click());
  expect(put).toHaveBeenCalledWith({ ...settings, allowApps: true, words: ['badword', 'worse phrase'] });
});

it('stops one app\'s AI with a reason its owner sees', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue({ data: { current: null, candidates: [] } });
  vi.spyOn(window, 'prompt').mockReturnValue('Complaints');
  const block = vi.spyOn(api, 'adminBlockAppAi').mockResolvedValue({ data: adminView({ apps: [{ ...adminView().apps[0], blocked: true, blockedReason: 'Complaints' }] }) });
  await mount();
  await act(async () => button('Stop its AI')!.click());
  expect(block).toHaveBeenCalledWith('app-1', true, 'Complaints');
  expect(container.textContent).toContain('Stopped');
  expect(button('Allow again')).toBeDefined();
});
