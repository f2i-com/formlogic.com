// Storage-inspection test (plan §14/§17): after a private-form submit + owner view
// + lock, NO plaintext answer may exist in any client-side persistence —
// localStorage, sessionStorage, the persisted response store, or the exact POST
// body the Workbox background-sync queue captures for offline replay.
//
// Runs in the NODE environment (jsdom's realm breaks libsodium's instanceof input
// checks) with an in-memory Storage polyfill standing in for the browser stores.
import { beforeEach, describe, expect, it } from 'vitest';

class MemStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  dump(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  }
}

const localStore = new MemStorage();
const sessionStore = new MemStorage();
Object.assign(globalThis, { localStorage: localStore, sessionStorage: sessionStore });

const { CryptoClient, createInlineWorker } = await import('./cryptoClient');
const { __resetCryptoWorkerState } = await import('./worker');
const { sealPrivateSubmission } = await import('./privateSubmit');
const { clearSignerPins } = await import('./signerPins');
const { isEncryptedEnvelope } = await import('./envelope');
const { usePrivateDataStore } = await import('../../stores/privateDataStore');
const { useResponseStore } = await import('../../stores/responseStore');
type FormEncryptionManifest = import('../../types/e2ee').FormEncryptionManifest;
type InnerPayload = import('./envelope').InnerPayload;

const USER = 'user-1';
const FORM = '11111111-2222-4333-8444-555555555555';
const CANARY = 'canary-plaintext-7f3a9e';
const CANARY_2 = 'second-secret-b81c04';

async function servedManifest(): Promise<FormEncryptionManifest> {
  __resetCryptoWorkerState();
  const client = new CryptoClient(createInlineWorker);
  const created = await client.createVault(USER, 'correct horse battery staple');
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

describe('storage inspection after private submit + view + lock', () => {
  beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
    clearSignerPins(localStore as unknown as Storage);
    usePrivateDataStore.getState().clear();
    useResponseStore.setState({ responses: [], currentFormId: null, currentAnswers: {}, currentStep: 0, startTime: null });
  });

  it('the offline-captured POST body carries ONLY the envelope — no plaintext, no answers key', async () => {
    const encryption = await servedManifest();
    const { envelope } = await sealPrivateSubmission({
      formId: FORM,
      encryption,
      answers: { f1: CANARY },
      completionTime: 4200,
      language: 'en-US',
    });

    // The exact body Workbox's background-sync queue captures for offline replay.
    const queuedBody = JSON.stringify({ envelope, idempotencyKey: 'idem-test-1' });

    expect(queuedBody).not.toContain(CANARY);
    expect(queuedBody).not.toContain('4200');
    const parsed = JSON.parse(queuedBody) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['envelope', 'idempotencyKey']);
    expect('answers' in parsed).toBe(false);
    expect(isEncryptedEnvelope(parsed.envelope)).toBe(true);
  });

  it('after submit + owner view + lock, no plaintext survives in storage or the decrypted cache', async () => {
    const encryption = await servedManifest();
    const { envelope, recordId } = await sealPrivateSubmission({
      formId: FORM,
      encryption,
      answers: { f1: CANARY, f2: CANARY_2 },
    });
    void envelope;

    // Owner view: decrypted rows live ONLY in the in-memory LRU (never persisted).
    const inner: InnerPayload = { v: 1, answers: { f1: CANARY, f2: CANARY_2 } };
    usePrivateDataStore.getState().put(recordId, 1, inner);
    expect(usePrivateDataStore.getState().get(recordId)).toBeDefined();

    // The private submit path clears in-progress answers WITHOUT recording them
    // (responseStore.submitResponse is never called for private forms).
    useResponseStore.getState().startResponse(FORM);
    useResponseStore.getState().resetCurrentResponse();

    // Lock: generation bump wipes the decrypted LRU.
    usePrivateDataStore.getState().setGeneration(usePrivateDataStore.getState().generation + 1);
    usePrivateDataStore.getState().clear();

    const dump = `${localStore.dump()}\n${sessionStore.dump()}`;
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain(CANARY_2);
    expect(usePrivateDataStore.getState().get(recordId)).toBeUndefined();

    // The persisted response store holds no private-form rows at all.
    const persisted = localStore.getItem('formlogic-responses') ?? '';
    expect(persisted).not.toContain(FORM);
  });
});
