// Worker round-trip + vault lifecycle tests, driven through the cryptoClient
// request/response protocol against an in-process worker adapter (node has no
// Worker — the adapter runs worker.ts's own exported handler).
import { beforeEach, describe, expect, it } from 'vitest';
import { CryptoClient, createInlineWorker } from './cryptoClient';
import { __resetCryptoWorkerState } from './worker';
import { getSodium } from './sodium';
import { fromB64, toB64, utf8Bytes } from './encoding';
import { CONTENT_SUITE, WRAP_SUITE, sha256Hex } from './envelope';
import type { VaultWire } from '../../types/e2ee';

const USER = 'user-1';
const FORM = '11111111-2222-4333-8444-555555555555';

function makeClient() {
  __resetCryptoWorkerState();
  return new CryptoClient(createInlineWorker);
}

describe('cryptoClient + worker', () => {
  let client: CryptoClient;
  let vault: VaultWire;

  beforeEach(() => {
    client = makeClient();
  });

  it('creates a vault unlocked and reports status', async () => {
    const created = await client.createVault(USER, 'correct horse battery staple');
    expect(created.vault.version).toBe(1);
    expect(created.vault.kdf).toBe('argon2id13.1');
    expect(created.recoveryDisplay).toMatch(/^FLRK1-([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    vault = created.vault;
    const status = await client.status();
    expect(status.unlocked).toBe(true);
    expect(status.userId).toBe(USER);
  });

  it('round-trips unlock: lock → unlock with passphrase, wrong passphrase fails', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    await client.lockAndTerminate();
    expect(client.isRunning).toBe(false);

    // Wrong passphrase → vault_unlock_failed (a fresh inline worker each time).
    const wrong = makeClient();
    await expect(wrong.unlock(USER, 'passphrase-two', vault)).rejects.toMatchObject({ code: 'vault_unlock_failed' });

    const right = makeClient();
    await expect(right.unlock(USER, 'passphrase-one', vault)).resolves.toEqual({ ok: true });
  });

  it('fails closed (vault_corrupt) when the stored bundle does not match the public keys', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    // Corrupt the stored x25519 public key — unlock must refuse (§5).
    const sodium = await getSodium();
    const tampered: VaultWire = { ...vault, x25519Pk: toB64(sodium.randombytes_buf(32)) };
    const c = makeClient();
    await expect(c.unlock(USER, 'passphrase-one', tampered)).rejects.toMatchObject({ code: 'vault_corrupt' });
  });

  it('catches a mistyped recovery code via checksum BEFORE any KDF work', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    // Flip one character in the middle of the recovery code body (not the checksum group).
    const body = created.recoveryDisplay.split('-');
    const group = body[2];
    const flipped = group[0] === 'A' ? `B${group.slice(1)}` : `A${group.slice(1)}`;
    const mistyped = [...body.slice(0, 2), flipped, ...body.slice(3)].join('-');
    const c = makeClient();
    // recovery_invalid (checksum) — NOT vault_unlock_failed (which would mean the KDF ran).
    await expect(c.recoveryUnlock(USER, mistyped, 'new-passphrase-1', vault)).rejects.toMatchObject({ code: 'recovery_invalid' });
  });

  it('recovery-unlocks with a valid kit and rewraps under a new passphrase', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    const c = makeClient();
    const { rewrap } = await c.recoveryUnlock(USER, created.recoveryDisplay, 'passphrase-two', vault);
    const updated: VaultWire = { ...vault, ...rewrap, version: 2 };
    // Old passphrase no longer works; new one does.
    const stale = makeClient();
    await expect(stale.unlock(USER, 'passphrase-one', updated)).rejects.toMatchObject({ code: 'vault_unlock_failed' });
    const fresh = makeClient();
    await expect(fresh.unlock(USER, 'passphrase-two', updated)).resolves.toEqual({ ok: true });
    // The recovery wrapper is untouched by the rewrap.
    expect(updated.wrappedUmkRecovery).toBe(vault.wrappedUmkRecovery);
  });

  it('changes the passphrase rewrap-only: bundle + keys + recovery wrapper untouched', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    const { rewrap } = await client.changePassphrase(USER, 'passphrase-one', 'passphrase-two', vault);
    const updated: VaultWire = { ...vault, ...rewrap, version: 2 };
    expect(updated.encKeyBundle).toBe(vault.encKeyBundle);
    expect(updated.x25519Pk).toBe(vault.x25519Pk);
    expect(updated.ed25519Pk).toBe(vault.ed25519Pk);
    expect(updated.wrappedUmkRecovery).toBe(vault.wrappedUmkRecovery);
    expect(updated.wrappedUmk).not.toBe(vault.wrappedUmk);
    const c = makeClient();
    await expect(c.unlock(USER, 'passphrase-two', updated)).resolves.toEqual({ ok: true });
  });

  it('rejects a wrong current passphrase on change', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    await expect(client.changePassphrase(USER, 'not-the-passphrase', 'passphrase-two', vault))
      .rejects.toMatchObject({ code: 'vault_unlock_failed' });
  });

  it('enables form encryption end-to-end: enable → load keys → seal → open', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    vault = created.vault;
    const schemaJson = JSON.stringify([{ id: 'f1', type: 'short_text', label: 'Name' }]);
    const payload = await client.enableFormEncryption(USER, FORM, schemaJson);
    expect(payload.keyId).toMatch(/^fik_[0-9a-f]{32}$/);
    expect(payload.grant.grantId).toMatch(/^fkg_[0-9a-f]{32}$/);

    // The manifest + grant signatures must verify against the §8/§11 canonical
    // strings rebuilt INDEPENDENTLY here — the same strings the backend rebuilds
    // and verifies against the requester's vault keys (drift on either side fails).
    const sodium = await getSodium();
    const manifestCanonical = `flmanifest:1|${FORM}|${payload.keyId}|1|${payload.ingestionPublicKey}`
      + `|${CONTENT_SUITE}|${WRAP_SUITE}|1|${payload.schema.schemaHash}|${payload.manifest.signerKeyId}|-`;
    expect(sodium.crypto_sign_verify_detached(
      fromB64(payload.manifest.signature), utf8Bytes(manifestCanonical), fromB64(vault.ed25519Pk),
    )).toBe(true);
    const granteePkHash = await sha256Hex(fromB64(vault.x25519Pk));
    const wrappedKeyHash = await sha256Hex(fromB64(payload.grant.wrappedKey));
    const grantCanonical = `flgrant:1|${payload.grant.grantId}|${FORM}|1|${USER}|${USER}`
      + `|${granteePkHash}|${wrappedKeyHash}|${WRAP_SUITE}|owner|-`;
    expect(sodium.crypto_sign_verify_detached(
      fromB64(payload.grant.signature), utf8Bytes(grantCanonical), fromB64(vault.ed25519Pk),
    )).toBe(true);

    // Submitter side: seal against the served manifest (no vault needed).
    const { envelope } = await client.sealResponse({
      formId: FORM,
      keyId: payload.keyId,
      epoch: payload.ingestEpoch,
      schemaVersion: 1,
      schemaHash: payload.schema.schemaHash,
      publicKey: payload.ingestionPublicKey,
      inner: { v: 1, answers: { f1: 'Ada' } },
    });
    expect(envelope.__flenc).toBe(1);
    expect(envelope.rev).toBe(1);

    // Owner side: reload keys from the server-shaped rows and open the envelope.
    const owner = makeClient();
    await owner.unlock(USER, 'passphrase-one', vault);
    const loaded = await owner.loadFormKeys(FORM, [{
      grantId: payload.grant.grantId,
      fkEpoch: payload.fkEpoch,
      wrappedKey: payload.grant.wrappedKey,
      role: payload.grant.role,
      grantorUserId: USER,
      granteeUserId: USER,
      granteePk: vault.x25519Pk,
      sigVersion: payload.grant.sigVersion,
      signature: payload.grant.signature,
    }], [{
      id: payload.keyId,
      epoch: payload.ingestEpoch,
      publicKey: payload.ingestionPublicKey,
      wrappedSecret: payload.wrappedIngestionSecret,
      fkEpoch: payload.fkEpoch,
      state: 'active',
    }]);
    expect(loaded.loadedEpochs).toEqual([1]);

    const opened = await owner.openResponses(FORM, [{ envelope }], [{
      keyId: payload.keyId,
      ingestEpoch: payload.ingestEpoch,
      schemaVersion: 1,
      schemaHash: payload.schema.schemaHash,
    }], [{ id: payload.keyId, state: 'active', acceptUntil: null }]);
    expect(opened.results).toHaveLength(1);
    const first = opened.results[0];
    expect('inner' in first && first.inner.answers).toEqual({ f1: 'Ada' });
  });

  it('rejects an envelope whose tuple matches no acceptable manifest row', async () => {
    await client.createVault(USER, 'passphrase-one');
    const schemaJson = '[]';
    const payload = await client.enableFormEncryption(USER, FORM, schemaJson);
    const { envelope } = await client.sealResponse({
      formId: FORM,
      keyId: payload.keyId,
      epoch: 1,
      schemaVersion: 1,
      schemaHash: payload.schema.schemaHash,
      publicKey: payload.ingestionPublicKey,
      inner: { v: 1, answers: {} },
    });
    const opened = await client.openResponses(FORM, [{ envelope }], [{
      keyId: payload.keyId,
      ingestEpoch: 1,
      schemaVersion: 2, // skewed — no manifest row matches
      schemaHash: payload.schema.schemaHash,
    }], [{ id: payload.keyId, state: 'active', acceptUntil: null }]);
    expect(opened.results[0]).toMatchObject({ error: { code: 'manifest_rejected' } });
  });

  it('sealed responses mint a UUIDv4 recordId inside the worker', async () => {
    await client.createVault(USER, 'passphrase-one');
    const payload = await client.enableFormEncryption(USER, FORM, '[]');
    const { envelope } = await client.sealResponse({
      formId: FORM,
      keyId: payload.keyId,
      epoch: 1,
      schemaVersion: 1,
      schemaHash: payload.schema.schemaHash,
      publicKey: payload.ingestionPublicKey,
      inner: { v: 1, answers: {} },
    });
    expect(envelope.recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('schema-hash drift between enable and publish is caught by the owner pipeline', async () => {
    const created = await client.createVault(USER, 'passphrase-one');
    const payload = await client.enableFormEncryption(USER, FORM, '[]');
    const published = await client.publishSchemaVersion(USER, FORM, {
      keyId: payload.keyId,
      ingestEpoch: 1,
      schemaJson: utf8BytesToString([1]),
      version: 2,
    });
    expect(published.schemaHash).not.toBe(payload.schema.schemaHash);
    // The v2 manifest signature verifies against the independently rebuilt
    // §8 canonical string — exactly what the backend recomputes at publish.
    const sodium = await getSodium();
    const canonical = `flmanifest:1|${FORM}|${payload.keyId}|1|${payload.ingestionPublicKey}`
      + `|${CONTENT_SUITE}|${WRAP_SUITE}|2|${published.schemaHash}|${published.manifest.signerKeyId}|-`;
    expect(sodium.crypto_sign_verify_detached(
      fromB64(published.manifest.signature), utf8Bytes(canonical), fromB64(created.vault.ed25519Pk),
    )).toBe(true);
  });
});

function utf8BytesToString(arr: number[]): string {
  return JSON.stringify(arr);
}
