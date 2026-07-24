// The create-app entry (/apps/new): name the app, then land straight in the
// App Studio wizard — creating and editing share ONE surface (owner direction).
//
// AI availability routes the entry: with a usable default AI the name card
// mentions the copilot; with none, the "Connect your AI" doors appear FIRST as
// a precursor (never a tollgate — "Continue without AI" is always one click).
// The advanced flows (build over existing forms / companion app) stay reachable
// at /apps/new/advanced.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Boxes, Layers, RefreshCw, Sparkles } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { ConnectAiDoors } from '../../components/ai/ConnectAiDoors';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';

type Phase = 'checking' | 'connect' | 'name';

export function AppCreateStart() {
  const navigate = useNavigate();
  const createApp = useAppStore((s) => s.createApp);
  const [phase, setPhase] = useState<Phase>('checking');
  const [aiReady, setAiReady] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Source-specific readiness (audit FL-23): only a default AI that can actually
  // EXECUTE counts — otherwise the connect doors come first.
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness().then(
      (res) => {
        if (cancelled) return;
        setAiReady(res.ready);
        setPhase(res.ready ? 'name' : 'connect');
      },
      () => {
        if (!cancelled) setPhase('connect');
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const recheck = async () => {
    if (rechecking) return;
    setRechecking(true);
    try {
      const res = await getAiReadiness({ fresh: true });
      setAiReady(res.ready);
      if (res.ready) {
        toast.success('AI connected', 'Your default AI is ready — the studio can now plan and build with you.');
        setPhase('name');
      } else {
        toast.info('Not connected yet', res.reason ?? 'No usable default AI was found.');
      }
    } finally {
      setRechecking(false);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const app = await createApp({ name: trimmed, description: description.trim() || undefined });
      if (app) {
        // Brand-new apps land on the studio's Plan step (the /studio redirect).
        navigate(`/apps/${app.id}/studio`);
        return;
      }
      toast.error('Creation failed', useAppStore.getState().error || 'Could not create the app. Please try again.');
    } catch {
      toast.error('Creation failed', 'An unexpected error occurred. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Create app"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:pt-8">
        {phase === 'checking' && (
          <div className="flex items-center justify-center py-24" role="status" aria-label="Checking your AI setup">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        )}

        {phase === 'connect' && (
          <>
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
              <Sparkles className="h-6 w-6 text-primary-600 dark:text-primary-300" />
              Want an AI copilot for this app?
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500 dark:text-slate-400">
              No AI is connected yet. Connect one and the App Studio can plan, sketch and build
              with you — or skip this and build everything by hand. You can connect an AI later
              at any time.
            </p>
            <div className="mt-6">
              <ConnectAiDoors />
            </div>
            <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
              <Button variant="secondary" onClick={recheck} isLoading={rechecking} leftIcon={<RefreshCw className="h-4 w-4" />}>
                I've connected it — check again
              </Button>
              <Button onClick={() => setPhase('name')} rightIcon={<ArrowRight className="h-4 w-4" />}>
                Continue without AI
              </Button>
            </div>
          </>
        )}

        {phase === 'name' && (
          <>
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
              <Boxes className="h-6 w-6 text-primary-600 dark:text-primary-300" />
              Create a new app
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500 dark:text-slate-400">
              {aiReady
                ? 'Name it and step into the App Studio — plan it with AI, sketch it as a diagram, or build it by hand. Everything is editable later.'
                : 'Name it and step into the App Studio — a guided, skippable builder for data, screens, automations and access. Everything is editable later.'}
            </p>

            <section className="mt-6 rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm dark:border-slate-700/60 dark:bg-slate-900 sm:p-6">
              <div className="space-y-4">
                <div>
                  <label htmlFor="new-app-name" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
                    App name
                  </label>
                  <Input
                    id="new-app-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
                    placeholder="e.g. Plumbing Operations, Client Portal"
                    autoFocus
                  />
                </div>
                <div>
                  <label htmlFor="new-app-desc" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
                    What is it for? <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
                  </label>
                  <Textarea
                    id="new-app-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="One or two sentences — shown to members and used by the AI when planning."
                    rows={2}
                  />
                </div>
                <div className="flex items-center justify-end">
                  <Button onClick={create} isLoading={creating} disabled={!name.trim()} rightIcon={<ArrowRight className="h-4 w-4" />}>
                    Create and open the studio
                  </Button>
                </div>
              </div>
            </section>

            <button
              type="button"
              onClick={() => navigate('/apps/new/advanced')}
              className="mt-5 inline-flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-gray-300 px-4 py-3 text-left text-sm text-gray-600 transition hover:border-primary-400 hover:text-primary-700 dark:border-white/15 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
            >
              <Layers className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Advanced starts</span>
                <span className="mt-0.5 block text-xs text-gray-400 dark:text-slate-500">
                  Build over forms you already have, or create a companion app for an existing one.
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </button>
          </>
        )}
      </main>
    </div>
  );
}

export default AppCreateStart;
