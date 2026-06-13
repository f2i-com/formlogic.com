import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Accessible focus management for a custom (non-`Modal`) dialog/overlay:
 * - moves focus into the dialog on open (first focusable, or the container)
 * - traps Tab / Shift+Tab within the dialog
 * - closes on Escape (via `onEscape`)
 * - restores focus to the previously-focused element on close
 *
 * Attach `containerRef` to the dialog panel (give it `tabIndex={-1}` so it can
 * receive focus when it has no focusable children).
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void
) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    previousFocus.current = document.activeElement as HTMLElement;

    // Move focus into the dialog (defer so children have mounted).
    const raf = requestAnimationFrame(() => {
      const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
      if (focusables && focusables.length > 0) {
        focusables[0].focus();
      } else {
        container?.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const items = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (!container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown);
      const prev = previousFocus.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
      previousFocus.current = null;
    };
  }, [active, containerRef]);
}
