import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../lib/utils';

/**
 * "We couldn't load this" — the state this app kept rendering as EMPTY.
 *
 * `api.request` never throws; it returns `{ data?, error?, status? }`. So the ubiquitous
 * `res.data?.rows ?? []` quietly turns a 500 into a legitimate-looking empty list, and
 * every surface then renders its cheerful first-run copy: an owner whose 47 forms failed
 * to load was told "No forms yet — create your first one", and a failed permissions read
 * rendered as an all-unchecked matrix that the next save would have committed.
 *
 * Three states are distinct and must stay distinct: LOADING, LOADED-AND-EMPTY, FAILED.
 * This is the third. It always says the data is not lost — a non-technical owner's first
 * reading of an empty screen is that their work is gone — and it always offers a retry,
 * because a read failure is usually transient.
 *
 * Use EmptyState for a genuinely empty result; use this when a read failed.
 */
interface LoadFailureProps {
  /** What failed, in the user's words: "We couldn't load your forms". */
  title: string;
  /** The server's message, when there is one worth showing. Never a raw stack. */
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Inline variant for panels and cards, rather than a full page slot. */
  compact?: boolean;
  className?: string;
}

export function LoadFailure({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
  className,
}: LoadFailureProps) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-xl border border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10',
        compact ? 'flex items-start gap-3 p-3' : 'flex flex-col items-center gap-3 px-4 py-10 text-center',
        className
      )}
    >
      <AlertTriangle
        className={cn('flex-none text-amber-600 dark:text-amber-400', compact ? 'mt-0.5 h-4 w-4' : 'h-6 w-6')}
        aria-hidden="true"
      />
      <div className={cn('min-w-0', compact ? 'flex-1' : '')}>
        <p className={cn('font-medium text-gray-900 dark:text-white', compact ? 'text-sm' : 'text-base')}>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-gray-600 dark:text-slate-300">
          Nothing has been lost — this is a problem reading it, not a problem with your data.
        </p>
        {message && (
          <p className="mt-1.5 break-words text-xs text-gray-500 dark:text-slate-400">{message}</p>
        )}
      </div>
      {onRetry && (
        <Button
          size="sm"
          variant="outline"
          className="flex-none"
          onClick={onRetry}
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
