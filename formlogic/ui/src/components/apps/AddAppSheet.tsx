import { useEffect, useRef } from 'react';
import { ExternalLink, PackagePlus, X } from 'lucide-react';
import type { AppOffer } from '../studio/useAppOffer';
import { Button } from '../ui/Button';

/**
 * FormLogic's question when an app offers the person an app it made (its `formlogicAddApp` bridge:
 * HostedAppFrame, useAppOffer), over the app's frame as the wallet is. The offering app chose only
 * the name shown, which is text and nothing more; the person chooses whether it is added. Only on
 * Add app are its files fetched and the app made, in their own account, where nobody else can open
 * it until they share it. The offering app hears whether it was added, and its name.
 *
 * It cannot be put away while the app is being made: the person said yes, and is shown how it went.
 */
export function AddAppSheet({ offer, hostName, onAdd, onClose }: { offer: AppOffer; hostName: string; onAdd: () => void; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  // The keyboard comes to the sheet, not to Add app: the person was in the app, and a key meant for it adds nothing.
  useEffect(() => { sheet.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const adding = offer.state === 'adding';
  const name = offer.shown || 'this app';
  const title = offer.state === 'added' ? 'Added to your apps.' : offer.state === 'failed' ? 'This app could not be added' : `Add ${name} to your apps?`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={sheet} role="dialog" aria-modal="true" aria-labelledby="fl-add-app-title" tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none dark:bg-slate-900 sm:rounded-2xl" data-testid="add-app-sheet">
        <div className="flex items-start justify-between gap-3">
          <h2 id="fl-add-app-title" className="flex min-w-0 items-start gap-2 text-base font-semibold text-gray-900 dark:text-white"><PackagePlus className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" /><span className="min-w-0 break-words">{title}</span></h2>
          <button type="button" aria-label="Close" disabled={adding} className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-slate-800" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        {offer.state === 'added' ? (
          <div className="mt-3 space-y-4">
            <p className="break-words text-sm leading-6 text-gray-600 dark:text-slate-300">{offer.added?.name ?? name} is yours: only you can open it until you share it.</p>
            <div className="flex flex-wrap gap-2">
              {offer.added && (
                // A tab of its own: the app that made it stays open here.
                <a href={`/app/${encodeURIComponent(offer.added.slug)}`} target="_blank" rel="noopener noreferrer" onClick={onClose}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground shadow-md shadow-primary-600/15 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 max-sm:min-h-11 dark:focus-visible:ring-offset-slate-950">
                  Open it<ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              )}
              <Button variant="outline" onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : offer.state === 'failed' ? (
          <div className="mt-3 space-y-4">
            <p role="alert" className="break-words text-sm leading-6 text-red-600 dark:text-red-400">{offer.message ?? 'The app could not be added. Try again in a moment.'}</p>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="break-words text-sm leading-6 text-gray-600 dark:text-slate-300">{hostName} made this app and is offering you a copy. It becomes yours: only you can open it until you share it.</p>
            <div className="flex flex-wrap gap-2">
              <Button isLoading={adding} disabled={adding} onClick={onAdd}>Add app</Button>
              <Button variant="outline" disabled={adding} onClick={onClose}>Not now</Button>
            </div>
            {adding && <p role="status" className="text-sm text-gray-500 dark:text-slate-400">Adding it to your apps…</p>}
          </div>
        )}
      </div>
    </div>
  );
}
