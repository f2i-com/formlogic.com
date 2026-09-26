import { useEffect, useState } from 'react';
import { getAiReadiness } from '../client-runtime/flows/aiDefault';

/**
 * Whether the person's default AI source can run a request now (getAiReadiness, audit FL-23):
 * true or false once known, null while it is being checked. Used to offer AI Studio only to
 * someone whose AI would answer it, and the Visual Builder to everyone. `recheck` asks again
 * without the cached answer, after the person connects an AI.
 */
export function useAiReady(): boolean | null;
export function useAiReady(options: { withRecheck: true }): { ready: boolean | null; reason: string | null; recheck(): Promise<boolean> };
export function useAiReady(options?: { withRecheck: true }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness().then(
      (result) => { if (!cancelled) { setReady(result.ready); setReason(result.ready ? null : result.reason ?? null); } },
      () => { if (!cancelled) setReady(false); },
    );
    return () => { cancelled = true; };
  }, []);
  if (!options?.withRecheck) return ready;
  const recheck = async () => {
    try {
      const result = await getAiReadiness({ fresh: true });
      setReady(result.ready); setReason(result.ready ? null : result.reason ?? null);
      return result.ready;
    } catch {
      setReady(false);
      return false;
    }
  };
  return { ready, reason, recheck };
}
