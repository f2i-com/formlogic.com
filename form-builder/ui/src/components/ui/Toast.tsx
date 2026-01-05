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
    container: 'bg-white border-green-200 shadow-green-100/50',
    iconBg: 'bg-green-100',
    icon: 'text-green-600',
    title: 'text-green-900',
    message: 'text-green-700',
  },
  error: {
    container: 'bg-white border-red-200 shadow-red-100/50',
    iconBg: 'bg-red-100',
    icon: 'text-red-600',
    title: 'text-red-900',
    message: 'text-red-700',
  },
  warning: {
    container: 'bg-white border-amber-200 shadow-amber-100/50',
    iconBg: 'bg-amber-100',
    icon: 'text-amber-600',
    title: 'text-amber-900',
    message: 'text-amber-700',
  },
  info: {
    container: 'bg-white border-blue-200 shadow-blue-100/50',
    iconBg: 'bg-blue-100',
    icon: 'text-blue-600',
    title: 'text-blue-900',
    message: 'text-blue-700',
  },
};

function ToastItem({ toast }: { toast: ToastType }) {
  const [isExiting, setIsExiting] = useState(false);
  const removeToast = useToastStore((state) => state.removeToast);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Icon = icons[toast.type];
  const style = styles[toast.type];

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleClose = useCallback(() => {
    setIsExiting(true);
    timeoutRef.current = setTimeout(() => removeToast(toast.id), 150);
  }, [removeToast, toast.id]);

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl border shadow-lg max-w-sm w-full',
        'backdrop-blur-sm',
        style.container,
        isExiting ? 'animate-slide-out' : 'animate-slide-in'
      )}
      role="alert"
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
        className="flex-shrink-0 p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
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
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-3">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
