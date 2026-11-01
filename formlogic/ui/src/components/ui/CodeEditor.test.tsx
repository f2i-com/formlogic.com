// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';
import { CodeEditor } from './CodeEditor';

// Monaco is left out of the precache, so unlike a route's chunk it is gone even while an old worker
// is alive: a page pinned by a stale sw.js asks for a file the update deleted, and reloading asks again.
vi.mock('./MonacoEditorImpl', () => { throw new Error('error loading dynamically imported module: https://formlogic.example/assets/MonacoEditorImpl-abc.js'); });
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn() } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const reload = vi.fn();
const realLocation = window.location;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

const page = (children: ReactNode) => <ErrorBoundary fallback={<p>The whole page is gone</p>}>{children}</ErrorBoundary>;

it('says the editor could not load and leaves the page around it alone', async () => {
  // The one reload has been spent, so what is left is what the person sees.
  sessionStorage.setItem('lazy_refresh', String(Date.now()));
  await act(async () => root.render(page(<CodeEditor value="" onChange={() => {}} />)));
  await vi.waitFor(() => expect(host.textContent).toContain('couldn’t load'));
  expect(host.textContent).not.toContain('The whole page is gone');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
