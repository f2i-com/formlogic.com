import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Globe, FileText, Plus, Share2, Sparkles, Layers, Plug } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { DEFAULT_APP_SETTINGS, KIND_LABELS } from '../../types/app';
import type { App, AppFormUsageApp, AppKind } from '../../types/app';

/** How the new app starts: brand new, over existing forms, or as a companion of another app. */
type WizardMode = 'fresh' | 'existing' | 'companion';

/** Server-side role-preset names — tune the NEW app's default system-role permissions. */
type RolePreset = 'admin-console' | 'client-portal' | 'staff-field-app' | 'public-intake';

/** Kind → role preset. internal/custom send no preset (the server's stock defaults apply). */
const KIND_ROLE_PRESET: Partial<Record<AppKind, RolePreset>> = {
  admin: 'admin-console',
  client: 'client-portal',
  staff: 'staff-field-app',
  public: 'public-intake',
};

/** One-line description per kind for the optional "What kind of app?" selector (T8). */
const KIND_OPTIONS: Array<{ kind: AppKind; desc: string }> = [
  { kind: 'admin', desc: 'See and manage everything across the app’s forms.' },
  { kind: 'client', desc: 'Customers submit requests and track their own.' },
  { kind: 'staff', desc: 'A day-to-day work app for your team.' },
  { kind: 'public', desc: 'A public-facing intake point — submit and go.' },
  { kind: 'internal', desc: 'A general-purpose tool for your own team.' },
  { kind: 'custom', desc: 'Anything else — no assumptions made.' },
];

const stepsForMode = (mode: WizardMode | null): string[] => {
  if (mode === 'companion') return ['Get started', 'Source app', 'Companion details', 'Review'];
  if (mode === 'existing') return ['Get started', 'App details', 'Select forms', 'Review'];
  // 'fresh' — also the preview shown before a mode is chosen.
  return ['Get started', 'App details', 'Review'];
};

/** What a candidate source app brings to a companion (dashboard + reports + logic). Form counts come
 *  from the owner-scoped app-forms endpoint (appFormsMap) — navConfig is NOT a reliable forms source. */
const appSummary = (app: App) => {
  const hasDashboard = app.customScreen?.kind === 'dashboard';
  const widgetCount = hasDashboard ? (app.customScreen?.dashboard?.widgets?.length ?? 0) : 0;
  const reportCount = app.reports?.length ?? 0;
  const hasLogic = (app.customLogic?.scripts?.length ?? 0) > 0;
  return { hasDashboard, widgetCount, reportCount, hasLogic };
};

export function AppCreateWizard() {
  const navigate = useNavigate();
  const { createApp, apps } = useAppStore();
  const { forms, createForm, setActiveForm, refreshForms } = useFormStore();
  const user = useAuthStore((s) => s.user);
  // The SAME store state that sizes the fixed Sidebar (w-16/w-64) and offsets the
  // shell's <main> (ml-16/ml-64) — the fixed wizard nav mirrors it so its content
  // column stays aligned with the page column in both sidebar states.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setFixedBottomBar = useUIStore((s) => s.setFixedBottomBar);

  // The wizard nav below is fixed — float the chat bubble / desktop chip above it.
  useEffect(() => {
    setFixedBottomBar(true);
    return () => setFixedBottomBar(false);
  }, [setFixedBottomBar]);

  // Refresh from the server so the selectable forms reflect reality (the
  // persisted store can be stale — missing forms made on another device, or
  // listing deleted ones).
  useEffect(() => {
    refreshForms();
  }, [refreshForms]);
  // Same for the apps slice — the companion picker must offer real, current apps.
  useEffect(() => {
    useAppStore.getState().fetchApps();
  }, []);
  const [isCreating, setIsCreating] = useState(false);
  const [showHandToAi, setShowHandToAi] = useState(false);

  // ONE batched request (GET /apps/form-usage) powers BOTH derived views below: the
  // "in <app>" share badges (formId → other-app names) and the companion picker's REAL
  // per-app form lists (appId → forms) — replacing the old getApps + per-app getAppForms
  // fan-out. Best-effort: on failure both views degrade to empty (the info is decorative).
  const [usageApps, setUsageApps] = useState<AppFormUsageApp[] | null>(null); // null = loading
  useEffect(() => {
    let cancelled = false;
    api.getAppsFormUsage()
      .then((res) => { if (!cancelled) setUsageApps(res.error ? [] : res.data?.apps ?? []); })
      .catch(() => { if (!cancelled) setUsageApps([]); });
    return () => { cancelled = true; };
  }, []);

  // formId → names of apps that already include the form. Picking one of these
  // SHARES it — the new app and the existing one(s) read and write the same data.
  const formAppUsage = useMemo(() => {
    const usage: Record<string, string[]> = {};
    for (const a of usageApps ?? []) {
      for (const f of a.forms) {
        if (!usage[f.formId]) usage[f.formId] = [];
        if (!usage[f.formId].includes(a.appName)) usage[f.formId].push(a.appName);
      }
    }
    return usage;
  }, [usageApps]);

  // Restore an in-progress draft (saved when the user bounced to the form builder
  // via "Create a Form") via lazy initializers — no setState-on-mount.
  const [draft] = useState<{ name?: string; description?: string; selectedFormIds?: string[]; mode?: string; appKind?: string }>(() => {
    try { return JSON.parse(sessionStorage.getItem('appWizardDraft') || '{}'); } catch { return {}; }
  });
  const [mode, setMode] = useState<WizardMode | null>(() =>
    draft.mode === 'fresh' || draft.mode === 'existing' || draft.mode === 'companion' ? draft.mode : null
  );
  // A draft only exists after the user bounced out mid-flow; drop them back past
  // the mode choice (and, for the existing-forms path, straight onto Select forms).
  const [step, setStep] = useState(() => {
    if (draft.mode === 'existing' && typeof draft.name === 'string' && draft.name.trim()) return 2;
    return draft.mode === 'fresh' || draft.mode === 'existing' || draft.mode === 'companion' ? 1 : 0;
  });
  const [name, setName] = useState<string>(typeof draft.name === 'string' ? draft.name : '');
  const [description, setDescription] = useState<string>(typeof draft.description === 'string' ? draft.description : '');
  const [selectedFormIds, setSelectedFormIds] = useState<string[]>(Array.isArray(draft.selectedFormIds) ? draft.selectedFormIds : []);
  const [nameError, setNameError] = useState<string | null>(null);
  // Optional portal type (T8): null = untyped (the default; nothing is sent). Companion apps
  // don't use this — the server types them 'admin' itself.
  const [appKind, setAppKind] = useState<AppKind | null>(() =>
    typeof draft.appKind === 'string' && draft.appKind in KIND_LABELS ? (draft.appKind as AppKind) : null
  );

  // ── Companion path state ──────────────────────────────────────────────────
  const [sourceAppId, setSourceAppId] = useState<string | null>(null);
  const [copyDashboard, setCopyDashboard] = useState(true);
  const [copyReports, setCopyReports] = useState(true);
  const [copyLogic, setCopyLogic] = useState(false); // custom code — opt-in
  // Prefill "<Source> Admin" without ever clobbering a name the user typed.
  const nameTouchedRef = useRef(false);
  const lastPrefillRef = useRef<string | null>(null);

  // Only apps the user owns can grow a companion — the server-authoritative canCreateCompanion
  // flag decides (the server enforces it; don't offer the rest). Fallback: a stale persisted
  // apps slice from an OLDER server build may predate the flag entirely — when NO app carries
  // it, fall back to the legacy ownerId heuristic so the wizard isn't bricked mid-deploy
  // (the fetchApps refresh above replaces the slice with flagged apps as soon as it lands).
  const hasCompanionFlag = apps.some((a) => a.canCreateCompanion !== undefined);
  const ownedApps = hasCompanionFlag
    ? apps.filter((a) => a.canCreateCompanion)
    : apps.filter((a) => !user?.id || !a.ownerId || a.ownerId === user.id);
  const sourceApp = sourceAppId ? apps.find((a) => a.id === sourceAppId) ?? null : null;

  // REAL form lists per app for the companion path. navConfig is NOT a reliable forms source
  // (pack-provisioned apps can have an empty/other-shaped navConfig, so counts showed 0) —
  // derived from the SAME single /apps/form-usage batch as the share badges above.
  // appId -> [{ formId, displayName }]; null while the batch is loading.
  const appFormsMap = useMemo(() => {
    if (usageApps === null) return null;
    const map: Record<string, { formId: string; displayName: string }[]> = {};
    for (const a of usageApps) {
      map[a.appId] = a.forms.map((f) => ({ formId: f.formId, displayName: f.displayName || 'Untitled' }));
    }
    return map;
  }, [usageApps]);
  /** Loaded form list for an app, or null while fetching. */
  const formsOf = (appId: string) => appFormsMap?.[appId] ?? null;
  const sourceSummary = sourceApp ? appSummary(sourceApp) : null;
  // Effective copy flags — a checkbox only counts when the source has something to copy.
  const effCopyDashboard = !!sourceSummary?.hasDashboard && copyDashboard;
  const effCopyReports = (sourceSummary?.reportCount ?? 0) > 0 && copyReports;
  const effCopyLogic = !!sourceSummary?.hasLogic && copyLogic;

  const steps = stepsForMode(mode);

  const chooseMode = (m: WizardMode) => {
    setMode(m);
    // Leaving the companion path with an untouched "<Source> Admin" prefill: clear it
    // so the details step doesn't open with a name that belongs to another flow.
    if (m !== 'companion' && !nameTouchedRef.current && name && name === lastPrefillRef.current) {
      setName('');
    }
    setStep(1);
  };

  const selectSource = (app: App) => {
    setSourceAppId(app.id);
    const prefill = `${app.name} Admin`;
    if (!nameTouchedRef.current || !name.trim() || name === lastPrefillRef.current) {
      setName(prefill);
      lastPrefillRef.current = prefill;
      setNameError(null);
    }
  };

  const detailsStep = mode === 'companion' ? 2 : 1; // the step that owns the name field
  const canNext =
    step === 0 ? mode !== null :
    mode === 'companion' && step === 1 ? !!sourceAppId :
    step === detailsStep ? name.trim().length > 0 :
    true;

  const validateName = () => {
    if (!name.trim()) {
      setNameError('App name is required');
      return false;
    }
    if (name.trim().length < 2) {
      setNameError('Name must be at least 2 characters');
      return false;
    }
    setNameError(null);
    return true;
  };

  const handleCreate = async () => {
    if (mode === 'companion') {
      await handleCreateCompanion();
      return;
    }
    setIsCreating(true);
    try {
      // Only the existing-forms path attaches forms; "Start fresh" adds them later.
      const formIds = mode === 'existing' ? selectedFormIds : [];
      // Local-only forms (drafted before this account was online) must exist server-side
      // before the atomic create validates ownership — the same best-effort sync the old
      // per-form attach loop did. "Already exists" is the normal, ignorable case.
      for (const formId of formIds) {
        const form = useFormStore.getState().forms.find((f) => f.id === formId);
        if (!form) continue;
        const syncResult = await api.createForm(form);
        if (syncResult.error && !syncResult.error.toLowerCase().includes('already exists')) {
          toast.error('Creation failed', syncResult.error);
          setIsCreating(false);
          return; // Stay on the review step.
        }
      }
      // ONE atomic request: the server creates the app and attaches every form inside a
      // single transaction — any invalid form rolls the WHOLE create back (no partial app,
      // unlike the old create-then-attach loop that could leave forms missing).
      // Optional kind (T8): settings.appKind is server-validated; the matching rolePreset
      // tunes the new app's default system-role permissions (internal/custom send none).
      // The payload rides through the store to api.createApp verbatim — a typed variable
      // (not a fresh literal) so the extra rolePreset key passes the store's signature.
      const rolePreset = appKind ? KIND_ROLE_PRESET[appKind] : undefined;
      const payload: Partial<App> & { formIds?: string[]; rolePreset?: RolePreset } = {
        name,
        description: description || undefined,
        ...(formIds.length > 0 ? { formIds } : {}),
        ...(appKind ? { settings: { ...DEFAULT_APP_SETTINGS, appKind } } : {}),
        ...(rolePreset ? { rolePreset } : {}),
      };
      const app = await createApp(payload);
      if (app) {
        try { sessionStorage.removeItem('appWizardDraft'); } catch { /* ignore */ }
        // Land in the App Studio — brand-new apps start at the Plan step.
        navigate(`/apps/${app.id}/studio`);
        return; // Skip setIsCreating after navigate
      }
      // Stay on the review step and surface the server's friendly message (captured by the store).
      toast.error('Creation failed', useAppStore.getState().error || 'Could not create the app. Please try again.');
    } catch {
      toast.error('Creation failed', 'An unexpected error occurred. Please try again.');
    }
    setIsCreating(false);
  };

  const handleCreateCompanion = async () => {
    if (!sourceApp) return;
    setIsCreating(true);
    try {
      const trimmed = name.trim();
      const result = await api.createCompanionApp(sourceApp.id, {
        name: trimmed || undefined,
        copyDashboard: effCopyDashboard,
        copyReports: effCopyReports,
        copyLogic: effCopyLogic,
        // Companions default to appKind 'admin' server-side — pair that with the matching role preset.
        rolePreset: 'admin-console',
      });
      const newApp = result.data?.app;
      if (result.error || !newApp?.id) {
        toast.error('Could not create companion app', typeof result.error === 'string' ? result.error : 'Please try again.');
        setIsCreating(false);
        return;
      }
      toast.success('Companion app created', `"${newApp.name || trimmed}" shares ${sourceApp.name}'s forms and data — members, roles and domains stay its own.`);
      // Refresh the apps slice so the new app exists in the store before we land on its settings.
      await useAppStore.getState().fetchApps();
      try { sessionStorage.removeItem('appWizardDraft'); } catch { /* ignore */ }
      navigate(`/apps/${newApp.id}/studio`);
      return; // Skip setIsCreating after navigate
    } catch {
      toast.error('Could not create companion app', 'An unexpected error occurred. Please try again.');
    }
    setIsCreating(false);
  };

  const toggleForm = (formId: string) => {
    setSelectedFormIds((prev) =>
      prev.includes(formId) ? prev.filter((id) => id !== formId) : [...prev, formId]
    );
  };

  const modeCards: Array<{ id: WizardMode; icon: typeof Sparkles; title: string; body: string }> = [
    {
      id: 'fresh',
      icon: Sparkles,
      title: 'Start fresh',
      body: 'A brand-new app with its own forms.',
    },
    {
      id: 'existing',
      icon: FileText,
      title: 'Use existing forms',
      body: 'Build on forms you already have — apps share their data.',
    },
    {
      id: 'companion',
      icon: Layers,
      title: 'Companion',
      body: 'A second app, like an admin console, over another app’s data.',
    },
  ];

  return (
    <div className="min-h-screen">
      <Header
        title="Create New App"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-2xl mx-auto">

      {/* Step indicator — numbers-only below sm (labels are hidden sm:inline) so four
          steps never overflow a 375px screen */}
      <div className="flex items-center mb-6 sm:mb-8">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center flex-1 last:flex-none min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className={cn(
                'w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-medium transition-all',
                i < step ? 'bg-primary-600 text-primary-foreground shadow-sm' :
                i === step ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-400 ring-2 ring-primary-600' :
                'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500'
              )}>
                {i < step ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span className={cn('text-sm hidden sm:inline truncate', i === step ? 'text-gray-900 dark:text-white font-medium' : i < step ? 'text-gray-600 dark:text-slate-300' : 'text-gray-400 dark:text-slate-500')}>{label}</span>
            </div>
            {i < steps.length - 1 && <div className={cn('flex-1 h-px mx-2 sm:mx-3', i < step ? 'bg-primary-400' : 'bg-gray-200 dark:bg-slate-700')} />}
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4 sm:p-6">
        {/* Step 0 — mode choice */}
        {step === 0 && (
          <div>
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">How do you want to start?</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {modeCards.map(({ id, icon: Icon, title, body }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => chooseMode(id)}
                  className={cn(
                    // flex-col + justify-start: grid rows stretch the buttons to equal height, and a
                    // button's default vertical centering would float shorter cards' content lower —
                    // pinning content to the top keeps every icon/title/body aligned across cards.
                    'flex h-full min-h-32 flex-col justify-start items-stretch text-left p-4 rounded-xl border transition-all duration-200 cursor-pointer',
                    mode === id
                      ? 'border-primary-300 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10'
                      : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                  )}
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className="w-9 h-9 shrink-0 rounded-lg bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center text-primary-600 dark:text-primary-400">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="text-sm font-medium text-gray-900 dark:text-white leading-snug">{title}</div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{body}</p>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowHandToAi(true)}
                className="flex h-full min-h-32 flex-col items-stretch justify-start rounded-xl border border-gray-200 p-4 text-left transition-all duration-200 cursor-pointer hover:bg-gray-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <div className="mb-2 flex items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                    <Plug className="h-4 w-4" />
                  </div>
                  <div className="text-sm font-medium leading-snug text-gray-900 dark:text-white">Connect an AI</div>
                </div>
                <p className="text-xs text-gray-500 dark:text-slate-400">Let your AI create the app with a secure connection.</p>
              </button>
            </div>
          </div>
        )}

        {/* Details step — fresh + existing */}
        {step === 1 && mode !== 'companion' && (
          <div className="space-y-4">
            <Input
              label="App Name *"
              type="text"
              value={name}
              onChange={(e) => { nameTouchedRef.current = true; setName(e.target.value); if (nameError) setNameError(null); }}
              onBlur={validateName}
              placeholder="My Application"
              error={nameError ?? undefined}
              autoFocus
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this app do?"
              rows={3}
            />

            {/* Optional portal type (T8) — quiet, never a blocker. Click a selected card to unpick it. */}
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-slate-300">
                What kind of app is this? <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
              </p>
              <p className="text-xs text-gray-400 dark:text-slate-400 mt-0.5 mb-2">
                Tunes starting permissions and suggests a dashboard — everything stays editable.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {KIND_OPTIONS.map(({ kind: k, desc }) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={appKind === k}
                    onClick={() => setAppKind(appKind === k ? null : k)}
                    className={cn(
                      'rounded-xl border p-2.5 text-left transition-colors cursor-pointer',
                      appKind === k
                        ? 'border-primary-300 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10'
                        : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                    )}
                  >
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">{KIND_LABELS[k]}</span>
                    <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === 'fresh' && (
              <p className="text-xs text-gray-400 dark:text-slate-400">You'll add forms after the app is created — build new ones or attach existing forms any time.</p>
            )}
          </div>
        )}

        {/* Select forms — existing-forms path */}
        {step === 2 && mode === 'existing' && (
          <div>
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Select forms to include in your app. You can add more later. Attaching a form SHARES it and its existing responses with any app it's already in — both apps read and write the same data.</p>
            {forms.length === 0 ? (
              <div className="text-center py-8">
                <FileText className="h-8 w-8 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                <p className="text-gray-400 dark:text-slate-400 mb-4">No forms available yet.</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    // Stash the wizard draft so it's restored when the user returns.
                    try { sessionStorage.setItem('appWizardDraft', JSON.stringify({ name, description, selectedFormIds, mode, appKind: appKind ?? undefined })); } catch { /* ignore */ }
                    const form = await createForm('Untitled Form');
                    if (!form) return;
                    setActiveForm(form.id);
                    navigate(`/builder/${form.id}`);
                  }}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Create a Form
                </Button>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {forms.map((form) => (
                  <label
                    key={form.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200',
                      selectedFormIds.includes(form.id)
                        ? 'border-primary-300 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10'
                        : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedFormIds.includes(form.id)}
                      onChange={() => toggleForm(form.id)}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 break-words text-sm font-medium text-gray-900 dark:text-white">{form.title}</span>
                        {(formAppUsage[form.id]?.length ?? 0) > 0 && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                            title={`Already used by ${formAppUsage[form.id].join(', ')}. Adding it here shares the form and its existing responses — both apps read and write the same data.`}
                          >
                            <Share2 className="h-3 w-3" />
                            {formAppUsage[form.id].length === 1 ? `in ${formAppUsage[form.id][0]}` : `in ${formAppUsage[form.id].length} apps`}
                          </span>
                        )}
                      </div>
                      {form.description && <p className="text-xs text-gray-500 dark:text-slate-400">{form.description}</p>}
                    </div>
                    <span className={cn('ml-auto flex-shrink-0 text-xs px-2 py-0.5 rounded-full', form.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400')}>
                      {form.status}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Source app — companion path */}
        {step === 1 && mode === 'companion' && (
          <div>
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Pick the app to build a companion for. The companion shares ALL of its forms and their responses — both apps read and write the same data.</p>
            {ownedApps.length === 0 ? (
              <div className="text-center py-8">
                <Layers className="h-8 w-8 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                <p className="text-gray-400 dark:text-slate-400 mb-1">You don't own an app yet.</p>
                <p className="text-sm text-gray-400 dark:text-slate-500 mb-4">A companion is a second app over an existing app's forms and data — create your first app with "Start fresh" or "Use existing forms".</p>
                <Button size="sm" variant="outline" onClick={() => chooseMode('fresh')} leftIcon={<Sparkles className="h-4 w-4" />}>
                  Start fresh instead
                </Button>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {ownedApps.map((app) => {
                  const s = appSummary(app);
                  return (
                    <label
                      key={app.id}
                      className={cn(
                        'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200',
                        sourceAppId === app.id
                          ? 'border-primary-300 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10'
                          : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                      )}
                    >
                      <input
                        type="radio"
                        name="companionSource"
                        checked={sourceAppId === app.id}
                        onChange={() => selectSource(app)}
                        className="mt-1 border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="min-w-0 break-words text-sm font-medium text-gray-900 dark:text-white">{app.name}</span>
                          <span className={cn('text-xs px-2 py-0.5 rounded-full capitalize', app.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400')}>
                            {app.status}
                          </span>
                        </div>
                        {app.description && <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{app.description}</p>}
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                          {formsOf(app.id)?.length ?? app.formCount ?? '…'} form{(formsOf(app.id)?.length ?? app.formCount) === 1 ? '' : 's'}
                          {' · '}{s.hasDashboard ? `dashboard (${s.widgetCount} widget${s.widgetCount === 1 ? '' : 's'})` : 'no dashboard'}
                          {' · '}{s.reportCount} saved report{s.reportCount === 1 ? '' : 's'}
                          {s.hasLogic ? ' · custom logic' : ''}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Companion details — name + what's shared + copy options */}
        {step === 2 && mode === 'companion' && sourceApp && sourceSummary && (
          <div className="space-y-4">
            <Input
              label="Companion App Name *"
              type="text"
              value={name}
              onChange={(e) => { nameTouchedRef.current = true; setName(e.target.value); if (nameError) setNameError(null); }}
              onBlur={validateName}
              placeholder={`${sourceApp.name} Admin`}
              error={nameError ?? undefined}
              autoFocus
            />

            {/* Fixed kind hint — the server types companions as 'admin' itself; nothing is sent. */}
            <p className="text-xs text-gray-400 dark:text-slate-400">
              Companions start typed as an <span className="font-medium text-gray-500 dark:text-slate-300">{KIND_LABELS.admin}</span> — a manage-everything view over the shared forms.
            </p>

            {/* What's shared */}
            <div className="p-3 rounded-xl bg-violet-50 dark:bg-violet-500/10 border border-violet-100 dark:border-violet-500/20">
              <p className="text-xs font-medium text-violet-700 dark:text-violet-300 flex items-center gap-1.5 mb-1">
                <Share2 className="h-3.5 w-3.5" />
                Shared with {sourceApp.name}
              </p>
              <p className="text-xs text-violet-600/90 dark:text-violet-400/90">
                {formsOf(sourceApp.id) === null
                  ? 'All of its forms — and every response, past and future. Both apps read and write the same data.'
                  : `All ${formsOf(sourceApp.id)!.length} form${formsOf(sourceApp.id)!.length === 1 ? '' : 's'} — and every response, past and future. Both apps read and write the same data.`}
              </p>
              {(formsOf(sourceApp.id)?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {formsOf(sourceApp.id)!.slice(0, 8).map((item) => (
                    <span key={item.formId} className="px-1.5 py-0.5 rounded text-xs bg-white/70 dark:bg-slate-900/40 text-violet-700 dark:text-violet-300">{item.displayName}</span>
                  ))}
                  {formsOf(sourceApp.id)!.length > 8 && (
                    <span className="px-1.5 py-0.5 text-xs text-violet-600 dark:text-violet-400">+{formsOf(sourceApp.id)!.length - 8} more</span>
                  )}
                </div>
              )}
            </div>

            {/* Copy options */}
            <div className="space-y-2">
              <label className={cn('flex items-start gap-3 p-3 rounded-xl border border-gray-200 dark:border-slate-700 transition-colors', sourceSummary.hasDashboard ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800' : 'opacity-60 cursor-not-allowed')}>
                <input
                  type="checkbox"
                  checked={effCopyDashboard}
                  disabled={!sourceSummary.hasDashboard}
                  onChange={() => setCopyDashboard((v) => !v)}
                  className="mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50"
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">Copy dashboard</span>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {sourceSummary.hasDashboard
                      ? `Start from a copy of ${sourceApp.name}'s dashboard (${sourceSummary.widgetCount} widget${sourceSummary.widgetCount === 1 ? '' : 's'}). Its widgets keep working — they read the same shared forms.`
                      : `${sourceApp.name} has no dashboard to copy.`}
                  </p>
                </div>
              </label>

              <label className={cn('flex items-start gap-3 p-3 rounded-xl border border-gray-200 dark:border-slate-700 transition-colors', sourceSummary.reportCount > 0 ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800' : 'opacity-60 cursor-not-allowed')}>
                <input
                  type="checkbox"
                  checked={effCopyReports}
                  disabled={sourceSummary.reportCount === 0}
                  onChange={() => setCopyReports((v) => !v)}
                  className="mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50"
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">Copy saved reports</span>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {sourceSummary.reportCount > 0
                      ? `Copies ${sourceSummary.reportCount} saved report${sourceSummary.reportCount === 1 ? '' : 's'} and document${sourceSummary.reportCount === 1 ? '' : 's'} — they run over the shared data.`
                      : `${sourceApp.name} has no saved reports to copy.`}
                  </p>
                </div>
              </label>

              <label className={cn('flex items-start gap-3 p-3 rounded-xl border border-gray-200 dark:border-slate-700 transition-colors', sourceSummary.hasLogic ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800' : 'opacity-60 cursor-not-allowed')}>
                <input
                  type="checkbox"
                  checked={effCopyLogic}
                  disabled={!sourceSummary.hasLogic}
                  onChange={() => setCopyLogic((v) => !v)}
                  className="mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50"
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">Copy app logic (custom code)</span>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {sourceSummary.hasLogic
                      ? 'Each app runs its OWN app-level custom logic and custom screens — copying gives this app an independent copy to edit. Form-level logic and the forms’ fields are shared with the data.'
                      : `${sourceApp.name} has no app-level custom logic to copy.`}
                  </p>
                </div>
              </label>
            </div>

            <p className="text-xs text-gray-400 dark:text-slate-400">Members, roles, custom domains and publishing status are NOT copied — the companion starts as a draft with fresh system roles.</p>
          </div>
        )}

        {/* Review — fresh + existing */}
        {step === steps.length - 1 && mode !== 'companion' && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-slate-800 rounded-xl">
              <Globe className="h-10 w-10 flex-shrink-0 text-primary-600 dark:text-primary-400" />
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900 dark:text-white tracking-tight break-words">{name}</h3>
                {description && <p className="text-sm text-gray-500 dark:text-slate-400">{description}</p>}
              </div>
            </div>
            {mode === 'existing' ? (
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Included Forms ({selectedFormIds.length})</h4>
                {selectedFormIds.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-slate-400">No forms selected</p>
                ) : (
                  <ul className="space-y-1">
                    {selectedFormIds.map((id) => {
                      const form = forms.find((f) => f.id === id);
                      return form ? (
                        <li key={id} className="text-sm text-gray-600 dark:text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary-500" />
                          {form.title}
                          {(formAppUsage[id]?.length ?? 0) > 0 && (
                            <span className="text-xs text-violet-600 dark:text-violet-400" title="Both apps read and write the same data.">shared with {formAppUsage[id].join(', ')}</span>
                          )}
                        </li>
                      ) : null;
                    })}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-slate-400">No forms yet — you'll build or attach them after the app is created.</p>
            )}
            {appKind && (
              <p className="text-sm text-gray-600 dark:text-slate-300">
                App type: <span className="font-medium text-gray-900 dark:text-white">{KIND_LABELS[appKind]}</span>
                {KIND_ROLE_PRESET[appKind] ? ' — starting role permissions tuned to match.' : ''}
              </p>
            )}
            <p className="text-xs text-gray-400 dark:text-slate-400">Default roles (Owner, Admin, Member) will be created automatically.</p>
          </div>
        )}

        {/* Review — companion */}
        {step === 3 && mode === 'companion' && sourceApp && sourceSummary && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-slate-800 rounded-xl">
              <Layers className="h-10 w-10 flex-shrink-0 text-primary-600 dark:text-primary-400" />
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900 dark:text-white tracking-tight break-words">{name}</h3>
                <p className="text-sm text-gray-500 dark:text-slate-400">Companion of {sourceApp.name}</p>
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Shared with {sourceApp.name}</h4>
              <p className="text-sm text-gray-600 dark:text-slate-300 flex items-start gap-2">
                <Share2 className="h-4 w-4 mt-0.5 flex-shrink-0 text-violet-500 dark:text-violet-400" />
                <span>
                  {formsOf(sourceApp.id) === null
                    ? 'All of its forms and every response — both apps read and write the same data.'
                    : `All ${formsOf(sourceApp.id)!.length} form${formsOf(sourceApp.id)!.length === 1 ? '' : 's'} and every response — both apps read and write the same data.`}
                </span>
              </p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Copied into the companion</h4>
              <ul className="space-y-1">
                <li className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
                  <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', effCopyDashboard ? 'bg-primary-500' : 'bg-gray-300 dark:bg-slate-600')} />
                  {effCopyDashboard ? `Dashboard (${sourceSummary.widgetCount} widget${sourceSummary.widgetCount === 1 ? '' : 's'})` : 'Dashboard — not copied'}
                </li>
                <li className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
                  <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', effCopyReports ? 'bg-primary-500' : 'bg-gray-300 dark:bg-slate-600')} />
                  {effCopyReports ? `${sourceSummary.reportCount} saved report${sourceSummary.reportCount === 1 ? '' : 's'}` : 'Saved reports — not copied'}
                </li>
                <li className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
                  <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', effCopyLogic ? 'bg-primary-500' : 'bg-gray-300 dark:bg-slate-600')} />
                  {effCopyLogic ? 'App logic (custom code) — the companion gets its own copy to edit' : 'App logic (custom code) — not copied; each app runs its own'}
                </li>
                <li className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />
                  Theme and navigation
                </li>
              </ul>
            </div>
            <p className="text-xs text-gray-400 dark:text-slate-400">Members, roles and custom domains stay separate; the companion starts as a draft with fresh system roles (Owner, Admin, Member).</p>
          </div>
        )}
      </div>

      {/* Clearance spacer — the wizard nav below is FIXED (out of flow), so the last
          in-flow controls need explicit room to scroll clear of it. Below md the shell's
          main already pads 5rem+safe-area for the MobileNav; the bar adds ~4rem on top,
          and h-12 (+ the wrapper's own p-4) covers it with ~1rem to spare. At md+ only
          the ~4rem+safe-area bar overlays, cleared by 3.5rem+safe-area + sm:p-6/lg:p-8. */}
      <div aria-hidden className="h-12 md:h-[calc(3.5rem+env(safe-area-inset-bottom))]" />
    </div>
    </div>

      {/* Wizard nav — FIXED to the viewport so Back / Next / Create can NEVER be moved
          by scrolling (sticky detached at its flow position: the shell's mobile bottom
          padding sat below it, so at full scroll the bar rode up; rubber-band overscroll
          moved it too). No ancestor creates a fixed containing block (no transform /
          filter / backdrop-filter / contain anywhere above — main's overflow-x-clip
          doesn't re-root fixed), so this pins to the true viewport, exactly like the
          MobileNav itself. Below md it sits flush on top of the fixed MobileNav
          (h-16 + safe-area); at md+ it pins to the bottom with its own safe-area
          padding and starts at the sidebar's right edge — mirroring main's ml-16/ml-64
          from the same uiStore state, with the same 300ms collapse transition. The
          inner wrappers replicate main's content gutters (px-4/sm:px-6/lg:px-8) and
          the wizard's max-w-2xl column so the buttons align with the page content.
          z-20: above step content, below the sidebar (z-40), MobileNav (z-50) and
          modal/toast layers. */}
      <div
        className={cn(
          'fixed left-0 right-0 z-20 bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-0',
          sidebarCollapsed ? 'md:left-16' : 'md:left-64',
          'transition-all duration-300',
          'pt-3 pb-3 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
          'bg-white/95 dark:bg-slate-900/70 backdrop-blur-xl border-t border-gray-200/60 dark:border-white/[0.06]'
        )}
      >
        <div className="px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
              leftIcon={<ArrowLeft className="h-4 w-4" />}
            >
              Back
            </Button>

            {step < steps.length - 1 ? (
              <Button
                onClick={() => { if (step === detailsStep && !validateName()) return; setStep(step + 1); }}
                disabled={!canNext}
                rightIcon={<ArrowRight className="h-4 w-4" />}
              >
                Next
              </Button>
            ) : (
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? 'Creating...' : mode === 'companion' ? 'Create Companion App' : 'Create App'}
              </Button>
            )}
          </div>
        </div>
      </div>
      <ConnectAiModal isOpen={showHandToAi} onClose={() => { setShowHandToAi(false); void useAppStore.getState().fetchApps(); }} creator />
    </div>
  );
}
