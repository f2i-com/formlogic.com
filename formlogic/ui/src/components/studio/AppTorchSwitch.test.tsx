// @vitest-environment jsdom
/**
 * The per-app torch switch: it keeps the app's other settings when it turns torch off, and where
 * the site does not allow torch it says so and cannot turn it on.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateApp: vi.fn(), app: { id: 'app-1', settings: { softnApp: true } as Record<string, unknown> } }));
vi.mock('../../stores/appStore', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ apps: [mocks.app], updateApp: mocks.updateApp }),
}));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { AppTorchSwitch } from './AppTorchSwitch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { mocks.updateApp.mockReset(); mocks.updateApp.mockResolvedValue(true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const policy = (torch?: boolean) => ({ default: 'zipp-web-python' as const, allowed: ['zipp-web-python' as const], installed: ['zipp-web-python' as const], ...(torch === undefined ? {} : { torch }) });
const toggle = () => container.querySelector<HTMLButtonElement>('button[role="switch"]')!;

it('turns torch off for this app and keeps its other settings', async () => {
  await act(async () => root.render(<AppTorchSwitch appId="app-1" policy={policy()} />));
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle().click());
  expect(mocks.updateApp).toHaveBeenCalledWith('app-1', { settings: { softnApp: true, torch: false } });
});

it('cannot turn torch on where the site does not allow it, and says so', async () => {
  await act(async () => root.render(<AppTorchSwitch appId="app-1" policy={policy(false)} />));
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain('This site does not allow torch');
});
