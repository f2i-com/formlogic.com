import { useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useToastStore, type Toast as ToastType } from '../../stores/toastStore';

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const styles = {
  success: {
    bg: 'bg-green-50 border-green-200',
    icon: 'text-green-500',
    title: 'text-green-800',
    message: 'text-green-700',
  },
  error: {
    bg: 'bg-red-50 border-red-200',
    icon: 'text-red-500',
    title: 'text-red-800',
    message: 'text-red-700',
  },
  warning: {
    bg: 'bg-yellow-50 border-yellow-200',
    icon: 'text-yellow-500',
    title: 'text-yellow-800',
    message: 'text-yellow-700',
  },
  info: {
    bg: 'bg-blue-50 border-blue-200',
    icon: 'text-blue-500',
    title: 'text-blue-800',
    message: 'text-blue-700',
  },
};

function ToastItem({ toast }: { toast: ToastType }) {
  const [isExiting, setIsExiting] = useState(false);
  const removeToast = useToastStore((state) => state.removeToast);
  const Icon = icons[toast.type];
  const style = styles[toast.type];

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => removeToast(toast.id), 150);
  };

  return (
    <div
      className={`
        flex items-start gap-3 p-4 rounded-lg border shadow-lg max-w-sm w-full
        ${style.bg}
        ${isExiting ? 'animate-slide-out' : 'animate-slide-in'}
      `}
      role="alert"
    >
      <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${style.icon}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${style.title}`}>{toast.title}</p>
        {toast.message && (
          <p className={`text-sm mt-1 ${style.message}`}>{toast.message}</p>
        )}
      </div>
      <button
        onClick={handleClose}
        className={`flex-shrink-0 p-1 rounded hover:bg-black/5 transition-colors ${style.icon}`}
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
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
