import { useId } from 'react';
import { Database, GitBranch, LayoutPanelTop, Map, Rocket, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { STUDIO_STEPS, type SectionBadge, type StudioStepId } from './studioSteps';

const STEP_ICONS = { plan: Map, data: Database, screens: LayoutPanelTop, automations: GitBranch, access: ShieldCheck, publish: Rocket };

/** Every section stays labelled and reachable, including on a phone. */
export function StudioRail({ activeStep, badges, onStepChange }: {
  activeStep: StudioStepId;
  badges: Record<StudioStepId, SectionBadge | null>;
  onStepChange: (step: StudioStepId) => void;
}) {
  const badgePrefix = useId();
  return (
    <nav aria-label="App Studio sections" className="@container/rail">
      <div className="mx-auto grid max-w-[1540px] grid-cols-3 gap-1.5 px-3 py-3 @4xl/rail:grid-cols-6 @4xl/rail:px-5">
        {STUDIO_STEPS.map(step => {
          const Icon = STEP_ICONS[step.id];
          const active = step.id === activeStep;
          const badge = badges[step.id];
          return (
            <button key={step.id} type="button" onClick={() => onStepChange(step.id)} aria-current={active ? 'page' : undefined}
              aria-label={step.label} aria-describedby={badge ? `${badgePrefix}-${step.id}` : undefined} title={step.description}
              className={cn('relative flex min-h-14 min-w-0 items-center gap-2 rounded-xl border px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 @4xl/rail:px-3',
                active ? 'border-primary-200 bg-primary-50 text-primary-800 dark:border-primary-500/30 dark:bg-primary-500/15 dark:text-primary-200'
                  : 'border-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-50 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800')}>
              <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-600 dark:text-primary-300' : 'text-gray-400 dark:text-slate-500')} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold leading-snug @4xl/rail:text-xs">{step.label}</span>
                {badge && <span aria-hidden="true" className={cn('mt-1 hidden text-[10px] @4xl/rail:block', badge.tone === 'attention' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-slate-400')} title={badge.title}>{badge.title}</span>}
              </span>
              {badge && <span id={`${badgePrefix}-${step.id}`} className="sr-only">{badge.title}</span>}
              {badge?.tone === 'attention' && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
