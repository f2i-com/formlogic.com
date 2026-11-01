// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderKey, listProviders, saveProvider, setProviderKey } from '../../client-runtime/flows/aiProviders';
import { useAuthStore } from '../../stores/authStore';
import type { FlowsDesktopPresence } from './useFlowsDesktopPresence';

const services = vi.hoisted(() => ({ oaiy: vi.fn(), legacy: vi.fn() }));
vi.mock('../../client-runtime/oaiy/oaiyServices', () => ({ listOaiyServices: services.oaiy }));
vi.mock('../../client-runtime/desktop/desktopClient', () => ({ desktopClient: { services: { list: services.legacy } } }));
import AiServicesDialog from './AiServicesDialog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  services.oaiy.mockReset().mockResolvedValue([{ id: 'llamacpp', name: 'Local Qwen', status: 'running', port: 8081 }]);
  services.legacy.mockReset().mockResolvedValue({ ok: true, data: [{ id: 'legacy', name: 'Legacy model', status: 'running', port: 8082 }] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(presence: FlowsDesktopPresence) {
  await act(async () => root.render(<MemoryRouter><AiServicesDialog isOpen onClose={() => {}} desktopPresence={presence} /></MemoryRouter>));
}
it('lists the paired OAIY services without calling the legacy bridge', async () => {
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Local Qwen');
  expect(services.oaiy).toHaveBeenCalledOnce();
  expect(services.legacy).not.toHaveBeenCalled();
});
it('replaces the service list when the active local runtime changes', async () => {
  await render({ kind: 'local' });
  expect(document.body.textContent).toContain('Legacy model');
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Local Qwen');
  expect(document.body.textContent).not.toContain('Legacy model');
  await render({ kind: 'none' });
  expect(document.body.textContent).not.toContain('Local Qwen');
  expect(document.body.textContent).toContain('Connect OAIY');
});
// A Test saves the new key to the store while the editor's copy still holds the sealed old one,
// and the Save after it wrote that copy back: the badge said "key saved", and flows failed.
describe('changing a saved key', () => {
  const USER = 'u-keys';
  let sent: string[];
  const saved = () => listProviders(USER)[0];
  const click = async (name: string) => {
    const button = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
    if (!button) throw new Error(`no button ${name}: ${Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent?.trim()).join(' | ')}`);
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  };
  const typeKey = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder*="key" i], input[type="password"]');
    if (!input) throw new Error('no key box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(async () => {
    localStorage.clear();
    sent = [];
    useAuthStore.setState({ user: { id: USER, email: 'owner@example.test' } as never });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('Authorization') ?? '');
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    saveProvider(USER, {
      id: 'p1', name: 'Mine', kind: 'openai', baseUrl: 'https://llm.example.test/v1', model: 'm', enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await setProviderKey(USER, 'p1', 'old-key');
    await render({ kind: 'none' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ user: null });
  });

  it('keeps the new key through Test and Save', async () => {
    await click('Edit');
    await typeKey('new-key');
    await click('Test connection');
    expect(sent.at(-1)).toBe('Bearer new-key');

    await click('Save service');

    expect(await getProviderKey(USER, 'p1')).toBe('new-key');
  });

  it('still has it for a second Test', async () => {
    await click('Edit');
    await typeKey('new-key');
    await click('Test connection');
    await click('Test connection');

    expect(sent.at(-1)).toBe('Bearer new-key');
  });

  it('does not bring back a key cleared before a Test', async () => {
    await click('Edit');
    await typeKey('new-key');
    await typeKey('');
    await click('Test connection');
    await click('Save service');

    expect(saved().encryptedKey).toBeUndefined();
  });

  it('keeps the key when only something else changed', async () => {
    await click('Edit');
    await click('Save service');

    expect(await getProviderKey(USER, 'p1')).toBe('old-key');
  });
});

it('shows an OAIY connection error instead of falling back to unrelated services', async () => {
  services.oaiy.mockResolvedValue(null);
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Could not load OAIY services');
  expect(document.body.textContent).not.toContain('Loading local services');
  expect(services.legacy).not.toHaveBeenCalled();
});
