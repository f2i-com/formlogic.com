// Whether a media query holds now, following it as the window changes: the database designer's
// widths (a phone, a wide screen). False where there is no window to ask.
import { useSyncExternalStore } from 'react';

export function useMatches(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      const list = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
      list?.addEventListener('change', notify);
      return () => list?.removeEventListener('change', notify);
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
