import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Compass, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StudioTopBar } from '../../components/studio/StudioTopBar';
import { StudioRail } from '../../components/studio/StudioRail';
import { StudioCommandPalette } from '../../components/studio/StudioCommandPalette';
import { useStudioData } from '../../components/studio/useStudioData';
import {
  STUDIO_STEPS,
  computeUnpublishedChanges,
  deriveNextAction,
  deriveSectionBadges,
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
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { returnToState } from '../../hooks/useReturnTo';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { isDemoLocalId } from '../../lib/demoLocal';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../../hooks/useKeyboardShortcuts';

/** One suggestion per section, offered only when a default AI can actually run. */
const STEP_PROMPTS: Record<StudioStepId, string> = {
  plan: 'Plan this app for me',
  data: 'Add the data types this app needs',
  screens: 'Design a dashboard home screen',
  automations: 'Notify me when a record is submitted',
  access: 'What roles should this app have?',
  publish: 'Is this app ready to publish?',
};

/**
 * The App Studio: one workspace per app with a top bar, a six-section nav —
 * Plan, Data, Screens, Automations, Access, Publish — and a single line of
 * guidance. Everything reads and writes the real app APIs; deep surfaces (form
 * builder, flow canvas, diagram, screen studios) open from their sections.
 *
 * It is deliberately NOT a wizard. An owner opens this screen for the life of
 * the app, so there is no step counter, no progress bar and no Previous/Next
 * bar pinned over the content — the nav carries what each section holds, and
 * one recommendation says what is worth doing next.
 */
export function AppStudio() {
  const { appId, step: stepParam } = useParams<{ appId: string; step?: string }>();
  const navigate = useNavigate();
  const data = useStudioData(appId);
  const isOnline = useOnlineStatus();
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const askAi = (prompt?: string) => {
    if (prompt) setChatSeed(prompt);
    setChatMinimized(false);
    setChatOpen(true);
  };

  const activeStep: StudioStepId = isStudioStep(stepParam) ? stepParam : 'data';

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

  // /studio (no section) → the natural entry: brand-new apps start at Plan,
  // existing apps at Data. An unknown section in the URL is corrected too, so
  // the address bar can never disagree with what is on screen.
  useEffect(() => {
    if (!appId) return;
    if (stepParam === undefined) {
      if (data.loading) return;
      navigate(`/apps/${appId}/studio/${data.appForms.length === 0 ? 'plan' : 'data'}`, { replace: true });
      return;
    }
    if (!isStudioStep(stepParam)) navigate(`/apps/${appId}/studio/data`, { replace: true });
  }, [appId, stepParam, data.loading, data.appForms.length, navigate]);

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

  const badges = useMemo(
    () =>
      deriveSectionBadges({
        formCount: data.appForms.length,
        hasBlueprint: data.blueprint !== null,
        hasHomeScreen: !!(data.app?.customScreen as { kind?: string } | undefined)?.kind,
        flowCount: data.flows.length,
        activeFlowCount: data.flows.filter((f) => f.enabled).length,
        roleCount: data.roles.length,
        published: data.app?.status === 'published',
        publishedVersion: data.app?.publishedVersion ?? 0,
        unpublishedCount: changes.everPublished ? changes.count : 0,
      }),
    [data.appForms.length, data.blueprint, data.app, data.flows, data.roles.length, changes]
  );

  const setStep = useCallback((step: StudioStepId) => {
    if (appId) navigate(`/apps/${appId}/studio/${step}`);
  }, [appId, navigate]);

  const activeIndex = STUDIO_STEPS.findIndex((s) => s.id === activeStep);
  const next = STUDIO_STEPS[activeIndex + 1];
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
      key: 'p',
      ctrl: true,
      shift: true,
      description: 'Open Review & publish',
      action: () => setStep('publish'),
    },
    {
      key: 'p',
      ctrl: true,
      description: 'Open the app',
      action: openPreview,
    },
    {
      key: '/',
      description: 'Search App Studio',
      action: () => setCommandPaletteOpen(true),
    },
    // Matched on event.code so Option+digit works on macOS, where Option rewrites
    // event.key into a symbol and the shortcut would otherwise never fire.
    ...STUDIO_STEPS.map<KeyboardShortcut>((step, index) => ({
      key: String(index + 1),
      code: `Digit${index + 1}`,
      alt: true,
      description: `Open ${step.label}`,
      action: () => setStep(step.id),
    })),
  ], [openPreview, setStep]);
  useKeyboardShortcuts({ shortcuts, enabled: !!data.app });

  // ONE recommendation, derived from real state — the nav says what each section
  // holds, this says what is worth doing next. Null = the app is in good shape
  // and the line disappears instead of nagging.
  const nextAction = useMemo(() => {
    if (!data.app || data.loading) return null;
    return deriveNextAction({
      formCount: data.appForms.length,
      fieldlessFormNames: data.appForms
        .filter((af) => (data.formsById[af.formId]?.fields.length ?? 1) === 0)
        .map((af) => af.displayName || data.formsById[af.formId]?.title || 'Untitled'),
      flowCount: data.flows.length,
      // Browser-only demo apps cannot send real invitations, so do not point
      // their recommendation at an unavailable cloud operation.
      memberCount: isDemoLocalId(data.app.id) ? 2 : data.memberCount,
      memberCountKnown: !data.auxFailed,
      published: data.app.status === 'published',
      unpublishedCount: changes.everPublished ? changes.count : 0,
    });
  }, [data.app, data.loading, data.appForms, data.formsById, data.flows.length, data.memberCount, data.auxFailed, changes]);

  if (!appId) return <Navigate to="/apps" replace />;

  // A transport failure is not a missing app: telling an owner their app was
  // deleted because a request dropped is both wrong and a dead end.
  if (data.appError && !data.app) {
    const missing = data.appError.kind === 'notFound';
    return (
      <div className="flex flex-col items-center justify-center px-4 py-24 text-center">
        <p className="text-lg font-medium text-gray-700 dark:text-slate-300">
          {missing ? 'App not found' : "Couldn't load this app"}
        </p>
        <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
          {missing ? "It may have been deleted, or you don't have access." : data.appError.message}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {!missing && (
            <Button onClick={() => void data.reload()} leftIcon={<RotateCcw className="h-4 w-4" />}>
              Try again
            </Button>
          )}
          <Button variant="outline" onClick={() => navigate('/apps')}>Back to apps</Button>
        </div>
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
      <StudioRail activeStep={activeStep} badges={badges} isOnline={isOnline} onStepChange={setStep} />

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

      {/* One guidance line: the recommendation when there is one, the section's own
          purpose when there isn't. AppShell already provides the main landmark. */}
      <div className="border-b border-gray-200/60 px-4 py-2 dark:border-white/[0.06] sm:px-6 lg:px-7">
        <div className="mx-auto flex max-w-[1540px] flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          {nextAction ? (
            <p className="flex min-w-0 items-center gap-2 text-xs text-gray-600 dark:text-slate-300">
              <Compass className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              <span className="min-w-0">
                <span className="font-semibold text-gray-900 dark:text-white">{nextAction.title}</span>
                <span className="hidden sm:inline"> — {nextAction.detail}</span>
              </span>
              {nextAction.step !== activeStep && (
                <button
                  type="button"
                  onClick={() => setStep(nextAction.step)}
                  className="shrink-0 cursor-pointer font-bold text-primary-600 hover:underline dark:text-primary-400"
                >
                  {nextAction.cta}
                </button>
              )}
            </p>
          ) : (
            <p className="min-w-0 truncate text-xs text-gray-500 dark:text-slate-400">{active.description}</p>
          )}
          {aiAvailable && (
            <button
              type="button"
              onClick={() => askAi(STEP_PROMPTS[activeStep])}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 transition hover:border-primary-300 hover:text-primary-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" aria-hidden="true" />
              {STEP_PROMPTS[activeStep]}
            </button>
          )}
        </div>
      </div>

      {/*
        A query CONTAINER, not a viewport breakpoint: the studio's usable width is the
        viewport minus the app sidebar (0 / 64 / 256px) minus the docked chat rail
        (384px), so a viewport-based layout is wrong for half of those combinations.
        Sections size themselves off `@container/studio` and stay right at every width.
        The bottom padding clears the floating chat launcher and desktop chip so the
        trailing "Next" control is never underneath them.
      */}
      <div className="@container/studio mx-auto max-w-[1540px] p-4 pb-24 sm:p-6 sm:pb-28 lg:p-7 lg:pb-28">
        <h2 className="sr-only">{active.label}</h2>

        {activeStep === 'plan' && (
          <PlanStep
            app={data.app}
            blueprint={data.blueprint}
            appForms={data.appForms}
            formsById={data.formsById}
            roles={data.roles}
            aiAvailable={aiAvailable}
            onGoToData={() => setStep('data')}
          />
        )}
        {activeStep === 'data' && (
          <DataStep
            app={data.app}
            appForms={data.appForms}
            formsById={data.formsById}
            unreadableFormIds={data.unreadableFormIds}
            formsResolving={data.formsResolving}
            formsFailed={data.formsFailed}
            onReloadForms={data.reloadForms}
          />
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
            onReloadRoles={data.reloadRoles}
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
            memberCountKnown={!data.auxFailed}
            formCountKnown={!data.formsFailed}
            changes={changes}
            onStepChange={setStep}
            onPublished={data.reload}
          />
        )}

        {/* Forward movement lives at the END of the content, where a reader
            actually finishes — not pinned over it in a fixed bar. */}
        {next && (
          <div className="mt-6 flex justify-end border-t border-gray-200/70 pt-4 dark:border-white/[0.06]">
            <Button variant="ghost" size="sm" onClick={() => setStep(next.id)}>
              Next: {next.label}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AppStudio;
