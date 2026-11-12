import type { ElementType } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/Button';

/**
 * One count on an admin page (users, apps, a form's records): its name, the number, and a
 * line of detail where there is one. Compact, so a row of them leaves the page to what
 * follows. Goes in a <dl> that lays the row out.
 */
export function AdminCount({ icon: Icon, label, value, note }: { icon: ElementType; label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:px-4">
      <dt className="flex items-start gap-1.5 text-xs font-medium text-gray-500 dark:text-slate-400">
        <Icon className="mt-px h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-400" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
      </dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-gray-900 dark:text-white">{value}</span>
        {note && <span className="text-xs text-gray-500 dark:text-slate-400">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * Shared async-state bits for the admin pages, matching the app's house style
 * (AdminDoctor / AdminActingBoundary): a real spinner with role="status"
 * instead of bare "Loading…" text, and an error block that always offers retry.
 * Both start at the left and are a line tall, so a panel that is still loading
 * (or could not load) takes little more room than its title.
 */

export function AdminSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2 text-sm text-gray-500 dark:text-slate-400">
      <div className="h-5 w-5 flex-none animate-spin rounded-full border-b-2 border-primary-500" role="status" aria-label={label} />
      <span aria-hidden="true">{label}…</span>
    </div>
  );
}

export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2.5 dark:border-red-500/30 dark:bg-red-500/10">
      <p role="alert" className="min-w-0 text-sm text-red-700 dark:text-red-300">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" />}>
        Try again
      </Button>
    </div>
  );
}
