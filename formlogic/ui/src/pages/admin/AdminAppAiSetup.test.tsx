// @vitest-environment jsdom
// Admin → Platform → AI for apps: the setup checklist, in each state it has. Five lines, each with
// its live state and one action, and a summary above them.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, DEFAULT_PLATFORM_PLANS, type SiteAiDesktopState } from '../../lib/api';
import type { AppAiAdminView, AppAiSetup, AppAiSiteSettings } from '../../lib/appAi';
import { AdminAppAiSetup } from './AdminAppAiSetup';

vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

const settings: AppAiSiteSettings = { allowApps: false, paused: false, pictureModel: null, chatModel: null, defaults: { perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500 }, siteDay: 2000, words: [] };
const ready: AppAiSiteSettings = { ...settings, allowApps: true, pictureModel: 'flux-3-image-klein' };
const nothing = (over: Partial<AppAiSetup> = {}): AppAiSetup => ({
  source: 'none', computer: null, gone: null, provider: { named: false, on: false }, drawing: true, kinds: [], reason: 'site_ai_unavailable', ready: false, workerIdleSeconds: 20, lastTest: null, ...over,
});
/** A computer chosen for the site's AI. */
const chosen = (over: Partial<AppAiSetup> = {}, computer: Partial<NonNullable<AppAiSetup['computer']>> = {}): AppAiSetup => nothing({
  source: 'computer', computer: { connectionId: 'dc-1', deviceName: 'Studio PC', providerId: 'oaiy-engine', online: true, lastSeenAt: '2026-11-09 10:00:00', ...computer }, kinds: ['chat'], reason: null, ...over,
});
const pc = { connectionId: 'dc-1', instanceId: 'inst-1', deviceName: 'Studio PC', fingerprint: 'AAAA', online: true, lastSeenAt: '2026-11-09 10:00:00' };
const laptop = { connectionId: 'dc-2', instanceId: 'inst-2', deviceName: 'Laptop', fingerprint: 'BBBB', online: false, lastSeenAt: '2026-11-08 09:00:00' };
const linked = (...candidates: SiteAiDesktopState['candidates']): SiteAiDesktopState => ({ current: null, candidates, engineProvider: 'oaiy-engine' });
const MODELS = [{ id: 'nanbeige', name: 'nanbeige' }, { id: 'sdxl', name: 'SD XL', type: 'image' }, { id: 'flux-3-image-klein', name: 'FLUX 3 Klein', type: 'image' }, { id: 'ltx-2.5', name: 'ltx-2.5', type: 'video' }];
const saved = (next: AppAiSiteSettings): AppAiAdminView => ({ settings: next, apps: [], warnings: [] });

async function mount(setup: AppAiSetup, now: AppAiSiteSettings = settings, desktop: SiteAiDesktopState | null = linked()) {
  const onReload = vi.fn(async () => {});
  const onSaved = vi.fn();
  const element = (next: AppAiSetup, computers: SiteAiDesktopState | null) => <MemoryRouter><AdminAppAiSetup setup={next} settings={now} desktop={computers} onReload={onReload} onSaved={onSaved} /></MemoryRouter>;
  root = createRoot(container);
  await act(async () => root!.render(element(setup, desktop)));
  return { onReload, onSaved, again: (next: AppAiSetup, computers: SiteAiDesktopState | null) => act(async () => root!.render(element(next, computers))) };
}
const step = (number: number) => container.querySelector<HTMLElement>(`[data-testid="ai-setup-step-${number}"]`)!;
const done = () => [1, 2, 3, 4, 5].map((number) => step(number).dataset.done === 'yes');
const title = (number: number) => step(number).querySelector('h3')!.firstChild!.textContent;
const summary = () => container.querySelector('[data-testid="ai-setup-summary"]')!.textContent;
const button = (label: string, within: ParentNode = container) => [...within.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
const type = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

it('starts from nothing: four steps left, and the first is to link a computer', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels');
  await mount(nothing());
  expect(summary()).toBe('4 steps left before apps can make pictures.');
  expect(done()).toEqual([false, false, false, false, false]);
  expect(title(1)).toBe('A computer for the site\'s AI');
  expect(step(1).textContent).toContain('None yet. Link the computer that runs OAIY:');
  expect(button('Connect an OAIY server', step(1))).toBeDefined();
  // A desktop links from Settings instead.
  expect(step(1).querySelector('a')?.getAttribute('href')).toBe('/settings#local-runtime');
  expect(step(2).textContent).toContain('Link a computer first.');
  expect(step(4).textContent).toContain('Choose where the site\'s AI runs first.');
  expect(button('Make a test picture')!.disabled).toBe(true);
  expect(button('Test chat')!.disabled).toBe(true);
  expect(step(5).textContent).toContain('Choose where the site\'s AI runs first (steps 1 and 2).');
  expect(models).not.toHaveBeenCalled();
  // Nothing has been sent anywhere yet, so the worker is not what is missing.
  expect(container.textContent).not.toContain('Nothing is running the AI worker');
});

it('makes a linked computer the site\'s AI with one click, and leaves members\' Site AI alone', async () => {
  const choose = vi.spyOn(api, 'adminPutSiteAiDesktop').mockResolvedValue({ data: linked(pc) });
  const plans = vi.spyOn(api, 'adminPutPlans');
  const { onReload } = await mount(nothing(), settings, linked(pc, laptop));
  expect(summary()).toBe('3 steps left before apps can make pictures.');
  expect(done()).toEqual([true, false, false, false, false]);
  expect(step(1).textContent).toMatch(/Studio PC \(online\), Laptop \(offline since .+\) are linked\./);
  expect(button('Connect an OAIY server')).toBeUndefined();
  const rows = [...step(2).querySelectorAll('li')];
  expect(rows.map((row) => row.textContent)).toEqual([expect.stringMatching(/^Studio PC · onlineUse this computer$/), expect.stringMatching(/^Laptop · offline since .+Use this computer$/)]);
  await act(async () => button('Use this computer', rows[0])!.click());
  expect(choose).toHaveBeenCalledWith('dc-1');
  expect(plans).not.toHaveBeenCalled();
  expect(onReload).toHaveBeenCalledTimes(1);
});

it('lists the chosen computer\'s picture models itself, and suggests FLUX 3 Klein', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: saved(ready) });
  const { onSaved } = await mount(chosen(), { ...settings, allowApps: true }, linked(pc));
  expect(models).toHaveBeenCalledTimes(1);
  expect(models).toHaveBeenCalledWith('dc-1', 'oaiy-engine');
  expect(done()).toEqual([true, true, true, false, false]);
  expect(title(2)).toBe('This site\'s AI runs on it');
  expect(step(2).textContent).toContain('This site\'s AI runs on Studio PC.');
  expect(step(2).textContent).toContain('Members\' own Site AI is a separate switch: “Offer operator-funded Site AI”, in Plans & AI above. Apps do not need it.');
  expect(summary()).toBe('1 step left before apps can make pictures. Chat already works.');
  const select = step(4).querySelector('select')!;
  expect([...select.options].map((option) => option.textContent)).toEqual(['None: no pictures', 'SD XL (sdxl)', 'FLUX 3 Klein (flux-3-image-klein)']);
  expect(select.value).toBe('flux-3-image-klein');
  expect(step(4).textContent).toContain('Suggested: flux-3-image-klein, from the models on Studio PC.');
  expect(step(4).textContent).toContain('Chat is answered by the model chosen in OAIY on Studio PC.');
  expect(step(4).querySelector('#ai-setup-chat-model')).toBeNull();
  await act(async () => button('Use this model')!.click());
  expect(put).toHaveBeenCalledWith({ ...settings, allowApps: true, pictureModel: 'flux-3-image-klein', chatModel: null });
  expect(onSaved).toHaveBeenCalledWith(saved(ready));
});

it('suggests the computer\'s first picture model when it has no FLUX 3 Klein, and lists a chat provider\'s models', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels').mockImplementation(async (_connection, provider) => ({
    data: { models: provider === 'oaiy-engine' ? [{ id: 'sdxl', name: 'sdxl', type: 'image' }, { id: 'pony', name: 'pony', type: 'image' }] : [{ id: 'llama3', name: 'llama3' }] },
  }));
  await mount(chosen({}, { providerId: 'ollama' }), settings, linked(pc));
  expect(models).toHaveBeenCalledWith('dc-1', 'oaiy-engine');
  expect(models).toHaveBeenCalledWith('dc-1', 'ollama');
  expect(step(4).querySelector<HTMLSelectElement>('#ai-setup-picture-model')!.value).toBe('sdxl');
  const chat = step(4).querySelector<HTMLSelectElement>('#ai-setup-chat-model')!;
  expect([...chat.options].map((option) => option.textContent)).toEqual(['The one the site\'s AI already uses', 'llama3']);
});

it('takes a typed model when the computer is offline, and says it is ready but offline', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels');
  await mount(chosen({ kinds: ['picture', 'chat'], ready: true }, { online: false, lastSeenAt: '2026-11-09 07:00:00' }), ready, linked({ ...pc, online: false }));
  expect(models).not.toHaveBeenCalled();
  expect(summary()).toBe('Ready, but Studio PC is offline. Apps\' requests wait until it is back.');
  expect(step(1).textContent).toMatch(/Studio PC · offline since /);
  const input = step(4).querySelector<HTMLInputElement>('input#ai-setup-picture-model')!;
  expect(input.value).toBe('flux-3-image-klein');
  expect(step(4).textContent).toContain('The computer is offline, so it cannot list its models now. Type the model\'s name exactly as OAIY shows it.');
  expect(step(5).textContent).toContain('Studio PC is offline, so a test waits until it is back.');
  expect(button('Make a test picture')!.disabled).toBe(false);
});

it('says when the computer did not list its models or lists none, and asks again', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels')
    .mockResolvedValueOnce({ error: 'That computer did not answer: it took too long.' })
    .mockResolvedValueOnce({ data: { models: [{ id: 'nanbeige', name: 'nanbeige' }] } })
    .mockResolvedValueOnce({ data: { models: MODELS } });
  await mount(chosen(), settings, linked(pc));
  expect(step(4).querySelector('[role="alert"]')?.textContent).toContain('The computer did not list its models (That computer did not answer: it took too long.). Type the model\'s name, or try the list again.');
  expect(step(4).querySelector('input#ai-setup-picture-model')).not.toBeNull();
  await act(async () => button('try the list again')!.click());
  expect(step(4).textContent).toContain('The computer lists no picture model. Turn one on in OAIY (Engines).');
  await act(async () => button('Check again')!.click());
  expect(models).toHaveBeenCalledTimes(3);
  expect(step(4).querySelector('select')?.value).toBe('flux-3-image-klein');
});

it('says when the chosen computer is gone, and forgets it', async () => {
  const forget = vi.spyOn(api, 'adminDeleteSiteAiDesktop').mockResolvedValue({ data: linked() });
  const { onReload, again } = await mount(nothing({ source: 'gone', gone: { deviceName: 'Studio PC' }, reason: 'site_ai_gone' }), ready);
  expect(summary()).toBe('2 steps left before apps can make pictures.');
  expect(done()).toEqual([false, false, true, true, false]);
  expect(step(1).textContent).toContain('Studio PC was unlinked or has a new key, so nothing is sent to it. Link it again, or forget it.');
  expect(button('Connect an OAIY server', step(1))).toBeDefined();
  expect(button('Make a test picture')!.disabled).toBe(true);
  await act(async () => button('Forget it')!.click());
  expect(forget).toHaveBeenCalledTimes(1);
  expect(onReload).toHaveBeenCalledTimes(1);
  // With another computer linked, the next step is to choose again.
  await again(nothing({ source: 'gone', gone: { deviceName: 'Studio PC' }, reason: 'site_ai_gone' }), linked(laptop));
  expect(step(1).textContent).toContain('Choose a computer again in step 2.');
  expect(button('Use this computer', step(2))).toBeDefined();
});

it('adapts when the site\'s AI is the provider in the server\'s settings: Site AI has to be on', async () => {
  const plans = { ...DEFAULT_PLATFORM_PLANS, paidName: 'Backer' };
  vi.spyOn(api, 'adminGetPlans').mockResolvedValue({ data: { plans } });
  const put = vi.spyOn(api, 'adminPutPlans').mockResolvedValue({ data: { plans: { ...plans, siteAiEnabled: true } } });
  const models = vi.spyOn(api, 'adminOaiyModels');
  const { onReload } = await mount(nothing({ source: 'env', provider: { named: true, on: false } }));
  expect(summary()).toBe('3 steps left before apps can make pictures.');
  expect(done()).toEqual([true, false, false, false, false]);
  expect([title(1), title(2)]).toEqual(['Where the site\'s AI runs', 'Site AI is turned on']);
  expect(step(1).textContent).toContain('This site\'s AI is the AI provider in your server settings. To run it on a computer of your own instead, link one:');
  expect(button('Connect an OAIY server', step(1))).toBeDefined();
  expect(step(2).textContent).toContain('Site AI is off, so the AI provider in your server settings is not used. Turning it on lets apps, and members, use it. Your provider may charge you for each request.');
  expect(step(2).textContent).toContain('It is the same switch as “Offer operator-funded Site AI”, in Plans & AI above.');
  await act(async () => button('Turn on Site AI')!.click());
  expect(put).toHaveBeenCalledWith({ ...plans, siteAiEnabled: true });
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(models).not.toHaveBeenCalled();
});

it('takes the provider\'s model names as typed, for pictures and for chat', async () => {
  const models = vi.spyOn(api, 'adminOaiyModels');
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: saved({ ...ready, pictureModel: 'gpt-image-2', chatModel: 'gpt-5' }) });
  await mount(nothing({ source: 'env', provider: { named: true, on: true }, kinds: ['chat'], reason: null }), { ...settings, allowApps: true });
  expect(summary()).toBe('1 step left before apps can make pictures. Chat already works.');
  expect(step(2).textContent).toContain('On. Apps\' requests go to the AI provider in your server settings, which may charge you for each one.');
  expect(step(4).querySelector('select')).toBeNull();
  expect(step(4).textContent).toContain('Type the picture model\'s name exactly as your provider names it.');
  await type(step(4).querySelector<HTMLInputElement>('#ai-setup-picture-model')!, 'gpt-image-2');
  await type(step(4).querySelector<HTMLInputElement>('#ai-setup-chat-model')!, 'gpt-5');
  await act(async () => button('Use this model')!.click());
  expect(put).toHaveBeenCalledWith({ ...settings, allowApps: true, pictureModel: 'gpt-image-2', chatModel: 'gpt-5' });
  expect(models).not.toHaveBeenCalled();
});

it('offers a linked computer over the provider, and the provider as the other way', async () => {
  vi.spyOn(api, 'adminGetPlans').mockResolvedValue({ data: { plans: DEFAULT_PLATFORM_PLANS } });
  const put = vi.spyOn(api, 'adminPutPlans').mockResolvedValue({ data: { plans: { ...DEFAULT_PLATFORM_PLANS, siteAiEnabled: true } } });
  await mount(nothing({ source: 'env', provider: { named: true, on: false } }), settings, linked(pc));
  expect([title(1), title(2)]).toEqual(['A computer for the site\'s AI', 'This site\'s AI runs on it']);
  expect(button('Use this computer', step(2))).toBeDefined();
  expect(step(2).textContent).toContain('Or use the AI provider in your server settings: turn on Site AI. It may charge you for each request, and members can use it too.');
  await act(async () => button('turn on Site AI')!.click());
  expect(put).toHaveBeenCalledWith({ ...DEFAULT_PLATFORM_PLANS, siteAiEnabled: true });
});

it('says Ready with the model and the computer, and how the last test went', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const lastTest = { status: 'done' as const, at: '2026-11-09 10:00:00', seconds: 37.5, model: 'flux-3-image-klein', code: null, message: null, current: true };
  const { again } = await mount(chosen({ kinds: ['picture', 'chat'], ready: true, lastTest }), ready, linked(pc));
  expect(summary()).toBe('Ready: apps can make pictures with flux-3-image-klein on Studio PC.');
  expect(done()).toEqual([true, true, true, true, true]);
  expect(step(4).textContent).toContain('Apps\' pictures are made with:');
  expect(button('Use this model')).toBeUndefined();
  expect(button('Save', step(4))).toBeUndefined();
  expect(step(5).textContent).toMatch(/The last test worked (at|on) .+, made in 37\.5 s with flux-3-image-klein\./);

  // A test from before the model or the computer changed proves nothing about now.
  await again(chosen({ kinds: ['picture', 'chat'], ready: true, lastTest: { ...lastTest, current: false } }), linked(pc));
  expect(done()[4]).toBe(false);
  expect(step(5).textContent).toMatch(/The last test worked .+ with flux-3-image-klein, but the model, or where the site's AI runs, has changed since\. Make another to be sure\./);
  await again(chosen({ kinds: ['picture', 'chat'], ready: true, lastTest: { ...lastTest, status: 'failed', code: 'model_disabled', message: 'flux-3-image-klein is switched off in Engines.' } }), linked(pc));
  expect(done()[4]).toBe(false);
  expect(step(5).textContent).toMatch(/The last test failed .+: flux-3-image-klein is switched off in Engines\./);
});

it('says Ready on the provider too', async () => {
  await mount(nothing({ source: 'env', provider: { named: true, on: true }, kinds: ['picture', 'chat'], reason: null, ready: true }), { ...ready, pictureModel: 'gpt-image-2' });
  expect(summary()).toBe('Ready: apps can make pictures with gpt-image-2 on the AI provider in your server settings.');
});

it('says when every step is done and it still is not ready: paused, or pictures cannot be prepared', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  await mount(chosen({ kinds: ['picture', 'chat'] }), { ...ready, paused: true }, linked(pc));
  expect(summary()).toBe('Paused: you have paused every app\'s AI. Turn the pause off below when you are ready.');
  await act(async () => root!.unmount());
  root = undefined;
  await mount(chosen({ kinds: ['chat'], drawing: false }), ready, linked(pc));
  expect(summary()).toBe('Not ready: this server cannot prepare pictures for apps. It needs PHP\'s GD extension.');
  expect(button('Make a test picture')!.disabled).toBe(true);
  expect(step(5).textContent).toContain('This server cannot prepare pictures: it needs PHP\'s GD extension.');
});

it('lets apps use the site\'s AI with one switch, saved at once', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const put = vi.spyOn(api, 'adminPutAppAi').mockResolvedValue({ data: saved({ ...settings, allowApps: true }) });
  const { onSaved } = await mount(chosen(), settings, linked(pc));
  const allow = step(3).querySelector<HTMLButtonElement>('button[role="switch"]')!;
  expect(allow.getAttribute('aria-label')).toBe('Apps may use the site\'s AI');
  expect(step(3).textContent).toContain('Off. No app can use the site\'s AI until you turn this on.');
  await act(async () => allow.click());
  expect(put).toHaveBeenCalledWith({ ...settings, allowApps: true });
  expect(onSaved).toHaveBeenCalledWith(saved({ ...settings, allowApps: true }));
});

it('warns when nothing runs the worker, which every request and the test need', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const { again } = await mount(chosen({ workerIdleSeconds: null }), ready, linked(pc));
  expect(step(5).querySelector('[role="alert"]')?.textContent).toContain('Nothing is running the AI worker on this server yet, so apps\' requests, and this test, would only wait.');
  expect(step(5).textContent).toContain('php bin/app-ai-worker.php');
  await again(chosen({ workerIdleSeconds: 600 }), linked(pc));
  expect(step(5).querySelector('[role="alert"]')?.textContent).toContain('(it last ran 10 minutes ago)');
  await again(chosen({ workerIdleSeconds: 45 }), linked(pc));
  expect(step(5).querySelector('[role="alert"]')).toBeNull();
});

it('makes a test picture through the worker and shows it with the time it took', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const start = vi.spyOn(api, 'adminTestAppAi').mockResolvedValue({ data: { jobId: 'f'.repeat(32) } });
  const follow = vi.spyOn(api, 'adminGetAppAiTest')
    .mockResolvedValueOnce({ data: { status: 'queued', waitedSeconds: 1, waiting: 'worker' } })
    .mockResolvedValueOnce({ data: { status: 'queued', waitedSeconds: 5, waiting: 'computer' } })
    .mockResolvedValueOnce({ data: { status: 'running', waitedSeconds: 8 } })
    .mockResolvedValueOnce({ data: { status: 'done', picture: 'data:image/png;base64,iVBORw0KGgo=', model: 'flux-3-image-klein', seed: 42, seconds: 37.5 } });
  const { onReload } = await mount(chosen({ kinds: ['picture', 'chat'], ready: true }), ready, linked(pc));
  await act(async () => button('Make a test picture')!.click());
  expect(start).toHaveBeenCalledWith('picture');
  const result = () => step(5).querySelector('[data-testid="ai-test"]')!.textContent;
  expect(result()).toContain('Test picture: Waiting for its turn…');
  expect(button('Make a test picture')!.disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result()).toContain('Test picture: Waiting, but nothing will start it');
  expect(result()).toContain('Nothing is running the AI worker on this server, so the test cannot start.');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result()).toContain('Test picture: Waiting for Studio PC to come online… 5 s');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result()).toContain('Test picture: Drawing… 8 s');
  expect(onReload).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(follow).toHaveBeenCalledTimes(4);
  expect(result()).toContain('Test picture: It works');
  expect(step(5).querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(result()).toContain('Made in 37.5 s · with flux-3-image-klein · seed 42');
  // The server's word on the last test is read again: it is what marks the line done.
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(button('Make a test picture')!.disabled).toBe(false);
});

it('says why a test failed or could not start, and tests chat too', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const start = vi.spyOn(api, 'adminTestAppAi')
    .mockResolvedValueOnce({ error: 'A test is already running. Wait for it to finish.' })
    .mockResolvedValue({ data: { jobId: 'e'.repeat(32) } });
  vi.spyOn(api, 'adminGetAppAiTest')
    .mockResolvedValueOnce({ data: { status: 'failed', code: 'model_disabled', message: 'flux-3-image-klein is switched off in Engines.' } })
    .mockResolvedValueOnce({ data: { status: 'done', text: 'Hello there, how are you?', model: 'nanbeige', seconds: 2.1 } });
  await mount(chosen({ kinds: ['picture', 'chat'], ready: true }), ready, linked(pc));
  await act(async () => button('Make a test picture')!.click());
  expect(step(5).querySelector('[role="alert"]')?.textContent).toBe('A test is already running. Wait for it to finish.');
  expect(step(5).querySelector('[data-testid="ai-test"]')).toBeNull();

  await act(async () => button('Make a test picture')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  const result = step(5).querySelector('[data-testid="ai-test"]')!;
  expect(result.textContent).toContain('Test picture: It failed');
  expect(result.querySelector('[role="alert"]')?.textContent).toBe('flux-3-image-klein is switched off in Engines. Turn the model on in OAIY (Engines) and check its files have downloaded, or choose another model.');

  await act(async () => button('Test chat')!.click());
  expect(start).toHaveBeenLastCalledWith('chat');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.textContent).toContain('Test chat: It works');
  expect(result.textContent).toContain('Hello there, how are you?');
  expect(result.textContent).toContain('Answered in 2.1 s · with nanbeige');
});

it('offers the other linked computers once one is chosen', async () => {
  vi.spyOn(api, 'adminOaiyModels').mockResolvedValue({ data: { models: MODELS } });
  const choose = vi.spyOn(api, 'adminPutSiteAiDesktop').mockResolvedValue({ data: linked(pc, laptop) });
  await mount(chosen(), settings, linked(pc, laptop));
  expect(step(2).textContent).toContain('Your other linked computers:');
  expect([...step(2).querySelectorAll('li')].map((row) => row.textContent)).toEqual([expect.stringMatching(/^Laptop · offline since .+Use this one instead$/)]);
  await act(async () => button('Use this one instead')!.click());
  expect(choose).toHaveBeenCalledWith('dc-2');
});

it('keeps looking for a server linked by code until it shows up', async () => {
  vi.spyOn(api, 'createDesktopLinkCode').mockResolvedValue({ data: { id: 'code-1', code: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 600_000).toISOString(), scope: 'ai', baseUrl: 'https://forms.example', command: 'oaiy-server link https://forms.example ABCD-EFGH' } });
  vi.spyOn(api, 'getDesktopLinkCode').mockResolvedValue({ data: { id: 'code-1', scope: 'ai', expiresAt: new Date(Date.now() + 600_000).toISOString(), status: 'linked', connectionId: 'dc-1', deviceName: 'Studio PC' } });
  const { onReload, again } = await mount(nothing());
  await act(async () => button('Connect an OAIY server')!.click());
  await act(async () => button('Make a code')!.click());
  expect(step(1).querySelector('[data-testid="oaiy-link-code"]')?.textContent).toBe('ABCD-EFGH');
  expect(onReload).not.toHaveBeenCalled();
  // The server redeemed the code: it shows here once OAIY has started on it.
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(step(1).textContent).toContain('Looking for the new computer. It appears here once OAIY has started on it.');
  expect(onReload).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(onReload).toHaveBeenCalledTimes(2);
  await again(nothing(), linked(pc));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(step(1).textContent).not.toContain('Looking for the new computer');
  expect(button('Use this computer', step(2))).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(onReload).toHaveBeenCalledTimes(2);
});
