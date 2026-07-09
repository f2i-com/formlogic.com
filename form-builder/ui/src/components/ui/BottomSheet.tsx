// Shared mobile sheet chrome for editors that need to keep the canvas visible while a
// secondary panel is open. The sizing/z-index classes intentionally mirror FlowEditor.
import { type ReactNode } from 'react';
import { X } from 'lucide-react';

export function BottomSheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div>
      <div className="fixed inset-0 z-[80] bg-gray-900/30 dark:bg-slate-950/60" onClick={onClose} aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-0 bottom-0 z-[90] flex max-h-[70dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-gray-200/80 px-3 py-2 dark:border-slate-700/60">
          <h4 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden [&>div>div:last-child]:pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
      </section>
    </div>
  );
}
