import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Module-level cache so we hit /ai/status once per session, not per component mount.
let cached: boolean | null = null;

/** Whether the in-app AI is available (configured + AI_ENABLED). Use to hide AI entry points.
 *  HIDE-UNTIL-CONFIRMED: defaults to false while the status loads (and on fetch failure), so an
 *  AI-disabled install (AI_ENABLED=false / unconfigured) NEVER flashes "Generate with AI" —
 *  enabled installs see the entry points appear as soon as /ai/status resolves (cached per session). */
export function useAiAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) return;
    let cancelled = false;
    api.getAIStatus()
      .then((r) => { if (!cancelled) { cached = !!r.data?.available; setAvailable(cached); } })
      .catch(() => { /* stay hidden — never advertise AI we can't confirm */ });
    return () => { cancelled = true; };
  }, []);
  return available;
}
