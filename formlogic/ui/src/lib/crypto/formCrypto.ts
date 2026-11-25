// Owner-side orchestration for private forms (docs/E2EE_PRIVATE_FORMS_PLAN.md
// SS8/SS10). Thin functional layer over getCryptoClient() (the worker facade),
// vaultStore (lifecycle + generation), privateDataStore (the decrypted LRU) and
// the api.ts E2EE endpoints. The read pipeline hook, CSV export and record pages
// depend only on this module - never on the worker directly.

import { api } from '../api';
import { currentSessionGeneration, isSessionGenerationCurrent, subscribeSessionGeneration } from '../sessionGeneration';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { usePrivateDataStore } from '../../stores/privateDataStore';
import { getCryptoClient, CryptoClientError } from './cryptoClient';
import { isEncryptedEnvelope, sha256Hex, type InnerPayload, type ResponseEnvelope } from './envelope';
import { utf8Bytes } from './encoding';
import type { FormEncryptionStateWire, ManifestRowWire, PublishSchemaPayload } from '../../types/e2ee';

export interface DecryptedRecord {
  answers: Record<string, unknown>;
  meta?: InnerPayload['meta'];
  rev: number;
}

export type OpenRowsResult = Map<string, DecryptedRecord | { error: { code: string; message: string } }>;

/** The current vault generation - caches of decrypted content key on this. */
export function vaultGeneration(): number {
  return useVaultStore.getState().generation;
}

/** formId -> definitively-known privacy (in-memory; enable marks true). */
const formPrivacyCache = new Map<string, boolean>();

/** Authoritative privacy state for a form: 'private' or 'plain' only when the
 *  server said so (or enable marked it); 'unknown' on any transient failure. */
export type FormPrivacy = 'unknown' | 'plain' | 'private';

/**
 * The server-authoritative privacy state (GET /api/forms/{id}/encryption, cached).
 * A transient failure resolves to 'unknown' and is NOT cached — callers must treat
 * 'unknown' conservatively (never as proof of plaintext).
 */
export async function getFormPrivacyState(formId: string): Promise<FormPrivacy> {
  const cached = formPrivacyCache.get(formId);
  if (cached !== undefined) return cached ? 'private' : 'plain';
  const gen = currentSessionGeneration();
  const res = await api.getFormEncryptionState(formId);
  if (res.data) {
    const isPrivate = res.data.encryption?.mode === 'private';
    if (isSessionGenerationCurrent(gen)) {
      formPrivacyCache.set(formId, isPrivate);
    }
    return isPrivate ? 'private' : 'plain';
  }
  if (res.status === 404) {
    // Do not cache 404 as authoritative 'plain' — another user or a newly-saved form may own it.
    return 'plain';
  }
  return 'unknown';
}

/** Whether a form is private (owner surfaces). A transient failure resolves to
 *  false and is NOT cached. Prefer getFormPrivacyState where 'unknown' matters. */
export async function getFormPrivacy(formId: string): Promise<boolean> {
  return (await getFormPrivacyState(formId)) === 'private';
}

export function markFormPrivate(formId: string): void {
  formPrivacyCache.set(formId, true);
}

/** Ensure we know whether the signed-in user has a vault (drives lock UI). */
export async function ensureVaultLoaded(): Promise<void> {
  if (useVaultStore.getState().status === 'unknown') {
    await useVaultStore.getState().refreshStatus();
  }
}

// --- per-form key state (one load per form per vault generation) --------------

interface FormKeysEntry {
  generation: number;
  promise: Promise<FormEncryptionStateWire>;
}
const formKeysReady = new Map<string, FormKeysEntry>();

subscribeSessionGeneration(() => {
  formPrivacyCache.clear();
  formKeysReady.clear();
});

/** The manifest new seals must carry: the latest non-superseded row. */
export function currentManifestOf(state: FormEncryptionStateWire): ManifestRowWire {
  const live = state.manifests.filter((m) => m.supersededAt === null);
  const pool = live.length > 0 ? live : state.manifests;
  const sorted = [...pool].sort((a, b) => (b.schemaVersion - a.schemaVersion) || (b.ingestEpoch - a.ingestEpoch));
  const current = sorted[0];
  if (!current) throw new CryptoClientError('form_keys_unavailable', 'This form has no encryption manifest');
  return current;
}

/**
 * Load this form's ingestion secrets into the worker (GET /encryption ->
 * loadFormKeys), once per form per vault generation. Resolves with the
 * (non-secret) grant/keys/manifests wire needed to seal and accept envelopes.
 */
export function ensureFormKeys(formId: string): Promise<FormEncryptionStateWire> {
  if (useVaultStore.getState().status !== 'unlocked') {
    return Promise.reject(new CryptoClientError('vault_locked', 'Unlock your vault first'));
  }
  const generation = vaultGeneration();
  const existing = formKeysReady.get(formId);
  if (existing && existing.generation === generation) return existing.promise;
  const entry: FormKeysEntry = {
    generation,
    promise: (async () => {
      const res = await api.getFormEncryptionState(formId);
      if (!res.data) {
        throw new CryptoClientError(
          (res as { code?: string }).code ?? 'form_keys_unavailable',
          res.error ?? 'Could not load form encryption keys',
        );
      }
      const state = res.data;
      await getCryptoClient().loadFormKeys(formId, state.grant ? [state.grant] : [], state.ingestionKeys, state.manifests, state.schemaVersions);
      return state;
    })(),
  };
  entry.promise.catch(() => {
    if (formKeysReady.get(formId) === entry) formKeysReady.delete(formId);
  });
  formKeysReady.set(formId, entry);
  return entry.promise;
}

export function forgetFormKeys(formId: string): void {
  formKeysReady.delete(formId);
}

// --- read pipeline ------------------------------------------------------------

function parseEnvelopeObject(answers: unknown): Record<string, unknown> | null {
  let obj: unknown = answers;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

function envelopeIdentity(obj: Record<string, unknown> | null): { recordId: string; rev: number } | null {
  if (!obj) return null;
  if (obj.__flenc !== 1 || typeof obj.recordId !== 'string' || typeof obj.rev !== 'number') return null;
  return { recordId: obj.recordId, rev: obj.rev };
}

/**
 * Cryptographic cache scope binding formId + every authenticated/ciphertext field of the envelope,
 * so cross-form replay or tampered ciphertext can never hit a previously decrypted cache entry.
 */
async function envelopeCacheScope(formId: string, obj: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify([
    formId,
    obj.__flenc ?? null,
    obj.content ?? null,
    obj.wrap ?? null,
    obj.recordId ?? null,
    obj.rev ?? null,
    obj.keyId ?? null,
    obj.epoch ?? null,
    obj.schemaVersion ?? null,
    obj.schemaHash ?? null,
    obj.wrappedDek ?? null,
    obj.nonce ?? null,
    obj.ct ?? null,
    obj.attachments ?? null,
  ]);
  return sha256Hex(utf8Bytes(canonical));
}

function isVaultStillAtGeneration(expectedGeneration: number): boolean {
  const vault = useVaultStore.getState();
  return vault.status === 'unlocked' && vault.generation === expectedGeneration;
}

/**
 * Batch-decrypt response rows (each row's `answers` is the stored envelope; the
 * row id equals the envelope recordId - plan SS8 storage). LRU-cached by
 * formId + envelope digest + recordId + rev in privateDataStore; misses go to
 * the worker in one batch. The result map is keyed by row id.
 */
export async function openResponsesForForm(
  formId: string,
  rows: Array<{ id: string; answers: unknown }>,
): Promise<OpenRowsResult> {
  const startGen = vaultGeneration();
  const state = await ensureFormKeys(formId);
  if (!isVaultStillAtGeneration(startGen)) {
    throw new CryptoClientError('vault_locked', 'Unlock your vault first');
  }
  const store = usePrivateDataStore.getState();
  const out: OpenRowsResult = new Map();
  const misses: Array<{ id: string; envelope: unknown; scopeKey: string | undefined }> = [];
  for (const row of rows) {
    if (!isEncryptedEnvelope(row.answers)) continue;
    const envObj = parseEnvelopeObject(row.answers);
    const identity = envelopeIdentity(envObj);
    const scopeKey = envObj ? await envelopeCacheScope(formId, envObj) : undefined;
    if (!isVaultStillAtGeneration(startGen)) {
      throw new CryptoClientError('vault_locked', 'Unlock your vault first');
    }
    // Only trust a cache hit when the envelope's recordId matches this row's id and full digest.
    const cached = identity && scopeKey && identity.recordId === row.id
      ? store.get(identity.recordId, identity.rev, scopeKey)
      : undefined;
    if (cached) {
      out.set(row.id, { answers: cached.inner.answers, meta: cached.inner.meta, rev: cached.rev });
    } else {
      misses.push({ id: row.id, envelope: envObj ?? row.answers, scopeKey });
    }
  }
  if (misses.length > 0) {
    const { results } = await getCryptoClient().openResponses(
      formId,
      misses.map((m) => ({ envelope: m.envelope })),
      state.manifests,
      state.ingestionKeys,
    );
    if (!isVaultStillAtGeneration(startGen)) {
      throw new CryptoClientError('vault_locked', 'Unlock your vault first');
    }
    const privateStore = usePrivateDataStore.getState();
    for (let i = 0; i < misses.length; i++) {
      const miss = misses[i];
      const result = results[i];
      if (!result) {
        out.set(miss.id, { error: { code: 'envelope_invalid', message: 'The stored envelope is malformed' } });
        continue;
      }
      if ('inner' in result) {
        if (result.recordId !== miss.id) {
          const mismatch = { code: 'envelope_invalid', message: 'Envelope recordId does not match the stored row' };
          privateStore.putError(miss.id, mismatch, startGen);
          out.set(miss.id, { error: mismatch });
          continue;
        }
        privateStore.put(result.recordId, result.rev, result.inner, miss.scopeKey, startGen);
        out.set(miss.id, { answers: result.inner.answers, meta: result.inner.meta, rev: result.rev });
      } else {
        privateStore.putError(miss.id, result.error, startGen);
        out.set(miss.id, { error: result.error });
      }
    }
  }
  return out;
}

/**
 * Re-seal a COMPLETE record for an edit: rev = expectedRev + 1, sealed under the
 * form's CURRENT manifest tuple. Caller sends {envelope, expectedRev} to the
 * update endpoint, handles 409 revision_conflict, and only calls
 * `cacheCommittedResponse` after the server acknowledges the write.
 */
export async function sealResponseForUpdate(
  formId: string,
  recordId: string,
  expectedRev: number,
  inner: InnerPayload,
): Promise<{ envelope: ResponseEnvelope; generation: number }> {
  const startGen = vaultGeneration();
  const state = await ensureFormKeys(formId);
  if (!isVaultStillAtGeneration(startGen)) {
    throw new CryptoClientError('vault_locked', 'Unlock your vault first');
  }
  const manifest = currentManifestOf(state);
  const key = state.ingestionKeys.find((k) => k.id === manifest.keyId);
  if (!key) throw new CryptoClientError('form_keys_unavailable', 'The current manifest references an unknown key');
  const rev = expectedRev + 1;
  const { envelope } = await getCryptoClient().sealResponse({
    formId,
    keyId: manifest.keyId,
    epoch: manifest.ingestEpoch,
    schemaVersion: manifest.schemaVersion,
    schemaHash: manifest.schemaHash,
    publicKey: key.publicKey,
    rev,
    recordId,
    inner,
  });
  return { envelope, generation: startGen };
}

/**
 * Cache a newly sealed response ONLY after the server accepts the update and
 * only if the vault is still unlocked at the same generation.
 */
export async function cacheCommittedResponse(
  formId: string,
  envelope: ResponseEnvelope,
  inner: InnerPayload,
  expectedGeneration: number,
): Promise<void> {
  if (!isVaultStillAtGeneration(expectedGeneration)) return;
  const scopeKey = await envelopeCacheScope(formId, envelope as unknown as Record<string, unknown>);
  if (!isVaultStillAtGeneration(expectedGeneration)) return;
  usePrivateDataStore.getState().put(envelope.recordId, envelope.rev, inner, scopeKey, expectedGeneration);
}

// --- enable + schema publish (owner, vault unlocked) --------------------------

/**
 * Enable end-to-end encryption on a freshly created, empty, unpublished form.
 * The worker mints FK + ingestion keys and signs the grant + manifest; the
 * payload goes to POST /api/forms/{id}/encryption. Rejects with a
 * CryptoClientError carrying the server's typed code (private_enable_blocked's
 * details.reasons[] ride on the error).
 */
export async function enableFormEncryption(formId: string, schemaJson: string): Promise<void> {
  const userId = requireUserId();
  if (useVaultStore.getState().status !== 'unlocked') {
    throw new CryptoClientError('vault_locked', 'Unlock your vault first');
  }
  const payload = await getCryptoClient().enableFormEncryption(userId, formId, schemaJson);
  const res = await api.enableFormEncryption(formId, payload);
  if (!res.ok) {
    const body = (res.body ?? {}) as { code?: string; message?: string; details?: { reasons?: unknown } };
    const err = new CryptoClientError(body.code ?? 'private_enable_failed', body.message ?? 'Could not enable private mode');
    const reasons = body.details?.reasons;
    if (Array.isArray(reasons)) {
      (err as CryptoClientError & { reasons?: string[] }).reasons = reasons.filter((r): r is string => typeof r === 'string');
    }
    throw err;
  }
  forgetFormKeys(formId);
}

/**
 * SIGN the form's current field schema as a new schema version + manifest —
 * WITHOUT persisting anything (review 2026-07-22, blocker 2). The caller attaches
 * the returned payload as `encryptionSchema` to the SAME update call that saves
 * fields+status, so a private form's fields, signature, manifest and publish state
 * land atomically (PUT /api/forms/{id}). Returns null when the latest manifest
 * already covers exactly these bytes (the no-op path). Throws vault_locked /
 * key_unavailable — the caller MUST block the publish, never publish unsigned.
 */
export async function signPrivateFormSchema(
  formId: string,
  schemaJson: string,
): Promise<{ encryptionSchema: PublishSchemaPayload; schemaVersion: number } | null> {
  const userId = requireUserId();
  if (useVaultStore.getState().status !== 'unlocked') {
    throw new CryptoClientError('vault_locked', 'Unlock your vault to publish a private form — the encryption schema must be signed by your vault.');
  }
  const state = await ensureFormKeys(formId);
  const manifest = currentManifestOf(state);
  const schemaHash = await sha256Hex(utf8Bytes(schemaJson));
  if (manifest.schemaHash === schemaHash) {
    return null;
  }
  const version = Math.max(0, ...state.manifests.map((m) => m.schemaVersion)) + 1;
  const signed = await getCryptoClient().publishSchemaVersion(userId, formId, {
    keyId: manifest.keyId,
    ingestEpoch: manifest.ingestEpoch,
    schemaJson,
    version,
  });
  return {
    encryptionSchema: {
      schema: { schemaJson, schemaHash: signed.schemaHash },
      manifest: signed.manifest,
    },
    schemaVersion: version,
  };
}

function requireUserId(): string {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new CryptoClientError('not_authenticated', 'Sign in to manage private forms');
  return userId;
}
