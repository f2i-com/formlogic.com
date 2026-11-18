// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SoftnCreateForm } from './SoftnCreateForm';
import { useUIStore } from '../../stores/uiStore';

const mocks = vi.hoisted(() => ({ createSoftnApp: vi.fn() }));
vi.mock('../../lib/softnApps', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/softnApps')>()), createSoftnApp: mocks.createSoftnApp }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const path = { current: '/apps/new' };
function PathProbe() { const location = useLocation(); React.useEffect(() => { path.current = location.pathname; }); return null; }

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes' };

beforeEach(() => {
  mocks.createSoftnApp.mockReset();
  mocks.createSoftnApp.mockResolvedValue({ app, project: { version: 1, files: {}, assets: {}, access: 'members' } });
  useUIStore.getState().setSoftnOpen(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const tree = () =>
  <MemoryRouter initialEntries={['/apps/new']}><PathProbe /><Routes>
    <Route path="/apps/new" element={<SoftnCreateForm />} />
    <Route path="/apps/:appId/web/*" element={<p>workspace</p>} />
  </Routes></MemoryRouter>;
async function render() {
  root = createRoot(container);
  await act(async () => root.render(tree()));
}
const button = (text: RegExp) => [...container.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement;

describe('project ZIP uploads', () => {
  /** A .softn file: a manifest, its page, and any other files given. */
  const softn = (manifest: Record<string, unknown>, extra: Record<string, string> = {}, name = 'coffee.softn') =>
    new File([zipSync(Object.fromEntries(Object.entries({ 'manifest.json': JSON.stringify(manifest), 'ui/main.ui': '<Text>Hi</Text>', ...extra }).map(([path, text]) => [path, strToU8(text)])))], name);
  const pick = async (file: File) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const attach = async (label: string, file: File) => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const drop = async (element: Element, file: File) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
    await act(async () => { element.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  };

  it('keeps a refused backend selection visible until the owner replaces or skips it', async () => {
    await render();
    await pick(softn({ main: 'ui/main.ui', name: 'Notes' }));
    await attach('Choose the file with its backend', softn({ main: 'ui/main.ui' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no backend');
    expect(button(/Create from this file/).disabled).toBe(true);
    await act(async () => button(/Skip separate backend/).click());
    expect(button(/Create from this file/).disabled).toBe(false);
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('only imports the database and verified key belonging to the current selection', async () => {
    await render();
    const bundle = (name: string) => softn({ name, id: 'example.app', main: 'ui/main.ui', server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite' },
    } }, { 'server/main.logic': 'function hello() {}' });
    await pick(bundle('First app'));
    await attach('Choose its database', new File(['fixture'], 'first.sqlite'));
    const oldKey = new File([], 'first-key.json');
    let finish!: (value: string) => void;
    vi.spyOn(oldKey, 'text').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await attach('Choose its key file', oldKey);
    expect(button(/Create from this file/).disabled).toBe(true);
    await pick(bundle('Second app'));
    await act(async () => finish(JSON.stringify({ keyHex: 'a'.repeat(64), cryptoDomains: { hmac: 'h', seal: 's' } })));
    expect(container.textContent).not.toMatch(/first\.sqlite|first-key\.json/);
    expect(button(/Create from this file/).disabled).toBe(false);
    await attach('Choose its database', new File(['fixture'], 'second.sqlite'));
    await attach('Choose its key file', new File(['{"keyHex":"short"}'], 'bad.json'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('64 hexadecimal');
    expect(button(/Create from this file/).disabled).toBe(true);
    await attach('Choose its key file', new File([JSON.stringify({
      keyHex: 'a'.repeat(64), cryptoDomains: { hmac: 'h', seal: 's' }, appId: 'another.app',
    })], 'other.json'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Choose the key file for example.app');
    expect(button(/Create from this file/).disabled).toBe(true);
    await act(async () => button(/Remove key file/).click());
    expect(button(/Create from this file/).disabled).toBe(false);
  });

  it('uploads a .softn file as the first version, named after the app it carries unless renamed', async () => {
    await render();
    expect(button(/Create from this file/).disabled).toBe(true);
    const file = softn({ name: 'Coffee Corner', main: 'ui/main.ui' });
    button(/^Choose a file$/).focus();
    await pick(file);
    expect(document.activeElement).toBe(button(/^Choose another file$/));
    // An app with no backend is one this host takes: it runs in the member's browser.
    const summary = container.querySelector('[role="status"]')!;
    expect(summary.textContent).toContain('coffee.softn');
    expect(summary.textContent).toContain('Coffee Corner · runs in the browser, no backend');
    expect((container.querySelector('#softn-app-name') as HTMLInputElement).placeholder).toBe('Coffee Corner');
    expect(button(/Create from this file/).disabled).toBe(false);
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('Native project exceeds 16 MB'));
    await act(async () => button(/Create from this file/).click());
    expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: '', start: {
      kind: 'upload', file, reviewed: { project: expect.objectContaining({ files: expect.objectContaining({ 'ui/main.ui': '<Text>Hi</Text>' }) }), notes: [] },
    } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('exceeds 16 MB');
    expect(path.current).toBe('/apps/new');
    await act(async () => button(/Create from this file/).click());
    expect(useUIStore.getState().softnOpen).toBeNull();
    expect(path.current).toBe('/apps/app-1/web/edit');
  });

  it('says what is wrong with a file as soon as it is chosen, and creates nothing from it', async () => {
    await render();
    await pick(new File([new Uint8Array([1])], 'broken.softn'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(button(/Create from this file/).disabled).toBe(true);
    await pick(softn({ name: 'Pages', main: 'ui/main.ui' }, { 'assets/page.htm': '<script>1</script>' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('assets/page.htm cannot be hosted with this app');
    expect(button(/Create from this file/).disabled).toBe(true);
    // A backend written for another SoftN host is refused before any app is made for it...
    await pick(softn({ name: 'Notes', main: 'ui/main.ui', server: { entry: 'server/main.logic', routes: [] } }, { 'server/main.logic': 'function list() {}' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('This app\'s backend is not one FormLogic runs: its API version is unsupported.');
    expect(button(/Create from this file/).disabled).toBe(true);
    // ...and one this host runs says so.
    await pick(softn({ name: 'Notes', main: 'ui/main.ui', server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } } }, { 'server/main.logic': 'function list() {}' }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Notes · with its own backend and database');
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('brings its data, and gives what its key file holds for its sign-in codes to the plugin on this site that sends them', async () => {
    const { api } = await import('../../lib/api');
    const signIn = vi.spyOn(api, 'getAppSignInCodes').mockResolvedValue({ data: {
      provider: 'text-codes', asked: true, plugin: { id: 'example.text-codes', name: 'Codes by text', label: 'Texts', enabled: true },
      fields: [], values: {}, kept: {}, imports: { account: 'sms.ACCOUNT', secret: 'sms.SECRET' }, configured: false,
    } } as never);
    const brought = vi.spyOn(api, 'importNativeData').mockResolvedValue({ data: { project: { version: 2, files: {}, assets: {} }, keyImported: true, verificationFound: true, verification: null } } as never);
    try {
      const into = async (label: string, file: File) => {
        const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => {});
      };
      const server = { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } };
      const database = new File([new Uint8Array([1, 2, 3])], 'application.sqlite');
      const key = (sms: Record<string, string>) => new File([JSON.stringify({ keyHex: 'ab'.repeat(32), cryptoDomains: { hmac: 'h', seal: 's' }, appId: 'com.example.notes', sms })], 'config.json');
      await render();
      await pick(softn({ name: 'Notes', main: 'ui/main.ui', server, config: { app: { verificationProvider: 'text-codes' } } }, { 'server/main.logic': 'function list() {}' }));
      await into('Choose its database', database);
      await into('Choose its key file', key({ ACCOUNT: 'acct-1', SECRET: 'made-up' }));
      // No provider's own words: the checkbox is offered for whatever plugin sends the codes here.
      const offer = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('sign-in codes were sent with'))!;
      expect(offer.textContent).not.toMatch(/Twilio/);
      expect((offer.querySelector('input') as HTMLInputElement).checked).toBe(true);
      await act(async () => button(/Create from this file/).click());
      expect(signIn).toHaveBeenCalledWith('app-1');
      expect(brought).toHaveBeenCalledWith('app-1', database, expect.any(File), true);
      // A key file without what the plugin takes from one gives it nothing.
      await act(async () => root.unmount());
      brought.mockClear();
      await render();
      await pick(softn({ name: 'Notes', main: 'ui/main.ui', server, config: { app: { verificationProvider: 'text-codes' } } }, { 'server/main.logic': 'function list() {}' }));
      await into('Choose its database', database);
      await into('Choose its key file', key({ ACCOUNT: 'acct-1' }));
      await act(async () => button(/Create from this file/).click());
      expect(brought).toHaveBeenCalledWith('app-1', database, expect.any(File), false);
      // An app that sends no codes is offered nothing, and the server is not asked.
      await act(async () => root.unmount());
      signIn.mockClear();
      await render();
      await pick(softn({ name: 'Notes', main: 'ui/main.ui', server }, { 'server/main.logic': 'function list() {}' }));
      await into('Choose its database', database);
      await into('Choose its key file', key({ ACCOUNT: 'acct-1', SECRET: 'made-up' }));
      expect(container.textContent).not.toContain('sign-in codes were sent with');
      await act(async () => button(/Create from this file/).click());
      expect(signIn).not.toHaveBeenCalled();
    } finally {
      signIn.mockRestore();
      brought.mockRestore();
    }
  });

  it('takes a .softn file dropped anywhere on the form as the start', async () => {
    await render();
    await drop(container.firstElementChild!, softn({ name: 'Dropped', main: 'ui/main.ui' }));
    expect(container.textContent).toContain('Dropped · runs in the browser, no backend');
  });

  it('reviews skipped build files before creation and passes the same notes with the hosted page', async () => {
    await render();
    const file = new File([zipSync({ 'index.html': strToU8('<h1>News</h1>'), 'team photo.jpg': new Uint8Array([1]) })], 'News.zip');
    await pick(file);
    expect(container.textContent).toContain('1 file was left out of the app: team photo.jpg');
    await act(async () => button(/Create from this file/).click());
    const { project, notes } = mocks.createSoftnApp.mock.calls[0][0].start.reviewed;
    expect(project.assets).toEqual({ 'site/index.html': btoa('<h1>News</h1>') });
    expect(notes).toEqual([expect.stringContaining('team photo.jpg')]);
  });

  it('drops files onto their own attachments, preserving the selected app and ignoring misplaced files', async () => {
    const { api } = await import('../../lib/api');
    const bringData = vi.spyOn(api, 'importNativeData').mockResolvedValue({ data: {} } as never);
    try {
      await render();
      const frontend = softn({ id: 'test.notes', name: 'Field Notes', main: 'ui/main.ui' }, {}, 'page.softn');
      const backend = softn({
        id: 'test.notes', name: 'Server', main: 'ui/main.ui', server: {
          entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite' },
        },
      }, { 'server/main.logic': 'function list() {}' }, 'server.softn');
      const database = new File(['fixture'], 'records.sqlite');
      const key = new File([JSON.stringify({ appId: 'test.notes', keyHex: 'aa'.repeat(32), cryptoDomains: { hmac: 'h', seal: 's' } })], 'server-key.json');
      const readPage = vi.spyOn(frontend, 'arrayBuffer');
      const readBackend = vi.spyOn(backend, 'arrayBuffer');
      await drop(container.firstElementChild!, frontend);
      await drop(button(/Choose the file with its backend/), backend);
      const summary = container.querySelector('[role="status"]')!;
      expect(summary.textContent).toContain('Field Notes · with the attached backend and database');
      expect(summary.textContent).not.toContain('no backend');
      await drop(button(/Choose its database/), database);
      await drop(button(/Add its key file/), key);
      for (const [target, misplaced, expectedHint] of [
        [summary, database, 'replace the app'],
        [button(/^Another file$/), key, 'contains the backend'],
        [button(/Another database/), frontend, 'SQLite database'],
        [button(/Another key file/), database, 'JSON key file'],
      ] as const) {
        await drop(target, misplaced);
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(expectedHint);
        expect(button(/Create from this file/).disabled).toBe(false);
      }
      await act(async () => button(/Create from this file/).click());
      expect(mocks.createSoftnApp).toHaveBeenCalledWith({ name: '', start: {
        kind: 'upload', file: frontend, reviewed: {
          project: expect.objectContaining({ files: expect.objectContaining({ 'ui/main.ui': '<Text>Hi</Text>', 'server/main.logic': 'function list() {}' }) }), notes: [],
        },
      } });
      expect(readPage).toHaveBeenCalledTimes(1);
      expect(readBackend).toHaveBeenCalledTimes(1);
      expect(bringData).toHaveBeenCalledWith('app-1', database, key, false);
    } finally { bringData.mockRestore(); }
  });
});
