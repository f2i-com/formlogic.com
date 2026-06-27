import { cn } from '../../lib/utils';

/**
 * A content-shaped loading placeholder. Use to mirror the layout of the content
 * that's loading so the page doesn't jump when data arrives. Decorative — hidden
 * from assistive tech (the surrounding region carries an aria-busy/label).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-gray-200/70 dark:bg-slate-700/40', className)}
    />
  );
}

/** Skeleton shaped like a FormsList form card, so the grid doesn't reflow on load. */
export function FormCardSkeleton() {
  return (
    <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-4">
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2 pt-0.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 flex-1 rounded-lg" />
      </div>
    </div>
  );
}

/** Skeleton row for a list/table of recent forms or responses. */
export function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-4">
      <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <Skeleton className="h-7 w-7 rounded-lg flex-shrink-0" />
    </div>
  );
}
