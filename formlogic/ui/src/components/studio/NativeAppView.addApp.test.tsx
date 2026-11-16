// @vitest-environment jsdom
// A hosted SoftN app offering the person an app it made (its formlogicAddApp bridge): only where
// its owner chose it and only to someone with an account; FormLogic asks in its own sheet, and only
// on Add app are the files fetched from the offering app and the new app made, as an upload is.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppReader, NativeHost } from '../../lib/nativeHost';

const mocks = vi.hoisted(() => ({ getNativeRuntime: vi.fn(), createSoftnApp: vi.fn(), getApps: vi.fn(), getNativeProject: vi.fn(), saveNativeProject: vi.fn(), frames: [] as Array<{ host?: NativeHost }> }));
vi.mock('../../lib/api', () => ({ api: { getNativeRuntime: mocks.getNativeRuntime, getAppMembership: vi.fn(), getApps: mocks.getApps, getNativeProject: mocks.getNativeProject, saveNativeProject: mocks.saveNativeProject } }));
// The importer is the real one: what it refuses of an upload it refuses here.
vi.mock('../../lib/softnApps', () => ({ createSoftnApp: mocks.createSoftnApp }));
vi.mock('./HostedAppFrame', () => ({
  HostedAppFrame: (props: { host?: NativeHost }) => { mocks.frames.push(props); return <div data-testid="frame">the app</div>; },
}));

import { unzipSync, strFromU8 } from 'fflate';
import { NativeAppView } from './NativeAppView';
import { useAuthStore } from '../../stores/authStore';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = (offers: boolean) => ({
  data: {
    name: 'Narrator',
    project: {
      version: 1, client: { 'manifest.json': '{}', 'ui/main.ui': '<Text/>' }, assets: {}, access: 'application' as const, origins: [],
      storageScope: { access: 'application' as const, appId: 'app-one' }, ...(offers ? { offers: true } : {}),
    },
  },
});
const made = { 'manifest.json': JSON.stringify({ name: 'Tiny notes', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Notes</Text>' };
const created = { id: 'app-9', name: 'Tiny notes', slug: 'tiny-notes' };

let root: Root | null = null;
let container: HTMLElement | null = null;
async function open(offers = true) {
  mocks.getNativeRuntime.mockResolvedValue(runtime(offers));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<NativeAppView slug="narrator" />); });
  await act(async () => {});
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null; container?.remove(); container = null;
}
const host = () => mocks.frames[mocks.frames.length - 1].host!;
/** The offering app's backend, answering the page's one read of it. */
let read: ReturnType<typeof vi.fn<AppReader>>;
const ask = (input: Record<string, unknown>) => act(async () => host().addApp(input, read));
const status = () => ask({ op: 'status' });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const sheet = () => document.querySelector('[data-testid="add-app-sheet"]');
const title = () => document.getElementById('fl-add-app-title')?.textContent ?? null;
async function press(label: string) {
  const button = [...document.querySelectorAll('[data-testid="add-app-sheet"] button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  expect(button, label).toBeTruthy();
  await act(async () => { (button as HTMLButtonElement).click(); });
  await settle();
}
function signIn(id: string | null, extra: Record<string, unknown> = {}) {
  useAuthStore.setState({ user: id ? { id, email: `${id}@example.test`, ...extra } as never : null });
  setSessionOwner(id); bumpSessionGeneration();
}

beforeEach(() => {
  mocks.frames.length = 0;
  mocks.createSoftnApp.mockReset().mockResolvedValue({ app: created, project: { version: 1, files: made, assets: {}, access: 'members' } });
  mocks.getApps.mockReset().mockResolvedValue({ data: { apps: [], count: 0 } });
  mocks.getNativeProject.mockReset();
  mocks.saveNativeProject.mockReset();
  read = vi.fn<AppReader>(async () => ({ data: { result: { status: 200, body: { files: made, name: 'Tiny notes' } } } }));
  signIn('member-a');
});
afterEach(async () => { await close(); setSessionOwner(null); useAuthStore.setState({ user: null }); });

describe('an offer', () => {
  it('is refused where the owner has not let the app offer its apps', async () => {
    await open(false);
    expect(host().abilities().addApp).toBe(false);
    expect(await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' })).toEqual({ state: 'refused', reason: 'off' });
    expect(sheet()).toBeNull();
    expect(await status()).toEqual({ state: 'idle' });
  });

  it('is refused to a visitor, and to a session that opens only this app: an app is added to an account', async () => {
    signIn(null);
    await open();
    expect(host().abilities().addApp).toBe(true);
    expect(await ask({ op: 'offer', from: '/api/made/7' })).toEqual({ state: 'refused', reason: 'signed_out' });
    expect(sheet()).toBeNull();
    await close();
    signIn('member-a', { domainSession: true });
    await open();
    expect(await ask({ op: 'offer', from: '/api/made/7' })).toEqual({ state: 'refused', reason: 'signed_out' });
    expect(sheet()).toBeNull();
  });

  it('is refused for an address that is not on the offering app\'s own backend', async () => {
    await open();
    for (const from of [undefined, 7, '', '/made/7', 'https://elsewhere.example/api/made', '/api/site/ai/jobs', '/api/../admin/users', '/api/made?to=http://x', `/api/${'a'.repeat(300)}`]) {
      expect(await ask({ op: 'offer', from, name: 'Tiny notes' }), String(from).slice(0, 40)).toEqual({ state: 'refused', reason: 'invalid' });
    }
    expect(sheet()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('is put to the person in FormLogic\'s own sheet, and nothing is fetched until they say yes', async () => {
    await open();
    expect(await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' })).toEqual({ state: 'asking' });
    const shown = sheet()!;
    expect(shown.getAttribute('role')).toBe('dialog');
    expect(shown.getAttribute('aria-modal')).toBe('true');
    expect(shown.getAttribute('aria-labelledby')).toBe('fl-add-app-title');
    expect(title()).toBe('Add Tiny notes to your apps?');
    expect(shown.textContent).toContain('Narrator made this app and is offering you a copy. It becomes yours: only you can open it until you share it.');
    expect([...shown.querySelectorAll('button')].map(button => button.textContent || button.getAttribute('aria-label'))).toEqual(['Close', 'Add app', 'Not now']);
    expect(document.activeElement, 'the keyboard is on the sheet, not on Add app').toBe(shown);
    expect(document.querySelector('[data-testid="frame"]'), 'the app stays open under it').not.toBeNull();
    expect(await status()).toEqual({ state: 'asking' });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
    expect(await ask({ op: 'offer', from: '/api/made/8', name: 'Another' }), 'one offer at a time').toEqual({ state: 'refused', reason: 'busy' });
    expect(title()).toBe('Add Tiny notes to your apps?');
  });

  it('shows the name the app gave as text, sixty characters of it, and says "this app" for none', async () => {
    await open();
    const given = `<b onclick="x()">Bold</b> ${'n'.repeat(80)}`;
    await ask({ op: 'offer', from: '/api/made/7', name: given });
    expect(sheet()!.querySelector('b')).toBeNull();
    expect(title()).toBe(`Add ${given.slice(0, 60)} to your apps?`);
    await press('Not now');
    await ask({ op: 'offer', from: '/api/made/7' });
    expect(title()).toBe('Add this app to your apps?');
    await press('Not now');
    await ask({ op: 'offer', from: '/api/made/7', name: { toString: () => 'Sneaky' } });
    expect(title()).toBe('Add this app to your apps?');
  });

  it('is declined by Not now, by closing the sheet and by Escape, and another may follow', async () => {
    await open();
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await press('Not now');
    expect(sheet()).toBeNull();
    expect(await status()).toEqual({ state: 'declined', reason: 'declined' });
    expect(await status(), 'it may go on reading the answer').toEqual({ state: 'declined', reason: 'declined' });
    expect(await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' })).toEqual({ state: 'asking' });
    await press('Close');
    expect(await status()).toEqual({ state: 'declined', reason: 'declined' });
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(sheet()).toBeNull();
    expect(await status()).toEqual({ state: 'declined', reason: 'declined' });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('on Add app fetches the files from the offering app and makes the app as an upload is made', async () => {
    await open();
    let hand: (answer: Awaited<ReturnType<AppReader>>) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => { hand = resolve; }));
    await ask({ op: 'offer', from: '/api/made/7?as=softn', name: 'Tiny notes' });
    await press('Add app');
    expect(read).toHaveBeenCalledWith('/api/made/7?as=softn');
    expect(await status()).toEqual({ state: 'adding' });
    expect(sheet()!.querySelector('[role="status"]')!.textContent).toBe('Adding it to your apps…');
    // It is not put away while the app is being made.
    expect([...sheet()!.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(await status()).toEqual({ state: 'adding' });
    expect(await ask({ op: 'offer', from: '/api/made/8' })).toEqual({ state: 'refused', reason: 'busy' });
    await act(async () => { hand({ data: { result: { status: 200, body: JSON.stringify({ data: { files: made, name: 'Tiny notes' } }) } } }); });
    await settle();
    expect(mocks.createSoftnApp).toHaveBeenCalledTimes(1);
    const [{ name, start }] = mocks.createSoftnApp.mock.calls[0] as [{ name: string; start: { kind: string; file: File } }];
    expect([name, start.kind, start.file.name]).toEqual(['Tiny notes', 'upload', 'Tiny notes.softn']);
    const files = unzipSync(new Uint8Array(await start.file.arrayBuffer()));
    expect(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, strFromU8(bytes)]))).toEqual(made);
    expect(await status()).toEqual({ state: 'added', name: 'Tiny notes' });
    expect(title()).toBe('Added to your apps.');
    const link = sheet()!.querySelector('a')!;
    expect(link.textContent).toBe('Open it');
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['/app/tiny-notes', '_blank', 'noopener noreferrer']);
    // Still open: a new offer waits until it is put away.
    expect(await ask({ op: 'offer', from: '/api/made/8' })).toEqual({ state: 'refused', reason: 'busy' });
    await press('Done');
    expect(sheet()).toBeNull();
    expect(await status(), 'read again until the next offer').toEqual({ state: 'added', name: 'Tiny notes' });
    expect(await ask({ op: 'offer', from: '/api/made/8', name: 'Another' })).toEqual({ state: 'asking' });
    expect(await status()).toEqual({ state: 'asking' });
  });

  it('says the new app\'s own name once it is added, whatever name the offer showed', async () => {
    await open();
    mocks.createSoftnApp.mockResolvedValue({ app: { id: 'app-9', name: 'Field notes', slug: 'field-notes' }, project: { version: 1, files: made, assets: {}, access: 'members' } });
    await ask({ op: 'offer', from: '/api/made/7', name: 'Something else' });
    await press('Add app');
    expect(await status()).toEqual({ state: 'added', name: 'Field notes' });
    expect(sheet()!.textContent).toContain('Field notes is yours: only you can open it until you share it.');
  });

  it('adds nothing for files the importer refuses, or too many or too much of them, and says why to the person alone', async () => {
    await open();
    const refused: Array<[unknown, RegExp]> = [
      [{ files: { ...made, 'tool.exe': 'MZ' } }, /tool\.exe is a kind of file this host cannot keep/],
      [{ files: { 'ui/main.ui': '<Text/>' } }, /No app manifest/],
      [{ files: { ...made, 'data/big.json': 'a'.repeat(4 * 1024 * 1024) } }, /not an app FormLogic can add/],
      [{ files: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`ui/p${index}.ui`, '<Text/>'])) }, /not an app FormLogic can add/],
      [{ name: 'Tiny notes' }, /not an app FormLogic can add/],
    ];
    for (const [body, why] of refused) {
      read.mockResolvedValueOnce({ data: { result: { status: 200, body } } });
      await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
      await press('Add app');
      expect(await status()).toEqual({ state: 'failed', reason: 'invalid' });
      expect(title()).toBe('This app could not be added');
      expect(sheet()!.querySelector('[role="alert"]')!.textContent).toMatch(why);
      await press('Close');
      expect(sheet()).toBeNull();
      expect(await status()).toEqual({ state: 'failed', reason: 'invalid' });
    }
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('says the limit for a plan\'s refusal, and failed for anything else', async () => {
    await open();
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('Cloud access has expired. Your data is safe and still exportable — add cloud time to publish, accept responses, and upload again.'));
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await press('Add app');
    expect(await status()).toEqual({ state: 'failed', reason: 'limit' });
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toContain('Cloud access has expired.');
    await press('Close');
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('Could not create the app. Please try again.'));
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await press('Add app');
    expect(await status()).toEqual({ state: 'failed', reason: 'failed' });
    await press('Close');
    read.mockResolvedValueOnce({ error: 'App not found or access denied', status: 404 });
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await press('Add app');
    expect(await status()).toEqual({ state: 'failed', reason: 'failed' });
    expect(mocks.createSoftnApp).toHaveBeenCalledTimes(2);
  });

  it('is dropped when another person signs in: what was offered to one is never shown to the next, nor added for them', async () => {
    await open();
    let hand: (answer: Awaited<ReturnType<AppReader>>) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => { hand = resolve; }));
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await press('Add app');
    await act(async () => { signIn('member-b'); });
    await act(async () => {});
    expect(sheet()).toBeNull();
    expect(await status()).toEqual({ state: 'idle' });
    await act(async () => { hand({ data: { result: { status: 200, body: { files: made } } } }); });
    await settle();
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
    expect(await status()).toEqual({ state: 'idle' });
  });

  it('keeps with the app it adds which app offered it and from where', async () => {
    await open();
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await settle();
    await press('Add app');
    const [{ settings }] = mocks.createSoftnApp.mock.calls[0] as [{ settings?: unknown }];
    expect(settings).toEqual({ softnMadeBy: { app: 'app-one', from: '/api/made/7' } });
  });

  it('offered again from the same place, asks to update the app it added before, which keeps its address and what is in it', async () => {
    const mine = (id: string, from: string, more: Record<string, unknown> = {}) => ({ id, name: `App ${id}`, slug: id, canManage: true, status: 'draft', updatedAt: '2026-11-10 10:00:00', settings: { softnApp: true, softnMadeBy: { app: 'app-one', from } }, ...more });
    mocks.getApps.mockResolvedValue({ data: { apps: [
      mine('older', '/api/made/7'), mine('newer', '/api/made/7', { updatedAt: '2026-11-15 09:00:00', name: 'Tiny notes' }), mine('elsewhere', '/api/made/8'),
      mine('shared', '/api/made/7', { canManage: false, updatedAt: '2026-11-16 09:00:00' }), mine('archived', '/api/made/7', { status: 'archived', updatedAt: '2026-11-16 09:00:00' }),
      { ...mine('other-app', '/api/made/7', { updatedAt: '2026-11-16 09:00:00' }), settings: { softnMadeBy: { app: 'app-two', from: '/api/made/7' } } },
    ], count: 6 } });
    mocks.getNativeProject.mockResolvedValue({ data: { available: true, project: { version: 4, files: { 'manifest.json': '{}' }, assets: {}, access: 'members', home: true } } });
    mocks.saveNativeProject.mockResolvedValue({ data: { project: { version: 5 } } });
    await open();
    expect(await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' })).toEqual({ state: 'asking' });
    await settle();
    expect(title()).toBe('Update Tiny notes?');
    expect(sheet()!.textContent).toContain('Narrator has a new version of Tiny notes, which you added from it before. Updating keeps its address and what has been entered in it, and its history keeps the version it has now.');
    expect([...sheet()!.querySelectorAll('button')].map(button => button.textContent || button.getAttribute('aria-label'))).toEqual(['Close', 'Update it', 'Add a copy', 'Not now']);
    expect(read).not.toHaveBeenCalled();
    await press('Update it');
    expect(read).toHaveBeenCalledWith('/api/made/7');
    expect(mocks.getNativeProject).toHaveBeenCalledWith('newer', { media: 'refs' });
    const [id, project, version, how] = mocks.saveNativeProject.mock.calls[0] as [string, { files: Record<string, string>; home: boolean; access: string }, number, unknown];
    expect([id, version, how, project.home, project.access]).toEqual(['newer', 4, { how: 'upload', summary: 'Updated from Narrator' }, true, 'members']);
    expect(project.files['ui/main.ui']).toBe('<Text>Notes</Text>');
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
    expect(await status()).toEqual({ state: 'added', name: 'Tiny notes', updated: true });
    expect(title()).toBe('Updated.');
    expect(sheet()!.textContent).toContain('Tiny notes is up to date. Its history has the version it had before.');
    expect(sheet()!.querySelector('a')!.getAttribute('href')).toBe('/app/newer');
    await press('Done');
    // A copy may still be added, and an offer from elsewhere is an offer of a new app.
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await settle();
    await press('Add a copy');
    expect(mocks.createSoftnApp).toHaveBeenCalledTimes(1);
    expect(await status()).toEqual({ state: 'added', name: 'Tiny notes' });
    await press('Done');
    await ask({ op: 'offer', from: '/api/made/9', name: 'Fresh' });
    await settle();
    expect(title()).toBe('Add Fresh to your apps?');
  });

  it('says so where the app it added before cannot be updated, and changes nothing else', async () => {
    mocks.getApps.mockResolvedValue({ data: { apps: [{ id: 'mine', name: 'Tiny notes', slug: 'mine', canManage: true, status: 'draft', updatedAt: '', settings: { softnMadeBy: { app: 'app-one', from: '/api/made/7' } } }], count: 1 } });
    mocks.getNativeProject.mockResolvedValue({ data: { available: true, project: { version: 2, files: {}, assets: {}, access: 'members' } } });
    mocks.saveNativeProject.mockResolvedValue({ error: 'This app was changed by someone else. Reload it.' });
    await open();
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await settle();
    await press('Update it');
    expect(await status()).toEqual({ state: 'failed', reason: 'failed' });
    expect(title()).toBe('Your app could not be updated');
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe('Tiny notes could not be updated: This app was changed by someone else. Reload it.');
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
    // A list that cannot be read leaves the offer an offer of a new app.
    await press('Close');
    mocks.getApps.mockRejectedValue(new Error('offline'));
    await ask({ op: 'offer', from: '/api/made/7', name: 'Tiny notes' });
    await settle();
    expect(title()).toBe('Add Tiny notes to your apps?');
  });

  it('tells the app an action it does not know', async () => {
    await open();
    expect(() => host().addApp({ op: 'install' }, read)).toThrow('Unknown add-app action.');
    expect(() => host().addApp({}, read)).toThrow('Unknown add-app action.');
  });
});
