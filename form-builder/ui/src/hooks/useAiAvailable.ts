import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Module-level cache so we hit /ai/status once per session, not per component mount.
let cached: boolean | null = null;

/** Whether the in-app AI is available (configured + AI_ENABLED). Use to hide AI entry points. */
export function useAiAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(cached ?? true);
  useEffect(() => {
    if (cached !== null) return;
    let cancelled = false;
    api.getAIStatus()
      .then((r) => { if (!cancelled) { cached = !!r.data?.available; setAvailable(cached); } })
      .catch(() => { /* leave optimistic default */ });
    return () => { cancelled = true; };
  }, []);
  return available;
}
