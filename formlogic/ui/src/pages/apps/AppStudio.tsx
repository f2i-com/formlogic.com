import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { StudioTopBar } from '../../components/studio/StudioTopBar';
import { StudioRail } from '../../components/studio/StudioRail';
import { useStudioData } from '../../components/studio/useStudioData';
import {
  STUDIO_STEPS,
  computeUnpublishedChanges,
  deriveCompletedSteps,
  isStudioStep,
  type StudioStepId,
} from '../../components/studio/studioSteps';
import { PlanStep } from '../../components/studio/steps/PlanStep';
import { DataStep } from '../../components/studio/steps/DataStep';
import { ScreensStep } from '../../components/studio/steps/ScreensStep';
import { AutomationsStep } from '../../components/studio/steps/AutomationsStep';
import { AccessStep } from '../../components/studio/steps/AccessStep';
import { PublishStep } from '../../components/studio/steps/PublishStep';
import { useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

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

  const activeStep: StudioStepId = isStudioStep(stepParam) ? stepParam : 'data';

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

  const setStep = (step: StudioStepId) => {
    if (appId) navigate(`/apps/${appId}/studio/${step}`);
  };

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

  const activeIndex = STUDIO_STEPS.findIndex((s) => s.id === activeStep);
  const active = STUDIO_STEPS[activeIndex];
  const previous = STUDIO_STEPS[activeIndex - 1]?.id;
  const next = STUDIO_STEPS[activeIndex + 1]?.id;

  return (
    <div className="min-h-screen">
      <StudioTopBar app={data.app} changes={changes} onOpenPublish={() => setStep('publish')} />
      <StudioRail activeStep={activeStep} completedSteps={completedSteps} onStepChange={setStep} />

      <main className="mx-auto max-w-[1540px] p-4 pb-28 sm:p-6 sm:pb-28 lg:p-7 lg:pb-28">
        <div className="mb-5 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
          <div>
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
          </div>
        </div>

        {activeStep === 'plan' && (
          <PlanStep
            app={data.app}
            blueprint={data.blueprint}
            appForms={data.appForms}
            formsById={data.formsById}
            roles={data.roles}
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
            onReloadApp={data.reloadApp}
            onReloadForms={data.reloadForms}
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
            <Button variant="secondary" onClick={() => navigate(`/app/${data.app!.slug}`)} leftIcon={<Check className="h-4 w-4" />}>
              Open the app
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AppStudio;
