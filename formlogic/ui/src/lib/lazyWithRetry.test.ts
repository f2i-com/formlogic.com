// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The words of a chunk that can't be had, from real browsers (Chromium, Firefox, WebKit twice) and
// from the build's own preload helper for a chunk's CSS.
const REFUSALS = [
  'Failed to fetch dynamically imported module: https://formlogic.example/assets/Flows-abc.js',
  'error loading dynamically imported module: https://formlogic.example/assets/Flows-abc.js',
  'Importing a module script failed.',
  "'text/html' is not a valid JavaScript MIME type.",
  'Unable to preload CSS for /assets/FlowsWorkspace-abc.css',
];
const missing = new Error(REFUSALS[0]);

const reload = vi.fn();
const realLocation = window.location;

/** A page load: a new copy of the module, with sessionStorage and the clock carrying on. */
async function freshPage() {
  vi.resetModules();
  return import('./lazyWithRetry');
}

/** What became of an import: the page is on its way to a reload ('waiting'), or the caller was told. */
function outcome(load: Promise<unknown>) {
  return Promise.race([
    load.then(() => 'loaded', () => 'refused'),
    new Promise((resolve) => { setTimeout(resolve, 0, 'waiting'); }),
  ]);
}

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('an import that can not be had', () => {
  it.each(REFUSALS)('reloads once, in any browser: %s', async (words) => {
    const { loadChunk } = await freshPage();
    await expect(outcome(loadChunk(() => Promise.reject(new Error(words))))).resolves.toBe('waiting');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a chunk that loads alone', async () => {
    const { loadChunk } = await freshPage();
    await expect(loadChunk(async () => 'module')).resolves.toBe('module');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the guard', () => {
  // /admin/*, the acting routes, and every route on a host the build doesn't know, which goes
  // through a lazy router first. In Chromium this shape reloaded a thousand times in six seconds.
  const parentLoadsChildMissing = async () => {
    const { loadChunk } = await freshPage();
    await loadChunk(async () => 'parent');
    return outcome(loadChunk(() => Promise.reject(missing)));
  };

  it('stops a loop when a parent chunk loads and its child stays missing', async () => {
    await expect(parentLoadsChildMissing()).resolves.toBe('waiting');
    expect(reload).toHaveBeenCalledTimes(1);
    for (let load = 0; load < 3; load++) {
      await expect(parentLoadsChildMissing(), 'the error shows instead').resolves.toBe('refused');
      vi.setSystemTime(Date.now() + 5_000);
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('tries again once the 30 seconds are up', async () => {
    await parentLoadsChildMissing();
    vi.setSystemTime(Date.now() + 30_001);
    await expect(parentLoadsChildMissing()).resolves.toBe('waiting');
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads where it could not stop itself', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const { loadChunk } = await freshPage();
    await expect(loadChunk(() => Promise.reject(missing)), 'and the caller is told what went wrong').rejects.toBe(missing);
    expect(reload).not.toHaveBeenCalled();
  });
});

// A plain React.lazy keeps its rejected import, and the page goes down with it.
describe('every lazy chunk', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

  it('goes through here', () => {
    const plain = walk(resolve(__dirname, '..')).filter((file) => !file.endsWith('lazyWithRetry.ts') && /(?:^|[^.\w])lazy\(\s*\(\)\s*=>\s*import\(|React\.lazy\(/m.test(readFileSync(file, 'utf8')));
    expect(plain).toEqual([]);
  });
});

describe('what a reload would cost', () => {
  it('keeps a page that would lose something, and says what failed', async () => {
    const warn = (event: Event) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    try {
      const { loadChunk } = await freshPage();
      await expect(loadChunk(() => Promise.reject(missing))).rejects.toBe(missing);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('beforeunload', warn);
    }
  });

  it('keeps a page while there is no network to reload from', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { loadChunk } = await freshPage();
    await expect(loadChunk(() => Promise.reject(missing))).rejects.toBe(missing);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the build\'s own preload failure', () => {
  const preloadError = () => new Event('vite:preloadError', { cancelable: true });
  let listening: EventListener[] = [];

  /** A page load with its listener on. A real reload takes the page's listener with it; this doesn't. */
  async function listeningPage() {
    listening.forEach((listener) => window.removeEventListener('vite:preloadError', listener));
    const added = vi.spyOn(window, 'addEventListener');
    const page = await freshPage();
    page.listenForStaleChunks();
    listening = added.mock.calls.filter(([type]) => (type as string) === 'vite:preloadError').map(([, listener]) => listener as EventListener);
    added.mockRestore();
    return page;
  }

  afterEach(() => {
    listening.forEach((listener) => window.removeEventListener('vite:preloadError', listener));
    listening = [];
  });

  it('reloads under the same guard', async () => {
    await listeningPage();
    const first = preloadError();
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // The same failure on the next load, inside the window.
    await listeningPage();
    const second = preloadError();
    window.dispatchEvent(second);
    expect(second.defaultPrevented, 'so the import rejects, and the error shows').toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Prevented, the import resolves to nothing: FormResponse's own `await import('../lib/swQueue')`
  // would throw inside its submit, and a visitor's answers are what that path is there to keep.
  it('lets the import fail as it would have when the page would lose something', async () => {
    const warn = (event: Event) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    try {
      await listeningPage();
      const event = preloadError();
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('beforeunload', warn);
    }
  });

  it('shows no error card in the moment before the reload', async () => {
    const { loadChunk } = await listeningPage();
    window.dispatchEvent(preloadError());
    // What the helper resolves a prevented import to, and what a chunk's named export then throws.
    await expect(outcome(loadChunk(async () => undefined))).resolves.toBe('waiting');
    await expect(outcome(loadChunk(() => Promise.resolve(undefined as unknown as { X: string }).then((m) => m.X)))).resolves.toBe('waiting');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
