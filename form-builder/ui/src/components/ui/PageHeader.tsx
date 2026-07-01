import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * Shared page header for in-app subpages: optional back button, title, subtitle, right-side
 * actions. Replaces the six hand-rolled `back-arrow + h1` blocks across the app runtime so
 * heading hierarchy, spacing, and focus affordances stay consistent.
 */
export function PageHeader({
  title,
  subtitle,
  onBack,
  backLabel = 'Back',
  actions,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-6 flex items-start gap-3 ${className}`}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          title={backLabel}
          className="mt-0.5 flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold tracking-tight text-gray-900 dark:text-white">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </div>
  );
}
