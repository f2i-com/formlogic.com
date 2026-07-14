import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/Button';

/**
 * Shared async-state bits for the admin pages, matching the app's house style
 * (AdminDoctor / AdminActingBoundary): a real spinner with role="status"
 * instead of bare "Loading…" text, and an error block that always offers retry.
 */

export function AdminSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" role="status" aria-label={label} />
    </div>
  );
}

export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/10 p-6 text-center space-y-3">
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" />}>
        Try again
      </Button>
    </div>
  );
}
