import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useStudioSaveState } from './studioSaveState';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';

/**
 * A failed write, pinned.
 *
 * The studio's save state stands at the end of its section row, which scrolls away with the
 * page. A transient "Saved" may scroll away; a failure may not: a builder who taps Add
 * field on a flaky mobile connection must not be able to scroll past the one
 * notice telling them the change did not land, and Retry is the only recovery
 * control there is. So this strip stays under the page Header, at every width.
 *
 * Renders nothing when the last write succeeded, so the healthy case costs 0px.
 */
export function StudioSaveErrorStrip() {
  const saveError = useStudioSaveState((s) => s.lastError);
  const failedLabel = useStudioSaveState((s) => s.failedLabel);
  const retry = useStudioSaveState((s) => s.retry);
  const retryLast = useStudioSaveState((s) => s.retryLast);
  const isOnline = useOnlineStatus();

  if (!saveError) return null;

  return (
    <div
      role="alert"
      // Under the Header (h-14, sm:h-16), which itself stands below the offline and demo banners.
      className={cn(
        'sticky z-20 flex min-h-11 items-center gap-2 border-b border-red-200 bg-red-50 px-4 text-xs font-medium text-red-700 sm:px-6 dark:border-red-500/20 dark:bg-red-950 dark:text-red-300',
        isOnline
          ? 'top-[calc(3.5rem+var(--fl-demo-banner-h,0px))] sm:top-[calc(4rem+var(--fl-demo-banner-h,0px))]'
          : 'top-[calc(5.5rem+var(--fl-demo-banner-h,0px))] sm:top-[calc(6rem+var(--fl-demo-banner-h,0px))]',
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={saveError}>
        Couldn&apos;t save {failedLabel ?? 'this change'}
      </span>
      {retry && (
        <button
          type="button"
          onClick={() => void retryLast()}
          className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 font-bold text-red-700 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-500/15"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}
