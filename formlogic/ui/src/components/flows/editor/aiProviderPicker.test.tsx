// @vitest-environment jsdom
// DOM-level tests for the llm_chat "AI service" picker (plan §5.6):
//   - "Default (from Settings)" renders as the TOP option and gains the resolved
//     source label once preferences load (site / desktop / custom variants);
//   - selecting it stores the 'default' alias value; Auto stores undefined;
//   - a stored 'default' value stays selected and never renders a "(missing)" ghost;
//   - the legacy Auto entry + registry options render unchanged beneath it.
// The option-list logic itself is pinned in aiProviderOptions.test.ts; these tests
// exercise the actual component wiring (prefs fetch → label, select value binding).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAiPreferencesMock, listProvidersMock } = vi.hoisted(() => ({
  getAiPreferencesMock: vi.fn(),
  listProvidersMock: vi.fn(),
}));

vi.mock('../../../client-runtime/flows/aiDefault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../client-runtime/flows/aiDefault')>();
  return {
    ...actual,
    getAiPreferences: (...args: unknown[]) => getAiPreferencesMock(...args),
  };
});

vi.mock('../../../client-runtime/flows/aiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../client-runtime/flows/aiProviders')>();
  return {
    ...actual,
    listProviders: (...args: unknown[]) => listProvidersMock(...args),
  };
});

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: { id: 'u1' } }),
}));

vi.mock('../../../client-runtime/desktop/desktopClient', () => ({
  desktopClient: {},
}));

import { AiProviderPickerField } from './NodeProperties';
import type { NodePropertySpec } from './nodeCatalog';
import type { AiProviderConfig } from '../../../client-runtime/flows/aiProviders';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function spec(overrides: Partial<NodePropertySpec> = {}): NodePropertySpec {
  return { key: 'provider', label: 'AI service', type: 'aiProvider', capability: 'chat', ...overrides };
}

function registryProvider(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'p1',
    name: 'My OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function prefsOk(patch: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      aiSource: 'site',
      desktopProviderId: null,
      desktopModel: null,
      customProviderId: null,
      chatToolMode: 'auto',
      ...patch,
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPicker(value: unknown, onChange: (v: unknown) => void = () => undefined) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AiProviderPickerField spec={spec()} value={value} onChange={onChange} />);
  });
  await flush();
  return { container, root };
}

function selectOf(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('select');
  if (!el) throw new Error('picker <select> not rendered');
  return el;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.textContent ?? '');
}

describe('AiProviderPickerField — "Default (from Settings)" option (plan §5.6)', () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    listProvidersMock.mockReturnValue([registryProvider()]);
    getAiPreferencesMock.mockResolvedValue(prefsOk());
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = '';
  });

  it('renders Default first, then Auto, then the registry services', async () => {
    const rendered = await renderPicker('');
    root = rendered.root;
    const select = selectOf(rendered.container);

    expect(select.options[0].value).toBe('default');
    expect(select.options[0].textContent).toBe('Default (from Settings) — Site AI');
    expect(select.options[1].value).toBe('');
    expect(select.options[1].textContent).toBe('Auto (Desktop/app default)');
    expect(select.options[2].value).toBe('p1');
    expect(select.options[2].textContent).toBe('My OpenAI - OpenAI');
  });

  it('shows the plain label while preferences are still loading', () => {
    // Never-resolving prefs promise: the component must render immediately with the
    // unresolved label and fill the source in once the promise lands (covered above).
    getAiPreferencesMock.mockReturnValue(new Promise(() => undefined));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const localRoot = createRoot(container);
    act(() => {
      localRoot.render(<AiProviderPickerField spec={spec()} value="" onChange={() => undefined} />);
    });
    const select = selectOf(container);
    expect(select.options[0].textContent).toBe('Default (from Settings)');
    act(() => {
      localRoot.unmount();
    });
  });

  it('labels the option with the desktop provider when the source is Desktop', async () => {
    getAiPreferencesMock.mockResolvedValue(prefsOk({ aiSource: 'desktop', desktopProviderId: 'codex' }));
    const rendered = await renderPicker('');
    root = rendered.root;
    expect(selectOf(rendered.container).options[0].textContent).toBe('Default (from Settings) — Desktop — codex');
  });

  it('labels the option with the registry service name when the source is Custom', async () => {
    getAiPreferencesMock.mockResolvedValue(prefsOk({ aiSource: 'custom', customProviderId: 'p1' }));
    const rendered = await renderPicker('');
    root = rendered.root;
    expect(selectOf(rendered.container).options[0].textContent).toBe('Default (from Settings) — Custom — My OpenAI');
  });

  it('keeps the plain label when preferences cannot be loaded (no crash, no hop)', async () => {
    getAiPreferencesMock.mockResolvedValue({ ok: false, error: { code: 'transport', message: 'down' } });
    const rendered = await renderPicker('');
    root = rendered.root;
    expect(selectOf(rendered.container).options[0].textContent).toBe('Default (from Settings)');
  });

  it("selecting Default stores the 'default' alias; selecting Auto clears the provider", async () => {
    const changes: unknown[] = [];
    const rendered = await renderPicker('p1', (v) => changes.push(v));
    root = rendered.root;
    const select = selectOf(rendered.container);

    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'default');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      setter.call(select, '');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(changes).toEqual(['default', undefined]);
  });

  it("a stored 'default' value stays selected and never renders a '(missing)' ghost", async () => {
    const rendered = await renderPicker('default');
    root = rendered.root;
    const select = selectOf(rendered.container);

    expect(select.value).toBe('default');
    expect(optionLabels(select).some((label) => label.includes('(missing)'))).toBe(false);
  });

  it('an unknown stored value keeps its verbatim "(missing)" entry', async () => {
    const rendered = await renderPicker('ghost-id');
    root = rendered.root;
    const select = selectOf(rendered.container);

    expect(select.value).toBe('ghost-id');
    expect(optionLabels(select)).toContain('ghost-id (missing)');
  });
});
