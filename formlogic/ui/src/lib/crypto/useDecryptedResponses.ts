// Owner-side decrypt pipeline hook (plan SS10 read pipeline).
//
// Give it the rows a page already fetched (each row's `answers` is either plain
// answers or, for a private form, the stored __flenc envelope object/string) and
// it returns display rows:
//  - plain forms pass through untouched (isPrivate=false, zero crypto loaded);
//  - private + vault locked -> rows unchanged, locked=true (render the lock UI);
//  - private + unlocked -> form keys are unlocked once per form per vault
//    generation, rows batch-decrypt in the worker, and decrypted answers merge
//    over each row transiently (never persisted; dropped on lock via the
//    generation counter).

import { useEffect, useMemo, useState } from 'react';
import { useVaultStore } from '../../stores/vaultStore';
import { isEncryptedEnvelope, type InnerPayload } from './envelope';
import {
  ensureVaultLoaded, openResponsesForForm, vaultGeneration, type OpenRowsResult,
} from './formCrypto';
import { logger } from '../logger';

export interface DecryptableRow {
  id: string;
  answers: Record<string, unknown>;
}

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

/**
 * The pure decrypt-merge step (exported for tests): batch-decrypts the
 * encrypted rows and merges each decrypted answer set over its row.
 */
export async function decryptRowsPipeline<T extends DecryptableRow>(
  deps: DecryptPipelineDeps,
  formId: string,
  rows: T[],
): Promise<{ merged: Map<string, DecryptedDisplayRow<T>>; errors: Record<string, string> }> {
  const encryptedRows = rows.filter((r) => isEncryptedEnvelope(r.answers));
  const merged = new Map<string, DecryptedDisplayRow<T>>();
  const errors: Record<string, string> = {};
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

export function useDecryptedResponses<T extends DecryptableRow>(
  formId: string | undefined,
  rows: T[],
): DecryptedResponsesResult<T> {
  const status = useVaultStore((s) => s.status);
  const generation = useVaultStore((s) => s.generation);

  const isPrivate = useMemo(() => rows.some((r) => isEncryptedEnvelope(r.answers)), [rows]);

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
  }, [formId, rows, isPrivate, status, generation]);

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
    locked: isPrivate && status !== 'unlocked',
    decrypting: isPrivate && status === 'unlocked' && (decrypting || current === null),
    errors: current?.errors ?? {},
  };
}
