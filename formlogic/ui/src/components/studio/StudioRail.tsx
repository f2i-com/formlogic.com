import { Check, ChevronDown, Database, GitBranch, LayoutPanelTop, Map, Rocket, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { STUDIO_STEPS, type StudioStepId } from './studioSteps';

const STEP_ICONS: Record<StudioStepId, typeof Map> = {
  plan: Map,
  data: Database,
  screens: LayoutPanelTop,
  automations: GitBranch,
  access: ShieldCheck,
  publish: Rocket,
};

/**
 * The six-step App Studio rail: desktop = a horizontal step tracker under the
 * top bar; mobile = a collapsible current-step summary with a progress bar.
 * Every step is always clickable — the studio is prefilled and skippable.
 */
export function StudioRail({
  activeStep,
  completedSteps,
  onStepChange,
}: {
  activeStep: StudioStepId;
  completedSteps: StudioStepId[];
  onStepChange: (step: StudioStepId) => void;
}) {
  const currentIndex = STUDIO_STEPS.findIndex((step) => step.id === activeStep);
  return (
    <>
      <div className="sticky top-14 sm:top-16 z-20 hidden border-b border-gray-200/60 dark:border-white/[0.06] bg-white/90 dark:bg-slate-900/80 px-4 py-2.5 backdrop-blur-xl md:block lg:px-7">
        <ol className="mx-auto grid max-w-[1460px] grid-cols-6 gap-1" aria-label="App Studio steps">
          {STUDIO_STEPS.map((step, index) => {
            const Icon = STEP_ICONS[step.id];
            const active = step.id === activeStep;
            const complete = completedSteps.includes(step.id);
            return (
              <li key={step.id} className="relative min-w-0">
                {index > 0 && (
                  <div
                    aria-hidden="true"
                    className={cn(
                      'absolute right-[calc(50%+19px)] top-[17px] h-px w-[calc(100%-38px)]',
                      complete || active ? 'bg-primary-300 dark:bg-primary-500/40' : 'bg-gray-200 dark:bg-white/10'
                    )}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onStepChange(step.id)}
                  aria-current={active ? 'step' : undefined}
                  className={cn(
                    'relative z-10 flex w-full cursor-pointer flex-col items-center gap-1 rounded-xl px-1 py-1 text-center transition-colors',
                    active
                      ? 'text-primary-600 dark:text-primary-400'
                      : 'text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-xl border transition-all',
                      active
                        ? 'border-primary-300 dark:border-primary-500/40 bg-primary-600 text-primary-foreground shadow-md shadow-primary-600/20'
                        : complete
                          ? 'border-primary-200 dark:border-primary-500/20 bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400'
                          : 'border-gray-200 dark:border-white/10 bg-white dark:bg-slate-900 text-gray-400 dark:text-slate-500'
                    )}
                  >
                    {complete && !active ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span className="max-w-full truncate text-[11px] font-semibold">{step.shortLabel}</span>
                  {step.optional && !complete && !active && (
                    <span className="text-[9px] text-gray-400 dark:text-slate-500">Optional</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Mobile step tracker */}
      <div className="sticky top-14 z-20 border-b border-gray-200/60 dark:border-white/[0.06] bg-white/95 dark:bg-slate-900/90 px-4 py-3 backdrop-blur-xl md:hidden">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-600 text-xs font-bold text-primary-foreground">
              {currentIndex + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-slate-500">
                Step {currentIndex + 1} of {STUDIO_STEPS.length}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                {STUDIO_STEPS[currentIndex]?.label}
                {STUDIO_STEPS[currentIndex]?.optional && <Badge size="sm">Optional</Badge>}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-gray-100 dark:border-white/[0.06] pt-3">
            {STUDIO_STEPS.map((step, index) => {
              const Icon = STEP_ICONS[step.id];
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={(event) => {
                    onStepChange(step.id);
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-2.5 text-left text-xs font-semibold',
                    step.id === activeStep
                      ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400'
                      : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-white/[0.04]'
                  )}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-current/15">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  {index + 1}. {step.shortLabel}
                </button>
              );
            })}
          </div>
        </details>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-white/[0.08]">
          <div
            className="h-full rounded-full bg-primary-600 dark:bg-primary-400 transition-all"
            style={{ width: `${((currentIndex + 1) / STUDIO_STEPS.length) * 100}%` }}
          />
        </div>
      </div>
    </>
  );
}
