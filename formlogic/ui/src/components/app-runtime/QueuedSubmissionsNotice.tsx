import { useState } from 'react';
import { OfflineQueuePanel } from '../../sdk/components';
import { useOfflineQueue } from '../../sdk/hooks';
import { cn } from '../../lib/utils';

/**
 * One quiet line in the app shell while submissions wait on this device or could not be sent,
 * with the SDK's queue panel (Sync now, and Send again / Discard for each failed one) behind
 * "Review". A custom screen can include that panel itself; a standard app had no way to it, so a
 * person never learned that what they submitted had not arrived.
 *
 * `offlineBannerShown`: the shell's offline banner already says submissions are queued, so while
 * it shows, waiting ones are left to it and only a failed one is named here.
 */
export function QueuedSubmissionsNotice({ offlineBannerShown, className }: { offlineBannerShown: boolean; className?: string }) {
  const q = useOfflineQueue();
  const [open, setOpen] = useState(false);
  const { pending, failed } = q;
  const count = (n: number) => `${n} submission${n === 1 ? '' : 's'}`;
  const waitingShown = pending > 0 && !(offlineBannerShown && q.offline);
  // Kept while the panel is open, so what Send again or Sync now did can still be read.
  if (!open && !waitingShown && failed === 0) return null;
  const summary = waitingShown && failed > 0
    ? `${pending} waiting to send, ${failed} could not be sent`
    : failed > 0
      ? `${count(failed)} could not be sent`
      : waitingShown
        ? `${count(pending)} waiting to send`
        : 'Nothing waiting to send';
  return (
    <div className={cn('border-b border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 px-4 py-1.5', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 shrink-0 rounded-full', failed > 0 ? 'bg-red-500' : waitingShown ? 'bg-amber-500' : 'bg-emerald-500')}
        />
        <span role="status" className="min-w-0 text-gray-600 dark:text-slate-300">{summary}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="app-queued-submissions"
          className="text-sm font-medium app-text-primary underline-offset-2 hover:underline cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
        >
          {open ? 'Hide' : 'Review'}
        </button>
      </div>
      {open && (
        <div id="app-queued-submissions" className="mt-2 mb-1 max-w-xl max-h-[50vh] overflow-y-auto">
          <OfflineQueuePanel />
        </div>
      )}
    </div>
  );
}
