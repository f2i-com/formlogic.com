import React, { useId, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { lockBodyScroll, unlockBodyScroll } from '../../lib/scrollLock';

// Every dialog MUST have an accessible name (audit FL-27): either the visible
// `title` or an explicit `ariaLabel` (for dialogs that render their own heading,
// e.g. ConfirmDialog — ignored when `title` is set). The union makes a nameless
// dialog a type error instead of a silent screen-reader gap.
type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  showCloseButton?: boolean;
} & (
  | { title: React.ReactNode; ariaLabel?: string }
  | { title?: undefined; ariaLabel: string }
);

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const openModals: string[] = [];
function focusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)).filter((el) => {
    if (el.tabIndex < 0 || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let ancestor: HTMLElement | null = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  showCloseButton = true,
  ariaLabel,
}: ModalProps) {
  const uniqueId = useId();
  const titleId = `modal-title-${uniqueId}`;
  const descId = `modal-desc-${uniqueId}`;
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasInitialFocusRef = useRef(false);
  // Store onClose in a ref to avoid re-running effect when it changes
  const onCloseRef = useRef(onClose);

  // Update ref in effect to avoid updating during render
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (openModals.at(-1) !== uniqueId || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      // Focus trapping
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = focusable(modalRef.current);
        if (focusableElements.length === 0) {
          e.preventDefault();
          modalRef.current.focus();
          return;
        }
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (!modalRef.current.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? lastElement : firstElement).focus();
        } else if (e.shiftKey && (document.activeElement === firstElement || document.activeElement === modalRef.current)) {
          e.preventDefault();
          lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    },
    [uniqueId]
  );

  useEffect(() => {
    // Closed runs must have NO side effects (and no cleanup that touches the
    // shared count) — otherwise an always-mounted/stacked modal decrements the
    // counter it never incremented, unlocking body scroll behind an open modal.
    if (!isOpen) {
      hasInitialFocusRef.current = false;
      return;
    }

    // Store the currently focused element (only on initial open)
    if (!hasInitialFocusRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement;
    }

    document.addEventListener('keydown', handleKeyDown);
    openModals.push(uniqueId);
    lockBodyScroll();

    // Focus the first focusable element in the modal (only on initial open).
    // With no focusable child, focus the PANEL itself (audit FL-27) so keyboard
    // and screen-reader users still land inside the dialog.
    let focusFrame = 0;
    if (!hasInitialFocusRef.current) {
      hasInitialFocusRef.current = true;
      focusFrame = requestAnimationFrame(() => {
        if (modalRef.current && openModals.at(-1) === uniqueId) {
          const focusableElements = focusable(modalRef.current);
          if (focusableElements[0]) focusableElements[0].focus();
          else modalRef.current.focus();
        }
      });
    }

    return () => {
      cancelAnimationFrame(focusFrame);
      const wasTop = openModals.at(-1) === uniqueId;
      const index = openModals.indexOf(uniqueId);
      if (index >= 0) openModals.splice(index, 1);
      hasInitialFocusRef.current = false;
      document.removeEventListener('keydown', handleKeyDown);
      unlockBodyScroll();

      // Restore focus to the previously focused element when closing
      if (wasTop && previousFocusRef.current?.isConnected && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    };
  }, [isOpen, handleKeyDown, uniqueId]);

  const sizes = {
    sm: 'max-w-[calc(100%-2rem)] sm:max-w-sm',
    md: 'max-w-[calc(100%-2rem)] sm:max-w-md',
    lg: 'max-w-[calc(100%-2rem)] sm:max-w-lg',
    xl: 'max-w-[calc(100%-2rem)] sm:max-w-xl',
    '2xl': 'max-w-[calc(100%-2rem)] sm:max-w-5xl',
    full: 'max-w-[calc(100%-2rem)] sm:max-w-4xl',
  };

  const content = (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 max-sm:items-end max-sm:p-0">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onMouseDown={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            aria-labelledby={title ? titleId : undefined}
            aria-label={!title ? ariaLabel : undefined}
            aria-describedby={description ? descId : undefined}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'relative w-full bg-white dark:bg-slate-900 rounded-2xl shadow-2xl shadow-black/20',
              // dvh (not vh) so the popup caps to the VISIBLE viewport on mobile toolbars; the body
              // scrolls internally, so any popup stays fully on-screen and flexes to any window height.
              'max-h-[90dvh] overflow-hidden flex flex-col',
              // Bottom-anchored on phones: a centred dialog capped at 90dvh leaves ~5dvh
              // under it, so its confirm button lands in the home-indicator swipe zone —
              // and the studio's dialogs (Add a data type, Add a role, Invite people,
              // Publish) all end in a confirm button.
              'max-sm:max-h-[85dvh] max-sm:w-full max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]',
              'ring-1 ring-black/5 dark:ring-white/[0.06] border border-gray-200/50 dark:border-slate-800',
              sizes[size]
            )}
          >
            {(title || showCloseButton) && (
              <div className="shrink-0 flex items-start justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-gray-200/80 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
                <div className="min-w-0 flex-1 pr-2">
                  {title && (
                    <h2 id={titleId} className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white break-words tracking-tight">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p id={descId} className="mt-1 text-sm text-gray-500 dark:text-slate-400">{description}</p>
                  )}
                </div>
                {showCloseButton && (
                  <button
                    onClick={onClose}
                    aria-label="Close modal"
                    className="p-2 -m-1 min-h-11 min-w-11 inline-flex items-center justify-center text-gray-400 dark:text-slate-400 hover:text-gray-500 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 transition-colors flex-shrink-0 cursor-pointer"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            {footer && <div className="shrink-0 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 sm:px-6">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  // reducedMotion="user" drops the scale/transform for users who set the OS
  // "reduce motion" preference (framer-motion ignores the CSS media query).
  return createPortal(
    <MotionConfig reducedMotion="user">{content}</MotionConfig>,
    document.body
  );
}
