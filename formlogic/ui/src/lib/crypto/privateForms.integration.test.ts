// Integration tests for the private-forms UI layer built on the crypto core
// (docs/E2EE_PRIVATE_FORMS_PLAN.md SS8/SS10/SS16-P3):
//  - the public submit path (privateSubmit) seals a verified manifest and REFUSES
//    on a tampered manifest / changed signer, never falling back to plaintext;
//  - no answer plaintext leaks into the sealed envelope or the persisted stores;
//  - the owner decrypt-merge pipeline (decryptRowsPipeline) merges + surfaces errors;
//  - the private CSV export assembles rows and honours cancel -> partial.
//
// Runs in the node env (NOT jsdom) so libsodium's crypto_pwhash sees a same-realm
// Uint8Array; localStorage is polyfilled with an in-memory shim so the signer-pin
// store (localStorage-backed) exercises its real path.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

beforeAll(() => {
  const map = new Map<string, string>();
  const shim: Storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = shim;
});
import { CryptoClient, createInlineWorker } from './cryptoClient';
import { __resetCryptoWorkerState } from './worker';
import { toB64 } from './encoding';
import { getSodium } from './sodium';
import type { FormEncryptionManifest } from '../../types/e2ee';
import { sealPrivateSubmission, PrivateSubmitError } from './privateSubmit';
import { clearSignerPins, pinSigner } from './signerPins';
import { decryptRowsPipeline } from './useDecryptedResponses';
import { buildCsv, exportPrivateFormCsv, csvEscapeCell } from './privateExport';
import type { FormField } from '../../types/form';

const USER = 'user-1';
const FORM = '11111111-2222-4333-8444-555555555555';
const SECRET = 'TOP-SECRET-ANSWER-9f2c';

async function servedManifest(): Promise<FormEncryptionManifest> {
  __resetCryptoWorkerState();
  const client = new CryptoClient(createInlineWorker);
  const created = await client.createVault(USER, 'passphrase-one');
  const schemaJson = JSON.stringify([{ id: 'f1', type: 'short_text', label: 'Name' }]);
  const payload = await client.enableFormEncryption(USER, FORM, schemaJson);
  const { CONTENT_SUITE, WRAP_SUITE } = await import('./envelope');
  return {
    mode: 'private',
    keyId: payload.keyId,
    epoch: payload.ingestEpoch,
    publicKey: payload.ingestionPublicKey,
    content: CONTENT_SUITE,
    wrap: WRAP_SUITE,
    schemaVersion: 1,
    schemaHash: payload.schema.schemaHash,
    schemaJson,
    signerKeyId: payload.manifest.signerKeyId,
    signerPk: created.vault.ed25519Pk,
    expiresAt: null,
    sig: payload.manifest.signature,
  };
}

describe('private submit path (SS8)', () => {
  beforeEach(() => clearSignerPins(localStorage));

  it('seals a verified manifest into a rev=1 envelope with no plaintext leak', async () => {
    const manifest = await servedManifest();
    const { envelope, recordId } = await sealPrivateSubmission({
      formId: FORM,
      encryption: manifest,
      answers: { f1: SECRET },
      completionTime: 4200,
    });
    expect(envelope.__flenc).toBe(1);
    expect(envelope.rev).toBe(1);
    expect(envelope.recordId).toBe(recordId);
    expect(envelope.keyId).toBe(manifest.keyId);
    // The whole serialized envelope is ciphertext + routing metadata only.
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
  });

  it('REFUSES on a tampered manifest (no plaintext fallback)', async () => {
    const manifest = await servedManifest();
    const sodium = await getSodium();
    const tampered = { ...manifest, publicKey: toB64(sodium.randombytes_buf(32)) };
    await expect(sealPrivateSubmission({ formId: FORM, encryption: tampered, answers: { f1: SECRET } }))
      .rejects.toBeInstanceOf(PrivateSubmitError);
  });

  it('REFUSES loudly when the pinned signer changes for a known form', async () => {
    const manifest = await servedManifest();
    // Pin a DIFFERENT signer first, simulating a previously-trusted key.
    const sodium = await getSodium();
    pinSigner(FORM, toB64(sodium.crypto_sign_keypair().publicKey), localStorage);
    await expect(sealPrivateSubmission({ formId: FORM, encryption: manifest, answers: { f1: SECRET } }))
      .rejects.toMatchObject({ code: 'signer_pin_mismatch' });
  });

  it('no answer plaintext lands in localStorage after a seal', async () => {
    localStorage.clear();
    clearSignerPins(localStorage);
    const manifest = await servedManifest();
    await sealPrivateSubmission({ formId: FORM, encryption: manifest, answers: { f1: SECRET } });
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) expect(localStorage.getItem(key) ?? '').not.toContain(SECRET);
    }
  });
});

describe('owner decrypt-merge pipeline (SS10)', () => {
  const enc = (recordId: string, rev: number) => ({ __flenc: 1, recordId, rev }) as unknown as Record<string, unknown>;

  it('merges decrypted answers over encrypted rows and passes plain rows through', async () => {
    const rows = [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', answers: enc('aaaaaaaa-1111-4111-8111-111111111111', 1) },
      { id: 'plain', answers: { foo: 'bar' } },
    ];
    const { merged } = await decryptRowsPipeline(
      {
        openResponses: async () => new Map([
          ['aaaaaaaa-1111-4111-8111-111111111111', { answers: { name: 'Ada' }, rev: 1, meta: { completionTime: 10 } }],
        ]),
      },
      FORM,
      rows,
    );
    expect(merged.get('aaaaaaaa-1111-4111-8111-111111111111')?.answers).toEqual({ name: 'Ada' });
    expect(merged.has('plain')).toBe(false); // plain rows are never touched
  });

  it('surfaces a per-row decrypt error instead of silently dropping it', async () => {
    const rows = [{ id: 'r1', answers: enc('r1', 1) }];
    const { merged, errors } = await decryptRowsPipeline(
      { openResponses: async () => new Map([['r1', { error: { code: 'decrypt_failed', message: 'bad' } }]]) },
      FORM,
      rows,
    );
    expect(errors.r1).toBe('decrypt_failed');
    expect((merged.get('r1') as { _decryptError?: string })._decryptError).toBe('decrypt_failed');
  });
});

describe('private CSV export (SS10)', () => {
  const fields: FormField[] = [
    { id: 'f1', type: 'short_text', label: 'Name', required: false, properties: {}, order: 0 },
  ];

  it('escapes formula-injection cells', () => {
    expect(csvEscapeCell('=cmd()')).toBe('"\'=cmd()"');
    expect(csvEscapeCell('plain')).toBe('"plain"');
  });

  it('assembles a header + row CSV', () => {
    expect(buildCsv(['A', 'B'], [['1', '2']])).toBe('"A","B"\n"1","2"');
  });

  it('full-fetch export decrypts every page and marks a cancelled export partial', async () => {
    let page = 0;
    const result = await exportPrivateFormCsv(
      {
        fetchPage: async () => {
          page += 1;
          if (page === 1) return { rows: [{ id: 'r1', answers: {}, submittedAt: '2026-01-01', status: 'submitted' }], count: 3 };
          return { rows: [{ id: 'r2', answers: {}, submittedAt: '2026-01-02', status: 'submitted' }], count: 3 };
        },
        decryptRows: async (rows) => new Map(rows.map((r) => [r.id, { answers: { f1: 'Ada' }, rev: 1 }])),
        formatDate: (iso) => iso,
      },
      { fields, pageSize: 1, shouldCancel: () => page >= 1 },
    );
    expect(result.partial).toBe(true);
    expect(result.rowCount).toBe(1); // only the first page landed before cancel
    expect(result.csv).toContain('Ada');
  });
});
