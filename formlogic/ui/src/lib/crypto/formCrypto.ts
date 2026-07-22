// Owner-side orchestration for private forms (docs/E2EE_PRIVATE_FORMS_PLAN.md
// SS8/SS10). Thin functional layer over getCryptoClient() (the worker facade),
// vaultStore (lifecycle + generation), privateDataStore (the decrypted LRU) and
// the api.ts E2EE endpoints. The read pipeline hook, CSV export and record pages
// depend only on this module - never on the worker directly.

import { api } from '../api';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import { usePrivateDataStore } from '../../stores/privateDataStore';
import { getCryptoClient, CryptoClientError } from './cryptoClient';
import { isEncryptedEnvelope, sha256Hex, type InnerPayload, type ResponseEnvelope } from './envelope';
import { utf8Bytes } from './encoding';
import type { FormEncryptionStateWire, ManifestRowWire } from '../../types/e2ee';

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

/** Whether a form is private (owner surfaces). A transient failure resolves to
 *  false and is NOT cached. */
export async function getFormPrivacy(formId: string): Promise<boolean> {
  const cached = formPrivacyCache.get(formId);
  if (cached !== undefined) return cached;
  const res = await api.getFormEncryptionState(formId);
  if (res.data) {
    const isPrivate = res.data.encryption?.mode === 'private';
    formPrivacyCache.set(formId, isPrivate);
    return isPrivate;
  }
  if (res.status === 404) {
    formPrivacyCache.set(formId, false);
    return false;
  }
  return false;
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
      await getCryptoClient().loadFormKeys(formId, state.grant ? [state.grant] : [], state.ingestionKeys);
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

function envelopeIdentity(answers: unknown): { recordId: string; rev: number } | null {
  let obj: unknown = answers;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const env = obj as { __flenc?: unknown; recordId?: unknown; rev?: unknown };
  if (env.__flenc !== 1 || typeof env.recordId !== 'string' || typeof env.rev !== 'number') return null;
  return { recordId: env.recordId, rev: env.rev };
}

/**
 * Batch-decrypt response rows (each row's `answers` is the stored envelope; the
 * row id equals the envelope recordId - plan SS8 storage). LRU-cached by
 * recordId+rev in privateDataStore; misses go to the worker in one batch. The
 * result map is keyed by row id.
 */
export async function openResponsesForForm(
  formId: string,
  rows: Array<{ id: string; answers: unknown }>,
): Promise<OpenRowsResult> {
  const state = await ensureFormKeys(formId);
  const store = usePrivateDataStore.getState();
  const out: OpenRowsResult = new Map();
  const misses: Array<{ id: string; envelope: unknown }> = [];
  for (const row of rows) {
    if (!isEncryptedEnvelope(row.answers)) continue;
    const identity = envelopeIdentity(row.answers);
    const cached = identity ? store.get(identity.recordId, identity.rev) : undefined;
    if (cached) {
      out.set(row.id, { answers: cached.inner.answers, meta: cached.inner.meta, rev: cached.rev });
    } else {
      misses.push({ id: row.id, envelope: typeof row.answers === 'string' ? JSON.parse(row.answers) as unknown : row.answers });
    }
  }
  if (misses.length > 0) {
    const { results } = await getCryptoClient().openResponses(
      formId,
      misses.map((m) => ({ envelope: m.envelope })),
      state.manifests,
      state.ingestionKeys,
    );
    const byRecordId = new Map(results.map((r) => [r.recordId, r]));
    for (const miss of misses) {
      const result = byRecordId.get(miss.id);
      if (!result) {
        out.set(miss.id, { error: { code: 'envelope_invalid', message: 'The stored envelope is malformed' } });
        continue;
      }
      if ('inner' in result) {
        usePrivateDataStore.getState().put(result.recordId, result.rev, result.inner);
        out.set(miss.id, { answers: result.inner.answers, meta: result.inner.meta, rev: result.rev });
      } else {
        usePrivateDataStore.getState().putError(result.recordId, result.error);
        out.set(miss.id, { error: result.error });
      }
    }
  }
  return out;
}

/**
 * Re-seal a COMPLETE record for an edit: rev = expectedRev + 1, sealed under the
 * form's CURRENT manifest tuple. Caller sends {envelope, expectedRev} to the
 * update endpoint and handles 409 revision_conflict.
 */
export async function sealResponseForUpdate(
  formId: string,
  recordId: string,
  expectedRev: number,
  inner: InnerPayload,
): Promise<{ envelope: ResponseEnvelope }> {
  const state = await ensureFormKeys(formId);
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
  usePrivateDataStore.getState().put(recordId, rev, inner);
  return { envelope };
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
 * Publish the form's current field schema as a new signed schema version +
 * manifest (required before a changed private form accepts new submissions).
 * No-ops (returns {published:false}) when the latest manifest already covers
 * exactly these bytes.
 */
export async function publishPrivateFormSchema(
  formId: string,
  schemaJson: string,
): Promise<{ published: boolean; schemaVersion?: number }> {
  const userId = requireUserId();
  const state = await ensureFormKeys(formId);
  const manifest = currentManifestOf(state);
  const schemaHash = await sha256Hex(utf8Bytes(schemaJson));
  if (manifest.schemaHash === schemaHash) {
    return { published: false, schemaVersion: manifest.schemaVersion };
  }
  const version = Math.max(0, ...state.manifests.map((m) => m.schemaVersion)) + 1;
  const signed = await getCryptoClient().publishSchemaVersion(userId, formId, {
    keyId: manifest.keyId,
    ingestEpoch: manifest.ingestEpoch,
    schemaJson,
    version,
  });
  const res = await api.publishFormSchemaVersion(formId, {
    schema: { schemaJson, schemaHash: signed.schemaHash },
    manifest: signed.manifest,
  });
  if (!res.ok) {
    forgetFormKeys(formId);
    const body = (res.body ?? {}) as { code?: string; message?: string };
    throw new CryptoClientError(body.code ?? 'schema_publish_failed', body.message ?? 'Could not publish the schema change');
  }
  forgetFormKeys(formId);
  return { published: true, schemaVersion: version };
}

function requireUserId(): string {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new CryptoClientError('not_authenticated', 'Sign in to manage private forms');
  return userId;
}
