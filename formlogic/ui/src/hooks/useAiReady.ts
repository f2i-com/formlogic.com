import { useEffect, useState } from 'react';
import { getAiReadiness } from '../client-runtime/flows/aiDefault';

/**
 * Whether the person's default AI source can run a request now (getAiReadiness, audit FL-23):
 * true or false once known, null while it is being checked. AI prompts use this result.
 * Both editors can open for manual editing and preview. `recheck` asks again
 * without the cached answer, after the person connects an AI.
 */
export function useAiReady(options?: { editor?: boolean }): boolean | null;
export function useAiReady(options: { withRecheck: true; editor?: boolean }): { ready: boolean | null; reason: string | null; recheck(): Promise<boolean> };
export function useAiReady(options?: { withRecheck?: true; editor?: boolean }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const editor = options?.editor;
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness({ editor }).then(
      (result) => { if (!cancelled) { setReady(result.ready); setReason(result.ready ? null : result.reason ?? null); } },
      () => { if (!cancelled) setReady(false); },
    );
    return () => { cancelled = true; };
  }, [editor]);
  if (!options?.withRecheck) return ready;
  const recheck = async () => {
    try {
      const result = await getAiReadiness({ fresh: true, editor });
      setReady(result.ready); setReason(result.ready ? null : result.reason ?? null);
      return result.ready;
    } catch {
      setReady(false);
      return false;
    }
  };
  return { ready, reason, recheck };
}
