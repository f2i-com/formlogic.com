// Smart sidebar target for "Diagrams" (owner direction): resume the most recent
// UNPUBLISHED diagram (no linked app yet) for quick navigation; otherwise open a
// fresh canvas — which persists nothing until the first real change. The full
// list stays one click away at /diagrams/all.
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';

export default function DiagramsEntry() {
  const [target, setTarget] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.listBlueprints().then((res) => {
      if (cancelled) return;
      if (res.error || !res.data) {
        // An API failure must not silently route to a fresh draft (audit FL-22) —
        // that hides the user's existing work behind an empty canvas. Surface it.
        setFailed(true);
        return;
      }
      // Resume the newest UNPUBLISHED diagram anywhere in the ordering — not only
      // when it happens to be the newest overall item (audit FL-22).
      const unpublished = (res.data.blueprints ?? []).find((b) => b.appId === null);
      setTarget(unpublished ? `/diagrams/${unpublished.id}` : '/diagrams/new');
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (failed) {
    return (
      // min-h, not a fixed height that subtracts a 4rem header: AppShell renders no
      // header of its own here, so the old calc left the panel short of centre.
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p className="text-sm text-gray-600 dark:text-slate-300">Couldn&apos;t load your diagrams.</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
          // `bg-primary` is NOT a token in this theme (only primary-50…950 and
          // primary-foreground exist), so the previous class emitted no CSS at all and
          // this button rendered as near-white text on the page background.
          className="cursor-pointer rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!target) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-label="Loading your diagrams">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }
  return <Navigate to={target} replace />;
}
