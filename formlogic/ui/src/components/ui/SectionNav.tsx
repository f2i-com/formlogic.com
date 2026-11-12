// A page's sections, as one row of links under its header: the SoftN app page, Settings and the
// admin area all move between their sections with it.
// Links, not tabs: each section is an address, so it opens in a new tab, a copied link lands on
// it and the back button returns to it. The row scrolls sideways before it wraps, and on a phone
// the names stand without their icons at a finger's height.
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { Link, type To } from 'react-router-dom';
import { cn } from '../../lib/utils';

export interface SectionNavItem {
  /** What `current` is compared with. */
  value: string;
  label: string;
  to: To;
  icon?: ComponentType<{ className?: string }>;
  /** A count or a short mark after the name, such as how many need attention. */
  mark?: ReactNode;
  /** Replace the address in history instead of adding to it (a section held in the `#hash`). */
  replace?: boolean;
  /** Router state to carry to the section: a page whose Back returns to where it was opened
      from (useReturnTo) keeps that through a change of section. */
  state?: unknown;
}

export function SectionNav({ label, items, current, end, className }: {
  /** The navigation's name for a screen reader: "App sections", "Settings sections". */
  label: string;
  items: readonly SectionNavItem[];
  current: string;
  /** What stands at the row's right end: a status line, a count. It wraps under on a narrow screen. */
  end?: ReactNode;
  className?: string;
}) {
  // On a phone the row scrolls sideways: the open section is brought into it, whichever page
  // opened it (a link from elsewhere lands on the fifth of five). The row's own scroll is set,
  // never scrollIntoView, which would pull the page back up to the row.
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    const link = row.current?.querySelector('[aria-current="page"]');
    if (!row.current || !link) return;
    const rowBox = row.current.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    if (linkBox.left < rowBox.left || linkBox.right > rowBox.right) row.current.scrollLeft += linkBox.left - rowBox.left - (rowBox.width - linkBox.width) / 2;
  }, [current]);

  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-4 border-b border-gray-200 dark:border-slate-700', className)}>
      <nav ref={row} aria-label={label} className="scrollbar-hide -mb-px flex min-w-0 max-w-full gap-1 overflow-x-auto">
        {items.map(({ value, label: name, to, icon: Icon, mark, replace, state }) => (
          <Link
            key={value}
            to={to}
            replace={replace}
            state={state}
            aria-current={current === value ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-2 text-[13px] font-medium sm:min-h-10 sm:px-3 sm:text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500',
              current === value
                ? 'border-primary-600 text-primary-700 dark:border-primary-400 dark:text-primary-300'
                : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-slate-300 dark:hover:text-white',
            )}
          >
            {Icon && <Icon className="hidden h-4 w-4 sm:block" aria-hidden="true" />}
            {name}
            {mark !== undefined && mark !== null && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-gray-600 dark:bg-white/10 dark:text-slate-300">{mark}</span>}
          </Link>
        ))}
      </nav>
      {end}
    </div>
  );
}
