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
  begin: () => void;
  end: (ok: boolean, label?: string, error?: string) => void;
  reset: () => void;
}

export const useStudioSaveState = create<StudioSaveState>((set) => ({
  pending: 0,
  lastSavedAt: null,
  lastLabel: null,
  lastError: null,
  begin: () => set((s) => ({ pending: s.pending + 1 })),
  end: (ok, label, error) =>
    set((s) => ({
      pending: Math.max(0, s.pending - 1),
      ...(ok
        ? { lastSavedAt: Date.now(), lastLabel: label ?? null, lastError: null }
        : { lastError: error ?? 'The change could not be saved.' }),
    })),
  reset: () => set({ pending: 0, lastSavedAt: null, lastLabel: null, lastError: null }),
}));

/**
 * Track one studio write. `ok` decides success: pass a predicate when the
 * promise resolves an API envelope (e.g. res => !res.error); by default any
 * resolution counts as success and any throw as failure.
 */
export async function trackStudioSave<T>(
  label: string,
  promise: Promise<T>,
  ok?: (result: T) => boolean
): Promise<T> {
  const { begin, end } = useStudioSaveState.getState();
  begin();
  try {
    const result = await promise;
    const succeeded = ok ? ok(result) : true;
    end(succeeded, label, succeeded ? undefined : 'The change could not be saved.');
    return result;
  } catch (error) {
    end(false, undefined, error instanceof Error ? error.message : 'The change could not be saved.');
    throw error;
  }
}
