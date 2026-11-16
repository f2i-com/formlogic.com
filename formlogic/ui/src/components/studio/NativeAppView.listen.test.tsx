// @vitest-environment jsdom
// Listening for a hosted SoftN app (its formlogicDictate bridge): only where its owner chose it;
// FormLogic asks the person itself the first time, opens the microphone in its own page, shows
// that it is listening with a Stop of its own, and gives the app the words and nothing else. The
// microphone is let go however the session ends.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeHost } from '../../lib/nativeHost';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), listenNative: vi.fn(), frames: [] as Array<{ host?: NativeHost }> }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn(), listenNative: mocks.listenNative } }));
vi.mock('./HostedAppFrame', () => ({
  HostedAppFrame: (props: { host?: NativeHost }) => { mocks.frames.push(props); return <div data-testid="frame">the app</div>; },
}));

import { NativeAppView } from './NativeAppView';
import { DICTATION_MAX_SECONDS } from '../../lib/dictationAudio';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Asks = { listen?: boolean; offers?: boolean; formlogic?: { visitors?: boolean } };
const runtime = (asks: Asks, access: 'application' | 'members', appId: string, userId: string) => ({
  data: {
    name: 'Narrator',
    project: {
      version: 1, client: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>' }, assets: {}, access, origins: [],
      storageScope: access === 'members' ? { access, appId, userId } : { access, appId },
      ...asks,
    },
  },
});

// The microphone and the sound from it, as a browser hands them to the page.
type Processor = { connect: () => void; disconnect: () => void; onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null };
const contexts: Array<{ close: ReturnType<typeof vi.fn>; processor: Processor }> = [];
const streams: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
const getUserMedia = vi.fn();
const stream = () => { const track = { stop: vi.fn() }; streams.push(track); return { getTracks: () => [track] }; };
/** The device handing over `seconds` of sound at its 48 kHz. */
const hear = (seconds: number, context = contexts[contexts.length - 1]) => {
  for (let left = Math.round(seconds * 48000); left > 0; left -= 4800) context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(Math.min(4800, left)).fill(0.25) } });
};
/** Every microphone that was opened has been let go: its track stopped and its audio context closed. */
const released = () => streams.length > 0 && streams.every(track => track.stop.mock.calls.length === 1) && contexts.every(context => context.close.mock.calls.length === 1);

let root: Root | null = null;
let container: HTMLElement | null = null;
async function open(asks: Asks = { listen: true }, { access = 'application' as 'application' | 'members', appId = 'app-one', userId = 'member-a', plugin = false } = {}) {
  mocks.getNativeRuntime.mockResolvedValue(runtime(asks, access, appId, userId));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<NativeAppView slug="narrator" plugin={plugin ? { context: {}, onDone: () => {} } : undefined} />); });
  await act(async () => {});
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null; container?.remove(); container = null;
}
const host = () => mocks.frames[mocks.frames.length - 1].host!;
/** The app's call, answered as the app is answered. */
const ask = (op: string) => act(async () => host().dictate({ op }));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const question = () => document.querySelector('[data-testid="listen-question"]');
const bar = () => document.querySelector('[data-testid="listening-bar"]');
async function press(label: string, within: ParentNode = document) {
  const button = [...within.querySelectorAll('button')].find(node => node.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
  await settle();
}
function signIn(id: string) {
  useAuthStore.setState({ user: { id, email: `${id}@example.test` } as never });
  setSessionOwner(id); bumpSessionGeneration();
}
/** Already allowed on this device, so the app's start opens the microphone at once. */
const allowed = (appId = 'app-one') => localStorage.setItem(`formlogic:native-listen:v1:${appId}`, 'allow');
const wavOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  mocks.frames.length = 0; contexts.length = 0; streams.length = 0;
  mocks.listenNative.mockReset().mockResolvedValue({ data: { text: 'hello there', seconds: 1 } });
  getUserMedia.mockReset().mockImplementation(async () => stream());
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000;
    destination = {};
    close = vi.fn(async () => undefined);
    resume = vi.fn(async () => undefined);
    processor: Processor = { connect: () => {}, disconnect: () => {}, onaudioprocess: null };
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createScriptProcessor() { return this.processor; }
  });
  signIn('member-a');
});
afterEach(async () => {
  await close();
  delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
  vi.unstubAllGlobals();
  setSessionOwner(null); useAuthStore.setState({ user: null });
});

describe('what the page can do for the app', () => {
  it('listens only where the owner chose it and the browser has a microphone to ask for', async () => {
    await open({ listen: true });
    expect(host().abilities()).toEqual({ dictate: true, addApp: false });
    await close();
    await open({});
    expect(host().abilities()).toEqual({ dictate: false, addApp: false });
    await close();
    await open({ listen: true, offers: true });
    delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
    expect(host().abilities()).toEqual({ dictate: false, addApp: true });
    expect(await ask('start')).toEqual({ state: 'refused', reason: 'no_microphone' });
  });

  it('is nothing a plugin\'s page may ask for', async () => {
    await open({ listen: true, offers: true }, { plugin: true });
    expect(mocks.frames[mocks.frames.length - 1].host).toBeUndefined();
  });
});

describe('listening', () => {
  it('is refused where the owner has it off, and nobody is asked', async () => {
    await open({});
    expect(await ask('start')).toEqual({ state: 'refused', reason: 'off' });
    expect(question()).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(await ask('status')).toEqual({ state: 'idle' });
  });

  it('is asked for by FormLogic itself the first time, over the running app, before any microphone is opened', async () => {
    await open();
    expect(await ask('start')).toEqual({ state: 'asking' });
    const dialog = question()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Let Narrator hear you?');
    expect(dialog.textContent).toContain('FormLogic listens while you speak and gives Narrator only the words. The sound is not kept.');
    expect([...dialog.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow', 'Not now']);
    // The keyboard is on the question, and on neither answer.
    expect(document.activeElement).toBe(dialog);
    expect(document.querySelector('[data-testid="frame"]'), 'the app is still open under it').not.toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(await ask('status')).toEqual({ state: 'asking' });
    expect(await ask('start'), 'one session at a time').toEqual({ state: 'refused', reason: 'busy' });
  });

  it('Not now ends it as denied, and is not remembered', async () => {
    await open();
    await ask('start');
    await press('Not now');
    expect(question()).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(await ask('status')).toEqual({ state: 'idle', reason: 'denied' });
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    expect(localStorage.getItem('formlogic:native-listen:v1:app-one')).toBeNull();
    // Asked again the next time, and Escape is a no too.
    expect(await ask('start')).toEqual({ state: 'asking' });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(question()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'idle', reason: 'denied' });
  });

  it('Allow opens the microphone, and FormLogic says outside the app that it is listening', async () => {
    await open();
    await ask('start');
    await press('Allow');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } });
    expect(question()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'listening', level: 0 });
    const shown = bar()!;
    expect(shown.getAttribute('role')).toBe('group');
    expect(shown.querySelector('[role="status"]')!.textContent).toBe('Narrator is listening');
    expect(shown.querySelector('button')!.textContent).toBe('Stop');
    expect(document.querySelector('[data-testid="frame"]')!.contains(shown), 'not in the app\'s frame').toBe(false);
    hear(0.5);
    const status = await ask('status') as { state: string; level: number };
    expect(status.state).toBe('listening');
    expect(status.level).toBeGreaterThan(0.5);
    expect(status.level).toBeLessThanOrEqual(1);
    expect(await ask('start')).toEqual({ state: 'refused', reason: 'busy' });
  });

  it('remembers Allow for this app on this device, and asks again for another app', async () => {
    await open();
    await ask('start');
    await press('Allow');
    expect(localStorage.getItem('formlogic:native-listen:v1:app-one')).toBe('allow');
    await close();
    await open();
    expect(await ask('start'), 'not asked again: the microphone is open as it answers').toEqual({ state: 'listening' });
    expect(question()).toBeNull();
    expect(bar()).not.toBeNull();
    await close();
    await open({ listen: true }, { appId: 'app-two' });
    expect(await ask('start')).toEqual({ state: 'asking' });
    expect(question()).not.toBeNull();
  });

  it('keeps a member\'s Allow as theirs: another account on this browser is asked for itself', async () => {
    await open({ listen: true }, { access: 'members' });
    await ask('start');
    await press('Allow');
    expect(localStorage.getItem('formlogic:native-listen:v1:app-one:member-a')).toBe('allow');
    await close();
    signIn('member-b');
    await open({ listen: true }, { access: 'members', userId: 'member-b' });
    expect(await ask('start')).toEqual({ state: 'asking' });
    expect(question()).not.toBeNull();
  });

  it('gives the app the words on stop: the recording goes to the server as a 16 kHz mono WAV, and the microphone is let go', async () => {
    allowed();
    await open();
    await ask('start');
    hear(1);
    expect(await ask('stop')).toEqual({ text: 'hello there', seconds: 1 });
    expect(mocks.listenNative).toHaveBeenCalledTimes(1);
    const [slug, audio, signal, visitor] = mocks.listenNative.mock.calls[0] as [string, string, AbortSignal, boolean];
    expect(slug).toBe('narrator');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(visitor).toBe(false);
    expect(audio.startsWith('data:'), 'base64 alone').toBe(false);
    const wav = wavOf(audio);
    const data = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4), ...wav.subarray(8, 12))).toBe('RIFFWAVE');
    expect([data.getUint16(22, true), data.getUint32(24, true), data.getUint16(34, true)]).toEqual([1, 16000, 16]);
    expect(wav.length).toBe(44 + 16000 * 2);
    expect(released()).toBe(true);
    expect(bar()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'idle' });
    // Nothing is left to stop.
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    expect(mocks.listenNative).toHaveBeenCalledTimes(1);
  });

  it('marks the recording as the app\'s visitor\'s where the app\'s own requests are marked', async () => {
    allowed();
    await open({ listen: true, formlogic: { visitors: true } });
    await ask('start');
    hear(1);
    await ask('stop');
    expect(mocks.listenNative.mock.calls[0][3]).toBe(true);
  });

  it('says why there are no words', async () => {
    allowed();
    await open();
    // A press with nothing said is not sent.
    await ask('start');
    hear(0.2);
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    expect(mocks.listenNative).not.toHaveBeenCalled();
    const answers: Array<[unknown, string]> = [
      [{ data: { text: '  ', seconds: 1 } }, 'nothing'],
      [{ error: 'Too many requests. Please try again later.', status: 429 }, 'limit'],
      [{ error: 'The speech server did not answer.', status: 502, code: 'listen_failed' }, 'failed'],
      [{ error: 'Listening is not turned on for this app.', status: 403, code: 'listen_off' }, 'failed'],
      [{ error: 'Network error', transportFailure: true }, 'failed'],
    ];
    for (const [answer, reason] of answers) {
      mocks.listenNative.mockResolvedValueOnce(answer);
      await ask('start');
      hear(1);
      expect(await ask('stop'), reason).toEqual({ text: '', reason });
    }
    mocks.listenNative.mockRejectedValueOnce(new Error('offline'));
    await ask('start');
    hear(1);
    expect(await ask('stop')).toEqual({ text: '', reason: 'failed' });
    expect(released()).toBe(true);
  });

  it('is stopped from FormLogic\'s own Stop, which holds what was said for the app', async () => {
    allowed();
    await open();
    await ask('start');
    hear(2);
    await press('Stop', bar()!);
    expect(released()).toBe(true);
    expect(bar()).toBeNull();
    expect(mocks.listenNative, 'nothing is sent until the app asks for the words').not.toHaveBeenCalled();
    expect(await ask('status')).toEqual({ state: 'ended' });
    mocks.listenNative.mockResolvedValue({ data: { text: 'two seconds of talk', seconds: 2 } });
    expect(await ask('stop')).toEqual({ text: 'two seconds of talk', seconds: 2 });
    expect(wavOf(mocks.listenNative.mock.calls[0][1] as string).length).toBe(44 + 2 * 16000 * 2);
    expect(await ask('status')).toEqual({ state: 'idle' });
  });

  it('stops by itself at the limit, and holds what was said', async () => {
    allowed();
    await open();
    await ask('start');
    await act(async () => { hear(DICTATION_MAX_SECONDS + 3); });
    expect(await ask('status')).toEqual({ state: 'ended' });
    expect(released()).toBe(true);
    expect(bar()).toBeNull();
    await ask('stop');
    expect(wavOf(mocks.listenNative.mock.calls[0][1] as string).length).toBe(44 + DICTATION_MAX_SECONDS * 16000 * 2);
  });

  it('lets a new session start over an ended one, whose words are let go', async () => {
    allowed();
    await open();
    await ask('start');
    hear(1);
    await press('Stop', bar()!);
    expect(await ask('start')).toEqual({ state: 'listening' });
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    expect(mocks.listenNative).not.toHaveBeenCalled();
  });

  it('cancel lets the microphone go and sends nothing', async () => {
    allowed();
    await open();
    await ask('start');
    hear(1);
    expect(await ask('cancel')).toEqual({ cancelled: true });
    expect(released()).toBe(true);
    expect(bar()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'idle' });
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    expect(mocks.listenNative).not.toHaveBeenCalled();
    // And while the person is still being asked: the question goes with it.
    localStorage.clear();
    await ask('start');
    expect(question()).not.toBeNull();
    expect(await ask('cancel')).toEqual({ cancelled: true });
    expect(question()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'idle' });
  });

  it('lets the microphone go when the page goes', async () => {
    allowed();
    await open();
    await ask('start');
    hear(1);
    expect(released()).toBe(false);
    await close();
    expect(released()).toBe(true);
    expect(mocks.listenNative).not.toHaveBeenCalled();
  });

  it('lets the microphone go when the app\'s frame goes or is opened again', async () => {
    allowed();
    await open();
    await ask('start');
    hear(1);
    await act(async () => { host().gone(); });
    expect(released()).toBe(true);
    expect(bar()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'idle' });
    // What an ended session held goes too: the frame that would have asked for it is gone.
    await ask('start');
    hear(1);
    await press('Stop', bar()!);
    await act(async () => { host().gone(); });
    expect(await ask('status')).toEqual({ state: 'idle' });
  });

  it('says so when the browser or the person refuses the microphone, or there is none', async () => {
    allowed();
    await open();
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    expect(await ask('start')).toEqual({ state: 'refused', reason: 'denied' });
    expect(await ask('status')).toEqual({ state: 'idle', reason: 'denied' });
    expect(bar()).toBeNull();
    getUserMedia.mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'));
    expect(await ask('start')).toEqual({ state: 'refused', reason: 'no_microphone' });
    expect(await ask('status')).toEqual({ state: 'idle', reason: 'no_microphone' });
    // Anything else is a failure, which the app learns as it asks how things stand.
    getUserMedia.mockRejectedValueOnce(new DOMException('Could not start audio source', 'NotReadableError'));
    expect(await ask('start')).toEqual({ state: 'asking' });
    expect(await ask('status')).toEqual({ state: 'idle', reason: 'failed' });
    expect(await ask('stop')).toEqual({ text: '', reason: 'failed' });
    expect(bar()).toBeNull();
  });

  it('answers at once while the browser asks, shows that it is waiting, and lets go of a microphone that opens after Stop', async () => {
    allowed();
    await open();
    let grant: (value: unknown) => void = () => {};
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    const began = Date.now();
    expect(await ask('start')).toEqual({ state: 'asking' });
    expect(Date.now() - began, 'the app is not kept waiting for the person').toBeLessThan(2000);
    expect(await ask('status')).toEqual({ state: 'asking' });
    expect(bar()!.querySelector('[role="status"]')!.textContent).toBe('Opening the microphone for Narrator');
    await press('Stop', bar()!);
    expect(bar()).toBeNull();
    expect(await ask('status')).toEqual({ state: 'ended' });
    await act(async () => { grant(stream()); });
    await settle();
    expect(released(), 'opened after it was stopped, and let go as it opened').toBe(true);
    expect(await ask('stop')).toEqual({ text: '', reason: 'nothing' });
    // The same when the person says yes in time: it is listening by the next time the app asks.
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    expect(await ask('start')).toEqual({ state: 'asking' });
    await act(async () => { grant(stream()); });
    await settle();
    expect(await ask('status')).toEqual({ state: 'listening', level: 0 });
    expect(bar()!.querySelector('[role="status"]')!.textContent).toBe('Narrator is listening');
  });

  it('tells the app an action it does not know', async () => {
    await open();
    await expect(host().dictate({ op: 'record' })).rejects.toThrow('Unknown dictation action.');
    await expect(host().dictate({})).rejects.toThrow('Unknown dictation action.');
  });
});
