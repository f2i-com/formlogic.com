import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { cn } from '../../lib/utils';

export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export interface PopoverProps {
  isOpen: boolean;
  onClose: () => void;
  /** The element the panel is anchored to (clicks on it never count as outside clicks). */
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  children: React.ReactNode;
  /** Accessible name for the non-modal dialog (no visible heading is guaranteed). */
  ariaLabel: string;
  /** Extra classes for the panel (sizing, padding). */
  className?: string;
}

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Gap between the anchor and the panel, and the minimum viewport margin, in px. */
const VIEWPORT_MARGIN = 8;

/**
 * Anchored, non-modal panel primitive — the small sibling of Modal.tsx for controls
 * like the Desktop Connection popover: portal-mounted, framer-motion in/out, Escape
 * and outside-click close, Tab focus-trapped while open, focus restored to the
 * previously focused element (the trigger) on close. Unlike Modal it does NOT lock
 * body scroll (a popover floats over a live page) and renders no backdrop.
 *
 * Positioning: fixed, measured from the anchor's bounding rect on open and on window
 * resize (a fixed-position anchor keeps the panel aligned without a scroll listener),
 * flipped + clamped so the panel never leaves the viewport.
 */
export function Popover({
  isOpen,
  onClose,
  anchorRef,
  placement = 'bottom-start',
  children,
  ariaLabel,
  className,
}: PopoverProps) {
  const uniqueId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasInitialFocusRef = useRef(false);
  const onCloseRef = useRef(onClose);
  // Hidden until the first layout measurement lands, so the panel never flashes at 0,0.
  const [position, setPosition] = useState<{ top: number; left: number; ready: boolean }>({
    top: 0,
    left: 0,
    ready: false,
  });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    // Focus trapping (same shape as Modal.tsx).
    if (e.key === 'Tab' && panelRef.current) {
      const focusableElements = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
      if (focusableElements.length === 0) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  }, []);

  // Measure + clamp the panel against the anchor and viewport. No reset on close is
  // needed: the panel unmounts while closed, and on re-open update() re-measures here
  // (synchronously, before paint) so a stale rect never becomes visible.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      let top = placement.startsWith('top')
        ? rect.top - panelRect.height - VIEWPORT_MARGIN
        : rect.bottom + VIEWPORT_MARGIN;
      let left = placement.endsWith('start') ? rect.left : rect.right - panelRect.width;
      // Clamp horizontally; flip vertically when the preferred side has no room.
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - panelRect.width - VIEWPORT_MARGIN));
      if (top < VIEWPORT_MARGIN) {
        top = placement.startsWith('top') ? rect.bottom + VIEWPORT_MARGIN : top;
      }
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - panelRect.height - VIEWPORT_MARGIN));
      setPosition({ top, left, ready: true });
    };
    update();
    window.addEventListener('resize', update);
    // Re-clamp when the PANEL's own size changes: async content (a services list,
    // an expanding section) lands after open, and without this the growing panel
    // can walk off the bottom/right of the viewport.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && panelRef.current) {
      observer = new ResizeObserver(() => update());
      observer.observe(panelRef.current);
    }
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [isOpen, placement, anchorRef]);

  // Escape / focus-trap keys, outside-click close, and focus in/out — only while open.
  useEffect(() => {
    if (!isOpen) {
      hasInitialFocusRef.current = false;
      return;
    }
    if (!hasInitialFocusRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement;
    }

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown, true);

    if (!hasInitialFocusRef.current) {
      hasInitialFocusRef.current = true;
      // rAF with a setTimeout fallback (jsdom without pretendToBeVisual has no rAF).
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(cb, 0);
      raf(() => {
        const focusableElements = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
        focusableElements?.[0]?.focus();
      });
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown, true);
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    };
  }, [isOpen, handleKeyDown, anchorRef]);

  const content = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label={ariaLabel}
          id={`popover-${uniqueId}`}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.12 }}
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            visibility: position.ready ? 'visible' : 'hidden',
          }}
          className={cn(
            'z-40 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl shadow-black/20',
            'ring-1 ring-black/5 dark:ring-white/[0.06] border border-gray-200/50 dark:border-slate-800',
            'max-h-[min(32rem,calc(100dvh-1rem))] overflow-y-auto',
            className
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  // reducedMotion="user" drops the scale/transform for users who set the OS
  // "reduce motion" preference (same convention as Modal.tsx).
  return createPortal(
    <MotionConfig reducedMotion="user">{content}</MotionConfig>,
    document.body
  );
}
