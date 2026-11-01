// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useToastStore } from '../stores/toastStore';

const reload = vi.fn();
const update = vi.fn(async () => {});
const realLocation = window.location;

class FakeWorkers extends EventTarget {
  controller: object | null;
  getRegistration = vi.fn(async () => ({ update }));
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
}

let store: typeof useToastStore;

/** A page load: new copies of the modules, built from `built`, or built outside a release. */
async function page(built: string | undefined, workers?: FakeWorkers) {
  vi.resetModules();
  vi.stubEnv('VITE_FORMLOGIC_VERSION', built ?? '');
  vi.stubGlobal('navigator', workers ? { serviceWorker: workers } : {});
  store = (await import('../stores/toastStore')).useToastStore;
  return import('./newRelease');
}

const notices = () => store.getState().toasts;

beforeEach(() => {
  reload.mockClear();
  update.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('a reply from another release', () => {
  it('offers a reload, and waits for it to be taken', async () => {
    const { noteServerRelease } = await page('0.1.20');
    noteServerRelease('0.1.21');
    expect(notices()).toHaveLength(1);
    const [notice] = notices();
    expect(notice).toMatchObject({ title: 'A new version is ready', type: 'info', duration: 0 });
    expect(notice.action?.label).toBe('Reload');
    expect(reload, 'someone may be typing').not.toHaveBeenCalled();

    notice.action?.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says so once, even after it is dismissed', async () => {
    const { noteServerRelease } = await page('0.1.20');
    noteServerRelease('0.1.21');
    noteServerRelease('0.1.21');
    expect(notices()).toHaveLength(1);
    store.getState().removeToast(notices()[0].id);
    noteServerRelease('0.1.21');
    expect(notices()).toHaveLength(0);
  });

  // After a rollback the server is the older one, and a reload is still what this page needs.
  it('counts an older release too', async () => {
    const { noteServerRelease } = await page('0.1.21');
    noteServerRelease('0.1.20');
    expect(notices()).toHaveLength(1);
  });

  // The worker keeps serving this release until it has looked at sw.js again, so Reload alone could
  // come back to the same page.
  it('has the worker look for the new release now', async () => {
    const workers = new FakeWorkers(true);
    const { noteServerRelease } = await page('0.1.20', workers);
    noteServerRelease('0.1.21');
    noteServerRelease('0.1.21');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });
});

describe('nothing to say', () => {
  it('stays quiet for the same release', async () => {
    const { noteServerRelease } = await page('0.1.20');
    noteServerRelease('0.1.20');
    expect(notices()).toHaveLength(0);
  });

  it('keeps working against a server that sends no header', async () => {
    const { noteServerRelease } = await page('0.1.20');
    noteServerRelease(null);
    noteServerRelease(undefined);
    noteServerRelease('');
    expect(notices()).toHaveLength(0);
  });

  // Only the packager names a build, so `npm run build` and `vite dev` compare with nothing.
  it('stays quiet in a build that names no release', async () => {
    const { noteServerRelease } = await page(undefined);
    noteServerRelease('0.1.21');
    expect(notices()).toHaveLength(0);
  });
});

describe('the replies that say', () => {
  async function client(reply: Response | object) {
    await page('0.1.20');
    vi.stubGlobal('fetch', vi.fn(async () => reply));
    return (await import('./api')).api as unknown as {
      request(endpoint: string): Promise<unknown>;
      requestWithMeta(endpoint: string): Promise<unknown>;
    };
  }
  const reply = (headers?: Record<string, string>) => new Response('{}', { status: 200, headers });

  it('hears it on an ordinary reply', async () => {
    await (await client(reply({ 'X-FormLogic-Release': '0.1.21' }))).request('/forms');
    expect(notices()).toHaveLength(1);
  });

  it('hears it on a refusal too', async () => {
    const refused = new Response('{"error":true,"message":"Maintenance"}', { status: 503, headers: { 'X-FormLogic-Release': '0.1.21' } });
    await (await client(refused)).request('/forms');
    expect(notices()).toHaveLength(1);
  });

  it('hears it on the path that keeps the whole answer', async () => {
    await (await client(reply({ 'X-FormLogic-Release': '0.1.21' }))).requestWithMeta('/forms');
    expect(notices()).toHaveLength(1);
  });

  it('asks nothing of a reply without the header', async () => {
    await expect((await client(reply())).request('/forms')).resolves.toEqual({ data: {} });
    expect(notices()).toHaveLength(0);
  });

  // Plenty of tests answer with a bare object, and so might whatever stands in for fetch in a shell.
  it('asks nothing of a reply with no headers at all', async () => {
    await expect((await client({ ok: true, status: 200, json: async () => ({}) })).request('/forms')).resolves.toEqual({ data: {} });
  });
});

describe('a new service worker', () => {
  it('offers a reload when it takes this tab from the old one', async () => {
    const workers = new FakeWorkers(true);
    const { watchForNewRelease } = await page('0.1.20', workers);
    watchForNewRelease();
    workers.dispatchEvent(new Event('controllerchange'));
    expect(notices().map((notice) => notice.title)).toEqual(['A new version is ready']);
    expect(reload).not.toHaveBeenCalled();
  });

  // clientsClaim: a first visit's worker takes this tab over too, and nothing about that is new.
  it('stays quiet when a first visit is claimed, and not for what comes after', async () => {
    const workers = new FakeWorkers(false);
    const { watchForNewRelease } = await page('0.1.20', workers);
    watchForNewRelease();
    workers.dispatchEvent(new Event('controllerchange'));
    expect(notices()).toHaveLength(0);
    workers.dispatchEvent(new Event('controllerchange'));
    expect(notices()).toHaveLength(1);
  });

  it('says it once however it heard', async () => {
    const workers = new FakeWorkers(true);
    const { noteServerRelease, watchForNewRelease } = await page('0.1.20', workers);
    watchForNewRelease();
    noteServerRelease('0.1.21');
    workers.dispatchEvent(new Event('controllerchange'));
    expect(notices()).toHaveLength(1);
  });

  it('asks nothing of a browser without workers', async () => {
    const { noteServerRelease, watchForNewRelease } = await page('0.1.20');
    watchForNewRelease();
    noteServerRelease('0.1.21');
    expect(notices()).toHaveLength(1);
  });
});
