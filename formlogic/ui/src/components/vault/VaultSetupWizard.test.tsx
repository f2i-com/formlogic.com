// @vitest-environment jsdom
// The vault setup wizard (plan D5): the recovery kit is shown BEFORE the vault exists, the
// vault is created only after the kit is typed back, and from the moment the kit is on
// screen the wizard cannot be dismissed — only explicitly cancelled, which discards the
// kit and creates nothing.
//
// jsdom's realm breaks libsodium's instanceof checks (see storageInspection.test.ts), so
// the crypto worker is replaced by a fake client. Everything else is the REAL store and
// the REAL Modal: the guarantees under test live in how they fit together.
import React, { StrictMode, act } from 'react';
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
import type { VaultWire } from '../../types/e2ee';
import { VaultSetupWizard } from './VaultSetupWizard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PASSPHRASE = 'correct horse battery staple';
// Shaped like a real kit (FLRK1 + 13 groups of 4 + checksum group). The fake worker does
// not validate it; the store compares what is typed back with exactly this string.
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

/** Stands in for the worker: "born unlocked" on createVault, dead after lockAndTerminate. */
function makeFakeClient(createVault?: () => Promise<{ vault: VaultWire; recoveryDisplay: string }>) {
  let running = false;
  let unlocked = false;
  const client = {
    get isRunning() { return running; },
    createVault: vi.fn(createVault ?? (async () => {
      running = true;
      unlocked = true;
      return { vault: VAULT, recoveryDisplay: KIT };
    })),
    status: vi.fn(async () => {
      running = true;
      return { unlocked, userId: unlocked ? 'user-1' : null };
    }),
    lockAndTerminate: vi.fn(async () => {
      running = false;
      unlocked = false;
    }),
    markUnlocked() { running = true; unlocked = true; },
  };
  return client;
}

type FakeClient = ReturnType<typeof makeFakeClient>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('VaultSetupWizard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: FakeClient;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onComplete: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    __resetVaultStoreForTests();
    client = makeFakeClient();
    setCryptoClientForTests(client as unknown as CryptoClient);
    setSessionOwner('user-1');
    vi.mocked(api.getVault).mockReset().mockResolvedValue({ data: { vault: null } });
    vi.mocked(api.healthCheck).mockReset().mockResolvedValue({ data: { status: 'ok', timestamp: '', privateForms: true } });
    vi.mocked(api.createVault).mockReset().mockImplementation(async (vault) => ({ ok: true, status: 200, body: { data: { vault } } }));
    await useVaultStore.getState().refreshStatus();
    client.status.mockClear();
    onClose = vi.fn<() => void>();
    onComplete = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    __resetVaultStoreForTests();
    setSessionOwner(null);
    setCryptoClientForTests(null);
  });

  async function renderWizard(isOpen = true, strict = false): Promise<void> {
    const wizard = <VaultSetupWizard isOpen={isOpen} onClose={onClose} onComplete={onComplete} />;
    await act(async () => {
      root.render(strict ? <StrictMode>{wizard}</StrictMode> : wizard);
    });
  }

  // The Modal portals into document.body, so everything is looked up there.
  const text = () => document.body.textContent ?? '';
  const button = (label: string): HTMLButtonElement | null =>
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) ?? null;
  const closeButton = () => document.body.querySelector('[aria-label="Close modal"]');

  async function click(label: string): Promise<void> {
    const target = button(label);
    expect(target, `button "${label}"`).not.toBeNull();
    await act(async () => { target!.click(); });
    await flush();
  }

  async function typeInto(placeholder: string, value: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    expect(input, `input "${placeholder}"`).not.toBeNull();
    await act(async () => {
      // React tracks the value setter — go through the prototype so onChange fires.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function enterPassphraseAndShowKit(): Promise<void> {
    await renderWizard();
    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click('Create vault');
  }

  async function goToConfirmStep(): Promise<void> {
    await enterPassphraseAndShowKit();
    await click('I saved it');
  }

  const pressEscape = () => act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  const clickBackdrop = () => act(() => {
    const backdrop = document.body.querySelector('.backdrop-blur-sm');
    expect(backdrop, 'modal backdrop').not.toBeNull();
    backdrop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });

  // --- ordering ----------------------------------------------------------------------

  it('shows the kit BEFORE the vault exists: nothing is sent when the passphrase is entered', async () => {
    await enterPassphraseAndShowKit();

    expect(text()).toContain(KIT);
    expect(text()).toContain('not created yet');
    expect(client.createVault).toHaveBeenCalledTimes(1);
    expect(api.createVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().status).toBe('none');
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('a wrong typed-back kit does not proceed: no request, an error, the kit is still recoverable', async () => {
    await goToConfirmStep();

    await typeInto('FLRK1-XXXX-XXXX-…', 'FLRK1-WRONG-WRONG');
    await click('Confirm & create vault');

    expect(api.createVault).not.toHaveBeenCalled();
    expect(text()).toContain("doesn't match your recovery kit");
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(useVaultStore.getState().status).toBe('none');
    // Back shows the same kit again.
    await click('Back');
    expect(text()).toContain(KIT);
  });

  it('the kit typed back correctly creates the vault — once — and completes', async () => {
    await goToConfirmStep();
    expect(api.createVault).not.toHaveBeenCalled();

    await typeInto('FLRK1-XXXX-XXXX-…', KIT.toLowerCase());
    await click('Confirm & create vault');

    expect(api.createVault).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.createVault).mock.calls[0][0]).toEqual(VAULT);
    expect(useVaultStore.getState().status).toBe('unlocked');
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a request that fails to get through keeps the kit: the user can try again with no re-typing of the passphrase', async () => {
    vi.mocked(api.createVault)
      .mockResolvedValueOnce({ ok: false, status: 0, body: null })
      .mockImplementation(async (vault) => ({ ok: true, status: 200, body: { data: { vault } } }));
    await goToConfirmStep();
    await typeInto('FLRK1-XXXX-XXXX-…', KIT);

    await click('Confirm & create vault');
    expect(text()).toContain('FormLogic did not confirm that the vault was created');
    expect(onComplete).not.toHaveBeenCalled();

    await click('Confirm & create vault');
    expect(api.createVault).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a lock while the kit is on screen voids it: confirming sends nothing and starts over with the reason', async () => {
    await goToConfirmStep();
    await typeInto('FLRK1-XXXX-XXXX-…', KIT);

    act(() => { useVaultStore.getState().lock(); });
    await flush();
    await click('Confirm & create vault');

    expect(api.createVault).not.toHaveBeenCalled();
    expect(text()).toContain('Create your encryption vault');
    expect(text()).toContain('Nothing was saved');
    expect(text()).not.toContain(KIT);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('refuses before any kit is shown when private forms are off on the server', async () => {
    vi.mocked(api.healthCheck).mockResolvedValue({ data: { status: 'ok', timestamp: '', privateForms: false } });
    await enterPassphraseAndShowKit();

    expect(text()).toContain('Private forms are not enabled on this server.');
    expect(text()).toContain('Create your encryption vault');
    expect(text()).not.toContain(KIT);
    expect(client.createVault).not.toHaveBeenCalled();
  });

  // --- saving the kit ------------------------------------------------------------------

  it('offers Copy, Download and Print next to the kit — none of them advances the wizard or sends anything', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wizard-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await enterPassphraseAndShowKit();

    expect(button('Copy to clipboard')).not.toBeNull();
    expect(button('Download')).not.toBeNull();
    expect(button('Print')).not.toBeNull();

    await click('Download');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(text()).toContain(KIT);
    expect(text()).toContain('Save your recovery kit');
    expect(api.createVault).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('Download hands the browser a text file with the kit, the date and a warning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0));
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return 'blob:wizard-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    await enterPassphraseAndShowKit();

    await click('Download');

    expect(downloads).toEqual(['formlogic-vault-recovery-kit-2026-09-29.txt']);
    const file = await blobs[0].text();
    expect(file).toContain(`    ${KIT}\n`);
    expect(file).toContain('Created: 2026-09-29');
    expect(file).toContain('FormLogic cannot recover them for you.');
    expect(button('Downloaded')).not.toBeNull();
  });

  it('the kit is written to no browser storage and sent in no request, through show, save and confirm', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wizard-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const printDoc = document.implementation.createHTMLDocument('');
    const win = { focus: vi.fn(), print: vi.fn(), addEventListener: vi.fn() };
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(win as unknown as Window);
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(printDoc);
    localStorage.clear();
    sessionStorage.clear();

    await goToConfirmStep();
    await click('Back');
    await click('Download');
    await click('Print');
    await click('I saved it');
    await typeInto('FLRK1-XXXX-XXXX-…', KIT);
    await click('Confirm & create vault');

    expect(onComplete).toHaveBeenCalledTimes(1);
    const kitBody = KIT.replace(/-/g, '').slice('FLRK1'.length);
    const persisted = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie });
    expect(persisted).not.toContain(KIT);
    expect(persisted).not.toContain(kitBody);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The one request that was made is the vault create, and it carries no kit.
    expect(api.createVault).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(api.createVault).mock.calls[0][0])).not.toContain(kitBody);
  });

  it('Print opens a minimal print view of the kit', async () => {
    const printDoc = document.implementation.createHTMLDocument('');
    const win = { focus: vi.fn(), print: vi.fn(), addEventListener: vi.fn() };
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(win as unknown as Window);
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(printDoc);
    await enterPassphraseAndShowKit();

    await click('Print');
    const frame = document.body.querySelector('iframe');
    expect(frame).not.toBeNull();
    act(() => { frame!.dispatchEvent(new Event('load')); });

    expect(win.print).toHaveBeenCalledTimes(1);
    expect(printDoc.querySelector('pre')?.textContent).toBe(KIT);
    expect(printDoc.body.textContent).toContain('Anyone who has this kit can open your encrypted vault.');
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('says so when the browser cannot start the download or the print', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('blocked'); });
    await enterPassphraseAndShowKit();

    await click('Download');
    expect(text()).toContain("couldn't start the download");

    vi.spyOn(document.body, 'appendChild').mockImplementationOnce(() => { throw new Error('no frames'); });
    await click('Print');
    expect(text()).toContain("Printing isn't available here");
    // The kit is still on screen: a failed save costs nothing.
    expect(text()).toContain(KIT);
  });

  // --- dismissal -----------------------------------------------------------------------

  it('the passphrase step is dismissible as before (nothing exists yet)', async () => {
    await renderWizard();
    expect(closeButton()).not.toBeNull();

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissal attempts are ignored while the kit is showing: Escape, backdrop click, no close button', async () => {
    await enterPassphraseAndShowKit();

    expect(closeButton()).toBeNull();
    pressEscape();
    clickBackdrop();
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain(KIT);
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(client.lockAndTerminate).not.toHaveBeenCalled();
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('dismissal attempts are ignored on the confirm step too', async () => {
    await goToConfirmStep();
    await typeInto('FLRK1-XXXX-XXXX-…', 'half-typed');

    expect(closeButton()).toBeNull();
    pressEscape();
    clickBackdrop();
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain('Recovery kit');
    expect((document.body.querySelector('input[placeholder="FLRK1-XXXX-XXXX-…"]') as HTMLInputElement).value).toBe('half-typed');
    expect(useVaultStore.getState().setupPending).toBe(true);
  });

  it('dismissal attempts are ignored while the kit is being prepared', async () => {
    let release!: (r: { vault: VaultWire; recoveryDisplay: string }) => void;
    client = makeFakeClient(() => new Promise((resolve) => { release = resolve; }));
    setCryptoClientForTests(client as unknown as CryptoClient);
    await renderWizard();
    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click('Create vault');
    expect(client.createVault).toHaveBeenCalledTimes(1);

    expect(closeButton()).toBeNull();
    pressEscape();
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();

    client.markUnlocked();
    await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
    await flush();
    expect(text()).toContain(KIT);
  });

  it('"Cancel and start over" says what it discards and needs a second, explicit click', async () => {
    await enterPassphraseAndShowKit();

    await click('Cancel and start over');

    expect(text()).toContain('no vault will be created');
    expect(text()).toContain('will be discarded');
    // Nothing has happened yet: the kit is still on screen and still pending.
    expect(text()).toContain(KIT);
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(client.lockAndTerminate).not.toHaveBeenCalled();

    // "Keep this kit" backs out.
    await click('Keep this kit');
    expect(text()).not.toContain('no vault will be created');
    expect(text()).toContain(KIT);
    expect(useVaultStore.getState().setupPending).toBe(true);
  });

  it('confirming "Cancel and start over" discards the kit and the prepared vault, sends nothing, and starts again', async () => {
    await enterPassphraseAndShowKit();

    await click('Cancel and start over');
    await click('Discard kit and start over');

    expect(api.createVault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // Back at the first step, kit gone from the page.
    expect(text()).toContain('Create your encryption vault');
    expect(text()).not.toContain(KIT);
    // The store is empty: no vault, nothing pending, the worker that held the secrets is dead.
    const state = useVaultStore.getState();
    expect(state.status).toBe('none');
    expect(state.vault).toBeNull();
    expect(state.setupPending).toBe(false);
    expect(client.isRunning).toBe(false);
    expect(client.lockAndTerminate).toHaveBeenCalled();
  });

  it('after starting over a brand-new kit and vault are prepared — the old kit is never reused', async () => {
    await enterPassphraseAndShowKit();
    await click('Cancel and start over');
    await click('Discard kit and start over');

    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click('Create vault');

    expect(client.createVault).toHaveBeenCalledTimes(2);
    expect(text()).toContain(KIT);
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('the wizard going away with the kit on screen creates nothing and leaves nothing pending', async () => {
    await enterPassphraseAndShowKit();
    expect(useVaultStore.getState().setupPending).toBe(true);

    act(() => root.unmount());
    await flush();

    expect(api.createVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(client.isRunning).toBe(false);
    // (re-create the root so afterEach can unmount it)
    root = createRoot(container);
  });

  it('a prepare that finishes after the wizard has gone is dropped, not left pending with an unlocked worker', async () => {
    let release!: (r: { vault: VaultWire; recoveryDisplay: string }) => void;
    client = makeFakeClient(() => new Promise((resolve) => { release = resolve; }));
    setCryptoClientForTests(client as unknown as CryptoClient);
    await renderWizard();
    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click('Create vault');
    expect(client.createVault).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    client.markUnlocked();
    await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
    await flush();

    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(client.isRunning).toBe(false);
    expect(api.createVault).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it('a parent closing the wizard while the kit is showing drops the kit and the prepared vault', async () => {
    await enterPassphraseAndShowKit();

    await renderWizard(false);
    await flush();
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(api.createVault).not.toHaveBeenCalled();

    await renderWizard(true);
    expect(text()).toContain('Create your encryption vault');
    expect(text()).not.toContain(KIT);
  });

  it('under React StrictMode (main.tsx) the double-invoked effects neither drop a setup nor lock a vault', async () => {
    // Open, prepare, confirm — all inside StrictMode, as the app runs in development.
    await renderWizard(true, true);
    await typeInto('At least 12 characters', PASSPHRASE);
    await typeInto('Repeat the passphrase', PASSPHRASE);
    await click('Create vault');
    expect(text()).toContain(KIT);
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(client.lockAndTerminate).not.toHaveBeenCalled();

    await click('I saved it');
    await typeInto('FLRK1-XXXX-XXXX-…', KIT);
    await click('Confirm & create vault');

    expect(api.createVault).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().status).toBe('unlocked');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a closed wizard never touches a vault that is already unlocked (several are mounted at once)', async () => {
    client.markUnlocked();
    useVaultStore.setState({ status: 'unlocked', vault: VAULT });

    await renderWizard(false);
    act(() => root.unmount());
    await flush();
    root = createRoot(container);

    expect(useVaultStore.getState().status).toBe('unlocked');
    expect(client.lockAndTerminate).not.toHaveBeenCalled();
  });
});
