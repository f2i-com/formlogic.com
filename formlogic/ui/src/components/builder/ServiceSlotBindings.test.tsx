// @vitest-environment jsdom
// SRV-405 binding UI: a package declares service SLOTS; this is where the owner says which
// service fills each. An unbound slot must state its consequence (nodes refuse to compile),
// and the service list must only offer definitions that actually provide every action the
// slot requires — offering an unusable choice would produce a binding that can only fail.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceSlotBindings } from './ServiceSlotBindings';
import { api, type PackageServiceSlot } from '../../lib/api';
import * as catalogHook from '../../hooks/useServiceCatalog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const catalog = {
  schemaVersion: 3,
  definitions: [
    { id: 'openai-api', name: 'OpenAI API', actions: [{ id: 'generate-image' }, { id: 'chat-complete' }] },
    // Missing the required action → must never be offered for this slot.
    { id: 'chat-only', name: 'Chat Only', actions: [{ id: 'chat-complete' }] },
  ],
} as unknown as ReturnType<typeof catalogHook.useServiceCatalog>;

function slot(overrides: Partial<PackageServiceSlot> = {}): PackageServiceSlot {
  return { slot: 'imageGenerator', required: true, requiredActions: ['generate-image'], binding: null, ...overrides };
}

async function render(slots: PackageServiceSlot[]): Promise<string> {
  vi.spyOn(api, 'getPackageServiceBindings').mockResolvedValue({ data: { slots } } as Awaited<ReturnType<typeof api.getPackageServiceBindings>>);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ServiceSlotBindings installationId="inst-1" />);
  });
  return host.textContent ?? '';
}

describe('ServiceSlotBindings', () => {
  it('states the consequence of an unbound required slot', async () => {
    vi.spyOn(catalogHook, 'useServiceCatalog').mockReturnValue(catalog);
    const text = await render([slot()]);

    expect(text).toContain('imageGenerator');
    expect(text).toContain('needs generate-image');
    expect(text).toContain('refuse to compile');
    expect(text).toContain('Choose a service');
  });

  it('only offers services that provide every action the slot requires', async () => {
    vi.spyOn(catalogHook, 'useServiceCatalog').mockReturnValue(catalog);
    await render([slot()]);

    const choose = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent === 'Choose a service');
    await act(async () => {
      choose!.click();
    });

    const options = Array.from(host!.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('openai-api');
    expect(options).not.toContain('chat-only');
  });

  it('shows an existing binding with change/unbind rather than a picker', async () => {
    vi.spyOn(catalogHook, 'useServiceCatalog').mockReturnValue(catalog);
    const text = await render([slot({ binding: { definitionId: 'openai-api', connection: 'profile-7', boundAt: '2026-07-25T00:00:00Z' } })]);

    expect(text).toContain('openai-api');
    expect(text).toContain('on profile-7');
    expect(text).toContain('bound');
    expect(text).not.toContain('refuse to compile');
  });

  it('still lets a slot be prepared with no paired Desktop', async () => {
    vi.spyOn(catalogHook, 'useServiceCatalog').mockReturnValue(null);
    await render([slot()]);

    const choose = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent === 'Choose a service');
    await act(async () => {
      choose!.click();
    });

    // No catalog → free-text ids, and the situation is stated rather than blocking.
    expect(host!.querySelector('select')).toBeNull();
    expect(host!.querySelectorAll('input[type="text"]').length).toBe(2);
    expect(host!.textContent).toContain('No paired Desktop right now');
  });
});
