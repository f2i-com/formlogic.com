// Two-phase vault creation (plan D5): the vault is PREPARED locally (wrappers + recovery
// kit, nothing sent) and created on the server only after the kit has been shown and
// typed back. These tests pin that ordering at the store, where the guarantee has to
// hold whatever the UI does: no create request before a correct confirmation, nothing
// persisted when the flow is abandoned, and no way to send a vault that no longer
// belongs to the session that prepared it.
//
// Node environment on purpose: jsdom's realm breaks libsodium's instanceof checks (see
// storageInspection.test.ts). Driven through the real worker handler via the inline
// adapter, exactly like vaultStore.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    isAuthenticated: () => true,
    getVault: vi.fn(),
    createVault: vi.fn(),
    changeVaultPassphrase: vi.fn(),
    healthCheck: vi.fn(),
  },
  newIdempotencyKey: () => 'idem-test',
}));

import { api } from '../lib/api';
import { CryptoClient, createInlineWorker, setCryptoClientForTests, getCryptoClient } from '../lib/crypto/cryptoClient';
import { bumpSessionGeneration, setSessionOwner } from '../lib/sessionGeneration';
import { useVaultStore, __resetVaultStoreForTests } from './vaultStore';
import { usePrivateDataStore } from './privateDataStore';
import type { VaultWire } from '../types/e2ee';

// Argon2id (64 MiB) runs for real in every prepare — leave headroom for a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const USER = 'user-1';
const PASS = 'correct horse battery staple';
const KIT_SHAPE = /^FLRK1-([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/;

type CreateResponse = { ok: boolean; status: number; body: Record<string, unknown> | null };

const createdOk = (vault: VaultWire): CreateResponse => ({ ok: true, status: 200, body: { data: { vault } } });

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Prepare a vault through the store and hand back what the wizard would receive. */
async function prepare(passphrase = PASS): Promise<{ setupId: string; kit: string }> {
  const result = await useVaultStore.getState().prepareSetup(USER, passphrase);
  expect(result.ok).toBe(true);
  return { setupId: result.setupId!, kit: result.recoveryDisplay! };
}

/** The wire the store handed to api.createVault on its Nth call. */
function sentVault(call = 0): VaultWire {
  return vi.mocked(api.createVault).mock.calls[call][0];
}

/** A vault some OTHER session created (built and torn down before the test's own setup,
 *  because every inline worker shares one heap). */
async function foreignVault(): Promise<VaultWire> {
  const other = new CryptoClient(createInlineWorker);
  const { vault } = await other.createVault(USER, 'somebody-elses-passphrase');
  await other.lockAndTerminate();
  return vault;
}

describe('vaultStore two-phase setup', () => {
  beforeEach(async () => {
    __resetVaultStoreForTests();
    usePrivateDataStore.getState().clear();
    setCryptoClientForTests(new CryptoClient(createInlineWorker));
    setSessionOwner(USER);
    vi.mocked(api.getVault).mockReset().mockResolvedValue({ data: { vault: null } });
    vi.mocked(api.healthCheck).mockReset().mockResolvedValue({ data: { status: 'ok', timestamp: '', privateForms: true } });
    vi.mocked(api.createVault).mockReset().mockImplementation(async (vault) => createdOk(vault));
    // The wizard only opens for an account the store already knows has no vault.
    await useVaultStore.getState().refreshStatus();
    expect(useVaultStore.getState().status).toBe('none');
  });

  afterEach(async () => {
    await getCryptoClient().lockAndTerminate();
    __resetVaultStoreForTests();
    setSessionOwner(null);
    setCryptoClientForTests(null);
  });

  // --- phase 1: prepare sends nothing --------------------------------------------------

  it('prepareSetup generates the vault and its kit locally and sends NOTHING to the server', async () => {
    const { kit } = await prepare();

    expect(kit).toMatch(KIT_SHAPE);
    expect(api.createVault).not.toHaveBeenCalled();
    const state = useVaultStore.getState();
    // The vault does not exist yet: the store still says so.
    expect(state.status).toBe('none');
    expect(state.vault).toBeNull();
    expect(state.setupPending).toBe(true);
    // The secrets are in the worker's heap only, as ever.
    expect((await getCryptoClient().status()).unlocked).toBe(true);
  });

  it('a wrong typed-back kit does not proceed: no request, the setup stays open', async () => {
    const { setupId, kit } = await prepare();
    // One character off inside the first body group.
    const wrong = `${kit.slice(0, 8)}${kit[8] === 'A' ? 'B' : 'A'}${kit.slice(9)}`;

    const result = await useVaultStore.getState().commitSetup(setupId, wrong);

    expect(result).toMatchObject({ ok: false, code: 'kit_mismatch' });
    expect(result.discarded).toBeFalsy();
    expect(api.createVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().status).toBe('none');
    expect(useVaultStore.getState().setupPending).toBe(true);

    // Empty and unrelated input are refused the same way.
    await expect(useVaultStore.getState().commitSetup(setupId, '')).resolves.toMatchObject({ code: 'kit_mismatch' });
    await expect(useVaultStore.getState().commitSetup(setupId, 'FLRK1-AAAA')).resolves.toMatchObject({ code: 'kit_mismatch' });
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('the kit typed back exactly creates the vault — one request, carrying the prepared wire', async () => {
    const { setupId, kit } = await prepare();
    expect(api.createVault).not.toHaveBeenCalled();
    const genBefore = useVaultStore.getState().generation;

    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toEqual({ ok: true });
    expect(api.createVault).toHaveBeenCalledTimes(1);
    const wire = sentVault();
    expect(wire.kdf).toBe('argon2id13.1');
    expect(wire.wrappedUmkRecovery).toBeTruthy();
    const state = useVaultStore.getState();
    expect(state.status).toBe('unlocked');
    expect(state.vault).toEqual(wire);
    expect(state.setupPending).toBe(false);
    expect(state.generation).toBeGreaterThan(genBefore);
    expect((await getCryptoClient().status()).unlocked).toBe(true);
  });

  it('the kit that was shown really opens the vault that was created', async () => {
    const { setupId, kit } = await prepare();
    await useVaultStore.getState().commitSetup(setupId, kit);
    const persisted = sentVault();

    // A fresh worker, with only what the server holds and what the user wrote down.
    await getCryptoClient().lockAndTerminate();
    const recovery = new CryptoClient(createInlineWorker);
    await expect(recovery.recoveryUnlock(USER, kit, 'a-brand-new-passphrase', persisted)).resolves.toHaveProperty('rewrap');
    await recovery.lockAndTerminate();

    const byPassphrase = new CryptoClient(createInlineWorker);
    await expect(byPassphrase.unlock(USER, PASS, persisted)).resolves.toEqual({ ok: true });
    await byPassphrase.lockAndTerminate();
  });

  it('the request carries only wrapped material — neither the kit nor the passphrase', async () => {
    const { setupId, kit } = await prepare();
    await useVaultStore.getState().commitSetup(setupId, kit);

    const body = JSON.stringify(sentVault());
    expect(body).not.toContain(PASS);
    expect(body).not.toContain(kit);
    expect(body).not.toContain(kit.replace(/-/g, '').slice('FLRK1'.length));
    expect(Object.keys(sentVault()).sort()).toEqual([
      'ed25519Pk', 'encKeyBundle', 'kdf', 'kdfMemlimit', 'kdfOpslimit', 'kdfSalt',
      'version', 'wrappedUmk', 'wrappedUmkRecovery', 'x25519Pk',
    ]);
  });

  it('the typed-back kit is matched the way recovery reads it: case, spaces and hyphens do not matter', async () => {
    const { setupId, kit } = await prepare();

    const sloppy = `  ${kit.toLowerCase().replace(/-/g, ' ')}  `;
    await expect(useVaultStore.getState().commitSetup(setupId, sloppy)).resolves.toEqual({ ok: true });
    expect(api.createVault).toHaveBeenCalledTimes(1);
  });

  // --- abandoning ---------------------------------------------------------------------

  it('abandoning before confirmation sends nothing and leaves the store locked and empty', async () => {
    const { setupId, kit } = await prepare();
    const client = getCryptoClient();
    expect(client.isRunning).toBe(true);

    await useVaultStore.getState().abandonSetup(setupId);

    expect(api.createVault).not.toHaveBeenCalled();
    const state = useVaultStore.getState();
    expect(state.status).toBe('none');
    expect(state.vault).toBeNull();
    expect(state.setupPending).toBe(false);
    // The worker that held the secrets is dead; a fresh one holds nothing.
    expect(client.isRunning).toBe(false);
    expect((await client.status()).unlocked).toBe(false);

    // The kit that was on screen is void: even typed back exactly it creates nothing.
    const late = await useVaultStore.getState().commitSetup(setupId, kit);
    expect(late).toMatchObject({ ok: false, code: 'setup_interrupted', discarded: true });
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('abandonSetup only acts on its own token — another holder cannot drop a setup', async () => {
    const { setupId, kit } = await prepare();

    await useVaultStore.getState().abandonSetup('setup-belonging-to-someone-else');

    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(getCryptoClient().isRunning).toBe(true);
    await expect(useVaultStore.getState().commitSetup(setupId, kit)).resolves.toEqual({ ok: true });
  });

  it('abandonSetup with nothing pending is a no-op — it never locks a working vault', async () => {
    // A vault that is already unlocked (e.g. the wizard mounted-but-closed elsewhere).
    const { setupId, kit } = await prepare();
    await useVaultStore.getState().commitSetup(setupId, kit);
    expect(useVaultStore.getState().status).toBe('unlocked');

    await useVaultStore.getState().abandonSetup('setup-1');
    await useVaultStore.getState().abandonSetup();

    expect(useVaultStore.getState().status).toBe('unlocked');
    expect((await getCryptoClient().status()).unlocked).toBe(true);
  });

  it('a lock (sign-out, another tab) drops the prepared vault: a later confirmation sends nothing', async () => {
    const { setupId, kit } = await prepare();

    useVaultStore.getState().lock();
    // The kit and wrappers are dropped synchronously; the worker follows.
    expect(useVaultStore.getState().setupPending).toBe(false);
    await flushAsync();
    expect(getCryptoClient().isRunning).toBe(false);

    const result = await useVaultStore.getState().commitSetup(setupId, kit);
    expect(result).toMatchObject({ ok: false, code: 'setup_interrupted', discarded: true });
    expect(api.createVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().status).toBe('none');
  });

  it('a second prepare replaces the first: the first kit is void', async () => {
    const first = await prepare();
    const second = await prepare('another correct horse battery');

    expect(second.setupId).not.toBe(first.setupId);
    expect(second.kit).not.toBe(first.kit);
    await expect(useVaultStore.getState().commitSetup(first.setupId, first.kit))
      .resolves.toMatchObject({ code: 'setup_interrupted', discarded: true });
    expect(api.createVault).not.toHaveBeenCalled();
    await expect(useVaultStore.getState().commitSetup(second.setupId, second.kit)).resolves.toEqual({ ok: true });
    expect(api.createVault).toHaveBeenCalledTimes(1);
  });

  it('prepares one vault at a time', async () => {
    const [a, b] = await Promise.all([
      useVaultStore.getState().prepareSetup(USER, PASS),
      useVaultStore.getState().prepareSetup(USER, PASS),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(api.createVault).not.toHaveBeenCalled();
  });

  // --- refusing before a kit exists ------------------------------------------------------

  it('refuses up front when a vault already exists — no kit is ever generated', async () => {
    vi.mocked(api.getVault).mockResolvedValue({ data: { vault: await foreignVault() } });

    const result = await useVaultStore.getState().prepareSetup(USER, PASS);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/i);
    expect(result.recoveryDisplay).toBeUndefined();
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(useVaultStore.getState().status).toBe('locked');
    expect(getCryptoClient().isRunning).toBe(false);
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('refuses up front when private forms are off on the server — the user is never asked to save a kit', async () => {
    vi.mocked(api.healthCheck).mockResolvedValue({ data: { status: 'ok', timestamp: '', privateForms: false } });

    const result = await useVaultStore.getState().prepareSetup(USER, PASS);

    expect(result).toMatchObject({ ok: false, error: 'Private forms are not enabled on this server.' });
    expect(result.recoveryDisplay).toBeUndefined();
    expect(getCryptoClient().isRunning).toBe(false);
    expect(useVaultStore.getState().setupPending).toBe(false);
  });

  it('refuses up front when the vault endpoint is unavailable (demo / acting-as / server error)', async () => {
    vi.mocked(api.getVault).mockResolvedValue({ error: 'Private forms are not available in the demo.', status: 403 });

    const result = await useVaultStore.getState().prepareSetup(USER, PASS);

    expect(result).toMatchObject({ ok: false, error: 'Private forms are not available in the demo.' });
    expect(getCryptoClient().isRunning).toBe(false);
  });

  it('an older server that does not report the private-forms flag does not block setup', async () => {
    vi.mocked(api.healthCheck).mockResolvedValue({ data: { status: 'ok', timestamp: '' } });

    await expect(useVaultStore.getState().prepareSetup(USER, PASS)).resolves.toMatchObject({ ok: true });
  });

  it('a weak passphrase is refused with no pending setup and no live worker', async () => {
    const result = await useVaultStore.getState().prepareSetup(USER, 'too short');

    expect(result.ok).toBe(false);
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(getCryptoClient().isRunning).toBe(false);
  });

  // --- the request itself ---------------------------------------------------------------

  it('a network failure keeps the setup: the SAME vault and kit can be sent again', async () => {
    vi.mocked(api.createVault)
      .mockResolvedValueOnce({ ok: false, status: 0, body: null })
      .mockImplementation(async (vault) => createdOk(vault));
    const { setupId, kit } = await prepare();

    const first = await useVaultStore.getState().commitSetup(setupId, kit);
    expect(first).toMatchObject({ ok: false, code: 'save_failed' });
    expect(first.discarded).toBeFalsy();
    expect(useVaultStore.getState().setupPending).toBe(true);
    expect(useVaultStore.getState().status).toBe('none');

    const second = await useVaultStore.getState().commitSetup(setupId, kit);
    expect(second).toEqual({ ok: true });
    expect(api.createVault).toHaveBeenCalledTimes(2);
    expect(sentVault(1)).toEqual(sentVault(0));
  });

  it('a lost response (409 vault_exists for the very same vault) is adopted, not reported as a failure', async () => {
    const { setupId, kit } = await prepare();
    vi.mocked(api.createVault).mockImplementationOnce(async (vault) => {
      // The server already holds exactly this vault: an earlier attempt got through and
      // only its response was lost.
      vi.mocked(api.getVault).mockResolvedValue({ data: { vault } });
      return { ok: false, status: 409, body: { error: true, code: 'vault_exists' } };
    });

    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toEqual({ ok: true });
    expect(useVaultStore.getState().status).toBe('unlocked');
    expect(useVaultStore.getState().setupPending).toBe(false);
  });

  it('a vault created by someone else first (409 vault_exists) discards the setup and opens that vault locked', async () => {
    const other = await foreignVault();
    const { setupId, kit } = await prepare();
    vi.mocked(api.createVault).mockResolvedValue({ ok: false, status: 409, body: { error: true, code: 'vault_exists' } });
    vi.mocked(api.getVault).mockResolvedValue({ data: { vault: other } });

    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toMatchObject({ ok: false, code: 'vault_exists', discarded: true });
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().vault).toEqual(other);
    expect(getCryptoClient().isRunning).toBe(false);
  });

  it('a refusal from the server (403 / 400) discards the setup and its worker', async () => {
    const { setupId, kit } = await prepare();
    vi.mocked(api.createVault).mockResolvedValue({
      ok: false,
      status: 403,
      body: { error: true, code: 'private_forms_disabled', message: 'Private forms are not enabled on this server.' },
    });

    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toMatchObject({
      ok: false,
      code: 'setup_rejected',
      discarded: true,
      error: 'Private forms are not enabled on this server.',
    });
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(useVaultStore.getState().status).toBe('none');
    expect(getCryptoClient().isRunning).toBe(false);
  });

  it('never sends a vault prepared under another sign-in session', async () => {
    const { setupId, kit } = await prepare();

    bumpSessionGeneration(); // sign-out + sign-in as someone else, without a lock in between
    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toMatchObject({ ok: false, code: 'setup_interrupted', discarded: true });
    expect(api.createVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().setupPending).toBe(false);
    expect(getCryptoClient().isRunning).toBe(false);
  });

  it('never sends a vault whose wrappers name a different account than the signed-in one', async () => {
    const { setupId, kit } = await prepare();

    setSessionOwner('user-2');
    const result = await useVaultStore.getState().commitSetup(setupId, kit);

    expect(result).toMatchObject({ ok: false, code: 'setup_interrupted', discarded: true });
    expect(api.createVault).not.toHaveBeenCalled();
  });

  it('a lock while the request is in flight: the vault exists but opens LOCKED, never unlocked without secrets', async () => {
    const { setupId, kit } = await prepare();
    let release!: (r: CreateResponse) => void;
    vi.mocked(api.createVault).mockImplementation(() => new Promise<CreateResponse>((resolve) => { release = resolve; }));

    const committing = useVaultStore.getState().commitSetup(setupId, kit);
    await flushAsync();
    expect(api.createVault).toHaveBeenCalledTimes(1);
    useVaultStore.getState().lock();
    await flushAsync();
    release(createdOk(sentVault()));
    const result = await committing;

    expect(result).toMatchObject({ ok: false, code: 'setup_interrupted', discarded: true });
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().vault).toEqual(sentVault());
    expect((await getCryptoClient().status()).unlocked).toBe(false);
  });

  it('while the request is in flight the setup cannot be torn down from under it', async () => {
    const { setupId, kit } = await prepare();
    let release!: (r: CreateResponse) => void;
    vi.mocked(api.createVault).mockImplementation(() => new Promise<CreateResponse>((resolve) => { release = resolve; }));

    const committing = useVaultStore.getState().commitSetup(setupId, kit);
    await flushAsync();
    await useVaultStore.getState().abandonSetup(setupId); // e.g. the wizard unmounting
    expect(getCryptoClient().isRunning).toBe(true);
    // ...and a second confirmation cannot fire a second request.
    await expect(useVaultStore.getState().commitSetup(setupId, kit)).resolves.toMatchObject({ code: 'setup_busy' });
    release(createdOk(sentVault()));

    await expect(committing).resolves.toEqual({ ok: true });
    expect(api.createVault).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().status).toBe('unlocked');
  });

  it('refreshStatus finding a vault on the server voids a pending setup and its unlocked worker', async () => {
    const other = await foreignVault();
    await prepare();
    vi.mocked(api.getVault).mockResolvedValue({ data: { vault: other } });

    await useVaultStore.getState().refreshStatus();

    expect(useVaultStore.getState().setupPending).toBe(false);
    // Locked — not "unlocked" on the strength of the setup's worker holding other secrets.
    expect(useVaultStore.getState().status).toBe('locked');
    expect((await getCryptoClient().status()).unlocked).toBe(false);
  });

  it('refreshStatus with no vault on the server leaves a pending setup alone', async () => {
    const { setupId, kit } = await prepare();

    await useVaultStore.getState().refreshStatus();

    expect(useVaultStore.getState().status).toBe('none');
    expect(useVaultStore.getState().setupPending).toBe(true);
    await expect(useVaultStore.getState().commitSetup(setupId, kit)).resolves.toEqual({ ok: true });
  });
});
