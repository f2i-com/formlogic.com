import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Module-level cache so the public /health flag is fetched once per session, not per component.
let cached: boolean | null = null;

/**
 * Whether this instance is running in public-beta mode (BETA_MODE=true): Cloud is free and payments are
 * disabled. Read from the public /api/health endpoint, so it works pre-auth (signup/landing) too.
 */
export function useBetaMode(): boolean {
  const [beta, setBeta] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) return; // already known — the initial state is already correct
    let active = true;
    api.healthCheck()
      .then((res) => {
        if (!active) return;
        cached = !!res.data?.betaMode;
        setBeta(cached);
      })
      .catch(() => { /* health unreachable — treat as non-beta */ });
    return () => { active = false; };
  }, []);
  return beta;
}
