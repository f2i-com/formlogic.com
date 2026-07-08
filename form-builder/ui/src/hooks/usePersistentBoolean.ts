import { useEffect, useState } from 'react';

/**
 * A boolean UI preference persisted in localStorage under `key`, stored as the raw '1'/'0'
 * strings this codebase already uses for simple flags (see 'fl-had-apps' in FormsList.tsx,
 * onboarding flags in Dashboard.tsx) rather than JSON — cheaper to read and there's nothing to
 * parse. Reads once via a lazy initializer; every following change is written back. Both the
 * read and the write are wrapped in try/catch so private-browsing / storage-disabled sessions
 * silently fall back to `defaultValue` without throwing.
 */
export function usePersistentBoolean(key: string, defaultValue: boolean): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultValue : raw === '1';
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* private browsing */ }
  }, [key, value]);

  return [value, setValue];
}
