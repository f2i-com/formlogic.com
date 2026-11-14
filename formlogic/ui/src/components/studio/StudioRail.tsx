// The App Studio's six sections as the row of links every page with sections has (SectionNav).
// Each section is an address (/apps/:appId/studio/:step), so it opens in a new tab, a copied link
// lands on it and Back returns to it.
import type { ReactNode } from 'react';
import { Database, GitBranch, LayoutPanelTop, Map, Rocket, ShieldCheck } from 'lucide-react';
import { SectionNav, type SectionNavItem } from '../ui/SectionNav';
import { STUDIO_STEPS, type SectionBadge, type StudioStepId } from './studioSteps';

const STEP_ICONS = { plan: Map, data: Database, screens: LayoutPanelTop, automations: GitBranch, access: ShieldCheck, publish: Rocket };

export function StudioSectionNav({ appId, activeStep, badges, end }: {
  appId: string;
  activeStep: StudioStepId;
  /** What each section holds: a count, or the app's release state on Review & publish. */
  badges: Record<StudioStepId, SectionBadge | null>;
  /** The app's state line, at the row's right end. */
  end?: ReactNode;
}) {
  const items: SectionNavItem[] = STUDIO_STEPS.map((step) => {
    const badge = badges[step.id];
    return {
      value: step.id,
      label: step.label,
      icon: STEP_ICONS[step.id],
      to: `/apps/${appId}/studio/${step.id}`,
      // The mark is a bare number: its meaning is spelled out for a screen reader and on hover,
      // so it is not trapped in a colour or a tooltip on a touch screen. Amber means something
      // is waiting on the owner (nothing built yet, changes not published).
      // `relative` keeps the spelled-out text inside the scrolling row: positioned against the
      // page instead, the text of a section scrolled out of view widened the page itself.
      mark: badge ? (
        <span title={badge.title} className={badge.tone === 'attention' ? 'relative text-amber-700 dark:text-amber-300' : 'relative'}>
          <span aria-hidden="true">{badge.text}</span>
          <span className="sr-only">{badge.title}</span>
        </span>
      ) : undefined,
    };
  });
  // Six names are longer than a phone is wide: there SectionNav wraps them onto a second line, so
  // every section is in view.
  return <SectionNav label="App Studio sections" current={activeStep} items={items} end={end} />;
}
