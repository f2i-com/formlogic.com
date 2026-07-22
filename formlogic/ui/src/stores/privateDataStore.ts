// Generation-scoped, in-memory cache of DECRYPTED private-form records
// (docs/E2EE_PRIVATE_FORMS_PLAN.md §10). Non-persisted by construction: decrypted
// answers never touch localStorage/IndexedDB — they live only in this LRU (cap 2000
// VIEWED records, keyed by recordId+rev) and are dropped wholesale whenever the
// vault generation changes (lock / unlock cycle), driven by vaultStore.

import { create } from 'zustand';
import type { InnerPayload } from '../lib/crypto/envelope';

export const DECRYPTED_LRU_CAP = 2000;

export interface DecryptedRecord {
  recordId: string;
  rev: number;
  inner: InnerPayload;
  /** Monotonic touch counter for LRU eviction. */
  touched: number;
}

interface PrivateDataState {
  /** Vault generation this cache belongs to; entries from an older generation are dropped. */
  generation: number;
  records: Map<string, DecryptedRecord>;
  /** Errors for rows that failed to decrypt (keyed like records) — surfaced, never silent. */
  errors: Map<string, { code: string; message: string }>;
  tick: number;

  setGeneration: (generation: number) => void;
  put: (recordId: string, rev: number, inner: InnerPayload) => void;
  putError: (recordId: string, error: { code: string; message: string }) => void;
  get: (recordId: string, rev?: number) => DecryptedRecord | undefined;
  getError: (recordId: string) => { code: string; message: string } | undefined;
  remove: (recordId: string) => void;
  clear: () => void;
}

const keyOf = (recordId: string, rev?: number) => (rev === undefined ? recordId : `${recordId}:${rev}`);

export const usePrivateDataStore = create<PrivateDataState>()((set, get) => ({
  generation: 0,
  records: new Map(),
  errors: new Map(),
  tick: 0,

  setGeneration: (generation) => {
    if (get().generation === generation) return;
    // A new vault generation invalidates every decrypted value (§10).
    set({ generation, records: new Map(), errors: new Map() });
  },

  put: (recordId, rev, inner) => {
    const { records, errors, tick } = get();
    const nextTick = tick + 1;
    const next = new Map(records);
    next.set(keyOf(recordId, rev), { recordId, rev, inner, touched: nextTick });
    // LRU evict oldest-touched beyond the cap.
    if (next.size > DECRYPTED_LRU_CAP) {
      const sorted = [...next.values()].sort((a, b) => a.touched - b.touched);
      for (const victim of sorted.slice(0, next.size - DECRYPTED_LRU_CAP)) {
        next.delete(keyOf(victim.recordId, victim.rev));
      }
    }
    const nextErrors = new Map(errors);
    nextErrors.delete(recordId);
    set({ records: next, errors: nextErrors, tick: nextTick });
  },

  putError: (recordId, error) => {
    const next = new Map(get().errors);
    next.set(recordId, error);
    set({ errors: next });
  },

  get: (recordId, rev) => {
    const state = get();
    if (rev !== undefined) {
      const hit = state.records.get(keyOf(recordId, rev));
      if (hit) return hit;
    }
    // rev-agnostic lookup: newest touched entry for the record id.
    let best: DecryptedRecord | undefined;
    for (const rec of state.records.values()) {
      if (rec.recordId !== recordId) continue;
      if (!best || rec.touched > best.touched) best = rec;
    }
    return best;
  },

  getError: (recordId) => get().errors.get(recordId),

  remove: (recordId) => {
    const records = new Map(get().records);
    for (const [k, v] of records) if (v.recordId === recordId) records.delete(k);
    const errors = new Map(get().errors);
    errors.delete(recordId);
    set({ records, errors });
  },

  clear: () => set({ records: new Map(), errors: new Map() }),
}));
