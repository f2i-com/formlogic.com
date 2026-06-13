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

  // Auto-dismiss after the duration set in the toast store
  useEffect(() => {
    const duration = toast.duration ?? 5000;
    const autoDismiss = setTimeout(() => handleClose(), duration);
    return () => {
      clearTimeout(autoDismiss);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [handleClose, toast.duration]);

  // Errors/warnings interrupt (assertive alert); success/info wait politely so
  // they don't talk over the user.
  const urgent = toast.type === 'error' || toast.type === 'warning';
  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl border shadow-lg max-w-sm w-full',
        'backdrop-blur-sm',
        style.container,
        isExiting ? 'animate-slide-out' : 'animate-slide-in'
      )}
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
    >
      <div className={cn('p-1.5 rounded-lg flex-shrink-0', style.iconBg)}>
        <Icon className={cn('h-4 w-4', style.icon)} />
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className={cn('text-sm font-semibold', style.title)}>{toast.title}</p>
        {toast.message && (
          <p className={cn('text-sm mt-0.5 leading-relaxed', style.message)}>{toast.message}</p>
        )}
      </div>
      <button
        onClick={handleClose}
        aria-label="Dismiss notification"
        className="flex-shrink-0 p-1.5 -m-1 rounded-lg text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 md:bottom-4 z-[100] flex flex-col gap-3 max-h-[calc(100vh-6rem)] overflow-y-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
