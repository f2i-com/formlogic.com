// Owner-side decrypt pipeline hook (plan SS10 read pipeline).
//
// Privacy is the SERVER-AUTHORITATIVE tri-state from getFormPrivacyState (GET
// /api/forms/{id}/encryption, cached) — never inferred from row shapes
// (review 2026-07-22, blocker 5):
//  - 'plain'    → rows pass through untouched (zero crypto loaded);
//  - 'unknown'  → transient state; envelope-looking rows still take the private
//                 path (fail-safe), plaintext-looking rows are left alone;
//  - 'private'  → vault locked -> rows unchanged, locked=true (render the lock UI);
//                 unlocked -> form keys load once per form per vault generation and
//                 rows batch-decrypt in the worker. ANY row whose answers are NOT a
//                 valid __flenc:1 envelope is CORRUPTION: it renders as an error row
//                 (never attempted as plaintext, never silently skipped).
// Decrypted answers merge over each row transiently (never persisted; dropped on
// lock via the generation counter).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../../stores/vaultStore';
import { isEncryptedEnvelope, type InnerPayload } from './envelope';
import {
  ensureVaultLoaded, getFormPrivacyState, openResponsesForForm, vaultGeneration,
  type FormPrivacy, type OpenRowsResult,
} from './formCrypto';
import { logger } from '../logger';

export interface DecryptableRow {
  id: string;
  answers: Record<string, unknown>;
}

/** Typed code for a non-envelope row inside an authoritatively-private form. */
export const CORRUPT_ROW_CODE = 'plaintext_in_private_form';

export type DecryptedDisplayRow<T extends DecryptableRow> = T & {
  /** True when this row was stored as ciphertext. */
  _encrypted?: boolean;
  /** The envelope revision - required as expectedRev when re-sealing an edit. */
  _rev?: number;
  /** Decrypted inner meta (preserve it when re-sealing an edit). */
  _encMeta?: InnerPayload['meta'];
  /** Set when this row failed to decrypt (typed code). */
  _decryptError?: string;
};

export interface DecryptedResponsesResult<T extends DecryptableRow> {
  rows: Array<DecryptedDisplayRow<T>>;
  /** Any row in the input is an encrypted envelope. */
  isPrivate: boolean;
  /** The server-authoritative privacy state ('unknown' until the check resolves). */
  privacy: FormPrivacy;
  /** Private data present but the vault is not unlocked. */
  locked: boolean;
  /** Worker decryption in flight. */
  decrypting: boolean;
  /** rowId -> typed error code for rows that failed to decrypt. */
  errors: Record<string, string>;
}

export interface DecryptPipelineDeps {
  openResponses: typeof openResponsesForForm;
}

export interface DecryptPipelineOptions {
  /** Server-authoritative "this form IS private": non-envelope rows are corruption. */
  authoritativePrivate?: boolean;
}

/**
 * The pure decrypt-merge step (exported for tests): batch-decrypts the
 * encrypted rows and merges each decrypted answer set over its row. When
 * `authoritativePrivate` is set, every non-envelope row is marked corrupt.
 */
export async function decryptRowsPipeline<T extends DecryptableRow>(
  deps: DecryptPipelineDeps,
  formId: string,
  rows: T[],
  opts?: DecryptPipelineOptions,
): Promise<{ merged: Map<string, DecryptedDisplayRow<T>>; errors: Record<string, string> }> {
  const encryptedRows = rows.filter((r) => isEncryptedEnvelope(r.answers));
  const merged = new Map<string, DecryptedDisplayRow<T>>();
  const errors: Record<string, string> = {};
  if (opts?.authoritativePrivate) {
    // A private form stores ONLY envelopes — a plaintext-shaped row is corruption
    // (server tampering or a stale writer). Render it as an error row; never try
    // to display it as plaintext and never drop it silently.
    for (const row of rows) {
      if (isEncryptedEnvelope(row.answers)) continue;
      errors[row.id] = CORRUPT_ROW_CODE;
      merged.set(row.id, { ...row, answers: {}, _encrypted: true, _decryptError: CORRUPT_ROW_CODE });
    }
  }
  if (encryptedRows.length === 0) return { merged, errors };
  const opened: OpenRowsResult = await deps.openResponses(
    formId,
    encryptedRows.map((r) => ({ id: r.id, answers: r.answers })),
  );
  for (const row of encryptedRows) {
    const result = opened.get(row.id);
    if (!result) continue;
    if ('error' in result) {
      errors[row.id] = result.error.code;
      merged.set(row.id, { ...row, answers: {}, _encrypted: true, _decryptError: result.error.code });
      continue;
    }
    const display: DecryptedDisplayRow<T> = {
      ...row,
      answers: result.answers,
      _encrypted: true,
      _rev: result.rev,
      _encMeta: result.meta,
    };
    // completionTime lives in the encrypted inner meta for private forms - lift
    // it to where every existing surface reads it, when the row has none.
    const rowCt = (row as { completionTime?: unknown }).completionTime;
    if ((rowCt === undefined || rowCt === 0 || rowCt === null) && typeof result.meta?.completionTime === 'number') {
      (display as { completionTime?: number }).completionTime = result.meta.completionTime;
    }
    merged.set(row.id, display);
  }
  return { merged, errors };
}

/**
 * Plaintext boundary helper (review 2026-07-22, blocker 3): run `reset` the moment
 * the vault generation changes (lock / re-unlock), so open editors close and
 * decrypted drafts are wiped immediately — decrypted React state must never
 * outlive the vault. The initial render never fires.
 */
export function useResetOnVaultGenerationChange(reset: () => void): void {
  const generation = useVaultStore((s) => s.generation);
  const prevRef = useRef(generation);
  useEffect(() => {
    if (prevRef.current === generation) return;
    prevRef.current = generation;
    reset();
  }, [generation, reset]);
}

export function useDecryptedResponses<T extends DecryptableRow>(
  formId: string | undefined,
  rows: T[],
): DecryptedResponsesResult<T> {
  const status = useVaultStore((s) => s.status);
  const generation = useVaultStore((s) => s.generation);

  // Server-authoritative privacy (tri-state). Until it resolves, envelope-shaped
  // rows still take the private path so ciphertext never renders as answers.
  const [privacy, setPrivacy] = useState<FormPrivacy>('unknown');
  useEffect(() => {
    if (!formId) { setPrivacy('unknown'); return; }
    let cancelled = false;
    setPrivacy('unknown');
    getFormPrivacyState(formId)
      .then((p) => { if (!cancelled) setPrivacy(p); })
      .catch(() => { if (!cancelled) setPrivacy('unknown'); });
    return () => { cancelled = true; };
  }, [formId]);

  const envelopePresent = useMemo(() => rows.some((r) => isEncryptedEnvelope(r.answers)), [rows]);
  const isPrivate = privacy === 'private' || (privacy === 'unknown' && envelopePresent);

  const [decrypting, setDecrypting] = useState(false);
  const [result, setResult] = useState<{
    generation: number;
    formId: string;
    merged: Map<string, DecryptedDisplayRow<T>>;
    errors: Record<string, string>;
  } | null>(null);

  // Knowing a private form exists, make sure the vault presence is loaded so
  // the lock UI can distinguish "no vault yet" from "locked".
  useEffect(() => {
    if (isPrivate) void ensureVaultLoaded().catch(() => undefined);
  }, [isPrivate]);

  useEffect(() => {
    if (!formId || !isPrivate || status !== 'unlocked') {
      setResult(null);
      setDecrypting(false);
      return;
    }
    let cancelled = false;
    setDecrypting(true);
    void (async () => {
      try {
        const { merged, errors } = await decryptRowsPipeline(
          { openResponses: openResponsesForForm }, formId, rows,
          { authoritativePrivate: privacy === 'private' },
        );
        // Never publish results from a generation that has since been locked.
        if (!cancelled && vaultGeneration() === generation) {
          setResult({ generation, formId, merged, errors });
        }
      } catch (e) {
        logger.warn('[e2ee] decrypt pipeline failed:', e);
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setDecrypting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId, rows, isPrivate, privacy, status, generation]);

  const current = result !== null && result.generation === generation && result.formId === formId
    ? result
    : null;

  const displayRows = useMemo(() => {
    if (!isPrivate || !current) return rows as Array<DecryptedDisplayRow<T>>;
    return rows.map((r) => current.merged.get(r.id) ?? (r as DecryptedDisplayRow<T>));
  }, [rows, isPrivate, current]);

  return {
    rows: displayRows,
    isPrivate,
    privacy,
    locked: isPrivate && status !== 'unlocked',
    decrypting: isPrivate && status === 'unlocked' && (decrypting || current === null),
    errors: current?.errors ?? {},
  };
}
