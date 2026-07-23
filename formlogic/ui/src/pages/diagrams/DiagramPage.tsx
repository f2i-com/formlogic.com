// One diagram at /diagrams/:diagramId (§11A D1): the canvas with a light header. The
// diagram IS a blueprint row — the create path (Dashboard "Start with a diagram") lands
// here, and later slices link it to a materialised app for bi-directional updates.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft, Loader2, Map as MapIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { Blueprint } from '../../types/blueprints';
import { DiagramCanvas } from './DiagramCanvas';

export default function DiagramPage() {
  const { diagramId } = useParams<{ diagramId: string }>();
  const [diagram, setDiagram] = useState<Blueprint | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!diagramId) return;
    const res = await api.getBlueprint(diagramId);
    if (res.data?.blueprint) {
      setDiagram(res.data.blueprint);
    } else {
      setMissing(true);
      toast.error('Diagram not found', typeof res.error === 'string' ? res.error : undefined);
    }
  }, [diagramId]);

  useEffect(() => {
    let cancelled = false;
    if (!diagramId) return;
    void api.getBlueprint(diagramId).then((res) => {
      if (cancelled) return;
      if (res.data?.blueprint) setDiagram(res.data.blueprint);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [diagramId]);

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5 dark:border-slate-700/60 dark:bg-slate-900">
        <Link
          to="/diagrams"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Diagrams
        </Link>
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <MapIcon className="h-4 w-4 text-primary-600 dark:text-primary-300" />
          {diagram?.name ?? (missing ? 'Not found' : 'Loading…')}
        </span>
      </div>
      <div className="min-h-0 flex-1 bg-gray-50 dark:bg-slate-950">
        {diagram ? (
          <ReactFlowProvider>
            <DiagramCanvas
              key={diagram.id}
              blueprint={diagram}
              onReload={load}
              onRevisions={(semantic, layout) =>
                setDiagram((current) =>
                  current ? { ...current, semanticRevision: semantic, layoutRevision: layout } : current,
                )
              }
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center">
            {missing ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">
                This diagram doesn't exist (or isn't yours). <Link to="/diagrams" className="text-primary-600 underline dark:text-primary-300">Back to Diagrams</Link>
              </p>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
