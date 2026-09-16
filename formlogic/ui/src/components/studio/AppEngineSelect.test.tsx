// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ put: vi.fn(), verified: { value: false } }));
vi.mock('../../lib/api', () => ({ api: { putAppEngine: mocks.put } }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (select: (state: { user: { isCodeTrustVerified: boolean } }) => unknown) =>
    select({ user: { isCodeTrustVerified: mocks.verified.value } }),
}));
import { AppEngineSelect } from './AppEngineSelect';
import type { AppEngine, OwnerEnginePolicy } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const POLICY: OwnerEnginePolicy = { default: 'zipp-web-python', allowed: ['zipp-web-python', 'host-js'], installed: ['zipp-web-python'] };
const engine = (over: Partial<AppEngine> = {}): AppEngine => ({ id: 'zipp-web-python', requested: 'zipp-web-python', stored: null, revision: 'abc123', ...over });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verified.value = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount(props: { engine?: AppEngine; policy?: OwnerEnginePolicy; onChanged?: (e: AppEngine, p: OwnerEnginePolicy) => void } = {}) {
  await act(async () => root.render(
    <AppEngineSelect appId="app-1" engine={props.engine ?? engine()} policy={props.policy ?? POLICY} onChanged={props.onChanged ?? (() => {})} />
  ));
  return container.querySelector<HTMLSelectElement>('select[aria-label="App engine"]')!;
}
const options = (select: HTMLSelectElement) => [...select.options].map(o => ({ value: o.value, disabled: o.disabled, text: o.textContent ?? '' }));
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

it('offers the site default plus only the engines the site allows', async () => {
  const select = await mount({ policy: { default: 'zipp-web-python', allowed: ['zipp-web-python'], installed: ['zipp-web-python'] } });
  expect(options(select).map(o => o.value)).toEqual(['', 'zipp-web-python']);
  expect(options(select)[0].text).toContain('Site default (ZIPP (JavaScript and Python))');
});

it('keeps host JavaScript unselectable, with the reason, until the account is verified', async () => {
  const select = await mount();
  const hostJs = options(select).find(o => o.value === 'host-js')!;
  expect(hostJs.disabled).toBe(true);
  expect(hostJs.text).toContain('needs an administrator to verify this account');
  expect(hostJs.text).toContain('None (host JavaScript, verified accounts)');
});

it('lets a verified account select host JavaScript', async () => {
  mocks.verified.value = true;
  const select = await mount();
  expect(options(select).find(o => o.value === 'host-js')!.disabled).toBe(false);
});

it('says which engine actually runs and why it is not the one asked for', async () => {
  await mount({ engine: engine({ stored: 'host-js', requested: 'host-js', reason: 'not-installed' }) });
  expect(container.textContent).toContain('This app runs on ZIPP (JavaScript and Python)');
  expect(container.textContent).toContain('not in the installed runtime yet');
  expect(container.textContent).toContain('Python always run on the full ZIPP engine');
});

it('stores the choice and hands the server\'s answer back to the panel', async () => {
  mocks.verified.value = true;
  const next = engine({ stored: 'host-js', requested: 'host-js', reason: 'not-installed' });
  mocks.put.mockResolvedValue({ data: { engine: next, policy: POLICY } });
  const onChanged = vi.fn();
  const select = await mount({ onChanged });
  await choose(select, 'host-js');
  expect(mocks.put).toHaveBeenCalledWith('app-1', 'host-js');
  expect(onChanged).toHaveBeenCalledWith(next, POLICY);
});

it('sends null for the site default', async () => {
  mocks.put.mockResolvedValue({ data: { engine: engine(), policy: POLICY } });
  const select = await mount({ engine: engine({ stored: 'zipp-web-python' }) });
  await choose(select, '');
  expect(mocks.put).toHaveBeenCalledWith('app-1', null);
});

it('shows a refusal instead of pretending the engine changed', async () => {
  mocks.put.mockResolvedValue({ error: 'This site does not allow that engine.' });
  const onChanged = vi.fn();
  const select = await mount({ onChanged });
  await choose(select, 'zipp-web-python');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('This site does not allow that engine.');
  expect(onChanged).not.toHaveBeenCalled();
});
