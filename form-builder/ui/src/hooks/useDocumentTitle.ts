import { useEffect } from 'react';

/**
 * Sets `document.title` to `"<title> · FormLogic"` while the component is mounted
 * and restores the previous title on unmount. SPA-safe (mirrors NotFound's
 * pattern) so navigating away never leaves a stale tab title. Pass an empty/
 * undefined value while data is still loading to fall back to the base title.
 */
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · FormLogic` : 'FormLogic';
    return () => {
      document.title = previous;
    };
  }, [title]);
}
