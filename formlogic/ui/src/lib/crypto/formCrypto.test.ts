// formCrypto owner-side orchestration tests (review 2026-07-22):
//  - signPrivateFormSchema (blocker 2): the SIGN-FIRST half of the atomic private
//    publish — returns the encryptionSchema payload for the same-transaction PUT,
//    null when the field bytes are unchanged, and refuses with vault_locked;
//  - getFormPrivacyState (blocker 5): the server-authoritative tri-state.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  api: {
    getFormEncryptionState: vi.fn(),
    enableFormEncryption: vi.fn(),
    getVault: vi.fn(),
    createVault: vi.fn(),
    changeVaultPassphrase: vi.fn(),
    isAuthenticated: () => true,
  },
  newIdempotencyKey: () => 'idem-test',
}));

import { api } from '../api';
import { CryptoClient, createInlineWorker, setCryptoClientForTests } from './cryptoClient';
import { __resetCryptoWorkerState } from './worker';
import { getSodium } from './sodium';
import { fromB64, utf8Bytes } from './encoding';
import { CONTENT_SUITE, WRAP_SUITE } from './envelope';
import { useVaultStore, __resetVaultStoreForTests } from '../../stores/vaultStore';
import { useAuthStore } from '../../stores/authStore';
import { signPrivateFormSchema, getFormPrivacyState, forgetFormKeys } from './formCrypto';
import type { FormEncryptionStateWire } from '../../types/e2ee';

const USER = 'user-1';
const FORM = '11111111-2222-4333-8444-555555555555';
const PASS = 'correct horse battery staple';

/** A real vault + enable payload, served back as the GET /encryption wire. */
async function buildServedState(schemaJson: string): Promise<FormEncryptionStateWire> {
  __resetCryptoWorkerState();
  const client = new CryptoClient(createInlineWorker);
  const { vault } = await client.createVault(USER, PASS);
  const payload = await client.enableFormEncryption(USER, FORM, schemaJson);
  setCryptoClientForTests(client);
  const manifestCanonical = `flmanifest:1|${FORM}|${payload.keyId}|1|${payload.ingestionPublicKey}`
    + `|${CONTENT_SUITE}|${WRAP_SUITE}|1|${payload.schema.schemaHash}|${payload.manifest.signerKeyId}|-`;
  return {
    encryption: { mode: 'private', currentIngestEpoch: 1, currentFkEpoch: 1 },
    grant: {
      grantId: payload.grant.grantId,
      fkEpoch: payload.fkEpoch,
      wrappedKey: payload.grant.wrappedKey,
      role: payload.grant.role,
      grantorUserId: USER,
      granteeUserId: USER,
      granteePk: vault.x25519Pk,
      sigVersion: payload.grant.sigVersion,
      signature: payload.grant.signature,
    },
    ingestionKeys: [{
      id: payload.keyId,
      epoch: payload.ingestEpoch,
      publicKey: payload.ingestionPublicKey,
      wrappedSecret: payload.wrappedIngestionSecret,
      fkEpoch: payload.fkEpoch,
      state: 'active',
    }],
    manifests: [{
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
    }],
    schemaVersions: [{ version: 1, schemaHash: payload.schema.schemaHash, schemaJson }],
  };
}

describe('signPrivateFormSchema (atomic publish, blocker 2)', () => {
  const schemaV1 = JSON.stringify([{ id: 'f1', type: 'short_text', label: 'Name' }]);
  const schemaV2 = JSON.stringify([{ id: 'f1', type: 'short_text', label: 'Full name' }]);

  beforeEach(() => {
    __resetVaultStoreForTests();
    forgetFormKeys(FORM);
    vi.mocked(api.getFormEncryptionState).mockReset();
    useAuthStore.setState({ user: { id: USER } as never });
    useVaultStore.setState({ status: 'unlocked', generation: 1 });
  });

  it('returns null (no-op) when the served manifest already covers the field bytes', async () => {
    vi.mocked(api.getFormEncryptionState).mockResolvedValue({ data: await buildServedState(schemaV1) });
    await expect(signPrivateFormSchema(FORM, schemaV1)).resolves.toBeNull();
  });

  it('signs a changed schema: the payload verifies against the vault key, version increments', async () => {
    const state = await buildServedState(schemaV1);
    vi.mocked(api.getFormEncryptionState).mockResolvedValue({ data: state });
    const signed = await signPrivateFormSchema(FORM, schemaV2);
    expect(signed).not.toBeNull();
    expect(signed!.schemaVersion).toBe(2);
    expect(signed!.encryptionSchema.schema.schemaJson).toBe(schemaV2);
    // The signature must verify over the §8 canonical string for v2.
    const sodium = await getSodium();
    const signerPk = fromB64(state.manifests[0].signerPk);
    const canonical = `flmanifest:1|${FORM}|${state.manifests[0].keyId}|1|${state.ingestionKeys[0].publicKey}`
      + `|${CONTENT_SUITE}|${WRAP_SUITE}|2|${signed!.encryptionSchema.schema.schemaHash}|${signed!.encryptionSchema.manifest.signerKeyId}|-`;
    expect(sodium.crypto_sign_verify_detached(
      fromB64(signed!.encryptionSchema.manifest.signature), utf8Bytes(canonical), signerPk,
    )).toBe(true);
  });

  it('REFUSES with vault_locked when the vault is locked — publish must be blocked', async () => {
    useVaultStore.setState({ status: 'locked' });
    await expect(signPrivateFormSchema(FORM, schemaV2)).rejects.toMatchObject({ code: 'vault_locked' });
    expect(api.getFormEncryptionState).not.toHaveBeenCalled();
  });
});

describe('getFormPrivacyState (authoritative tri-state, blocker 5)', () => {
  it("resolves 'private' for a private form, 'plain' for 404, 'unknown' on transient failure", async () => {
    vi.mocked(api.getFormEncryptionState).mockResolvedValue({ data: await buildServedState('[]') });
    await expect(getFormPrivacyState('form-a')).resolves.toBe('private');

    vi.mocked(api.getFormEncryptionState).mockResolvedValue({ error: 'Not found', status: 404 });
    await expect(getFormPrivacyState('form-b')).resolves.toBe('plain');

    // A transient failure is NOT cached and must not masquerade as 'plain'.
    vi.mocked(api.getFormEncryptionState).mockResolvedValue({ error: 'Server error (500)', status: 500 });
    await expect(getFormPrivacyState('form-c')).resolves.toBe('unknown');
  });
});
