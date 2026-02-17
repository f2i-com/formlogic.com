import React, { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
}

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  size = 'md',
  showCloseButton = true,
}: ModalProps) {
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
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }

      // Focus trapping
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    },
    []
  );

  useEffect(() => {
    if (isOpen) {
      // Store the currently focused element (only on initial open)
      if (!hasInitialFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement;
      }

      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';

      // Focus the first focusable element in the modal (only on initial open)
      if (!hasInitialFocusRef.current) {
        hasInitialFocusRef.current = true;
        requestAnimationFrame(() => {
          if (modalRef.current) {
            const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
            focusableElements[0]?.focus();
          }
        });
      }
    } else {
      // Reset the flag when modal closes
      hasInitialFocusRef.current = false;
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';

      // Restore focus to the previously focused element (only when actually closing)
      if (!isOpen && previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    };
  }, [isOpen, handleKeyDown]);

  const sizes = {
    sm: 'max-w-[calc(100%-2rem)] sm:max-w-sm',
    md: 'max-w-[calc(100%-2rem)] sm:max-w-md',
    lg: 'max-w-[calc(100%-2rem)] sm:max-w-lg',
    xl: 'max-w-[calc(100%-2rem)] sm:max-w-xl',
    full: 'max-w-[calc(100%-2rem)] sm:max-w-4xl',
  };

  const content = (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-md"
            onMouseDown={onClose}
          />
          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            aria-labelledby={title ? 'modal-title' : undefined}
            aria-describedby={description ? 'modal-description' : undefined}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'relative w-full bg-white dark:bg-slate-900 rounded-xl shadow-2xl',
              'max-h-[90vh] overflow-hidden flex flex-col',
              'ring-1 ring-black/5 dark:ring-white/10 border border-gray-100 dark:border-slate-800',
              sizes[size]
            )}
          >
            {(title || showCloseButton) && (
              <div className="flex items-start justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50">
                <div className="min-w-0 flex-1 pr-2">
                  {title && (
                    <h2 id="modal-title" className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white truncate">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p id="modal-description" className="mt-1 text-sm text-gray-500 dark:text-slate-500">{description}</p>
                  )}
                </div>
                {showCloseButton && (
                  <button
                    onClick={onClose}
                    aria-label="Close modal"
                    className="p-2 -m-1 text-gray-400 dark:text-slate-400 hover:text-gray-500 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 transition-colors flex-shrink-0"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, document.body);
}
