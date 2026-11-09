// @vitest-environment jsdom
// "AI for this app": where the app's AI comes from, its limits, a real test, and what its requests did.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppAiView } from '../../lib/appAi';
import { AppAiPanel } from './AppAiPanel';

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
const view = (over: Partial<AppAiView> = {}): AppAiView => ({
  declared: { uses: ['pictures', 'chat'], purpose: 'Draws your logo.', table: 'ai_jobs', deliver: '/api/site/ai/deliver' },
  settings: { mode: 'off', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500, blocked: false, blockedReason: null, pausedUntil: null, own: null },
  availability: { enabled: false, source: 'off', label: '', kinds: [], reason: 'ai_off' },
  reasonText: 'AI is turned off for this app.',
  siteOffers: true,
  status: { state: 'off', waiting: 0, running: 0, since: null, message: 'AI is off for this app: it is told so, and nothing is sent anywhere.' },
  today: { jobs: 3, failed: 1, refused: 0 },
  log: [
    { id: 'j1', appJobId: 'a1', kind: 'picture', status: 'done', code: null, message: null, requester: 'Visitor 3f2a91', test: false, createdAt: '2026-11-09 10:00:00.000', finishedAt: '2026-11-09 10:00:41.000', seconds: 38.2 },
    { id: 'j2', appJobId: 'a2', kind: 'picture', status: 'failed', code: 'expired', message: 'The AI was too busy.', requester: 'Visitor 77aa01', test: false, createdAt: '2026-11-09 09:00:00.000', finishedAt: null, seconds: null },
  ],
  ...over,
});

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<AppAiPanel appId="app-1" />));
}

it('says what the app asks for and where its AI comes from, and lists what its requests did', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view() });
  await mount();
  expect(container.textContent).toContain('This app asks for AI for pictures and chat');
  expect(container.textContent).toContain('Draws your logo.');
  expect(container.textContent).toContain('nothing is sent anywhere');
  expect(container.textContent).toContain('Today: 3 requests, 1 failed, 0 refused');
  expect(container.textContent).toContain('Ran out of time');
  expect(container.textContent).toContain('38.2 s');
  expect(container.textContent).not.toContain('Use my OAIY');
  expect(button('Test a picture')?.disabled).toBe(true);
});

it('saves the source and limits as numbers, and shows what the server answers', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view() });
  const on = view({ settings: { ...view().settings, mode: 'site', perIpDay: 5 }, availability: { enabled: true, source: 'site', label: 'This site\'s AI', kinds: ['picture', 'chat'], reason: null }, reasonText: null, status: { state: 'idle', waiting: 0, running: 0, since: null, message: 'Ready: This site\'s AI.' } });
  const put = vi.spyOn(api, 'putAppAi').mockResolvedValue({ data: on });
  await mount();
  const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="app-ai-mode"]')];
  await act(async () => radios[1].click());
  const perIpDay = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(perIpDay, '5');
    perIpDay.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { mode: 'site', perRequesterDay: 10, perIpDay: 5, perIpHour: 10, perAppDay: 500 });
  expect(container.textContent).toContain('Saved.');
  expect(container.textContent).toContain('Ready: This site\'s AI.');
  expect(button('Test a picture')?.disabled).toBe(false);
});

it('runs a test and shows its picture when it is done', async () => {
  const on = view({ availability: { enabled: true, source: 'site', label: 'This site\'s AI', kinds: ['picture', 'chat'], reason: null } });
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: on });
  vi.spyOn(api, 'testAppAi').mockResolvedValue({ data: { jobId: 'f'.repeat(32) } });
  const follow = vi.spyOn(api, 'getAppAiTest')
    .mockResolvedValueOnce({ data: { status: 'running' } })
    .mockResolvedValueOnce({ data: { status: 'done', picture: 'data:image/png;base64,iVBORw0KGgo=', model: 'flux-3-image-klein', seed: 42, seconds: 37.5 } });
  await mount();
  await act(async () => button('Test a picture')!.click());
  expect(container.textContent).toContain('Test picture: Waiting');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(container.textContent).toContain('Working');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(follow).toHaveBeenCalledTimes(2);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(container.textContent).toContain('37.5 s · flux-3-image-klein · seed 42');
});

it('says why it cannot be read', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ error: 'App not found or access denied', status: 404 });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('App not found or access denied');
});

it('uses the owner\'s own OAIY: a computer of theirs, and a picture model listed from it', async () => {
  const computers = [{ connectionId: 'dc-1', instanceId: 'inst-1', deviceName: 'Home PC', fingerprint: 'AAAA BBBB', online: true, lastSeenAt: null }];
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ computers }) });
  const models = vi.spyOn(api, 'getAppAiModels').mockResolvedValue({ data: { models: [{ id: 'nanbeige', name: 'nanbeige' }, { id: 'flux-3-image-klein', name: 'flux-3-image-klein', type: 'image' }] } });
  const put = vi.spyOn(api, 'putAppAi').mockResolvedValue({ data: view({ computers, settings: { ...view().settings, mode: 'own', own: { connectionId: 'dc-1', deviceName: 'Home PC', providerId: 'oaiy-engine', pictureModel: 'flux-3-image-klein', chatModel: null } } }) });
  await mount();
  await act(async () => [...container.querySelectorAll<HTMLInputElement>('input[name="app-ai-mode"]')][2].click());
  expect(container.textContent).toContain('Home PC');
  await act(async () => container.querySelector<HTMLInputElement>('input[name="app-ai-own-computer"]')!.click());
  await act(async () => button('List its picture models')!.click());
  expect(models).toHaveBeenCalledWith('app-1', 'dc-1', 'oaiy-engine');
  const select = container.querySelector<HTMLSelectElement>('[data-testid="app-ai-own"] select')!;
  expect([...select.options].map((o) => o.value)).toEqual(['', 'flux-3-image-klein']);
  await act(async () => { select.value = 'flux-3-image-klein'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { mode: 'own', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500, own: { connectionId: 'dc-1', providerId: 'oaiy-engine', pictureModel: 'flux-3-image-klein' } });
});
