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
      <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p className="text-sm text-gray-600 dark:text-gray-300">Couldn&apos;t load your diagrams.</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!target) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }
  return <Navigate to={target} replace />;
}
