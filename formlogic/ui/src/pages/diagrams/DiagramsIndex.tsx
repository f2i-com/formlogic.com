// Diagrams index (§11A D1): the management list behind /diagrams/all (the sidebar's
// /diagrams is the smart resume-or-new entry). New diagrams open a deferred canvas —
// nothing persists until the first real change. Each diagram is a blueprint row.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Map as MapIcon, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { Blueprint } from '../../types/blueprints';

export default function DiagramsIndex() {
  const navigate = useNavigate();
  const [diagrams, setDiagrams] = useState<Blueprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<Blueprint | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.listBlueprints().then((res) => {
      if (cancelled) return;
      setDiagrams(res.data?.blueprints ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const res = await api.listBlueprints();
    setDiagrams(res.data?.blueprints ?? []);
  }, []);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    await api.deleteBlueprint(target.id);
    await refresh();
  }, [pendingDelete, refresh]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
            <MapIcon className="h-6 w-6 text-primary-600 dark:text-primary-300" />
            Diagrams
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            Sketch what you're building — forms, flows, and what triggers what — before it exists.
          </p>
        </div>
      </div>
      <div className="mb-6">
        <Button onClick={() => navigate('/diagrams/new')} leftIcon={<Plus className="h-4 w-4" />}>
          New diagram
        </Button>
        {api.isDemoMode() && (
          <p className="mt-2 text-xs text-gray-400 dark:text-slate-500">
            Demo diagrams stay in this browser — nothing is saved to the server. Sign up free to keep
            them and turn a diagram into a real app.
          </p>
        )}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-gray-400 dark:text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : diagrams.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">
          No diagrams yet — create one above, or use "Start with a diagram" on the Dashboard.
        </p>
      ) : (
        <div className="space-y-2">
          {diagrams.map((diagram) => (
            <div
              key={diagram.id}
              className="group flex items-center gap-3 rounded-xl border border-gray-200/80 bg-white px-4 py-3 hover:border-primary-300 dark:border-slate-700/60 dark:bg-slate-900 dark:hover:border-primary-500/40"
            >
              <button type="button" onClick={() => navigate(`/diagrams/${diagram.id}`)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{diagram.name}</p>
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  {diagram.status} · rev {diagram.semanticRevision} · updated {diagram.updatedAt}
                </p>
              </button>
              <Button
                variant="ghost"
                size="iconOnly"
                className="opacity-0 group-hover:opacity-100"
                onClick={() => setPendingDelete(diagram)}
                aria-label={`Delete diagram ${diagram.name}`}
              >
                <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete diagram"
        message={pendingDelete ? `Delete '${pendingDelete.name}'? The forms and flows it references are kept.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
