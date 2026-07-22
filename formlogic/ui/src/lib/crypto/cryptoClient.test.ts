// Worker round-trip + vault lifecycle tests, driven through the cryptoClient
// request/response protocol against an in-process worker adapter (node has no
// Worker — the adapter runs worker.ts's own exported handler).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoClient, createInlineWorker } from './cryptoClient';
import { __resetCryptoWorkerState } from './worker';
import { getSodium } from './sodium';
import { fromB64, toB64, toHex, utf8Bytes } from './encoding';
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
    const grantWire = {
      grantId: payload.grant.grantId,
      fkEpoch: payload.fkEpoch,
      wrappedKey: payload.grant.wrappedKey,
      role: payload.grant.role,
      grantorUserId: USER,
      granteeUserId: USER,
      granteePk: vault.x25519Pk,
      sigVersion: payload.grant.sigVersion,
      signature: payload.grant.signature,
    };
    const ingestionWire = [{
      id: payload.keyId,
      epoch: payload.ingestEpoch,
      publicKey: payload.ingestionPublicKey,
      wrappedSecret: payload.wrappedIngestionSecret,
      fkEpoch: payload.fkEpoch,
      state: 'active' as const,
    }];
    const manifestRow = {
      manifestSeq: 1,
      keyId: payload.keyId,
      ingestEpoch: payload.ingestEpoch,
      schemaVersion: 1,
      schemaHash: payload.schema.schemaHash,
      contentSuite: CONTENT_SUITE,
      wrapSuite: WRAP_SUITE,
      signerKeyId: payload.manifest.signerKeyId,
      signerPk: vault.ed25519Pk,
      signedBytes: manifestCanonical,
      signature: payload.manifest.signature,
      expiresAt: null,
      supersededAt: null,
    };
    const schemaVersions = [{ version: 1, schemaHash: payload.schema.schemaHash, schemaJson }];
    const loaded = await owner.loadFormKeys(FORM, [grantWire], ingestionWire, [manifestRow], schemaVersions);
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

// ---------------------------------------------------------------------------
// Owner-side served-state verification (review 2026-07-22, blocker 4): the
// worker must reject non-self grants, unverifiable self-grants, and ANY stored
// manifest that does not fully verify — BEFORE loading keys.
// ---------------------------------------------------------------------------

async function buildServedState() {
  const sodium = await getSodium();
  const client = makeClient();
  const { vault } = await client.createVault(USER, 'passphrase-one');
  const schemaJson = JSON.stringify([{ id: 'f1', type: 'short_text', label: 'Name' }]);
  const payload = await client.enableFormEncryption(USER, FORM, schemaJson);
  const manifestCanonical = `flmanifest:1|${FORM}|${payload.keyId}|1|${payload.ingestionPublicKey}`
    + `|${CONTENT_SUITE}|${WRAP_SUITE}|1|${payload.schema.schemaHash}|${payload.manifest.signerKeyId}|-`;
  const grant = {
    grantId: payload.grant.grantId,
    fkEpoch: payload.fkEpoch,
    wrappedKey: payload.grant.wrappedKey,
    role: payload.grant.role,
    grantorUserId: USER,
    granteeUserId: USER,
    granteePk: vault.x25519Pk,
    sigVersion: payload.grant.sigVersion,
    signature: payload.grant.signature,
  };
  const ingestionKeys = [{
    id: payload.keyId,
    epoch: payload.ingestEpoch,
    publicKey: payload.ingestionPublicKey,
    wrappedSecret: payload.wrappedIngestionSecret,
    fkEpoch: payload.fkEpoch,
    state: 'active' as const,
  }];
  const manifest = {
    manifestSeq: 1,
    keyId: payload.keyId,
    ingestEpoch: payload.ingestEpoch,
    schemaVersion: 1,
    schemaHash: payload.schema.schemaHash,
    contentSuite: CONTENT_SUITE,
    wrapSuite: WRAP_SUITE,
    signerKeyId: payload.manifest.signerKeyId,
    signerPk: vault.ed25519Pk,
    signedBytes: manifestCanonical,
    signature: payload.manifest.signature,
    expiresAt: null,
    supersededAt: null,
  };
  const schemaVersions = [{ version: 1, schemaHash: payload.schema.schemaHash, schemaJson }];
  return { sodium, client, vault, payload, schemaJson, grant, ingestionKeys, manifest, schemaVersions };
}

describe('worker owner-side verification (blocker 4)', () => {
  it('loads keys for a fully valid served state', async () => {
    const { client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    const loaded = await client.loadFormKeys(FORM, [grant], ingestionKeys, [manifest], schemaVersions);
    expect(loaded.loadedEpochs).toEqual([1]);
  });

  it('REJECTS any grant whose grantor is not the vault owner (fail closed)', async () => {
    const { client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    // The old code skipped verification when grantorUserId !== self — now a
    // non-self grant is a typed refusal and the FK is never unwrapped.
    const tampered = { ...grant, grantorUserId: 'someone-else' };
    await expect(client.loadFormKeys(FORM, [tampered], ingestionKeys, [manifest], schemaVersions))
      .rejects.toMatchObject({ code: 'grant_invalid' });
  });

  it('REJECTS a grant sealed to a different grantee public key', async () => {
    const { sodium, client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    const tampered = { ...grant, granteePk: toB64(sodium.crypto_box_keypair().publicKey) };
    await expect(client.loadFormKeys(FORM, [tampered], ingestionKeys, [manifest], schemaVersions))
      .rejects.toMatchObject({ code: 'grant_invalid' });
  });

  it('REJECTS a self-grant with a bad signature', async () => {
    const { sodium, client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    const forged = { ...grant, signature: toB64(sodium.crypto_sign_detached(utf8Bytes('forged'), sodium.crypto_sign_keypair().privateKey)) };
    await expect(client.loadFormKeys(FORM, [forged], ingestionKeys, [manifest], schemaVersions))
      .rejects.toMatchObject({ code: 'grant_invalid' });
  });

  it('REJECTS a served manifest not signed by the vault key (owner is the only signer in P3)', async () => {
    const { sodium, client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    const foreign = sodium.crypto_sign_keypair();
    const foreignKeyId = toHex(sodium.crypto_hash_sha256(foreign.publicKey)).slice(0, 16);
    const signedBytes = manifest.signedBytes.replace(manifest.signerKeyId, foreignKeyId);
    const tampered = {
      ...manifest,
      signerKeyId: foreignKeyId,
      signerPk: toB64(foreign.publicKey),
      signedBytes,
      signature: toB64(sodium.crypto_sign_detached(utf8Bytes(signedBytes), foreign.privateKey)),
    };
    await expect(client.loadFormKeys(FORM, [grant], ingestionKeys, [tampered], schemaVersions))
      .rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('REJECTS a manifest whose schemaHash does not match the served schema bytes', async () => {
    const { client, grant, ingestionKeys, manifest } = await buildServedState();
    // Serve different schema JSON under the same version — the row's schemaHash
    // no longer matches sha256 of the served bytes.
    const tamperedSchemas = [{ version: 1, schemaHash: manifest.schemaHash, schemaJson: JSON.stringify([{ id: 'evil', type: 'short_text', label: 'Injected' }]) }];
    await expect(client.loadFormKeys(FORM, [grant], ingestionKeys, [manifest], tamperedSchemas))
      .rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('REJECTS a manifest whose stored canonical bytes were altered', async () => {
    const { client, grant, ingestionKeys, manifest, schemaVersions } = await buildServedState();
    const tampered = { ...manifest, signedBytes: manifest.signedBytes.replace('|1|', '|2|') };
    await expect(client.loadFormKeys(FORM, [grant], ingestionKeys, [tampered], schemaVersions))
      .rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('REJECTS a manifest row missing its schema version', async () => {
    const { client, grant, ingestionKeys, manifest } = await buildServedState();
    await expect(client.loadFormKeys(FORM, [grant], ingestionKeys, [manifest], []))
      .rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('REJECTS when no manifests are served at all', async () => {
    const { client, grant, ingestionKeys, schemaVersions } = await buildServedState();
    await expect(client.loadFormKeys(FORM, [grant], ingestionKeys, [], schemaVersions))
      .rejects.toMatchObject({ code: 'manifest_invalid' });
  });
});

describe('bounded lock (blocker 3)', () => {
  it('lockAndTerminate hard-terminates a wedged worker in ~250ms, never waiting indefinitely', async () => {
    const wedged = {
      postMessage: () => { /* never answers */ },
      addEventListener: () => { /* noop */ },
      removeEventListener: () => { /* noop */ },
      terminate: vi.fn(),
    };
    const client = new CryptoClient(() => wedged);
    // Spawn the worker; the op stays pending forever.
    const dangling = client.status().catch(() => undefined);
    const started = Date.now();
    await client.lockAndTerminate();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(wedged.terminate).toHaveBeenCalledTimes(1);
    expect(client.isRunning).toBe(false);
    await dangling;
  });
});

describe('passphrase strength floor (review 2026-07-22)', () => {
  it('createVault refuses passphrases under 12 characters', async () => {
    const client = makeClient();
    await expect(client.createVault(USER, 'eleven-chrs')).rejects.toMatchObject({ code: 'vault_invalid' });
    await expect(client.createVault(USER, 'twelve-chars')).resolves.toBeDefined();
  });

  it('recoveryUnlock and changePassphrase refuse a new passphrase under 12 characters', async () => {
    const client = makeClient();
    const { vault, recoveryDisplay } = await client.createVault(USER, 'passphrase-one');
    await expect(client.recoveryUnlock(USER, recoveryDisplay, 'eleven-chrs', vault))
      .rejects.toMatchObject({ code: 'vault_invalid' });
    await expect(client.changePassphrase(USER, 'passphrase-one', 'eleven-chrs', vault))
      .rejects.toMatchObject({ code: 'vault_invalid' });
  });
});
