// Autosave visibility for the App Studio (recommendation #5): the top bar's
// save line reacts to real writes — "Saving…", "Saved just now", or an honest
// failure — instead of a static "All changes saved". Steps wrap their write
// promises in trackStudioSave(label, promise); the store just counts.
import { create } from 'zustand';

interface StudioSaveState {
  /** Writes currently in flight. */
  pending: number;
  /** Epoch ms of the last successful write (null = nothing saved this visit). */
  lastSavedAt: number | null;
  /** Short label of the last successful write (e.g. "Landing screen updated"). */
  lastLabel: string | null;
  /** Message of the last FAILED write; cleared by the next success. */
  lastError: string | null;
  /** Human label for the resource/action that failed. */
  failedLabel: string | null;
  /** Safe replay for the last failed idempotent write (null for one-shot creates). */
  retry: (() => Promise<unknown>) | null;
  begin: () => void;
  end: (ok: boolean, label?: string, error?: string, retry?: (() => Promise<unknown>) | null) => void;
  retryLast: () => Promise<void>;
  reset: () => void;
}

export const useStudioSaveState = create<StudioSaveState>((set) => ({
  pending: 0,
  lastSavedAt: null,
  lastLabel: null,
  lastError: null,
  failedLabel: null,
  retry: null,
  begin: () => set((s) => ({ pending: s.pending + 1 })),
  end: (ok, label, error, retry) =>
    set((s) => ({
      pending: Math.max(0, s.pending - 1),
      ...(ok
        ? {
            lastSavedAt: Date.now(),
            lastLabel: label ?? null,
            lastError: null,
            failedLabel: null,
            retry: null,
          }
        : {
            lastError: error ?? 'The change could not be saved.',
            failedLabel: label ?? 'this change',
            retry: retry ?? null,
          }),
    })),
  retryLast: async () => {
    const retry = useStudioSaveState.getState().retry;
    if (!retry) return;
    // The replay tracks its own pending/success/failure state. Swallow a thrown
    // transport error here so Retry never creates an unhandled rejection.
    try {
      await retry();
    } catch {
      // The tracker has already recorded the fresh error.
    }
  },
  reset: () => set({
    pending: 0,
    lastSavedAt: null,
    lastLabel: null,
    lastError: null,
    failedLabel: null,
    retry: null,
  }),
}));

/**
 * Track one studio write. `ok` decides success: pass a predicate when the
 * promise resolves an API envelope (e.g. res => !res.error); by default any
 * resolution counts as success and any throw as failure.
 */
export async function trackStudioSave<T>(
  label: string,
  operation: Promise<T> | (() => Promise<T>),
  ok?: (result: T) => boolean
): Promise<T> {
  const { begin, end } = useStudioSaveState.getState();
  const retry = typeof operation === 'function'
    ? () => trackStudioSave(label, operation, ok)
    : null;
  begin();
  try {
    const promise = typeof operation === 'function' ? operation() : operation;
    const result = await promise;
    const succeeded = ok ? ok(result) : true;
    end(succeeded, label, succeeded ? undefined : 'The change could not be saved.', succeeded ? null : retry);
    return result;
  } catch (error) {
    end(false, label, error instanceof Error ? error.message : 'The change could not be saved.', retry);
    throw error;
  }
}
