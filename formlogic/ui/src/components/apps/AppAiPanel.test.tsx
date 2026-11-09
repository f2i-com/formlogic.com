// @vitest-environment jsdom
// "AI for this app": where the app's AI comes from and why a source is not there, how it is doing
// now, its limits, a real test, and what its requests did.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppAiSiteOffer, AppAiStatus, AppAiView } from '../../lib/appAi';
import { useAuthStore } from '../../stores/authStore';
import { AppAiPanel } from './AppAiPanel';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.test', isAdmin: false } as never });
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
const modes = () => [...container.querySelectorAll<HTMLInputElement>('input[name="app-ai-mode"]')];
const status = () => container.querySelector('[data-testid="app-ai-status"]')!.textContent;
const offered: AppAiSiteOffer = { offered: true, working: true, reason: null, kinds: ['picture', 'chat'], missing: null };
const view = (over: Partial<AppAiView> = {}): AppAiView => ({
  declared: { uses: ['pictures', 'chat'], purpose: 'Draws your logo.', table: 'ai_jobs', deliver: '/api/site/ai/deliver' },
  settings: { mode: 'off', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500, blocked: false, blockedReason: null, pausedUntil: null, own: null },
  availability: { enabled: false, source: 'off', label: '', kinds: [], reason: 'ai_off' },
  reasonText: 'AI is turned off for this app.',
  siteOffers: true,
  site: offered,
  status: { state: 'off', waiting: 0, running: 0, since: null, message: 'AI is off for this app: it is told so, and nothing is sent anywhere.' },
  today: { jobs: 3, failed: 1, refused: 0 },
  log: [
    { id: 'j1', appJobId: 'a1', kind: 'picture', status: 'done', code: null, message: null, requester: 'Visitor 3f2a91', test: false, createdAt: '2026-11-09 10:00:00.000', finishedAt: '2026-11-09 10:00:41.000', seconds: 38.2 },
    { id: 'j2', appJobId: 'a2', kind: 'picture', status: 'failed', code: 'expired', message: 'The AI was too busy.', requester: 'Visitor 77aa01', test: false, createdAt: '2026-11-09 09:00:00.000', finishedAt: null, seconds: null },
  ],
  ...over,
});
/** The app on the site's AI, in the state given. */
const onSite = (state: Partial<AppAiStatus> = {}, over: Partial<AppAiView> = {}): AppAiView => view({
  settings: { ...view().settings, mode: 'site' },
  availability: { enabled: true, source: 'site', label: 'This site\'s AI', kinds: ['picture', 'chat'], reason: null },
  reasonText: null,
  status: { state: 'idle', waiting: 0, running: 0, since: null, message: 'Ready: This site\'s AI.', ...state },
  ...over,
});

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><AppAiPanel appId="app-1" /></MemoryRouter>));
}

it('says what the app asks for and where its AI comes from, and lists what its requests did', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view() });
  await mount();
  expect(container.textContent).toContain('This app asks for AI for pictures and chat');
  expect(container.textContent).toContain('Draws your logo.');
  expect(status()).toBe('Off. Choose where its AI comes from, then save.');
  expect(container.textContent).toContain('Off: the app is told its AI is off, and nothing is sent anywhere.');
  expect(container.textContent).toContain('Use this site\'s AI: this site\'s own AI answers, within the limits below.');
  expect(container.querySelector('[data-testid="app-ai-site-why"]')).toBeNull();
  expect(container.textContent).toContain('Today: 3 requests, 1 failed, 0 refused');
  expect(container.textContent).toContain('Ran out of time');
  expect(container.textContent).toContain('38.2 s');
  expect(container.textContent).not.toContain('Use my OAIY');
  expect(button('Test a picture')?.disabled).toBe(true);
  expect(container.textContent).toContain('Turn its AI on and save, then test it here.');
});

it.each([
  ['site_ai_closed', false, 'This site does not let apps use its AI yet.'],
  ['site_ai_unavailable', true, 'This site has no AI set up yet.'],
  ['site_ai_gone', true, 'The computer this site\'s AI ran on is gone. An administrator has to choose one again.'],
  ['ai_paused', true, 'The site\'s administrator has paused AI for apps.'],
])('says why the site\'s AI is not there (%s), and what to do about it', async (reason, isOffered, words) => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ siteOffers: isOffered, site: { offered: isOffered, working: false, reason, kinds: [], missing: null } }) });
  await mount();
  expect(container.textContent).toContain('Use this site\'s AI: not available yet.');
  const why = container.querySelector('[data-testid="app-ai-site-why"]')!;
  // Someone who is not an administrator is told who can.
  expect(why.textContent).toBe(`${words} Ask this site's administrator to set it up.`);
  expect(why.querySelector('a')).toBeNull();
  // It can be chosen only where the administrator lets apps use the site's AI at all.
  expect(modes()[1].disabled).toBe(!isOffered);
});

it('gives an administrator a direct link to set the site\'s AI up', async () => {
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.test', isAdmin: true } as never });
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ siteOffers: false, site: { offered: false, working: false, reason: 'site_ai_closed', kinds: [], missing: null } }) });
  await mount();
  const why = container.querySelector('[data-testid="app-ai-site-why"]')!;
  expect(why.textContent).toBe('This site does not let apps use its AI yet. Set up the site\'s AI');
  expect(why.querySelector('a')?.getAttribute('href')).toBe('/admin/platform#app-ai');
});

it('says when the site\'s AI can chat but not make pictures yet', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ site: { offered: true, working: true, reason: null, kinds: ['chat'], missing: { kinds: ['picture'], reason: 'model_unset' } } }) });
  await mount();
  expect(container.textContent).toContain('Use this site\'s AI: this site\'s own AI answers, within the limits below.');
  expect(container.querySelector('[data-testid="app-ai-site-why"]')!.textContent)
    .toBe('For now it can do chat only. No picture model is chosen for this site\'s AI yet, so it cannot make pictures. Ask this site\'s administrator to set it up.');
  expect(modes()[1].disabled).toBe(false);
});

it('reads an older server, which says only whether the site\'s AI is offered', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ siteOffers: false, site: undefined }) });
  await mount();
  expect(container.querySelector('[data-testid="app-ai-site-why"]')!.textContent).toContain('This site does not let apps use its AI yet.');
  expect(modes()[1].disabled).toBe(true);
});

it('saves the source and limits as numbers, and says how it is doing once saved', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view() });
  const put = vi.spyOn(api, 'putAppAi').mockResolvedValue({ data: onSite({}, { settings: { ...view().settings, mode: 'site', perIpDay: 5 } }) });
  await mount();
  await act(async () => modes()[1].click());
  // What is chosen is not saved yet: a test would not use it.
  expect(button('Test a picture')?.disabled).toBe(true);
  expect(container.textContent).toContain('Save first. A test uses what is saved.');
  const perIpDay = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(perIpDay, '5');
    perIpDay.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="app-ai-saved"]')).toBeNull();
  await act(async () => button('Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { mode: 'site', perRequesterDay: 10, perIpDay: 5, perIpHour: 10, perAppDay: 500 });
  expect(container.querySelector('[data-testid="app-ai-saved"]')!.textContent).toBe('Saved. Ready. This site\'s AI answers.');
  expect(status()).toBe('Ready. This site\'s AI answers.');
  expect(button('Test a picture')?.disabled).toBe(false);
});

it.each<[string, AppAiView, RegExp]>([
  ['ready, for chat only', onSite({}, { availability: { enabled: true, source: 'site', label: 'This site\'s AI', kinds: ['chat'], reason: null } }), /^Ready\. This site's AI answers, for chat only: no picture model is chosen yet\.$/],
  ['busy', onSite({ state: 'busy', running: 1, waiting: 3 }), /^Busy\. 1 being made, 3 waiting\.$/],
  ['offline', onSite({ state: 'offline', offlineSince: '2026-11-09 07:00:00' }), /^Offline since .+\. The computer its AI runs on is not answering\. Requests wait for it, for up to 30 minutes\.$/],
  ['offline, never heard from', onSite({ state: 'offline', offlineSince: null }), /^Offline\. The computer its AI runs on is not answering\./],
  ['paused', onSite({ state: 'paused', message: 'The site\'s administrator has paused AI for apps.' }), /^Paused\. The site's administrator has paused AI for apps\.$/],
  ['stopped', onSite({ state: 'blocked', message: 'An administrator stopped this app\'s AI: Complaints' }), /^Stopped\. An administrator stopped this app's AI: Complaints$/],
  ['on, and not working', onSite({ state: 'off', message: 'This site has no AI set up yet.' }), /^Not working\. This site has no AI set up yet\.$/],
])('says how the app\'s AI is doing: %s', async (_name, state, words) => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: state });
  await mount();
  expect(status()).toMatch(words);
});

it('runs a test and shows its picture, with the time it took, when it is done', async () => {
  const read = vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: onSite() });
  vi.spyOn(api, 'testAppAi').mockResolvedValue({ data: { jobId: 'f'.repeat(32) } });
  const follow = vi.spyOn(api, 'getAppAiTest')
    .mockResolvedValueOnce({ data: { status: 'queued', waitedSeconds: 1 } })
    .mockResolvedValueOnce({ data: { status: 'running', waitedSeconds: 4 } })
    .mockResolvedValueOnce({ data: { status: 'done', picture: 'data:image/png;base64,iVBORw0KGgo=', model: 'flux-3-image-klein', seed: 42, seconds: 37.5 } });
  await mount();
  await act(async () => button('Test a picture')!.click());
  const result = () => container.querySelector('[data-testid="ai-test"]')!.textContent;
  expect(result()).toContain('Test picture: Waiting for its turn…');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result()).toContain('Test picture: Waiting for its turn…');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result()).toContain('Test picture: Drawing… 4 s');
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(follow).toHaveBeenCalledTimes(3);
  expect(result()).toContain('Test picture: It works');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(result()).toContain('Made in 37.5 s · with flux-3-image-klein · seed 42');
  // Today's numbers and the log now count it.
  expect(read).toHaveBeenCalledTimes(2);
});

it('says why a test failed, and what to try', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: onSite() });
  vi.spyOn(api, 'testAppAi').mockResolvedValue({ data: { jobId: 'f'.repeat(32) } });
  vi.spyOn(api, 'getAppAiTest').mockResolvedValue({ data: { status: 'failed', code: 'timeout', message: 'The AI took too long.' } });
  await mount();
  await act(async () => button('Test a picture')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  const result = container.querySelector('[data-testid="ai-test"]')!;
  expect(result.textContent).toContain('Test picture: It failed');
  expect(result.querySelector('[role="alert"]')?.textContent).toBe('The AI took too long. The AI did not answer in time. Check the computer is on and OAIY is running.');
});

it('says why it cannot be read', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ error: 'App not found or access denied', status: 404 });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('App not found or access denied');
});

it('uses the owner\'s own OAIY: their only computer is chosen, its picture models listed, and one suggested', async () => {
  const computers = [{ connectionId: 'dc-1', instanceId: 'inst-1', deviceName: 'Home PC', fingerprint: 'AAAA BBBB', online: true, lastSeenAt: null }];
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ computers }) });
  const models = vi.spyOn(api, 'getAppAiModels').mockResolvedValue({ data: { models: [{ id: 'nanbeige', name: 'nanbeige' }, { id: 'sdxl', name: 'SD XL', type: 'image' }, { id: 'flux-3-image-klein', name: 'flux-3-image-klein', type: 'image' }] } });
  const put = vi.spyOn(api, 'putAppAi').mockResolvedValue({ data: view({ computers, settings: { ...view().settings, mode: 'own', own: { connectionId: 'dc-1', deviceName: 'Home PC', providerId: 'oaiy-engine', pictureModel: 'flux-3-image-klein', chatModel: null } } }) });
  await mount();
  expect(models).not.toHaveBeenCalled();
  await act(async () => modes()[2].click());
  const own = container.querySelector('[data-testid="app-ai-own"]')!;
  expect(own.querySelector<HTMLInputElement>('input[name="app-ai-own-computer"]')!.checked).toBe(true);
  expect(own.textContent).toContain('Home PConline');
  expect(models).toHaveBeenCalledTimes(1);
  expect(models).toHaveBeenCalledWith('app-1', 'dc-1', 'oaiy-engine');
  const select = own.querySelector('select')!;
  expect([...select.options].map((option) => option.textContent)).toEqual(['None: no pictures', 'SD XL (sdxl)', 'flux-3-image-klein']);
  expect(select.value).toBe('flux-3-image-klein');
  expect(own.textContent).toContain('Suggested: flux-3-image-klein. Save to use it.');
  expect(own.textContent).toContain('Chat is answered by the model chosen in OAIY on Home PC.');
  await act(async () => button('Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { mode: 'own', perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500, own: { connectionId: 'dc-1', providerId: 'oaiy-engine', pictureModel: 'flux-3-image-klein' } });
});

it('links a computer right there when the owner has none, and saves nothing until there is one', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ computers: [] }) });
  const models = vi.spyOn(api, 'getAppAiModels');
  const put = vi.spyOn(api, 'putAppAi');
  await mount();
  await act(async () => modes()[2].click());
  const own = container.querySelector('[data-testid="app-ai-own"]')!;
  expect(own.textContent).toContain('No computer of yours can answer yet. Link the one that runs OAIY:');
  expect([...own.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['Connect an OAIY server']);
  expect(own.querySelector('a')?.getAttribute('href')).toBe('/settings#local-runtime');
  expect(button('Save')!.disabled).toBe(true);
  expect(container.textContent).toContain('Link a computer above first. Then you can save.');
  expect(models).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it('has the owner pick between two computers, and type the model for one that is offline', async () => {
  const computers = [
    { connectionId: 'dc-1', instanceId: 'inst-1', deviceName: 'Home PC', fingerprint: 'AAAA', online: false, lastSeenAt: '2026-11-09 07:00:00' },
    { connectionId: 'dc-2', instanceId: 'inst-2', deviceName: 'Office PC', fingerprint: 'BBBB', online: true, lastSeenAt: null },
  ];
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view({ computers }) });
  const models = vi.spyOn(api, 'getAppAiModels').mockResolvedValue({ data: { models: [{ id: 'sdxl', name: 'sdxl', type: 'image' }] } });
  await mount();
  await act(async () => modes()[2].click());
  const own = container.querySelector('[data-testid="app-ai-own"]')!;
  const picks = [...own.querySelectorAll<HTMLInputElement>('input[name="app-ai-own-computer"]')];
  expect(picks.map((pick) => pick.checked)).toEqual([false, false]);
  expect(button('Save')!.disabled).toBe(true);
  await act(async () => picks[0].click());
  expect(models).not.toHaveBeenCalled();
  expect(own.querySelector('input#app-ai-own-picture-model')).not.toBeNull();
  expect(own.textContent).toContain('The computer is offline, so it cannot list its models now.');
  expect(button('Save')!.disabled).toBe(false);
  await act(async () => picks[1].click());
  expect(models).toHaveBeenCalledWith('app-1', 'dc-2', 'oaiy-engine');
  expect(own.querySelector('select')?.value).toBe('sdxl');
  expect(own.textContent).toContain('Is it another computer? Link it here:');
});
