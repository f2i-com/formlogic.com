// @vitest-environment jsdom
// Settings → AI source card (Site AI plan Phase 2 step 6): source radio states,
// desktop model catalog (dropdown vs free-text fallback), custom provider list,
// save round-trip, typed error surface, and demo read-only mode.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAiPreferencesMock, putAiPreferencesMock, fetchModelCatalogMock, fetchProviderCatalogMock, listAiSourcesMock, listProvidersMock, toastSuccess, toastError } =
  vi.hoisted(() => ({
    getAiPreferencesMock: vi.fn(),
    putAiPreferencesMock: vi.fn(),
    fetchModelCatalogMock: vi.fn(),
    fetchProviderCatalogMock: vi.fn(),
    listAiSourcesMock: vi.fn(),
    listProvidersMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));

let mockUser: { id: string; isDemo?: boolean } | null = { id: 'u1' };

vi.mock('../../lib/api', () => ({
  api: {
    getAiPreferences: (...args: unknown[]) => getAiPreferencesMock(...args),
    putAiPreferences: (...args: unknown[]) => putAiPreferencesMock(...args),
  },
}));

vi.mock('../../client-runtime/desktop/desktopTunnel', () => ({
  fetchModelCatalog: (...args: unknown[]) => fetchModelCatalogMock(...args),
  fetchProviderCatalog: (...args: unknown[]) => fetchProviderCatalogMock(...args),
  CODEX_PROVIDER_ID: 'openai-codex-agent',
  CODEX_REASONING_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
}));

vi.mock('../../client-runtime/flows/desktopService', () => ({
  listAiSources: (...args: unknown[]) => listAiSourcesMock(...args),
}));

vi.mock('../../client-runtime/flows/aiProviders', () => ({
  listProviders: (...args: unknown[]) => listProvidersMock(...args),
  providerSupports: () => true,
}));

let mockPresence: { kind: 'local' | 'remote' | 'none'; label?: string } = { kind: 'none' };

vi.mock('../flows/useFlowsDesktopPresence', () => ({
  useFlowsDesktopPresence: () => mockPresence,
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: typeof mockUser }) => unknown) => selector({ user: mockUser }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { AiSourceCard } from './AiSourceCard';
import { clearModelCatalogCacheForTests, clearProviderCatalogCacheForTests } from './aiModelCatalog';
import { clearCachedAiPreferences } from '../../lib/websiteAiRouting';
import type { AiPreferencesState } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function prefs(patch: Partial<AiPreferencesState> = {}): AiPreferencesState {
  return {
    aiSource: 'site',
    desktopProviderId: null,
    desktopModel: null,
    customProviderId: null,
    chatToolMode: 'auto',
    desktopReasoning: null,
    ...patch,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderCard(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AiSourceCard />);
  });
  await flush();
  return { container, root };
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function radio(container: HTMLElement, value: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[name="fl-ai-source"][value="${value}"]`);
  if (!el) throw new Error(`radio ${value} not found`);
  return el;
}

describe('AiSourceCard', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    clearModelCatalogCacheForTests();
    clearProviderCatalogCacheForTests();
    clearCachedAiPreferences();
    mockUser = { id: 'u1' };
    mockPresence = { kind: 'none' };
    listAiSourcesMock.mockResolvedValue([]);
    listProvidersMock.mockReturnValue([]);
    fetchModelCatalogMock.mockResolvedValue({ ok: false, error: { code: 'desktop_offline', message: 'offline' } });
    fetchProviderCatalogMock.mockResolvedValue({ ok: false, error: { code: 'desktop_offline', message: 'offline' } });
    putAiPreferencesMock.mockResolvedValue({ data: prefs() });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(): Promise<void> {
    const rendered = await renderCard();
    root = rendered.root;
    container = rendered.container;
  }

  it('renders the site source with live monthly usage', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs({ usage: { used: 12, limit: 500 } }) });
    await mount();
    expect(radio(container!, 'site').checked).toBe(true);
    expect(container!.textContent).toContain('12 of 500 messages this month');
    expect(container!.textContent).toContain('Default flows use this too.');
  });

  it('degrades gracefully when usage is absent', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs() });
    await mount();
    expect(container!.textContent).toContain('Monthly usage is not tracked on this instance yet.');
  });

  it('shows the load error with retry when preferences cannot load', async () => {
    getAiPreferencesMock.mockResolvedValue({ error: 'Not Found', status: 404 });
    await mount();
    expect(container!.textContent).toContain('Not Found');
    expect(container!.textContent).toContain('Try again');
  });

  it('offers provider + model dropdowns for the desktop source', async () => {
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'prov-x', desktopModel: 'gpt-5' }),
    });
    listAiSourcesMock.mockResolvedValue([
      {
        id: 'provider:prov-x',
        kind: 'provider',
        refId: 'prov-x',
        name: 'Codex on Desktop',
        category: '',
        status: 'provider',
        capabilities: ['chat'],
        url: '',
        model: '',
        enabled: true,
      },
    ]);
    fetchModelCatalogMock.mockResolvedValue({
      ok: true,
      data: { models: [{ id: 'gpt-5', displayName: 'GPT-5' }, { id: 'gpt-5-codex' }], threadId: 't1' },
    });
    await mount();

    expect(radio(container!, 'desktop').checked).toBe(true);
    const providerSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop provider"]');
    expect(providerSelect?.value).toBe('prov-x');
    expect(fetchModelCatalogMock).toHaveBeenCalledWith('prov-x');

    const modelSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop model"]');
    expect(modelSelect).not.toBeNull();
    expect(modelSelect!.value).toBe('gpt-5');
    expect(modelSelect!.textContent).toContain('GPT-5');
    expect(modelSelect!.textContent).toContain('gpt-5-codex');
  });

  it('fills the provider dropdown over the tunnel when the loopback listing is empty but a desktop is linked', async () => {
    mockPresence = { kind: 'remote', label: 'DESKTOP-X' };
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent' }),
    });
    listAiSourcesMock.mockResolvedValue([]);
    fetchProviderCatalogMock.mockResolvedValue({
      ok: true,
      data: {
        providers: [
          { id: 'openai-codex-agent', label: 'ChatGPT (Codex)', capabilities: ['chat'] },
          { id: 'local-llama', label: 'Llama.cpp' },
        ],
        threadId: 't1',
      },
    });
    await mount();

    // A dropdown, NOT the free-text provider-id input.
    const providerSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop provider"]');
    expect(providerSelect).not.toBeNull();
    expect(providerSelect!.value).toBe('openai-codex-agent');
    expect(providerSelect!.textContent).toContain('ChatGPT (Codex)');
    expect(providerSelect!.textContent).toContain('Llama.cpp');
    expect(container!.querySelector('input[aria-label="Desktop provider id"]')).toBeNull();
  });

  it('offers chat-capable local services in the dropdown, saved under the service: token', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs({ aiSource: 'desktop', desktopProviderId: 'service:llama-cpp' }) });
    listAiSourcesMock.mockResolvedValue([
      {
        id: 'service:llama-cpp',
        kind: 'service',
        refId: 'llama-cpp',
        name: 'Llama.cpp Server',
        category: 'LLM',
        status: 'running',
        capabilities: ['chat'],
        url: 'http://127.0.0.1:8080',
        model: '',
        enabled: true,
      },
      {
        id: 'service:krea2',
        kind: 'service',
        refId: 'krea2',
        name: 'Krea-2 Turbo',
        category: 'Image Generation',
        status: 'stopped',
        capabilities: ['image'],
        url: '',
        model: '',
        enabled: true,
      },
    ]);
    await mount();

    const providerSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop provider"]');
    expect(providerSelect).not.toBeNull();
    expect(providerSelect!.value).toBe('service:llama-cpp');
    expect(providerSelect!.textContent).toContain('Llama.cpp Server');
    // Non-chat services never appear.
    expect(providerSelect!.textContent).not.toContain('Krea-2 Turbo');
  });

  it('never tunnels for providers when no desktop is linked (presence none)', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs({ aiSource: 'desktop' }) });
    listAiSourcesMock.mockResolvedValue([]);
    await mount();
    expect(fetchProviderCatalogMock).not.toHaveBeenCalled();
    // The honest fallback stays: free-text provider id input.
    expect(container!.querySelector('input[aria-label="Desktop provider id"]')).not.toBeNull();
  });

  it('falls back to a free-text model input when the catalog fails', async () => {
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'prov-x', desktopModel: 'my-model' }),
    });
    fetchModelCatalogMock.mockResolvedValue({ ok: false, error: { code: 'desktop_offline', message: 'Desktop is offline' } });
    await mount();

    const modelInput = container!.querySelector<HTMLInputElement>('input[aria-label="Desktop model"]');
    expect(modelInput).not.toBeNull();
    expect(modelInput!.value).toBe('my-model');
    expect(container!.textContent).toContain("The model catalog couldn't be loaded");
    expect(container!.textContent).toContain('Desktop is offline');
  });

  it('lists browser-local providers for the custom source', async () => {
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'custom', customProviderId: 'cp1' }),
    });
    listProvidersMock.mockReturnValue([{ id: 'cp1', name: 'My OpenAI', enabled: true }]);
    await mount();

    expect(radio(container!, 'custom').checked).toBe(true);
    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="Custom provider"]');
    expect(select?.value).toBe('cp1');
    expect(select?.textContent).toContain('My OpenAI');
  });

  it('auto-saves discrete picks (source, provider, model, tool mode) without a Save click', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs() });
    listAiSourcesMock.mockResolvedValue([
      {
        id: 'provider:prov-x',
        kind: 'provider',
        refId: 'prov-x',
        name: 'Codex on Desktop',
        category: '',
        status: 'provider',
        capabilities: ['chat'],
        url: '',
        model: '',
        enabled: true,
      },
    ]);
    fetchModelCatalogMock.mockResolvedValue({
      ok: true,
      data: { models: [{ id: 'gpt-5' }, { id: 'gpt-5-codex' }], threadId: 't1' },
    });
    // The mock echoes whatever was PUT, like the real API.
    putAiPreferencesMock.mockImplementation(async (input: Partial<AiPreferencesState>) => ({ data: prefs(input) }));
    await mount();

    // Flipping to desktop with no provider picked is an incomplete intermediate: no save.
    await act(async () => {
      radio(container!, 'desktop').click();
    });
    expect(putAiPreferencesMock).not.toHaveBeenCalled();

    // Picking the provider completes the state → auto-saved.
    const providerSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop provider"]')!;
    await act(async () => {
      setSelectValue(providerSelect, 'prov-x');
    });
    await flush();
    expect(putAiPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ aiSource: 'desktop', desktopProviderId: 'prov-x' })
    );

    // Model pick + tool-mode toggle each persist immediately.
    const modelSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop model"]')!;
    await act(async () => {
      setSelectValue(modelSelect, 'gpt-5');
    });
    await flush();
    const confirmButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
    await act(async () => {
      confirmButton.click();
    });
    await flush();
    expect(putAiPreferencesMock).toHaveBeenLastCalledWith({
      aiSource: 'desktop',
      desktopProviderId: 'prov-x',
      desktopModel: 'gpt-5',
      customProviderId: null,
      chatToolMode: 'confirm',
      desktopReasoning: null,
    });

    // Everything is already saved — the explicit Save button has nothing left to do.
    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save AI settings')!;
    expect(saveButton.disabled).toBe(true);
  });

  it('offers the Default reasoning select ONLY for the Codex/ChatGPT connector and auto-saves picks', async () => {
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent' }),
    });
    listAiSourcesMock.mockResolvedValue([{ id: 'openai-codex-agent', name: 'Codex / ChatGPT' }]);
    fetchModelCatalogMock.mockResolvedValue({ ok: true, data: { models: [], threadId: 't1' } });
    putAiPreferencesMock.mockImplementation(async (input: Partial<AiPreferencesState>) => ({ data: prefs(input) }));
    await mount();

    const reasoningSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Default reasoning effort"]')!;
    expect(reasoningSelect).toBeTruthy();
    await act(async () => {
      setSelectValue(reasoningSelect, 'high');
    });
    await flush();
    expect(putAiPreferencesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ desktopProviderId: 'openai-codex-agent', desktopReasoning: 'high' })
    );

    // A non-codex provider shows no reasoning select.
    putAiPreferencesMock.mockClear();
    getAiPreferencesMock.mockResolvedValue({ data: prefs({ aiSource: 'desktop', desktopProviderId: 'prov-x' }) });
    listAiSourcesMock.mockResolvedValue([{ id: 'prov-x', name: 'Provider X' }]);
    await mount();
    expect(container!.querySelector('select[aria-label="Default reasoning effort"]')).toBeNull();
  });

  it('explicit Save still covers free-text edits (no catalog: typed model id) and toasts', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs({ aiSource: 'desktop', desktopProviderId: 'prov-x' }) });
    fetchModelCatalogMock.mockResolvedValue({ ok: false, error: { code: 'desktop_offline', message: 'offline' } });
    putAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'prov-x', desktopModel: 'my-model' }),
    });
    await mount();

    const modelInput = container!.querySelector<HTMLInputElement>('input[aria-label="Desktop model"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(modelInput, 'my-model');
      modelInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Typing never auto-saves.
    expect(putAiPreferencesMock).not.toHaveBeenCalled();

    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save AI settings')!;
    expect(saveButton.disabled).toBe(false);
    await act(async () => {
      saveButton.click();
    });
    await flush();
    expect(putAiPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ desktopModel: 'my-model' })
    );
    expect(toastSuccess).toHaveBeenCalledWith('AI settings saved');
  });

  it('surfaces a typed save error honestly', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs() });
    putAiPreferencesMock.mockResolvedValue({ error: 'The monthly Site AI allowance is used up.', code: 'ai_allowance_exceeded', status: 402 });
    await mount();

    const confirmButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
    await act(async () => {
      confirmButton.click();
    });
    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save AI settings')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(toastError).toHaveBeenCalledWith('Site AI allowance reached', 'The monthly Site AI allowance is used up.');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('validates the active source before saving', async () => {
    getAiPreferencesMock.mockResolvedValue({ data: prefs() });
    await mount();
    await act(async () => {
      radio(container!, 'desktop').click();
    });
    // No provider picked yet (empty listing) → save must refuse client-side.
    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save AI settings')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();
    expect(putAiPreferencesMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Pick a desktop provider', expect.any(String));
  });

  it('is read-only for the shared demo account', async () => {
    mockUser = { id: 'demo', isDemo: true };
    getAiPreferencesMock.mockResolvedValue({ data: prefs() });
    await mount();

    expect(container!.textContent).toContain('read-only');
    expect(radio(container!, 'site').disabled).toBe(true);
    expect(radio(container!, 'desktop').disabled).toBe(true);
    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save AI settings')!;
    expect(saveButton.disabled).toBe(true);
  });

  it('keeps a saved desktop provider selectable when the local listing is empty', async () => {
    getAiPreferencesMock.mockResolvedValue({
      data: prefs({ aiSource: 'desktop', desktopProviderId: 'remote-prov' }),
    });
    listAiSourcesMock.mockResolvedValue([]);
    await mount();

    const providerSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="Desktop provider"]');
    expect(providerSelect).not.toBeNull();
    expect(providerSelect!.value).toBe('remote-prov');
    expect(providerSelect!.textContent).toContain('remote-prov (saved)');
  });
});
