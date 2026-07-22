// @vitest-environment jsdom
// One-way "Encrypt this form" settings section (E2EE plan §3 D8 / §9.1):
//  - private form → read-only permanent status, NO decrypt-back affordance;
//  - non-private + unlocked vault → confirm → the creation-time enable path runs
//    and onEnabled fires (builder badge refreshes without reload);
//  - locked vault → the click sequences through VaultUnlockDialog first;
//  - 409 private_enable_blocked → the server's details.reasons[] render in
//    human-readable form.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { enableMock, markPrivateMock, ensureVaultMock, toastSuccess, toastError } = vi.hoisted(() => ({
  enableMock: vi.fn(),
  markPrivateMock: vi.fn(),
  ensureVaultMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/crypto/formCrypto', () => ({
  enableFormEncryption: (...args: unknown[]) => enableMock(...args),
  markFormPrivate: (...args: unknown[]) => markPrivateMock(...args),
  ensureVaultLoaded: (...args: unknown[]) => ensureVaultMock(...args),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// Keep the vault dialogs as markers — their own internals are tested elsewhere.
vi.mock('../vault/VaultSetupWizard', () => ({
  VaultSetupWizard: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="setup-wizard" /> : null),
}));
vi.mock('../vault/VaultUnlockDialog', () => ({
  VaultUnlockDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="unlock-dialog" /> : null),
}));

import { EncryptionSettings } from './EncryptionSettings';
import { describeEnableBlockReasons } from '../../lib/crypto/enableBlockReasons';
import { useVaultStore } from '../../stores/vaultStore';
import { useFormStore } from '../../stores/formStore';
import type { Form } from '../../types/form';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FORM_ID = 'form-e2ee-settings';

function makeForm(): Form {
  return {
    id: FORM_ID,
    title: 'Candidate',
    fields: [{ id: 'f1', type: 'short_text', label: 'Name', required: false, properties: {}, order: 0 } as Form['fields'][number]],
    settings: {} as Form['settings'],
    theme: {} as Form['theme'],
    createdAt: '',
    updatedAt: '',
    status: 'draft',
    responseCount: 0,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('EncryptionSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    useFormStore.setState({ forms: [makeForm()] } as never);
    useVaultStore.setState({ status: 'unlocked', vault: null, generation: 0 });
    onEnabled = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(isPrivate: boolean): Promise<void> {
    await act(async () => {
      root.render(<EncryptionSettings formId={FORM_ID} isPrivate={isPrivate} onEnabled={onEnabled} />);
    });
  }

  function button(label: string): HTMLButtonElement | null {
    // The ConfirmDialog portals to document.body, so search the whole document.
    return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) ?? null;
  }

  it('renders read-only permanent status for a private form — no enable action, no decrypt-back', async () => {
    await render(true);
    expect(container.textContent).toContain('End-to-end encrypted — permanent');
    expect(container.textContent).toContain('Private mode cannot be turned off');
    expect(button('Encrypt this form permanently')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('runs the creation-time enable path on confirm and fires onEnabled', async () => {
    enableMock.mockResolvedValue(undefined);
    await render(false);
    await act(async () => { button('Encrypt this form permanently')?.click(); });
    // Danger confirm with the permanence warning (portaled to document.body).
    expect(document.body.textContent).toContain('Encrypt this form permanently?');
    expect(document.body.textContent).toContain('cannot be undone');
    await act(async () => { button('Encrypt permanently')?.click(); });
    await flush();
    expect(enableMock).toHaveBeenCalledWith(FORM_ID, JSON.stringify(makeForm().fields));
    expect(markPrivateMock).toHaveBeenCalledWith(FORM_ID);
    expect(onEnabled).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('locked vault sequences through the unlock dialog instead of the confirm', async () => {
    useVaultStore.setState({ status: 'locked' });
    await render(false);
    await act(async () => { button('Encrypt this form permanently')?.click(); });
    await flush();
    expect(container.querySelector('[data-testid="unlock-dialog"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Encrypt this form permanently?');
    expect(enableMock).not.toHaveBeenCalled();
  });

  it('missing vault sequences through the setup wizard', async () => {
    useVaultStore.setState({ status: 'none' });
    await render(false);
    await act(async () => { button('Encrypt this form permanently')?.click(); });
    await flush();
    expect(container.querySelector('[data-testid="setup-wizard"]')).not.toBeNull();
    expect(enableMock).not.toHaveBeenCalled();
  });

  it('renders private_enable_blocked reasons in human-readable form', async () => {
    const err = Object.assign(new Error('blocked'), {
      code: 'private_enable_blocked',
      reasons: ['ever_published', 'has_webhooks'],
    });
    enableMock.mockRejectedValue(err);
    await render(false);
    await act(async () => { button('Encrypt this form permanently')?.click(); });
    await act(async () => { button('Encrypt permanently')?.click(); });
    await flush();
    expect(container.textContent).toContain("This form can't be made private:");
    expect(container.textContent).toContain('This form was published before encryption existed and can never be made private.');
    expect(container.textContent).toContain('The form has webhooks — remove them first (a webhook would receive plaintext).');
    expect(onEnabled).not.toHaveBeenCalled();
  });
});

describe('describeEnableBlockReasons', () => {
  it('maps every §9.1 preflight reason to a human sentence and keeps unknowns legible', () => {
    expect(describeEnableBlockReasons(['ever_published'])).toEqual([
      'This form was published before encryption existed and can never be made private.',
    ]);
    const out = describeEnableBlockReasons(['some_future_reason']);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('some_future_reason');
  });
});
