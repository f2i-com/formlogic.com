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
 * The App Studio section nav: one scrollable row of the app's six sections, each
 * carrying a fact about what it holds (data types, automations, roles, pending
 * changes). It is a nav, not a progress tracker — the studio is a workspace an
 * owner returns to, not a wizard they finish once.
 *
 * The sticky offset mirrors the top bar's exactly, including the demo /
 * acting-as banner variable and the offline strip; a hard-coded offset here let
 * the top bar paint over the nav for every banner-carrying session.
 */
export function StudioRail({
  activeStep,
  badges,
  isOnline = true,
  onStepChange,
}: {
  activeStep: StudioStepId;
  badges: Record<StudioStepId, SectionBadge | null>;
  /** Offline adds the shell's 2rem status strip above the top bar. */
  isOnline?: boolean;
  onStepChange: (step: StudioStepId) => void;
}) {
  // On narrow widths the row scrolls; the current section has to be the one you can
  // see, whether you arrived by tab, by shortcut or on a deep link. The scroll offset
  // is computed rather than delegated to scrollIntoView, which under-scrolled the last
  // tab and also scrolled the PAGE while trying to reach it.
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
    <nav
      aria-label="App Studio sections"
      className={cn(
        'sticky z-20 border-b border-gray-200/60 dark:border-white/[0.06] bg-white/90 dark:bg-slate-900/85 backdrop-blur-xl',
        isOnline
          ? 'top-[calc(3.5rem+var(--fl-demo-banner-h,0px))] sm:top-[calc(4rem+var(--fl-demo-banner-h,0px))]'
          : 'top-[calc(5.5rem+var(--fl-demo-banner-h,0px))] sm:top-[calc(6rem+var(--fl-demo-banner-h,0px))]'
      )}
    >
      {/* `relative` makes this the offsetParent, so the tabs' offsetLeft is measured
          against the scroller rather than some ancestor. */}
      <div ref={scrollerRef} className="scrollbar-thin relative mx-auto flex max-w-[1540px] gap-0.5 overflow-x-auto px-2 sm:px-4 lg:px-6">
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
              title={badge?.title ?? step.description}
              className={cn(
                'relative flex min-h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-2.5 py-2.5 text-xs font-semibold transition-colors sm:px-3',
                active
                  ? 'text-primary-700 dark:text-primary-300 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary-600 dark:after:bg-primary-400'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500')} />
              {step.shortLabel}
              {badge && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-px text-[10px] font-bold leading-4',
                    badge.tone === 'attention'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-200'
                      : active
                        ? 'bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-200'
                        : 'bg-gray-100 text-gray-600 dark:bg-white/[0.07] dark:text-slate-300'
                  )}
                >
                  {badge.text}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
