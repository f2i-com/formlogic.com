// The create-app entry (/apps/new): name the app, then land straight in the
// App Studio wizard — creating and editing share ONE surface (owner direction).
//
// AI availability routes the entry: with a usable default AI the name card
// mentions the copilot; with none, the "Connect your AI" doors appear FIRST as
// a precursor (never a tollgate — "Continue without AI" is always one click).
// Deliberately minimal: attaching existing forms happens in the studio's Data
// step, companion apps are created from an app's Forms manager.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Boxes, Check, HardDrive, Package, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { ConnectAiDoors } from '../../components/ai/ConnectAiDoors';
import { VaultSetupWizard } from '../../components/vault/VaultSetupWizard';
import { VaultUnlockDialog } from '../../components/vault/VaultUnlockDialog';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { cn } from '../../lib/utils';
import type { AppFormPrivacyDefault } from '../../types/app';

type Phase = 'checking' | 'connect' | 'name';

export function AppCreateStart() {
  const navigate = useNavigate();
  const createApp = useAppStore((s) => s.createApp);
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const [phase, setPhase] = useState<Phase>('checking');
  const [aiReady, setAiReady] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formPrivacy, setFormPrivacy] = useState<AppFormPrivacyDefault>('plain');
  const [creating, setCreating] = useState(false);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);

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

    // A private default is fail-closed: pause app creation until the vault is
    // ready. The selection must never create a plaintext app that merely looks
    // encrypted.
    if (formPrivacy === 'private') {
      if (isDemo) {
        toast.info('Already private to this browser', 'Demo projects stay in IndexedDB and are never uploaded. Sign up to use end-to-end encrypted forms.');
        return;
      }
      let vaultStatus = useVaultStore.getState().status;
      if (vaultStatus === 'unknown') {
        await useVaultStore.getState().refreshStatus();
        vaultStatus = useVaultStore.getState().status;
      }
      if (vaultStatus === 'none') {
        setShowVaultSetup(true);
        return;
      }
      if (vaultStatus !== 'unlocked') {
        setShowVaultUnlock(true);
        return;
      }
    }

    setCreating(true);
    try {
      const app = await createApp({
        name: trimmed,
        description: description.trim() || undefined,
        settings: { defaultFormPrivacy: formPrivacy },
      });
      if (app) {
        // Brand-new apps land on the studio's Overview (the /studio redirect).
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
      <main className="mx-auto max-w-3xl px-4 pb-32 pt-6 sm:pb-16 sm:pt-8">
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
              {isDemo && (
                <div className="mb-5 flex items-start gap-3 rounded-xl border border-primary-200/80 bg-primary-50/70 p-3 text-primary-800 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-200">
                  <HardDrive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p className="text-xs leading-5">
                    <span className="font-semibold">Private demo project.</span> This app is saved in this browser&apos;s IndexedDB and never uploaded to the shared server.
                  </p>
                </div>
              )}
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
                    rows={3}
                    className="min-h-24 resize-none"
                  />
                </div>
                <fieldset>
                  <legend className="mb-2 block text-xs font-semibold text-gray-600 dark:text-slate-300">
                    How should client data be protected?
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label
                      className={cn(
                        'relative flex cursor-pointer gap-3 rounded-xl border p-4 transition',
                        formPrivacy === 'plain'
                          ? 'border-primary-400 bg-primary-50/70 ring-2 ring-primary-500/10 dark:border-primary-500/60 dark:bg-primary-500/[0.08]'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-white/10 dark:hover:border-white/20 dark:hover:bg-white/[0.03]'
                      )}
                    >
                      <input
                        type="radio"
                        name="new-app-privacy"
                        value="plain"
                        checked={formPrivacy === 'plain'}
                        onChange={() => setFormPrivacy('plain')}
                        className="sr-only"
                      />
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500 shadow-sm ring-1 ring-gray-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-white/10">
                        {isDemo ? <HardDrive className="h-4 w-4" /> : <Boxes className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                          {isDemo ? 'Browser-local' : 'Standard'}
                          {formPrivacy === 'plain' && <Check className="h-4 w-4 text-primary-600 dark:text-primary-300" />}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-slate-400">
                          {isDemo
                            ? 'Saved only in this browser. Nothing is uploaded to the shared demo.'
                            : 'Full feature support with normal workspace data storage and access controls.'}
                        </span>
                      </span>
                    </label>

                    <label
                      aria-disabled={isDemo}
                      className={cn(
                        'relative flex gap-3 rounded-xl border p-4 transition',
                        isDemo ? 'cursor-not-allowed border-gray-200 bg-gray-50/70 opacity-65 dark:border-white/10 dark:bg-white/[0.02]' : 'cursor-pointer',
                        !isDemo && formPrivacy === 'private'
                          ? 'border-emerald-400 bg-emerald-50/70 ring-2 ring-emerald-500/10 dark:border-emerald-500/60 dark:bg-emerald-500/[0.08]'
                          : !isDemo && 'border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/40 dark:border-white/10 dark:hover:border-emerald-500/30 dark:hover:bg-emerald-500/[0.04]'
                      )}
                    >
                      <input
                        type="radio"
                        name="new-app-privacy"
                        value="private"
                        checked={formPrivacy === 'private'}
                        onChange={() => setFormPrivacy('private')}
                        disabled={isDemo}
                        className="sr-only"
                      />
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-200 dark:bg-slate-800 dark:text-emerald-300 dark:ring-emerald-500/20">
                        <ShieldCheck className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                          End-to-end encrypted
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Beta</span>
                          {formPrivacy === 'private' && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-slate-400">
                          {isDemo
                            ? 'Available after sign-up. Demo data is already kept on this device.'
                            : 'New Studio data types start as private forms. FormLogic stores ciphertext and cannot read client responses.'}
                        </span>
                      </span>
                    </label>
                  </div>
                  {formPrivacy === 'private' && !isDemo && (
                    <p className="mt-2 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                      This can&apos;t be undone: once a data type is private it stays private. File uploads,
                      camera and linked-record questions aren&apos;t available on private forms, and you&apos;ll
                      need your vault unlocked to read the answers. Existing forms you attach are unchanged.
                    </p>
                  )}
                </fieldset>
                <div className="flex items-center justify-end">
                  <Button onClick={() => void create()} isLoading={creating} disabled={!name.trim()} rightIcon={<ArrowRight className="h-4 w-4" />}>
                    Create and open the studio
                  </Button>
                </div>
              </div>
            </section>

            {/* Starting from a ready-made app was invisible at the moment someone
                decided to create one — the marketplace was only reachable from the
                sidebar's Advanced tools or the Apps header's Import button. */}
            <div className="mt-5 rounded-2xl border border-dashed border-gray-300 p-4 text-center dark:border-white/15">
              <p className="text-sm font-semibold text-gray-800 dark:text-slate-200">Or start from something that already works</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-gray-500 dark:text-slate-400">
                Install a ready-made app from the Marketplace and edit it, instead of building from
                an empty studio. Already have forms? Attach them in Data &amp; forms once the app exists.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => navigate('/packs')}
                leftIcon={<Package className="h-4 w-4" />}
              >
                Browse the Marketplace
              </Button>
            </div>
          </>
        )}
      </main>
      <VaultSetupWizard
        isOpen={showVaultSetup}
        onClose={() => setShowVaultSetup(false)}
        onComplete={() => void create()}
      />
      <VaultUnlockDialog
        isOpen={showVaultUnlock}
        onClose={() => setShowVaultUnlock(false)}
        onUnlocked={() => void create()}
        title="Unlock your vault to create this app"
      />
    </div>
  );
}

export default AppCreateStart;
