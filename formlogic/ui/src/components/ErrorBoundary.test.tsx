// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

vi.mock('../lib/logger', () => ({ logger: { error: vi.fn() } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const reload = vi.fn();
const realLocation = window.location;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

function Failing({ message }: { message: string }): never {
  throw new Error(message);
}

// React.lazy keeps its rejected import, so rendering the same tree again can only fail again, and
// the words differ per browser. Firefox and WebKit have their own, and a chunk's CSS has another.
it.each([
  'error loading dynamically imported module: https://formlogic.example/assets/Flows-abc.js',
  'Importing a module script failed.',
  'Unable to preload CSS for /assets/FlowsWorkspace-abc.css',
])('Try Again reloads the page: %s', async (message) => {
  await act(async () => root.render(<ErrorBoundary><Failing message={message} /></ErrorBoundary>));
  const tryAgain = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try Again');
  await act(async () => tryAgain!.click());
  expect(reload).toHaveBeenCalledTimes(1);
});
