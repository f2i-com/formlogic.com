import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppWindow, ArrowRight, Boxes, Check, ChevronDown, ClipboardList, FileUp, HardDrive, Package, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { ConnectAiDoors } from '../../components/ai/ConnectAiDoors';
import { VaultSetupWizard } from '../../components/vault/VaultSetupWizard';
import { VaultUnlockDialog } from '../../components/vault/VaultUnlockDialog';
import { getAiReadiness, type AiReadiness } from '../../client-runtime/flows/aiDefault';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { cn } from '../../lib/utils';
import { useFocusIfInView } from '../../hooks/useFocusIfInView';
import type { AppFormPrivacyDefault, AppKind } from '../../types/app';
import { SoftnCreateForm } from './SoftnCreateForm';
import { SiteCreateForm } from '../../components/apps/SiteCreateForm';
import { WebAppStarter } from './WebAppStarter';
import { CreateAppChat } from './CreateAppChat';

type Build = 'web' | 'forms' | 'upload';
const builds = [
  { type: 'web', label: 'Web app', hint: 'JavaScript, React or Vue', icon: AppWindow },
  { type: 'forms', label: 'Forms app', hint: 'Forms, CRUD & live charts', icon: ClipboardList },
  { type: 'upload', label: 'Upload SoftN / ZIP', hint: 'SoftN, PHP, Rust, JS or static', icon: FileUp },
] as const;
const headings = {
  web: ['Start with a web app', 'Choose a framework and open a working starter in your editor.'],
  forms: ['Create a forms app', 'Name your app, then design the first form people will fill out.'],
  upload: ['Upload a SoftN or web app ZIP', 'Upload a .softn or .zip project (including PHP, Rust, JS, Python, or static builds) — with optional shared database linking.'],
};

export function AppCreateStart() {
  const navigate = useNavigate();
  const createApp = useAppStore((s) => s.createApp);
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const [ai, setAi] = useState<AiReadiness | null>(null);
  const aiReady = ai?.ready === true;
  const [searchParams] = useSearchParams();
  const requested = searchParams.get('type');
  const [manualStarted, setManualStarted] = useState(false);
  const build: Build = requested === 'site' || requested === 'upload' ? 'upload'
    : requested === 'forms' || (!requested && isDemo) ? 'forms' : 'web';
  const showChat = aiReady && !isDemo && (requested === 'chat' || (!requested && !manualStarted));
  const [rechecking, setRechecking] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formPrivacy, setFormPrivacy] = useState<AppFormPrivacyDefault>('plain');
  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const [destination, setDestination] = useState<'form' | 'studio'>('form');
  const [appKind, setAppKind] = useState<AppKind>('internal');
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  useFocusIfInView(nameField, build);

  // Source-specific readiness (audit FL-23): only a default AI that can actually
  // EXECUTE counts — otherwise the connect doors come first.
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness().then(
      (res) => { if (!cancelled) setAi(res); },
      () => {
        if (!cancelled) setAi({ ready: false });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const recheck = async (quiet = false) => {
    if (rechecking) return;
    setRechecking(true);
    try {
      const res = await getAiReadiness({ fresh: true });
      setAi(res);
      if (quiet) return;
      if (res.ready) {
        toast.success('AI connected', 'Create with AI is ready.');
      } else {
        toast.info('Not connected yet', res.reason ?? 'No usable default AI was found.');
      }
    } catch {
      toast.error('Connection check failed', 'You can still create your app and connect AI later.');
    } finally {
      setRechecking(false);
    }
  };

  const create = async (next: 'form' | 'studio') => {
    const trimmed = name.trim();
    if (!trimmed || createLock.current) return;
    createLock.current = true;
    setDestination(next);
    setCreating(true);
    try {

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

      const app = await createApp({
        name: trimmed,
        description: description.trim() || undefined,
        settings: { defaultFormPrivacy: formPrivacy, appKind },
      });
      if (app) {
        navigate(next === 'form' ? `/apps/${app.id}/studio/data?new=form` : `/apps/${app.id}/studio`);
        return;
      }
      toast.error('Creation failed', useAppStore.getState().error || 'Could not create the app. Please try again.');
    } catch {
      toast.error('Creation failed', 'An unexpected error occurred. Please try again.');
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Create app"
        back={{ onClick: () => navigate('/apps'), label: 'Back to apps' }}
      />
      {showChat ? <CreateAppChat prefs={ai?.prefs} /> : <div className="@container/create mx-auto w-full max-w-5xl px-4 pb-24 pt-4 sm:px-6 sm:pt-6"
        onPointerDownCapture={() => { if (!requested && !ai) setManualStarted(true); }}
        onKeyDownCapture={() => { if (!requested && !ai) setManualStarted(true); }}>
        <div className="grid items-start gap-3 @3xl/create:grid-cols-[12rem_minmax(0,1fr)] @3xl/create:gap-6">
        <nav aria-label="App creation methods" className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-900/70 @3xl/create:grid-cols-1 @3xl/create:gap-1.5 @3xl/create:border-0 @3xl/create:bg-transparent @3xl/create:p-0 @3xl/create:dark:bg-transparent">
          {builds.map(({type, label, hint, icon: Icon}) => <Link key={type} to={`?type=${type}`} replace preventScrollReset
            aria-current={build === type ? 'page' : undefined}
            className={cn('flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-1 text-sm focus-visible:outline-2 focus-visible:outline-primary-500 @3xl/create:justify-start @3xl/create:gap-3 @3xl/create:px-3 @3xl/create:py-3', build === type
              ? 'border-slate-200 bg-white text-primary-800 shadow-sm dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200'
              : 'text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800')}>
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0"><span className="block font-semibold">{label}</span>
              <span className="mt-0.5 hidden text-xs text-slate-600 dark:text-slate-400 @3xl/create:block">{hint}</span>
            </span>
          </Link>)}
        </nav>
        <section aria-labelledby="create-method-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm @xl/create:p-6 dark:border-slate-700 dark:bg-slate-900">
          <header className="mb-5">
            <h2 id="create-method-title" className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">{headings[build][0]}</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">{headings[build][1]}</p>
          </header>
          {isDemo && <p className="mb-4 rounded-xl bg-primary-50 p-3 text-sm text-primary-800 dark:bg-primary-500/10 dark:text-primary-200">
            {build === 'forms' ? 'Demo projects are saved in this browser.' : 'Sign up to host a web app, or try a forms app in this browser.'}
          </p>}
          {requested === 'site' ? <SiteCreateForm disabled={isDemo} /> : build === 'upload' ? <SoftnCreateForm disabled={isDemo} />
            : build === 'web' ? <WebAppStarter disabled={isDemo} /> : <form className="space-y-5" onSubmit={event => { event.preventDefault(); void create('form'); }}>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                  <div>
                    <label htmlFor="new-app-name" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
                      App name
                    </label>
                    <Input
                      id="new-app-name"
                      ref={nameField}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      placeholder="e.g. Workshop requests"
                      disabled={creating}
                      maxLength={120}
                    />
                  </div>
                  <div>
                    <label htmlFor="new-app-kind" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">App type</label>
                    <select id="new-app-kind" value={appKind} onChange={event => setAppKind(event.target.value as AppKind)} disabled={creating}
                      className="min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
                      <option value="internal">Internal tool</option><option value="client">Client portal</option>
                      <option value="public">Public intake</option><option value="custom">Custom app</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="new-app-desc" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
                    What is it for? <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
                  </label>
                  <Textarea
                    id="new-app-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What will people use this app for?"
                    rows={2}
                    disabled={creating}
                    className="min-h-16 resize-y"
                  />
                </div>
                <details className="group/privacy rounded-xl border border-slate-200 dark:border-slate-700">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-800 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
                    <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-slate-500 dark:text-slate-400" />
                    Form privacy
                    <span className="ml-auto text-right text-xs text-slate-600 dark:text-slate-300">{isDemo ? 'Browser-local' : formPrivacy === 'private' ? 'End-to-end encrypted' : 'Standard'}</span>
                    <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-slate-500 group-open/privacy:rotate-180" />
                  </summary>
                <fieldset className="border-t border-slate-200 p-3 dark:border-slate-700">
                  <legend className="sr-only">How should client data be protected?</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label
                      className={cn(
                        'relative flex cursor-pointer gap-3 rounded-xl border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary-500',
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
                        disabled={creating}
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
                      aria-disabled={isDemo || creating}
                      className={cn(
                        'relative flex gap-3 rounded-xl border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary-500',
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
                        disabled={isDemo || creating}
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
                            : 'New forms in the studio start as private forms. FormLogic stores ciphertext and cannot read client responses.'}
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>
                </details>
                {formPrivacy === 'private' && !isDemo && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    New forms stay private permanently. Unlock your vault to read their answers. Private forms
                    support text and other standard questions. File uploads, camera and linked records require standard forms.
                  </p>
                )}
                <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 @xl/create:flex-row @xl/create:items-center @xl/create:justify-end dark:border-slate-700">
                  <Button type="submit" className="@xl/create:order-last" isLoading={creating && destination === 'form'} disabled={creating || !name.trim()} rightIcon={<ArrowRight className="h-4 w-4" />}>
                    Create and add a form
                  </Button>
                  <Button type="button" variant="ghost" isLoading={creating && destination === 'studio'} disabled={creating || !name.trim()} onClick={() => void create('studio')}>
                    Create and open workspace
                  </Button>
                </div>
              </form>}
        </section>
        <div className="flex flex-wrap items-start justify-between gap-3 text-sm text-slate-600 @3xl/create:col-start-2 dark:text-slate-400">
          <Link to="/packs" className="inline-flex min-h-10 items-center gap-2 hover:underline"><Package className="size-4" />Browse the Marketplace</Link>
          {aiReady && !isDemo && <Link to="?type=chat" className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"><Sparkles className="size-4" />Create with AI</Link>}
          {ai && !aiReady && !isDemo && build !== 'upload' && <details className="group min-w-0 open:basis-full">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 hover:underline"><Sparkles className="size-4" />Connect AI</summary>
            <div className="mt-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700"><ConnectAiDoors onConnected={() => recheck(true)} />
              <Button className="mt-3" variant="secondary" onClick={() => void recheck()} isLoading={rechecking} leftIcon={<RefreshCw className="size-4" />}>Check connection</Button>
            </div>
          </details>}
        </div>
        </div>
      </div>}
      <VaultSetupWizard
        isOpen={showVaultSetup}
        onClose={() => setShowVaultSetup(false)}
        onComplete={() => void create(destination)}
      />
      <VaultUnlockDialog
        isOpen={showVaultUnlock}
        onClose={() => setShowVaultUnlock(false)}
        onUnlocked={() => void create(destination)}
        title="Unlock your vault to create this app"
      />
    </div>
  );
}

export default AppCreateStart;
