import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Compass, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StudioTopBar } from '../../components/studio/StudioTopBar';
import { StudioRail } from '../../components/studio/StudioRail';
import { StudioCommandPalette } from '../../components/studio/StudioCommandPalette';
import { useStudioData } from '../../components/studio/useStudioData';
import {
  STUDIO_STEPS,
  computeUnpublishedChanges,
  deriveCompletedSteps,
  deriveNextAction,
  isStudioStep,
  type StudioStepId,
} from '../../components/studio/studioSteps';
import { useStudioSaveState } from '../../components/studio/studioSaveState';
import { PlanStep } from '../../components/studio/steps/PlanStep';
import { DataStep } from '../../components/studio/steps/DataStep';
import { ScreensStep } from '../../components/studio/steps/ScreensStep';
import { AutomationsStep } from '../../components/studio/steps/AutomationsStep';
import { AccessStep } from '../../components/studio/steps/AccessStep';
import { PublishStep } from '../../components/studio/steps/PublishStep';
import { useUIStore } from '../../stores/uiStore';
import { returnToState } from '../../hooks/useReturnTo';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { cn } from '../../lib/utils';
import { isDemoLocalId } from '../../lib/demoLocal';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../../hooks/useKeyboardShortcuts';

/** Per-step chat seeds (recommendation #8) — shown only when a default AI can run. */
const STEP_PROMPTS: Record<StudioStepId, string[]> = {
  plan: ['Plan this app for me', 'Sketch this app as a diagram', 'What would make this app more useful?'],
  data: ['Add the data types this app needs', 'Create relationships between my data types', 'Improve the fields on my forms'],
  screens: ['Design a dashboard home screen', 'Which screen should members land on?', 'Simplify the navigation'],
  automations: ['Notify me when a record is submitted', 'Add an approval process', 'What automations would help here?'],
  access: ['What roles should this app have?', 'How do permissions work here?'],
  publish: ['Is this app ready to publish?', 'What should I check before going live?'],
};

/**
 * The App Studio (app-first redesign): one workspace per app with a top bar
 * (Use app / Edit app), a six-step prefilled, skippable builder — Plan, Data,
 * Screens, Automations, Access, Publish — and a footer step navigator.
 * Everything reads and writes the real app APIs; deep surfaces (form builder,
 * flow canvas, diagram, studios) open from their steps.
 */
export function AppStudio() {
  const { appId, step: stepParam } = useParams<{ appId: string; step?: string }>();
  const navigate = useNavigate();
  const data = useStudioData(appId);
  const { isMobile, sidebarCollapsed } = useUIStore();
  const chatDockedVisible = useUIStore((s) => s.chatDocked && s.chatOpen && !s.chatMinimized);
  const setFixedBottomBar = useUIStore((s) => s.setFixedBottomBar);
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const askAi = (prompt: string) => {
    setChatSeed(prompt);
    setChatMinimized(false);
    setChatOpen(true);
  };

  const activeStep: StudioStepId = isStudioStep(stepParam) ? stepParam : 'data';

  // The footer step navigator is fixed — float the chat bubble / desktop chip
  // above it while the studio is mounted.
  useEffect(() => {
    setFixedBottomBar(true);
    return () => setFixedBottomBar(false);
  }, [setFixedBottomBar]);

  // The save indicator starts clean per app — one app's failure must not haunt
  // the next one's top bar.
  useEffect(() => {
    useStudioSaveState.getState().reset();
    return () => useStudioSaveState.getState().reset();
  }, [appId]);

  // With no usable default AI, the studio drops its AI affordances ("Ask AI",
  // "Plan with AI") — building manually shouldn't advertise a copilot that
  // would refuse on first use (audit FL-23 readiness, same as CreateBand).
  const [aiAvailable, setAiAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness().then(
      (res) => { if (!cancelled) setAiAvailable(res.ready); },
      () => { if (!cancelled) setAiAvailable(false); }
    );
    return () => { cancelled = true; };
  }, []);

  // /studio (no step) → the natural entry: brand-new apps start at Plan,
  // existing apps at Data.
  useEffect(() => {
    if (!appId || stepParam !== undefined || data.loading) return;
    const target = data.appForms.length === 0 ? 'plan' : 'data';
    navigate(`/apps/${appId}/studio/${target}`, { replace: true });
  }, [appId, stepParam, data.loading, data.appForms.length, navigate]);

  const completedSteps = useMemo(
    () =>
      deriveCompletedSteps({
        formCount: data.appForms.length,
        hasBlueprint: data.blueprint !== null,
        hasHomeScreen: !!(data.app?.customScreen as { kind?: string } | undefined)?.kind,
        flowCount: data.flows.length,
        roleCount: data.roles.length,
        published: data.app?.status === 'published',
      }),
    [data.appForms.length, data.blueprint, data.app, data.flows.length, data.roles.length]
  );

  const changes = useMemo(() => {
    if (!data.app) return { everPublished: false, count: 0, changed: [] };
    return computeUnpublishedChanges(
      data.app,
      data.appForms
        .map((af) => data.formsById[af.formId])
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ id: f.id, title: f.title, updatedAt: f.updatedAt })),
      data.flows.map((f) => ({ id: f.id, name: f.name, updatedAt: f.updatedAt }))
    );
  }, [data.app, data.appForms, data.formsById, data.flows]);

  const setStep = useCallback((step: StudioStepId) => {
    if (appId) navigate(`/apps/${appId}/studio/${step}`);
  }, [appId, navigate]);

  const activeIndex = STUDIO_STEPS.findIndex((s) => s.id === activeStep);
  const previous = STUDIO_STEPS[activeIndex - 1]?.id;
  const next = STUDIO_STEPS[activeIndex + 1]?.id;
  const openPreview = useCallback(() => {
    if (!data.app) return;
    navigate(`/app/${data.app.slug}`, {
      state: returnToState(`/apps/${appId}/studio/${activeStep}`, 'App Studio'),
    });
  }, [activeStep, appId, data.app, navigate]);
  const openContextualChat = useCallback(() => {
    setChatMinimized(false);
    setChatOpen(true);
  }, [setChatMinimized, setChatOpen]);

  const shortcuts = useMemo<KeyboardShortcut[]>(() => [
    {
      key: 'k',
      ctrl: true,
      description: 'Search App Studio',
      action: () => setCommandPaletteOpen(true),
    },
    {
      key: 'Enter',
      ctrl: true,
      description: 'Continue to the next Studio step',
      action: () => {
        if (next) setStep(next);
        else openPreview();
      },
    },
    {
      key: 'p',
      ctrl: true,
      shift: true,
      description: 'Open Review & publish',
      action: () => setStep('publish'),
    },
    {
      key: 'p',
      ctrl: true,
      description: 'Preview app',
      action: openPreview,
    },
    {
      key: '/',
      description: 'Search App Studio',
      action: () => setCommandPaletteOpen(true),
    },
    ...STUDIO_STEPS.map<KeyboardShortcut>((step, index) => ({
      key: String(index + 1),
      alt: true,
      description: `Open ${step.label}`,
      action: () => setStep(step.id),
    })),
  ], [next, openPreview, setStep]);
  useKeyboardShortcuts({ shortcuts, enabled: !!data.app });

  // ONE recommended next action (recommendation #1) — where the rail says
  // "you are here", this says "this matters next". Null = the app is in good
  // shape and the card stays out of the way.
  const nextAction = useMemo(() => {
    if (!data.app || data.loading) return null;
    return deriveNextAction({
      formCount: data.appForms.length,
      fieldlessFormNames: data.appForms
        .filter((af) => (data.formsById[af.formId]?.fields.length ?? 1) === 0)
        .map((af) => af.displayName || data.formsById[af.formId]?.title || 'Untitled'),
      flowCount: data.flows.length,
      // Browser-only demo apps cannot send real invitations, so do not point
      // their next-action card at an unavailable cloud operation.
      memberCount: isDemoLocalId(data.app.id) ? 2 : data.memberCount,
      published: data.app.status === 'published',
      unpublishedCount: changes.everPublished ? changes.count : 0,
    });
  }, [data.app, data.loading, data.appForms, data.formsById, data.flows.length, data.memberCount, changes]);

  if (!appId) return <Navigate to="/apps" replace />;

  if (data.appLoaded && !data.app) {
    return (
      <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
        <p className="text-lg font-medium text-gray-700 dark:text-slate-300">App not found</p>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">It may have been deleted, or you don't have access.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/apps')}>Back to apps</Button>
      </div>
    );
  }

  if (!data.app) {
    return (
      <div className="flex items-center justify-center py-32" role="status" aria-label="Loading App Studio">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  // Members without manage rights use the app, they don't edit it (ownerId is
  // stripped from non-owner reads, so its absence is the capability signal).
  if (!data.app.ownerId) {
    return <Navigate to={`/app/${data.app.slug}`} replace />;
  }

  const active = STUDIO_STEPS[activeIndex];

  return (
    <div className="min-h-screen">
      <StudioTopBar
        app={data.app}
        changes={changes}
        aiAvailable={aiAvailable}
        onOpenPublish={() => setStep('publish')}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      />
      <StudioRail activeStep={activeStep} completedSteps={completedSteps} onStepChange={setStep} />

      {commandPaletteOpen && (
        <StudioCommandPalette
          app={data.app}
          appForms={data.appForms}
          formsById={data.formsById}
          flows={data.flows}
          roles={data.roles}
          activeStep={activeStep}
          aiAvailable={aiAvailable}
          onClose={() => setCommandPaletteOpen(false)}
          onStepChange={setStep}
          onPreview={openPreview}
          onPublish={() => setStep('publish')}
          onAskAi={openContextualChat}
        />
      )}

      <main className="mx-auto max-w-[1540px] p-4 pb-28 sm:p-6 sm:pb-28 lg:p-7 lg:pb-28">
        <div className="mb-5 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400 dark:text-slate-500">
              App Studio · Step {activeIndex + 1} of {STUDIO_STEPS.length}
              {active.optional && <span className="rounded-full border border-gray-200 dark:border-white/10 px-2 py-0.5">Optional</span>}
              {completedSteps.includes(activeStep) && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 dark:border-emerald-400/20 bg-emerald-50 dark:bg-emerald-400/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-300">
                  <Check className="h-3 w-3" /> Configured
                </span>
              )}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{active.label}</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{active.description}</p>
            {/* Studio-aware prompt chips (recommendation #8): teach capability in place. */}
            {aiAvailable && STEP_PROMPTS[activeStep].length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" aria-hidden="true" />
                {STEP_PROMPTS[activeStep].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => askAi(prompt)}
                    className="cursor-pointer rounded-full border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-gray-600 dark:text-slate-300 transition hover:border-primary-300 hover:text-primary-700 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ONE recommended next action (recommendation #1). */}
          {nextAction && nextAction.step !== activeStep && (
            <div className="grid w-full flex-none grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-primary-200/70 dark:border-primary-500/20 bg-primary-50/60 dark:bg-primary-500/[0.07] px-3.5 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] lg:w-auto lg:max-w-md">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-primary-foreground">
                <Compass className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary-600/80 dark:text-primary-300/80">Next recommended step</p>
                <p className="truncate text-xs font-semibold text-gray-900 dark:text-white" title={nextAction.title}>{nextAction.title}</p>
                <p className="mt-0.5 hidden text-[11px] leading-4 text-gray-500 dark:text-slate-400 sm:line-clamp-1">{nextAction.detail}</p>
              </div>
              <Button size="sm" variant="secondary" className="col-span-2 w-full shrink-0 sm:col-span-1 sm:w-auto" onClick={() => setStep(nextAction.step)}>
                {nextAction.cta}
              </Button>
            </div>
          )}
        </div>

        {activeStep === 'plan' && (
          <PlanStep
            app={data.app}
            blueprint={data.blueprint}
            appForms={data.appForms}
            formsById={data.formsById}
            roles={data.roles}
            aiAvailable={aiAvailable}
            onSkip={() => setStep('data')}
          />
        )}
        {activeStep === 'data' && (
          <DataStep app={data.app} appForms={data.appForms} formsById={data.formsById} onReloadForms={data.reloadForms} />
        )}
        {activeStep === 'screens' && (
          <ScreensStep
            app={data.app}
            appForms={data.appForms}
            formsById={data.formsById}
            roles={data.roles}
            changes={changes}
            onReloadApp={data.reloadApp}
            onReloadForms={data.reloadForms}
            onOpenPublish={() => setStep('publish')}
          />
        )}
        {activeStep === 'automations' && (
          <AutomationsStep
            app={data.app}
            flows={data.flows}
            bindings={data.bindings}
            appForms={data.appForms}
            formsById={data.formsById}
            onReloadFlows={data.reloadFlows}
          />
        )}
        {activeStep === 'access' && (
          <AccessStep
            app={data.app}
            roles={data.roles}
            appForms={data.appForms}
            formsById={data.formsById}
            onReloadAux={data.reload}
            onReloadApp={data.reloadApp}
          />
        )}
        {activeStep === 'publish' && (
          <PublishStep
            app={data.app}
            appForms={data.appForms}
            formsById={data.formsById}
            flows={data.flows}
            roles={data.roles}
            domains={data.domains}
            versions={data.versions}
            memberCount={data.memberCount}
            changes={changes}
            onStepChange={setStep}
            onPublished={data.reload}
          />
        )}
      </main>

      {/* Footer step navigator */}
      <div
        className={cn(
          'fixed inset-x-0 z-30 border-t border-gray-200/80 dark:border-white/[0.08] bg-white/92 dark:bg-slate-900/92 px-4 py-3 backdrop-blur-xl shadow-[0_-8px_30px_rgba(15,23,42,0.06)] dark:shadow-black/20',
          isMobile ? 'bottom-[calc(4rem+env(safe-area-inset-bottom))]' : 'bottom-0',
          !isMobile && (sidebarCollapsed ? 'left-16' : 'left-64'),
          !isMobile && chatDockedVisible && 'right-96'
        )}
      >
        <div className="mx-auto flex max-w-[1540px] items-center justify-between gap-3">
          <Button
            variant="secondary"
            disabled={!previous}
            onClick={() => previous && setStep(previous)}
            leftIcon={<ArrowLeft className="h-4 w-4" />}
          >
            <span className="hidden sm:inline">Previous</span>
            <span className="sm:hidden">Back</span>
          </Button>
          <div className="hidden text-center sm:block">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">Saved automatically</p>
            <p className="mt-0.5 text-xs font-medium text-gray-600 dark:text-slate-300">
              Move freely — every step is prefilled and editable
            </p>
          </div>
          {next ? (
            <Button onClick={() => setStep(next)}>
              Continue to {STUDIO_STEPS[activeIndex + 1].shortLabel}
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={openPreview}
              leftIcon={<Check className="h-4 w-4" />}
            >
              Open the app
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AppStudio;
