// @vitest-environment jsdom
// "This app can use AI. Set it up": one line for the owner of an app that asks for AI and has it off.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppAiView } from '../../lib/appAi';
import { AppAiPrompt } from './AppAiPrompt';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

const view = (mode: 'off' | 'site' | 'own', declared = true): AppAiView => ({
  declared: declared ? { uses: ['pictures'], purpose: 'Draws your logo.', table: 'ai_jobs', deliver: '/api/site/ai/deliver' } : null,
  settings: { mode, perRequesterDay: 10, perIpDay: 20, perIpHour: 10, perAppDay: 500, blocked: false, blockedReason: null, pausedUntil: null, own: null },
  availability: { enabled: mode !== 'off', source: mode, label: '', kinds: [], reason: null },
  reasonText: null,
  siteOffers: true,
  status: { state: mode === 'off' ? 'off' : 'idle', waiting: 0, running: 0, since: null, message: '' },
  today: { jobs: 0, failed: 0, refused: 0 },
  log: [],
});
async function mount(appId = 'app-1') {
  const onSetUp = vi.fn();
  root = createRoot(container);
  await act(async () => root!.render(<AppAiPrompt appId={appId} onSetUp={onSetUp} />));
  return onSetUp;
}
const prompt = () => container.querySelector('[data-testid="app-ai-prompt"]');

it('tells the owner once the app is known to ask for AI and have it off, and leads to its settings', async () => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view('off') });
  const onSetUp = await mount();
  expect(prompt()?.textContent).toBe('This app can use AI. Set it up');
  await act(async () => [...prompt()!.querySelectorAll('button')].find((node) => node.textContent === 'Set it up')!.click());
  expect(onSetUp).toHaveBeenCalledTimes(1);
});

it.each([
  ['its AI is already on', { data: view('site') }],
  ['it does not ask for AI', { data: view('off', false) }],
  ['its settings could not be read', { error: 'App not found or access denied' }],
])('says nothing when %s', async (_name, answer) => {
  vi.spyOn(api, 'getAppAi').mockResolvedValue(answer);
  await mount();
  expect(prompt()).toBeNull();
});

it('can be dismissed, and stays dismissed for that app in this browser', async () => {
  const read = vi.spyOn(api, 'getAppAi').mockResolvedValue({ data: view('off') });
  await mount();
  await act(async () => prompt()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
  expect(prompt()).toBeNull();
  await act(async () => root!.unmount());
  root = undefined;
  await mount();
  expect(prompt()).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  // Another app of theirs is still told.
  await act(async () => root!.unmount());
  root = undefined;
  await mount('app-2');
  expect(prompt()).not.toBeNull();
});
