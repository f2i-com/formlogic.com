import { useEffect, useState } from 'react';
import { Boxes, Loader2, Sparkles } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

type Sample = { id: string; name: string; description: string; formCount: number };

/** "Try a sample app" gallery — installs a ready-made demo app (a full, owned copy) and opens it. */
export function SampleAppsModal({ isOpen, onClose, onInstalled }: { isOpen: boolean; onClose: () => void; onInstalled: () => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // setState only after the await, so this doesn't trip react-hooks/set-state-in-effect
    // (loading defaults to true, so the spinner shows until the first fetch resolves).
    (async () => {
      try {
        const r = await api.getSampleApps();
        if (!cancelled) setSamples(r.data?.samples || []);
      } catch {
        /* ignore — empty state renders */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const install = async (s: Sample) => {
    if (installing) return;
    setInstalling(s.id);
    const r = await api.installSampleApp(s.id);
    if (r.error || !r.data?.apps?.[0]) {
      setInstalling(null);
      toast.error('Could not install the sample', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    toast.success(`${s.name} installed`, 'A full copy is now in your account.');
    onInstalled();
    const appId = r.data.apps[0].id;
    const appRes = await api.getApp(appId);
    const slug = (appRes.data?.app as { slug?: string } | undefined)?.slug;
    setInstalling(null);
    onClose();
    if (slug) window.open(`/app/${slug}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Try a sample app">
      <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">
        Install a ready-made app to see what FormLogic can do — multiple forms, linked records, roles, and a custom dashboard. It's a full copy you own and can edit or export.
      </p>
      {loading ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary-500" /></div>
      ) : samples.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-slate-500">No sample apps available.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {samples.map((s) => (
            <div key={s.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 p-4 flex flex-col">
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-lg bg-primary-50 dark:bg-primary-500/10 shrink-0"><Boxes className="h-4 w-4 text-primary-600 dark:text-primary-400" /></div>
                <span className="font-medium text-gray-900 dark:text-white text-sm">{s.name}</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed flex-1">{s.description}</p>
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-gray-400 dark:text-slate-500">{s.formCount} form{s.formCount === 1 ? '' : 's'}</span>
                <Button size="sm" onClick={() => install(s)} disabled={!!installing} leftIcon={installing === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}>
                  {installing === s.id ? 'Installing…' : 'Try it'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
