// @vitest-environment jsdom
// The vault setup wizard opened from Form settings -> Access -> "Encrypt this form
// permanently" (the main way a vault is created from the builder). Form settings has its
// own Escape handling and focus trap, and the wizard lives INSIDE it: closing the settings
// unmounts the wizard and discards the recovery kit on screen. So the wizard's promise -
// "cannot be dismissed while the kit is showing" - only holds if a dialog UNDERNEATH another
// one neither closes nor pulls focus when the one above is the one being used.
//
// The real FormSettingsModal, EncryptionSettings, VaultSetupWizard, Modal, focus trap and
// vault store are mounted together; only the network and the crypto worker are faked (jsdom's
// realm breaks libsodium's instanceof checks, see storageInspection.test.ts).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  api: {
    isAuthenticated: () => true,
    getVault: vi.fn(),
    createVault: vi.fn(),
    changeVaultPassphrase: vi.fn(),
    healthCheck: vi.fn(),
  },
  newIdempotencyKey: () => 'idem-test',
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string; email: string } }) => unknown) =>
    selector({ user: { id: 'user-1', email: 'owner@example.test' } }),
}));

import { api } from '../../lib/api';
import { setSessionOwner } from '../../lib/sessionGeneration';
import { setCryptoClientForTests, type CryptoClient } from '../../lib/crypto/cryptoClient';
import { useVaultStore, __resetVaultStoreForTests } from '../../stores/vaultStore';
import type { FormSettings } from '../../types/form';
import type { VaultWire } from '../../types/e2ee';
import { FormSettingsModal } from './FormSettingsPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PASSPHRASE = 'correct horse battery staple';
const KIT = 'FLRK1-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST-UVWX';
const VAULT: VaultWire = {
  version: 1,
  kdf: 'argon2id13.1',
  kdfSalt: 'c2FsdHNhbHRzYWx0c2FsdA==',
  kdfMemlimit: 67_108_864,
  kdfOpslimit: 3,
  wrappedUmk: 'd3JhcHBlZC11bWs=',
  wrappedUmkRecovery: 'd3JhcHBlZC1yZWNvdmVyeQ==',
  encKeyBundle: 'ZW5jLWtleS1idW5kbGU=',
  x25519Pk: 'eDI1NTE5LXBr',
  ed25519Pk: 'ZWQyNTUxOS1wYg==',
};

// One stable object: the modal re-seeds its edit buffer whenever `settings` changes identity.
const SETTINGS = {} as FormSettings;

function makeFakeClient() {
  let running = false;
  let unlocked = false;
  return {
    get isRunning() { return running; },
    createVault: vi.fn(async () => {
      running = true;
      unlocked = true;
      return { vault: VAULT, recoveryDisplay: KIT };
    }),
    status: vi.fn(async () => {
      running = true;
      return { unlocked, userId: unlocked ? 'user-1' : null };
    }),
    lockAndTerminate: vi.fn(async () => {
      running = false;
      unlocked = false;
    }),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the setup wizard inside Form settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: ReturnType<typeof makeFakeClient>;
  let onHostClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    __resetVaultStoreForTests();
    client = makeFakeClient();
    setCryptoClientForTests(client as unknown as CryptoClient);
    setSessionOwner('user-1');
    vi.mocked(api.getVault).mockReset().mockResolvedValue({ data: { vault: null } });
    vi.mocked(api.healthCheck).mockReset().mockResolvedValue({ data: { status: 'ok', timestamp: '', privateForms: true } });
    vi.mocked(api.createVault).mockReset().mockImplementation(async (vault) => ({ ok: true, status: 200, body: { data: { vault } } }));
    await useVaultStore.getState().refreshStatus();
    onHostClose = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    __resetVaultStoreForTests();
    setSessionOwner(null);
    setCryptoClientForTests(null);
  });

  const button = (label: string): HTMLButtonElement | null =>
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) ?? null;
  const text = () => document.body.textContent ?? '';

  async function click(target: HTMLElement | null, name: string): Promise<void> {
    expect(target, name).not.toBeNull();
    await act(async () => { target!.click(); });
    await flush();
  }

  async function typeInto(placeholder: string, value: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    expect(input, `input "${placeholder}"`).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function renderSettings(): Promise<void> {
    await act(async () => {
      root.render(
        <FormSettingsModal isOpen onClose={onHostClose} settings={SETTINGS} onSave={vi.fn()} formId="form-1" isPrivate={false} />,
      );
    });
  }

  /** Form settings -> Access -> "Encrypt this form permanently": the wizard opens on its passphrase step. */
  async function openWizard(): Promise<void> {
    await renderSettings();
    await click(document.body.querySelector('[role="tab"][aria-label="Access"]'), 'Access tab');
    await click(button('Encrypt this form permanently'), 'Encrypt this form permanently');
    expect(text()).toContain('Create your encryption vault');
  }

  async function showKit(): Promise<void> {
    await openWizard();
    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click(button('Create vault'), 'Create vault');
    expect(text()).toContain(KIT);
  }

  const settingsDialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('#form-settings-title')?.closest<HTMLElement>('[role="dialog"]') ?? null;
  // The wizard is the shared Modal, portalled to <body>: the one dialog that is not Form settings.
  const wizardDialog = (): HTMLElement | null =>
    [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d !== settingsDialog()) ?? null;

  const press = (key: string, init: KeyboardEventInit = {}) => act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

  // --- the kit is on screen: nothing behind the wizard may take it away ----------------------

  it('Escape with the kit showing does not close Form settings behind it, so the kit survives', async () => {
    await showKit();

    press('Escape');
    await flush();

    expect(onHostClose).not.toHaveBeenCalled();
    expect(text()).toContain(KIT);
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(client.lockAndTerminate).not.toHaveBeenCalled();
  });

  it('Tab and Shift+Tab with the kit showing keep focus inside the wizard, not on the settings behind it', async () => {
    await showKit();
    const dialog = wizardDialog();
    expect(dialog).not.toBeNull();
    const focusable = [...dialog!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    expect(focusable.length).toBeGreaterThan(2);
    const [first, second] = focusable;
    const last = focusable[focusable.length - 1];

    // A plain Tab from inside the wizard.
    second.focus();
    press('Tab');
    expect(dialog!.contains(document.activeElement), 'after Tab').toBe(true);
    expect(settingsDialog()!.contains(document.activeElement), 'settings must not take focus on Tab').toBe(false);

    // Forwards past the last control wraps to the wizard's first.
    last.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);

    // Backwards past the first control wraps to the wizard's last.
    first.focus();
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(onHostClose).not.toHaveBeenCalled();
    expect(useVaultStore.getState().setupPending).toBe(true);
  });

  it('with focus outside every dialog Tab lands in the wizard on top, and Enter cannot reach the settings close button', async () => {
    await showKit();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    press('Tab');

    expect(wizardDialog()!.contains(document.activeElement)).toBe(true);
    expect(onHostClose).not.toHaveBeenCalled();
    expect(text()).toContain(KIT);
  });

  it('a dismissal attempt at the confirm step is ignored by the settings behind it too', async () => {
    await showKit();
    await click(button('I saved it'), 'I saved it');

    press('Escape');
    await flush();

    expect(onHostClose).not.toHaveBeenCalled();
    expect(text()).toContain('Recovery kit');
    expect(useVaultStore.getState().setupPending).toBe(true);
  });

  // --- the wizard is dismissible where it always was --------------------------------------------

  it('Escape on the passphrase step closes the wizard only - Form settings stays open', async () => {
    await openWizard();

    press('Escape');
    // The Modal fades out before it leaves the DOM.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });

    expect(wizardDialog()).toBeNull();
    expect(onHostClose).not.toHaveBeenCalled();
    expect(settingsDialog()).not.toBeNull();
    expect(text()).toContain('Form settings');
  });

  // --- Form settings on its own is unchanged -------------------------------------------------

  it('with nothing above it, Escape still closes Form settings', async () => {
    await renderSettings();

    press('Escape');

    expect(onHostClose).toHaveBeenCalledTimes(1);
  });

  it('with nothing above it, Escape with unsaved edits still asks before discarding them', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderSettings();
    await click(document.body.querySelector('[role="tab"][aria-label="Behavior"]'), 'Behavior tab');
    const quota = document.body.querySelector<HTMLInputElement>('input[type="number"]');
    expect(quota).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(quota, '25');
      quota!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    press('Escape');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onHostClose).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    press('Escape');
    expect(onHostClose).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('with nothing above it, Tab still wraps inside Form settings', async () => {
    await renderSettings();
    const dialog = settingsDialog()!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);

    first.focus();
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
