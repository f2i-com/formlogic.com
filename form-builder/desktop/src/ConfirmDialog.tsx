import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

let nextConfirmId = 1;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setPending(null);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending({ ...options, id: nextConfirmId++ });
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    return () => resolverRef.current?.(false);
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      settle(false);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const titleId = pending ? `confirm-title-${pending.id}` : undefined;
  const bodyId = pending?.body ? `confirm-body-${pending.id}` : undefined;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div className="confirm-overlay" onMouseDown={() => settle(false)}>
          <div
            ref={dialogRef}
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={onDialogKeyDown}
          >
            <h2 className="confirm-title" id={titleId}>
              {pending.title}
            </h2>
            {pending.body && (
              <p className="confirm-body" id={bodyId}>
                {pending.body}
              </p>
            )}
            <div className="confirm-actions">
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-ghost"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
