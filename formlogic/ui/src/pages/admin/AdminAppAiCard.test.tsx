// @vitest-environment jsdom
// Admin → Platform → AI for apps: the setup checklist first (AdminAppAiSetup.test.tsx has its states),
// then the limits and the pause, the warnings the server gives, and a stop for one app.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppAiAdminView, AppAiSetup } from '../../lib/appAi';
import { announceSiteAiChanged } from '../../lib/siteAiEvents';
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
const toggle = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
  .find((node) => node.getAttribute('aria-label') === name || document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === name)!;
const settings = { allowApps: false, paused: false, pictureModel: null, chatModel: null, defaults: { perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500 }, siteDay: 2000, words: ['badword'] };
const setup: AppAiSetup = { source: 'none', computer: null, gone: null, provider: { named: false, on: false }, drawing: true, kinds: [], reason: 'site_ai_unavailable', ready: false, workerIdleSeconds: 20, lastTest: null };
const adminView = (over: Partial<AppAiAdminView> = {}): AppAiAdminView => ({
  settings,
  setup,
  apps: [{ appId: 'app-1', name: 'Five Cent Designs', ownerEmail: 'owner@example.com', mode: 'site', jobsToday: 12, failedToday: 1, blocked: false, blockedReason: null, pausedUntil: null }],
  warnings: [
    { code: 'trusted_proxies_unset', message: 'This site is reached through Cloudflare, but TRUSTED_PROXIES is not set.' },
    { code: 'picture_model_unset', message: 'Apps may use this site\'s AI, but no picture model is chosen, so they can ask for chat only.' },
  ],
  ...over,
});
const noComputers = { data: { current: null, candidates: [], engineProvider: 'oaiy-engine' } };

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><AdminAppAiCard /></MemoryRouter>));
}
const typeInto = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});

it('shows the checklist first, then the warnings and every app', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  await mount();
  const checklist = container.querySelector('[data-testid="ai-setup"]')!;
  expect(checklist.querySelector('[data-testid="ai-setup-summary"]')?.textContent).toBe('4 steps left before apps can make pictures.');
  expect(checklist.compareDocumentPosition(button('Save limits')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The checklist's fourth line says a picture model is missing: the warning is not said twice.
  const warnings = [...container.querySelectorAll('ul[aria-label="Warnings"] li')].map((node) => node.textContent);
  expect(warnings).toEqual(['This site is reached through Cloudflare, but TRUSTED_PROXIES is not set.']);
  expect(container.textContent).toContain('Five Cent Designs');
  expect(container.textContent).toContain('12, 1 failed');
});

it('still shows a server that sends no checklist its settings and every warning', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView({ setup: undefined }) });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  await mount();
  expect(container.querySelector('[data-testid="ai-setup"]')).toBeNull();
  expect(container.querySelectorAll('ul[aria-label="Warnings"] li')).toHaveLength(2);
  expect(button('Save limits')).toBeDefined();
});

it('saves the limits and the words together, the words one a line', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: adminView() });
  await mount();
  await typeInto(container.querySelector('textarea')!, 'badword\n  worse phrase \n\n');
  const perIpDay = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')][0];
  await typeInto(perIpDay, '7');
  await act(async () => button('Save limits')!.click());
  expect(put).toHaveBeenCalledWith({ ...settings, defaults: { ...settings.defaults, perIpDay: 7 }, words: ['badword', 'worse phrase'] });
});

it('pauses every app\'s AI at once, and keeps what is being typed in the limits', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: adminView({ settings: { ...settings, paused: true } }) });
  await mount();
  await typeInto(container.querySelector('textarea')!, 'not saved yet');
  expect(container.textContent).toContain('Stops every app\'s AI at once. Apps are told it is paused.');
  await act(async () => toggle('Pause every app\'s AI').click());
  expect(put).toHaveBeenCalledWith({ ...settings, paused: true });
  expect(toggle('Pause every app\'s AI').getAttribute('aria-checked')).toBe('true');
  expect(container.textContent).toContain('Paused. Apps are told their AI is paused, and nothing is sent anywhere.');
  expect(container.querySelector('textarea')!.value).toBe('not saved yet');
});

it('saves the checklist\'s switch at once, with the limits as they are saved', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: adminView({ settings: { ...settings, allowApps: true } }) });
  await mount();
  await typeInto(container.querySelector('textarea')!, 'not saved yet');
  await act(async () => toggle('Apps may use the site\'s AI').click());
  expect(put).toHaveBeenCalledWith({ ...settings, allowApps: true });
  expect(toggle('Apps may use the site\'s AI').getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('textarea')!.value).toBe('not saved yet');
});

it('reads everything again when the Plans card changes where the site\'s AI runs', async () => {
  const read = vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  const computers = vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  await mount();
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ data: adminView({ setup: { ...setup, source: 'env', provider: { named: true, on: true }, kinds: ['chat'], reason: null } }) });
  await act(async () => announceSiteAiChanged());
  expect(read).toHaveBeenCalledTimes(2);
  expect(computers).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-testid="ai-setup-summary"]')?.textContent).toBe('2 steps left before apps can make pictures.');
});

it('stops one app\'s AI with a reason its owner sees', async () => {
  vi.spyOn(api, 'adminGetAppAi').mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  vi.spyOn(window, 'prompt').mockReturnValue('Complaints');
  const block = vi.spyOn(api, 'adminBlockAppAi').mockResolvedValue({ data: adminView({ apps: [{ ...adminView().apps[0], blocked: true, blockedReason: 'Complaints' }] }) });
  await mount();
  await act(async () => button('Stop its AI')!.click());
  expect(block).toHaveBeenCalledWith('app-1', true, 'Complaints');
  expect(container.textContent).toContain('Stopped');
  expect(button('Allow again')).toBeDefined();
});

it('says why it could not be read, and tries again', async () => {
  const read = vi.spyOn(api, 'adminGetAppAi').mockResolvedValueOnce({ error: 'The server is busy.' }).mockResolvedValue({ data: adminView() });
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue(noComputers);
  await mount();
  expect(container.textContent).toContain('The server is busy.');
  await act(async () => [...container.querySelectorAll('button')][0].click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-testid="ai-setup"]')).not.toBeNull();
});
