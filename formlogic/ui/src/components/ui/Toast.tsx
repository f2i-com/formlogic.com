import { useEffect, useState, useRef, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useToastStore, type Toast as ToastType } from '../../stores/toastStore';
import { cn } from '../../lib/utils';

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const styles = {
  success: {
    container: 'bg-white dark:bg-slate-900 border-green-200 dark:border-green-500/30 shadow-green-100/50 dark:shadow-green-500/5',
    iconBg: 'bg-green-100 dark:bg-green-500/10',
    icon: 'text-green-600 dark:text-green-400',
    title: 'text-green-900 dark:text-green-300',
    message: 'text-green-700 dark:text-green-400/80',
  },
  error: {
    container: 'bg-white dark:bg-slate-900 border-red-200 dark:border-red-500/30 shadow-red-100/50 dark:shadow-red-500/5',
    iconBg: 'bg-red-100 dark:bg-red-500/10',
    icon: 'text-red-600 dark:text-red-400',
    title: 'text-red-900 dark:text-red-300',
    message: 'text-red-700 dark:text-red-400/80',
  },
  warning: {
    container: 'bg-white dark:bg-slate-900 border-amber-200 dark:border-amber-500/30 shadow-amber-100/50 dark:shadow-amber-500/5',
    iconBg: 'bg-amber-100 dark:bg-amber-500/10',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-900 dark:text-amber-300',
    message: 'text-amber-700 dark:text-amber-400/80',
  },
  info: {
    container: 'bg-white dark:bg-slate-900 border-blue-200 dark:border-blue-500/30 shadow-blue-100/50 dark:shadow-blue-500/5',
    iconBg: 'bg-blue-100 dark:bg-blue-500/10',
    icon: 'text-blue-600 dark:text-blue-400',
    title: 'text-blue-900 dark:text-blue-300',
    message: 'text-blue-700 dark:text-blue-400/80',
  },
};

function ToastItem({ toast }: { toast: ToastType }) {
  const [isExiting, setIsExiting] = useState(false);
  const removeToast = useToastStore((state) => state.removeToast);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Icon = icons[toast.type];
  const style = styles[toast.type];

  const handleClose = useCallback(() => {
    setIsExiting(true);
    timeoutRef.current = setTimeout(() => removeToast(toast.id), 150);
  }, [removeToast, toast.id]);

  // Auto-dismiss after the duration set in the toast store. duration <= 0 means
  // PERSISTENT (manual dismiss only — e.g. admin broadcast warnings); the store's
  // own fallback timer already honors this convention.
  useEffect(() => {
    const duration = toast.duration ?? 5000;
    if (duration <= 0) return;
    const autoDismiss = setTimeout(() => handleClose(), duration);
    return () => {
      clearTimeout(autoDismiss);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [handleClose, toast.duration]);

  // Presentational only: announcements are made by the persistent live regions in
  // ToastContainer. A live region mounted together with its content is frequently
  // not announced by screen readers (esp. for polite), so the visual toast must NOT
  // also be a live region (that would double-announce).
  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl border shadow-lg max-w-sm w-full',
        'backdrop-blur-sm',
        style.container,
        isExiting ? 'animate-slide-out' : 'animate-slide-in'
      )}
    >
      <div className={cn('p-1.5 rounded-lg flex-shrink-0', style.iconBg)}>
        <Icon className={cn('h-4 w-4', style.icon)} />
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className={cn('text-sm font-semibold', style.title)}>{toast.title}</p>
        {toast.message && (
          <p className={cn('text-sm mt-0.5 leading-relaxed', style.message)}>{toast.message}</p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              handleClose();
            }}
            className={cn(
              'mt-1.5 inline-flex min-h-8 cursor-pointer items-center rounded-lg border border-current/25 px-2.5 text-xs font-bold transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
              style.title
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={handleClose}
        aria-label="Dismiss notification"
        className="flex-shrink-0 p-1.5 -m-1 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts);

  // Persistent, always-mounted live regions (even when there are no toasts) so a
  // screen reader announces text added LATER. Errors/warnings are assertive
  // (interrupt); success/info are polite (wait). The visual toasts below are
  // presentational only.
  const announce = (t: ToastType) => [t.title, t.message].filter(Boolean).join('. ');
  const polite = toasts.filter((t) => t.type !== 'error' && t.type !== 'warning');
  const assertive = toasts.filter((t) => t.type === 'error' || t.type === 'warning');

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {polite.map((t) => <div key={t.id}>{announce(t)}</div>)}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {assertive.map((t) => <div key={t.id}>{announce(t)}</div>)}
      </div>
      {toasts.length > 0 && (
        <div className="fixed bottom-[var(--fl-mobile-float)] right-4 md:bottom-4 z-[100] flex flex-col gap-3 max-h-[calc(100dvh-6rem)] overflow-y-auto">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} />
          ))}
        </div>
      )}
    </>
  );
}
