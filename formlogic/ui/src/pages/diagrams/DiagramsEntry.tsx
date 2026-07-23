// Smart sidebar target for "Diagrams" (owner direction): resume the most recent
// UNPUBLISHED diagram (no linked app yet) for quick navigation; otherwise open a
// fresh canvas — which persists nothing until the first real change. The full
// list stays one click away at /diagrams/all.
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../../lib/api';

export default function DiagramsEntry() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.listBlueprints().then((res) => {
      if (cancelled) return;
      const last = (res.data?.blueprints ?? [])[0];
      setTarget(last && last.appId === null ? `/diagrams/${last.id}` : '/diagrams/new');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!target) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }
  return <Navigate to={target} replace />;
}
