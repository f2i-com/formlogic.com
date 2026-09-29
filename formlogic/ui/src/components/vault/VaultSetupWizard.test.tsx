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
import { useToastStore } from '../../stores/toastStore';
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
    useToastStore.getState().clearToasts();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useToastStore.getState().clearToasts();
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

  // While a prepare runs (its preflight requests, then the key derivation) NO kit exists yet, so
  // nothing is at stake and the user must be able to leave — a stalled connection must not trap
  // them in a dialog with no way out but a reload. What was being prepared is dropped when it ends.
  describe('while the vault is being prepared (no kit exists yet)', () => {
    let release: (r: { vault: VaultWire; recoveryDisplay: string }) => void;

    async function startSlowPrepare(): Promise<void> {
      client = makeFakeClient(() => new Promise((resolve) => { release = resolve; }));
      setCryptoClientForTests(client as unknown as CryptoClient);
      await renderWizard();
      await typeInto('At least 12 characters', PASSPHRASE);
      await typeInto('Repeat the passphrase', PASSPHRASE);
      await click('Create vault');
      expect(client.createVault).toHaveBeenCalledTimes(1);
    }

    it.each([
      ['Escape', () => pressEscape()],
      ['a click outside', () => clickBackdrop()],
      ['the close button', () => act(() => { (closeButton() as HTMLButtonElement).click(); })],
      ['the Cancel button', () => act(() => { button('Cancel')!.click(); })],
    ])('%s still dismisses it, and a prepare that finishes afterwards is dropped', async (_name, dismiss) => {
      await startSlowPrepare();
      expect(closeButton(), 'a close button while preparing').not.toBeNull();

      dismiss();
      expect(onClose).toHaveBeenCalledTimes(1);

      client.markUnlocked();
      await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
      await flush();
      // It finished after the wizard was closed: no kit on screen, nothing pending, worker gone.
      expect(text()).not.toContain(KIT);
      expect(text()).toContain('Create your encryption vault');
      expect(useVaultStore.getState().setupPending).toBe(false);
      expect(client.isRunning).toBe(false);
      expect(api.createVault).not.toHaveBeenCalled();
    });

    it('a parent closing the wizard while it is preparing makes that prepare stale too', async () => {
      await startSlowPrepare();

      await renderWizard(false);
      client.markUnlocked();
      await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
      await flush();

      expect(useVaultStore.getState().setupPending).toBe(false);
      expect(client.isRunning).toBe(false);
      await renderWizard(true);
      expect(text()).toContain('Create your encryption vault');
      expect(text()).not.toContain(KIT);
    });

    it('after dismissing mid-prepare the wizard is not stuck: Create vault reaches the store again', async () => {
      await startSlowPrepare();
      pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);

      // The first prepare is still running, so the store says wait — but it WAS asked.
      await typeInto('At least 12 characters', PASSPHRASE);
      await typeInto('Repeat the passphrase', PASSPHRASE);
      await click('Create vault');
      expect(text()).toMatch(/already being set up/i);
      expect(button('Create vault')!.disabled).toBe(false);

      client.markUnlocked();
      await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
      await flush();
    });

    it('a second Enter is ignored: no second prepare, no error, the fields are kept', async () => {
      client = makeFakeClient(() => new Promise((resolve) => { release = resolve; }));
      setCryptoClientForTests(client as unknown as CryptoClient);
      await renderWizard();
      await typeInto('At least 12 characters', PASSPHRASE);
      await typeInto('Repeat the passphrase', PASSPHRASE);
      const repeat = document.body.querySelector<HTMLInputElement>('input[placeholder="Repeat the passphrase"]')!;
      const pressEnter = () => act(() => {
        repeat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });

      pressEnter();
      await flush();
      pressEnter();
      await flush();

      expect(client.createVault).toHaveBeenCalledTimes(1);
      expect(text()).not.toMatch(/already being set up/i);
      expect(repeat.value).toBe(PASSPHRASE);

      client.markUnlocked();
      await act(async () => { release({ vault: VAULT, recoveryDisplay: KIT }); });
      await flush();
      expect(text()).toContain(KIT);
    });

    it('a prepare that throws is reported and does not leave the wizard busy for good', async () => {
      const original = useVaultStore.getState().prepareSetup;
      useVaultStore.setState({ prepareSetup: vi.fn().mockRejectedValue(new Error('the connection blew up')) });
      try {
        await renderWizard();
        await typeInto('At least 12 characters', PASSPHRASE);
        await typeInto('Repeat the passphrase', PASSPHRASE);
        await click('Create vault');

        expect(text()).toContain('the connection blew up');
        expect(button('Create vault')!.disabled).toBe(false);
        expect(button('Cancel')!.disabled).toBe(false);
      } finally {
        useVaultStore.setState({ prepareSetup: original });
      }
    });
  });

  it('says the vault is being saved while the create request is out, and dismissal stays blocked meanwhile', async () => {
    await goToConfirmStep();
    await typeInto('FLRK1-XXXX-XXXX-…', KIT);
    let respond!: (r: { ok: boolean; status: number; body: Record<string, unknown> | null }) => void;
    vi.mocked(api.createVault).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));

    await click('Confirm & create vault');

    expect(api.createVault).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Saving your vault/);
    expect(text()).toMatch(/recovery kit stays valid/i);
    expect(closeButton()).toBeNull();
    pressEscape();
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Cancel and start over')!.disabled).toBe(true);

    await act(async () => { respond({ ok: true, status: 200, body: { data: { vault: VAULT } } }); });
    await flush();
    expect(onComplete).toHaveBeenCalledTimes(1);
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

  // The notice opens above the trigger, often below the fold on a phone: focus goes to its safe
  // choice and the notice is scrolled into view, so a keyboard or screen-reader user (and a thumb)
  // lands on it instead of on <body>.
  describe('the discard notice and focus', () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoView = vi.fn();
      // jsdom does not implement it.
      Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
    });

    afterEach(() => {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    });

    it('moves focus to "Keep this kit" and scrolls the notice into view when it opens', async () => {
      await enterPassphraseAndShowKit();

      await click('Cancel and start over');

      expect(document.activeElement).toBe(button('Keep this kit'));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('does not disable the trigger while the notice is open — it says it is expanded instead', async () => {
      await enterPassphraseAndShowKit();
      const trigger = () => button('Cancel and start over')!;
      expect(trigger().getAttribute('aria-expanded')).toBe('false');

      await click('Cancel and start over');

      expect(trigger().disabled).toBe(false);
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      const notice = document.getElementById(trigger().getAttribute('aria-controls')!);
      expect(notice, 'the notice the trigger controls').not.toBeNull();
      expect(notice!.textContent).toContain('Discard this recovery kit and start over?');
      expect(document.activeElement).not.toBe(document.body);
    });

    it('a second press on the trigger while the notice is open changes nothing', async () => {
      await enterPassphraseAndShowKit();
      await click('Cancel and start over');

      await click('Cancel and start over');

      expect(button('Keep this kit')).not.toBeNull();
      expect(useVaultStore.getState().setupPending).toBe(true);
      expect(document.activeElement).toBe(button('Keep this kit'));
    });

    it('"Keep this kit" puts focus back on the trigger it came from', async () => {
      await enterPassphraseAndShowKit();
      await click('Cancel and start over');

      await click('Keep this kit');

      expect(document.activeElement).toBe(button('Cancel and start over'));
      expect(button('Cancel and start over')!.getAttribute('aria-expanded')).toBe('false');
      expect(text()).not.toContain('Discard kit and start over');
    });

    it('the same on the confirm step, and after a check that had to ask the server first', async () => {
      vi.mocked(api.createVault).mockResolvedValueOnce({ ok: false, status: 0, body: null });
      await goToConfirmStep();
      await typeInto('FLRK1-XXXX-XXXX-…', KIT);
      await click('Confirm & create vault');
      expect(text()).toContain('FormLogic did not confirm');

      await click('Cancel and start over'); // the server has no vault: the notice opens after the check

      expect(text()).toContain('FormLogic checked');
      expect(document.activeElement).toBe(button('Keep this kit'));
      await click('Keep this kit');
      expect(document.activeElement).toBe(button('Cancel and start over'));
    });

    it('names its warning for a screen reader: a labelled group whose description is on the safe button', async () => {
      await enterPassphraseAndShowKit();

      await click('Cancel and start over');

      const keep = button('Keep this kit')!;
      const group = keep.closest('[role="group"]');
      expect(group, 'the notice is a group').not.toBeNull();
      expect(document.getElementById(group!.getAttribute('aria-labelledby')!)?.textContent).toContain('Discard this recovery kit');
      expect(document.getElementById(keep.getAttribute('aria-describedby')!)?.textContent).toContain('no vault will be created');
    });
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

  // --- a create request that got no answer ------------------------------------------------------
  //
  // The request may have created the vault even though nothing came back. Then the kit the user
  // saved may be the only way into it, so the wizard must not say that nothing was saved, or that
  // the kit can be thrown away, until the server has said there is no vault.

  describe('when the create request gets no answer', () => {
    const FALSE_COMFORT = /nothing has been saved|nothing was saved|not created yet|no vault will be created|throw away/i;
    const toasts = () => useToastStore.getState().toasts;
    let serverVault: VaultWire | null;

    beforeEach(() => {
      serverVault = null;
      vi.mocked(api.getVault).mockImplementation(async () => ({ data: { vault: serverVault } }));
      vi.mocked(api.createVault).mockImplementation(async (vault) => {
        if (serverVault) return { ok: false, status: 409, body: { error: true, code: 'vault_exists' } };
        serverVault = vault;
        return { ok: true, status: 200, body: { data: { vault } } };
      });
    });

    /** The request reaches the server and the vault is stored, but the answer is lost. */
    const loseResponse = () => vi.mocked(api.createVault).mockImplementationOnce(async (vault) => {
      serverVault = vault;
      return { ok: false, status: 0, body: null };
    });
    /** The request never reaches the server. */
    const dropRequest = () => vi.mocked(api.createVault).mockImplementationOnce(async () => ({ ok: false, status: 0, body: null }));

    async function confirmWithNoAnswer(lose: 'response' | 'request' = 'response'): Promise<void> {
      if (lose === 'response') loseResponse(); else dropRequest();
      await goToConfirmStep();
      await typeInto('FLRK1-XXXX-XXXX-…', KIT);
      await click('Confirm & create vault');
      expect(text()).toContain('FormLogic did not confirm that the vault was created');
      expect(api.createVault).toHaveBeenCalledTimes(1);
    }

    it('says the vault may exist and to keep the kit — and nothing on the page says it was not created', async () => {
      await confirmWithNoAnswer();

      expect(text()).toMatch(/may already exist/i);
      expect(text()).toMatch(/keep it/i);
      // Even the small print under the buttons no longer promises that Cancel creates no vault.
      expect(text()).toMatch(/first checks with FormLogic whether your vault was created/i);
      expect(text()).not.toMatch(FALSE_COMFORT);
      // The kit step reached with Back says the same, not "not created yet".
      await click('Back');
      expect(text()).toContain(KIT);
      expect(text()).toMatch(/may already exist/i);
      expect(text()).toMatch(/first checks with FormLogic whether your vault was created/i);
      expect(text()).not.toMatch(FALSE_COMFORT);
    });

    it('"Cancel and start over" asks the server first — and when the vault is there it keeps it, unlocked', async () => {
      await confirmWithNoAnswer('response');
      const lookedBefore = vi.mocked(api.getVault).mock.calls.length;

      await click('Cancel and start over');

      // It found the vault: adopted, the wizard closes, and the user is told the kit is its kit.
      expect(vi.mocked(api.getVault).mock.calls.length - lookedBefore).toBe(1);
      expect(useVaultStore.getState().status).toBe('unlocked');
      expect(useVaultStore.getState().setupPending).toBe(false);
      expect(client.lockAndTerminate).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled(); // they asked to cancel; the vault exists, that is all
      expect(toasts().map((t) => `${t.title} ${t.message ?? ''}`).join(' ')).toMatch(/vault was created/i);
      expect(text()).not.toContain('Discard');
    });

    it('when the server has no vault it says so, and only then offers to discard the kit', async () => {
      await confirmWithNoAnswer('request');
      expect(text()).not.toContain('Discard kit and start over');

      await click('Cancel and start over');

      expect(text()).toContain('FormLogic checked');
      expect(text()).toContain('no vault was created');
      expect(text()).toContain('no vault will be created');
      expect(useVaultStore.getState().setupPending).toBe(true);
      expect(client.lockAndTerminate).not.toHaveBeenCalled();

      await click('Discard kit and start over');
      expect(text()).toContain('Create your encryption vault');
      expect(text()).not.toContain(KIT);
      expect(useVaultStore.getState().setupPending).toBe(false);
      expect(useVaultStore.getState().status).toBe('none');
      expect(client.isRunning).toBe(false);
      expect(api.createVault).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('"Keep this kit" after that check backs out, and the same kit can still be confirmed', async () => {
      await confirmWithNoAnswer('request');
      await click('Cancel and start over');
      await click('Keep this kit');

      expect(text()).not.toContain('FormLogic checked');
      await click('Confirm & create vault');

      expect(api.createVault).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(useVaultStore.getState().status).toBe('unlocked');
    });

    it('when the server cannot be reached it does not discard: it says the vault may exist and lets the user leave knowingly', async () => {
      await confirmWithNoAnswer('response');
      vi.mocked(api.getVault).mockResolvedValueOnce({ error: 'Network error' });

      await click('Cancel and start over');

      expect(text()).toMatch(/could not be reached/i);
      expect(text()).toMatch(/may already exist/i);
      expect(text()).toContain('Recovery kit'); // still on the confirm step, kit not thrown away
      expect(text()).not.toMatch(FALSE_COMFORT);
      expect(useVaultStore.getState().setupPending).toBe(true);
      expect(client.lockAndTerminate).not.toHaveBeenCalled();

      // Keeping the kit backs out; leaving anyway is the user's explicit choice.
      await click('Keep this kit');
      expect(useVaultStore.getState().setupPending).toBe(true);
      vi.mocked(api.getVault).mockResolvedValueOnce({ error: 'Network error' });
      await click('Cancel and start over');
      await click('Leave anyway');
      expect(text()).toContain('Create your encryption vault');
      expect(text()).not.toContain(KIT);
      expect(useVaultStore.getState().setupPending).toBe(false);
      // The vault DOES exist on the server, and the store now knows: locked, not "none".
      await flush();
      expect(useVaultStore.getState().status).toBe('locked');
      expect(useVaultStore.getState().vault).toEqual(serverVault);
    });

    it('when the server holds a DIFFERENT vault the wizard closes with the reason, and that vault opens locked', async () => {
      await confirmWithNoAnswer('request');
      serverVault = { ...VAULT, kdfSalt: 'c29tZWJvZHktZWxzZQ==' };

      await click('Cancel and start over');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(toasts().map((t) => `${t.title} ${t.message ?? ''}`).join(' ')).toMatch(/already exists/i);
      expect(useVaultStore.getState().status).toBe('locked');
      expect(useVaultStore.getState().vault).toEqual(serverVault);
      expect(useVaultStore.getState().setupPending).toBe(false);
      expect(client.isRunning).toBe(false);
    });

    it('a lock after the no-answer, then another confirm: says the vault may exist — not that nothing was saved', async () => {
      await confirmWithNoAnswer('response');

      act(() => { useVaultStore.getState().lock(); });
      await flush();
      await click('Confirm & create vault');

      expect(api.createVault).toHaveBeenCalledTimes(1);
      expect(text()).toContain('Create your encryption vault');
      expect(text()).toMatch(/may already exist/i);
      expect(text()).toMatch(/keep the recovery kit you saved/i);
      expect(text()).not.toMatch(/nothing was saved|void/i);
    });

    it('a lock after the no-answer, then "Cancel and start over": no discard notice — the reason is shown instead', async () => {
      await confirmWithNoAnswer('response');

      act(() => { useVaultStore.getState().lock(); });
      await flush();
      await click('Cancel and start over');

      expect(text()).toContain('Create your encryption vault');
      expect(text()).toMatch(/may already exist/i);
      expect(text()).toMatch(/keep the recovery kit you saved/i);
      expect(text()).not.toContain('Discard');
      expect(text()).not.toMatch(/nothing was saved|void/i);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('a different vault found when the confirm is sent closes the wizard too (no create form under a message about an existing vault)', async () => {
      await goToConfirmStep();
      // Somebody else's session created a vault while the kit was being saved.
      serverVault = { ...VAULT, kdfSalt: 'c29tZWJvZHktZWxzZQ==' };
      await typeInto('FLRK1-XXXX-XXXX-…', KIT);

      await click('Confirm & create vault');

      expect(api.createVault).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
      expect(toasts().map((t) => `${t.title} ${t.message ?? ''}`).join(' ')).toMatch(/already exists/i);
      expect(useVaultStore.getState().status).toBe('locked');
    });

    it('a setup whose request was never sent still says no vault will be created — with no check and no doubt', async () => {
      await goToConfirmStep();
      vi.mocked(api.getVault).mockClear();

      await click('Cancel and start over');

      expect(text()).toContain('Nothing has been saved to your account');
      expect(text()).toContain('no vault will be created');
      expect(text()).not.toContain('FormLogic checked');
      expect(api.getVault).not.toHaveBeenCalled();
    });
  });
});
