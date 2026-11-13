import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Compass, RotateCcw, Sparkles } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { PageBody, PAGE_GUTTER } from '../../components/layout/PageBody';
import { Button } from '../../components/ui/Button';
import { StudioHeaderActions, StudioStateLine } from '../../components/studio/StudioTopBar';
import { StudioSectionNav } from '../../components/studio/StudioRail';
import { StudioCommandPalette } from '../../components/studio/StudioCommandPalette';
import { StudioAppMenu } from '../../components/studio/StudioAppMenu';
import { StudioSaveErrorStrip } from '../../components/studio/StudioSaveErrorStrip';
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
import { OverviewStep } from '../../components/studio/steps/OverviewStep';
import { DataStep } from '../../components/studio/steps/DataStep';
import { ScreensStep } from '../../components/studio/steps/ScreensStep';
import { AutomationsStep } from '../../components/studio/steps/AutomationsStep';
import { AccessStep } from '../../components/studio/steps/AccessStep';
import { PublishStep } from '../../components/studio/steps/PublishStep';
import { useUIStore } from '../../stores/uiStore';
import { returnToState } from '../../hooks/useReturnTo';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { isDemoLocalId } from '../../lib/demoLocal';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../../hooks/useKeyboardShortcuts';
import { cn } from '../../lib/utils';
import { useNativeTables } from '../../components/studio/useNativeTables';
import { useAdminActing } from '../../components/admin/AdminActingContext';
import { isSoftnApp, softnPathForStudio, softnWorkspacePath } from '../../lib/softnApps';

/** One suggestion per section, offered only when a default AI can actually run. */
const STEP_PROMPTS: Record<StudioStepId, string> = {
  plan: 'Plan this app for me',
  data: 'Add the forms this app needs',
  screens: 'Design a dashboard home screen',
  automations: 'Notify me when a record is submitted',
  access: 'What roles should this app have?',
  publish: 'Is this app ready to publish?',
};

/**
 * The App Studio: one workspace per forms app. The same frame as every page that
 * manages an app: the page Header with the app's name, then a row of six sections —
 * Overview, Data, Screens, Automations, Access, Publish — each at its own address,
 * with the app's state at the row's end. Everything reads and writes the real app
 * APIs; deep surfaces (form builder, flow canvas, diagram, screen studios) open
 * from their sections.
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
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);

  const askAi = (prompt?: string) => {
    if (prompt) setChatSeed(prompt);
    setChatMinimized(false);
    setChatOpen(true);
  };

  const activeStep: StudioStepId = isStudioStep(stepParam) ? stepParam : 'data';
  const acting = useAdminActing();
  const nativeDatabase = useNativeTables(appId && data.app && !isDemoLocalId(appId) && !acting ? appId : undefined, activeStep);

  // Footer navigation should reveal the next section from its heading.
  useEffect(() => { window.scrollTo(0, 0); }, [appId, activeStep]);

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
        nativeTableCount: nativeDatabase.tables.length,
        flowCount: data.flows.length,
        activeFlowCount: data.flows.filter((f) => f.enabled).length,
        roleCount: data.roles.length,
        published: data.app?.status === 'published',
        publishedVersion: data.app?.publishedVersion ?? 0,
        unpublishedCount: changes.everPublished ? changes.count : 0,
      }),
    [data.appForms.length, data.app, data.flows, data.roles.length, changes, nativeDatabase.tables.length]
  );

  const setStep = useCallback((step: StudioStepId) => {
    if (appId) navigate(`/apps/${appId}/studio/${step}`);
  }, [appId, navigate]);

  const activeIndex = STUDIO_STEPS.findIndex((s) => s.id === activeStep);
  const next = STUDIO_STEPS[activeIndex + 1];
  const previous = STUDIO_STEPS[activeIndex - 1];
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
      nativeTableCount: nativeDatabase.tables.length,
      fieldlessFormNames: data.appForms
        .filter((af) => (data.formsById[af.formId]?.fields.length ?? 1) === 0)
        .map((af) => af.displayName || data.formsById[af.formId]?.title || 'Untitled'),
      flowCount: data.flows.length,
      // Browser-only demo apps cannot send real invitations, so do not point
      // their recommendation at an unavailable cloud operation.
      memberCount: isDemoLocalId(data.app.id) ? 2 : data.memberCount,
      memberCountKnown: !data.membersFailed,
      published: data.app.status === 'published',
      unpublishedCount: changes.everPublished ? changes.count : 0,
    });
  }, [data.app, data.loading, data.appForms, data.formsById, data.flows.length, data.memberCount, data.membersFailed, changes, nativeDatabase.tables.length]);

  if (!appId) return <Navigate to="/apps" replace />;

  const backToApps = { onClick: () => navigate('/apps'), label: 'Back to apps' };

  // A transport failure is not a missing app: telling an owner their app was
  // deleted because a request dropped is both wrong and a dead end.
  if (data.appError && !data.app) {
    const missing = data.appError.kind === 'notFound';
    return (
      <div className="min-h-screen">
        <Header title="App Studio" back={backToApps} />
        <div className={cn('py-8', PAGE_GUTTER)} role="alert">
          <p className="text-base font-semibold text-gray-900 dark:text-white">
            {missing ? 'App not found' : "Couldn't load this app"}
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            {missing ? "It may have been deleted, or you don't have access." : data.appError.message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {!missing && (
              <Button onClick={() => void data.reload()} leftIcon={<RotateCcw className="h-4 w-4" />}>
                Try again
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate('/apps')}>Back to apps</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!data.app || data.initialLoading) {
    return (
      <div className="min-h-screen">
        <Header title={data.app?.name ?? 'App Studio'} back={backToApps} />
        <div className={cn('flex items-center gap-3 py-8 text-sm text-gray-500 dark:text-slate-400', PAGE_GUTTER)} role="status" aria-label="Loading App Studio">
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600" />
          Loading the app…
        </div>
      </div>
    );
  }

  // Members without manage rights use the app, they don't edit it (ownerId is
  // stripped from non-owner reads, so its absence is the capability signal).
  if (!data.app.ownerId) {
    return <Navigate to={`/app/${data.app.slug}`} replace />;
  }

  // The studio is for forms apps. A SoftN app is managed on its own page, which has what each
  // part of the studio did for it (its data, members, automations and settings): an address of
  // the studio that names one goes there. Unless the app also holds forms, as some made before
  // the two were told apart do: their forms, relations and screens have no other home, so such
  // an app keeps its studio, under a line that says where the rest of it is. Decided once its
  // forms are known, and never on a read of them that failed.
  const softn = isSoftnApp(data.app);
  if (softn && !data.formsFailed && data.appForms.length === 0) {
    return <Navigate to={softnPathForStudio(appId, stepParam)} replace />;
  }

  // Resolve the entry URL before mounting a section: the previous effect briefly
  // mounted Data & forms while deciding that an empty app should open Overview.
  if (!isStudioStep(stepParam)) {
    const entry = stepParam === undefined && !data.formsFailed && data.appForms.length === 0 ? 'plan' : 'data';
    return <Navigate to={`/apps/${appId}/studio/${entry}`} replace />;
  }

  const active = STUDIO_STEPS[activeIndex];

  return (
    <div className="min-h-screen">
      <Header
        title={data.app.name}
        back={backToApps}
        actions={
          <StudioHeaderActions
            app={data.app}
            changes={changes}
            aiAvailable={aiAvailable}
            onOpenPublish={() => setStep('publish')}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            onOpenAppMenu={() => setAppMenuOpen(true)}
          />
        }
      />
      {/* A transient success may scroll away; a failure never may: it stays under the header. */}
      <StudioSaveErrorStrip />

      {appMenuOpen && (
        <StudioAppMenu
          app={data.app}
          changes={changes}
          aiAvailable={aiAvailable}
          aiPrompt={STEP_PROMPTS[activeStep]}
          onClose={() => setAppMenuOpen(false)}
          onOpenSearch={() => setCommandPaletteOpen(true)}
          onOpenPublish={() => setStep('publish')}
          onAskAi={openContextualChat}
        />
      )}

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

      {/*
        The page body, left-aligned and as wide as the page, and a query CONTAINER: the
        studio's usable width is the viewport minus the app sidebar (0 / 64 / 256px) minus
        the docked chat rail (384px), so a viewport-based layout is wrong for half of those
        combinations. Sections size themselves off `@container/studio` and stay right at
        every width.
      */}
      <PageBody className="@container/studio">
        <StudioSectionNav
          appId={appId}
          activeStep={activeStep}
          badges={badges}
          end={<StudioStateLine app={data.app} changes={changes} onOpenPublish={() => setStep('publish')} />}
        />

        {/* The section's name is in the row above, so it is not painted again: a heading for
            a screen reader's outline, and ONE line under the row.
            The line is the recommendation when there is one about THIS section, and what the
            section is for otherwise. The recommendation used to be a permanent strip that
            showed the same section-agnostic advice on all six sections, then a card of its
            own above the section; said in the section's one line it reads as advice, and
            the section starts right under it. */}
        <div className="mb-4 mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="sr-only">{active.label}</h2>
          {nextAction && nextAction.step === activeStep ? (
            <p className="flex min-w-0 items-start gap-2 text-sm text-gray-500 dark:text-slate-400">
              <Compass className="mt-0.5 h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              <span className="min-w-0"><span className="font-semibold text-gray-900 dark:text-white">{nextAction.title}.</span> {nextAction.detail}</span>
            </p>
          ) : (
            <p className="min-w-0 text-sm text-gray-500 dark:text-slate-400">{active.description}</p>
          )}
          {aiAvailable && (
            <button
              type="button"
              onClick={() => askAi(STEP_PROMPTS[activeStep])}
              className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-[11px] font-medium text-gray-600 transition hover:border-primary-300 hover:text-primary-700 max-sm:min-h-11 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" aria-hidden="true" />
              {STEP_PROMPTS[activeStep]}
            </button>
          )}
        </div>

        {/* A SoftN app that also holds forms: the studio is for those forms, and the rest of the app is on its own page. */}
        {softn && (
          <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-primary-200/80 bg-primary-50/70 px-3 py-2 text-sm text-gray-700 dark:border-primary-500/20 dark:bg-primary-500/[0.07] dark:text-slate-200">
            <span className="min-w-0 flex-1">This is a SoftN app that also holds forms. Its pages, data, members and settings are on its own page; the studio here is for its forms.</span>
            <Link to={softnWorkspacePath(data.app.id)} className="inline-flex min-h-9 items-center font-semibold text-primary-700 underline-offset-2 hover:underline max-sm:min-h-11 dark:text-primary-300">Open the app’s page</Link>
          </p>
        )}

        {activeStep === 'plan' && (
          <OverviewStep
            app={data.app}
            nativeTableCount={nativeDatabase.tables.length}
            appForms={data.appForms}
            formsById={data.formsById}
            roles={data.roles}
            flows={data.flows}
            blueprint={data.blueprint}
            memberCount={isDemoLocalId(data.app.id) ? 1 : data.memberCount}
            memberCountKnown={isDemoLocalId(data.app.id) || !data.membersFailed}
            aiAvailable={aiAvailable}
            onStepChange={setStep}
            onReloadApp={data.reloadApp}
          />
        )}
        {activeStep === 'data' && (
          <DataStep
            app={data.app}
            nativeDatabase={nativeDatabase}
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
            memberCountKnown={!data.membersFailed}
            formCountKnown={!data.formsFailed}
            versionsKnown={!data.versionsFailed}
            changes={changes}
            nativeTableCount={nativeDatabase.tables.length}
            onStepChange={setStep}
            onPublished={data.reload}
          />
        )}

        {/* Forward movement lives at the END of the content, where a reader
            actually finishes — not pinned over it in a fixed bar. */}
        <nav aria-label="Previous and next Studio sections" className="mt-6 flex flex-col gap-3 border-t border-gray-200 pt-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
          {previous ? <Button variant="ghost" onClick={() => setStep(previous.id)} className="min-h-11 whitespace-normal text-left"><ArrowLeft className="mr-2 h-4 w-4 shrink-0" />Previous: {previous.label}</Button> : <span className="text-xs text-gray-500 dark:text-slate-400">You can return to any section as your app grows.</span>}
          {next && <Button variant="outline" onClick={() => setStep(next.id)} className="min-h-11 whitespace-normal">Next: {next.label}<ArrowRight className="ml-2 h-4 w-4 shrink-0" /></Button>}
        </nav>
      </PageBody>
    </div>
  );
}

export default AppStudio;
