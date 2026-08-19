import { useEffect, useRef } from 'react';
import { Database, GitBranch, LayoutPanelTop, Map, Rocket, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { STUDIO_STEPS, type SectionBadge, type StudioStepId } from './studioSteps';

const STEP_ICONS: Record<StudioStepId, typeof Map> = {
  plan: Map,
  data: Database,
  screens: LayoutPanelTop,
  automations: GitBranch,
  access: ShieldCheck,
  publish: Rocket,
};

/**
 * The App Studio section nav: the app's six sections, each carrying a fact about
 * what it holds (data types, automations, roles, pending changes). It is a nav,
 * not a progress tracker — the studio is a workspace an owner returns to, not a
 * wizard they finish once.
 *
 * On a phone the six labelled tabs needed ~500px in a silent horizontal scroller,
 * so at 320-412px the last sections — including Publish, the one people go looking
 * for — were off-screen with no affordance saying so. They are DISTRIBUTED with
 * flex instead: inactive tabs shrink to their icon (plus an attention dot), the
 * active tab keeps its label and badge, and nothing overflows at any phone width.
 * Above `@2xl/rail` every tab is labelled exactly as before.
 *
 * The sticky offset lives on AppStudio's chrome wrapper, not here — the two rows
 * used to compute it independently and had already drifted once, letting the top
 * bar paint over this nav.
 */
export function StudioRail({
  activeStep,
  badges,
  onStepChange,
}: {
  activeStep: StudioStepId;
  badges: Record<StudioStepId, SectionBadge | null>;
  onStepChange: (step: StudioStepId) => void;
}) {
  // Above @2xl the row can still exceed its box, so keep the active tab in view.
  // Computed rather than scrollIntoView, which under-scrolled the last tab and
  // scrolled the PAGE while trying to reach it. At phone widths nothing overflows,
  // so this clamps to 0 and is a harmless no-op.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const scroller = scrollerRef.current;
    const tab = activeRef.current;
    if (!scroller || !tab) return;
    const centered = tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2;
    scroller.scrollLeft = Math.max(0, Math.min(centered, scroller.scrollWidth - scroller.clientWidth));
  }, [activeStep, badges]);

  return (
    <nav aria-label="App Studio sections" className="@container/rail">
      {/* `relative` makes this the offsetParent, so the tabs' offsetLeft is measured
          against the scroller rather than some ancestor. */}
      <div
        ref={scrollerRef}
        className="scrollbar-none relative mx-auto flex max-w-[1540px] gap-0.5 overflow-x-auto px-1.5 py-0.5 @2xl/rail:px-4 @4xl/rail:px-6"
      >
        {STUDIO_STEPS.map((step) => {
          const Icon = STEP_ICONS[step.id];
          const active = step.id === activeStep;
          const badge = badges[step.id];
          return (
            <button
              key={step.id}
              ref={active ? activeRef : undefined}
              type="button"
              onClick={() => onStepChange(step.id)}
              aria-current={active ? 'page' : undefined}
              // The FULL label, so an icon-only tab is never anonymous to a screen
              // reader or to voice control.
              aria-label={step.label}
              title={badge?.title ?? step.description}
              className={cn(
                'relative flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap px-1 text-[11px] font-semibold transition-colors @2xl/rail:justify-start @2xl/rail:gap-2 @2xl/rail:px-3 @2xl/rail:text-xs',
                active
                  ? 'flex-[2] text-primary-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary-600 @2xl/rail:flex-none dark:text-primary-300 dark:after:bg-primary-400'
                  : 'flex-1 text-gray-500 hover:text-gray-900 @2xl/rail:flex-none dark:text-slate-400 dark:hover:text-white'
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500')} />
              <span className={cn('truncate', active ? 'inline' : 'hidden @2xl/rail:inline')}>{step.shortLabel}</span>
              {badge && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-px text-[10px] font-bold leading-4',
                    active ? 'inline-flex' : 'hidden @2xl/rail:inline-flex',
                    badge.tone === 'attention'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-200'
                      : active
                        ? 'bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-200'
                        : 'bg-gray-100 text-gray-600 dark:bg-white/[0.07] dark:text-slate-300'
                  )}
                >
                  {/* The number alone is not the meaning; a hover title cannot be the
                      sole carrier of it on a touch screen. */}
                  <span aria-hidden="true">{badge.text}</span>
                  <span className="sr-only">{badge.title}</span>
                </span>
              )}
              {/* An unlabelled tab still has to be able to ask for attention. */}
              {!active && badge?.tone === 'attention' && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 @2xl/rail:hidden" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
