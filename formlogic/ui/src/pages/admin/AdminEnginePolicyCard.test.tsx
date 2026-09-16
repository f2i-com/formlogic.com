// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { adminGetEnginePolicy: mocks.get, adminPutEnginePolicy: mocks.put } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: mocks.error, success: mocks.success } }));
import { AdminEnginePolicyCard } from './AdminEnginePolicyCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const ENGINES = ['zipp-web-python', 'zipp-web', 'host-js'];
const policy = (over: Record<string, unknown> = {}) => ({
  revision: 3, default: 'zipp-web-python', allowed: ['zipp-web-python'], hostJsRequireWorker: false, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ data: { policy: policy(), installed: ['zipp-web-python'], engines: ENGINES } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const mount = async () => { await act(async () => root.render(<AdminEnginePolicyCard />)); };
const toggle = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.textContent === label);
const defaultSelect = () => container.querySelector<HTMLSelectElement>('#engine-default')!;

it('shows the stored policy and cannot switch the fallback engine off', async () => {
  await mount();
  expect(container.textContent).toContain('revision 3');
  const locked = toggle('Allow ZIPP (JavaScript and Python)');
  expect(locked?.disabled).toBe(true);
  expect(locked?.getAttribute('aria-checked')).toBe('true');
  expect(button('Save')?.disabled).toBe(true);
});

it('offers only ZIPP engines that are allowed as the site default', async () => {
  mocks.get.mockResolvedValue({ data: { policy: policy({ allowed: ['zipp-web-python', 'zipp-web', 'host-js'] }), installed: ['zipp-web-python'], engines: ENGINES } });
  await mount();
  expect([...defaultSelect().options].map(o => o.value)).toEqual(['zipp-web-python', 'zipp-web']);
});

it('marks an engine the installed runtime does not serve, and warns about host JavaScript', async () => {
  mocks.get.mockResolvedValue({ data: { policy: policy({ allowed: ['zipp-web-python', 'host-js'] }), installed: ['zipp-web-python'], engines: ENGINES } });
  await mount();
  expect(container.textContent).toContain('not in the installed runtime');
  expect(container.querySelector('[role="note"]')?.textContent).toContain('removes the virtual machine');
});

it('saves the edited allow-list and adopts the revision the server returns', async () => {
  mocks.put.mockResolvedValue({ data: { policy: policy({ revision: 4, allowed: ['zipp-web-python', 'host-js'] }), installed: ['zipp-web-python'], engines: ENGINES } });
  await mount();
  await act(async () => toggle('Allow None (host JavaScript, verified accounts)')!.click());
  expect(container.textContent).toContain('unsaved');
  await act(async () => button('Save')!.click());
  expect(mocks.put).toHaveBeenCalledWith({ default: 'zipp-web-python', allowed: ['zipp-web-python', 'host-js'], hostJsRequireWorker: false });
  expect(container.textContent).toContain('revision 4');
  expect(container.textContent).not.toContain('unsaved');
});

it('moves the default back to the fallback when its engine is switched off', async () => {
  mocks.get.mockResolvedValue({ data: { policy: policy({ default: 'zipp-web', allowed: ['zipp-web-python', 'zipp-web'] }), installed: ['zipp-web-python', 'zipp-web'], engines: ENGINES } });
  await mount();
  expect(defaultSelect().value).toBe('zipp-web');
  await act(async () => toggle('Allow ZIPP (JavaScript only)')!.click());
  expect(defaultSelect().value).toBe('zipp-web-python');
  expect([...defaultSelect().options].map(o => o.value)).toEqual(['zipp-web-python']);
});

it('keeps the edit visible and reports a refusal instead of pretending it saved', async () => {
  mocks.put.mockResolvedValue({ error: 'zipp-web-python cannot be removed from the allowed engines.' });
  await mount();
  await act(async () => toggle('Allow ZIPP (JavaScript only)')!.click());
  await act(async () => button('Save')!.click());
  expect(mocks.error).toHaveBeenCalledWith('Could not save the app engine policy', 'zipp-web-python cannot be removed from the allowed engines.');
  expect(container.textContent).toContain('unsaved');
  expect(container.textContent).toContain('revision 3');
});

it('treats a 2xx that carries no policy as a failure, not as a policy', async () => {
  // api.ts answers {data} for any 2xx, so a body without `policy` used to reach the card as a
  // truthy `data` and throw on the first field read — inside the promise, where the error branch
  // could no longer run. The card then sat on its spinner for ever with nothing said.
  for (const body of [{}, { policy: null }, { policy: { default: 'zipp-web-python' } }, { policy: { allowed: ['zipp-web-python'] } }]) {
    mocks.get.mockResolvedValue({ data: body });
    await act(async () => root.render(<AdminEnginePolicyCard />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the app engine policy');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('#engine-default')).toBeNull();
  }
});

it('does not send a missing worker flag back as a refusable non-boolean', async () => {
  const withoutFlag: Record<string, unknown> = policy({ allowed: ['zipp-web-python', 'zipp-web'] });
  delete withoutFlag.hostJsRequireWorker;
  mocks.get.mockResolvedValue({ data: { policy: withoutFlag, installed: ['zipp-web-python'], engines: ENGINES } });
  mocks.put.mockResolvedValue({ data: { policy: policy(), installed: ['zipp-web-python'], engines: ENGINES } });
  await mount();
  await act(async () => { defaultSelect().value = 'zipp-web'; defaultSelect().dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Save')!.click());
  expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ hostJsRequireWorker: false }));
});

it('offers a retry rather than an empty policy when the load fails', async () => {
  mocks.get.mockResolvedValueOnce({ error: 'Engine policy unavailable' })
    .mockResolvedValueOnce({ data: { policy: policy(), installed: ['zipp-web-python'], engines: ENGINES } });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Engine policy unavailable');
  expect(container.querySelector('#engine-default')).toBeNull();
  await act(async () => button('Try again')!.click());
  expect(container.querySelector('#engine-default')).not.toBeNull();
});
