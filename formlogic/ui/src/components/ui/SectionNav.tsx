// A page's sections, as one row of links under its header: the SoftN app page, Settings, the
// App Studio and the admin area all move between their sections with it.
// Links, not tabs: each section is an address, so it opens in a new tab, a copied link lands on
// it and the back button returns to it. The row scrolls sideways before it wraps, and on a phone
// the names stand without their icons at a finger's height.
// A row longer than the screen says so: the end it runs off fades out under an arrow, which also
// moves it along. Without that, a phone showed three sections and half a word, and nothing said
// there were three more.
import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { Link, type To } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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

/** How close to an end the row counts as being at it, in px: a screen can leave a fraction over. */
const AT_END = 4;
/**
 * How wide the fade at a running-off end is. The arrow over it is narrower still (1.5rem), so a
 * short section name at the edge ("Edit", "Data") is never wholly under either: most of it can be
 * read and pressed, and a press on the arrow brings the rest of it in.
 */
const FADE = '1.75rem';

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

  // Whether there are sections out of sight before the row's start or after its end. Measured
  // when the row scrolls, when its own width changes (a turned phone, a sidebar opening) and
  // when what is in it does (a count appearing beside a name).
  const [more, setMore] = useState({ before: false, after: false });
  // Which sections there are, in order: the row is watched again when they change, not only when
  // their number does (one section swapped for another keeps the count).
  const shape = items.map(item => item.value).join('\n');
  useEffect(() => {
    const nav = row.current;
    if (!nav) return;
    const measure = () => {
      const before = nav.scrollLeft > AT_END;
      const after = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - AT_END;
      setMore(now => (now.before === before && now.after === after ? now : { before, after }));
    };
    nav.addEventListener('scroll', measure, { passive: true });
    // The observer also measures once as it starts, so nothing is measured in this effect itself.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watch?.observe(nav);
    for (const link of nav.children) watch?.observe(link);
    return () => { nav.removeEventListener('scroll', measure); watch?.disconnect(); };
  }, [shape]);
  const along = (direction: 1 | -1) => row.current?.scrollBy?.({ left: direction * row.current.clientWidth * 0.7, behavior: 'smooth' });
  // The row itself fades at an end it runs off, whatever is behind it (the page is not one colour).
  const fade = `linear-gradient(to right, transparent 0, #000 ${more.before ? FADE : '0px'}, #000 ${more.after ? `calc(100% - ${FADE})` : '100%'}, transparent 100%)`;
  const faded: CSSProperties | undefined = more.before || more.after ? { maskImage: fade, WebkitMaskImage: fade } : undefined;
  // The arrows are for a finger or a mouse. The keyboard moves along the links themselves, and a
  // screen reader is read every section, so neither is given two more things to pass.
  const arrow = 'absolute inset-y-0 z-10 flex w-6 cursor-pointer items-center text-gray-600 hover:text-gray-900 dark:text-slate-300 dark:hover:text-white';

  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-4 border-b border-gray-200 dark:border-slate-700', className)}>
      <div className="relative -mb-px flex min-w-0 max-w-full">
        <nav ref={row} aria-label={label} style={faded} // A link brought into view by the keyboard stops clear of the fade and the arrow, so its focus ring is whole.
          className="scrollbar-hide flex min-w-0 max-w-full gap-1 overflow-x-auto scroll-px-8">
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
        {more.before && <button type="button" tabIndex={-1} aria-hidden="true" data-more="before" onClick={() => along(-1)} className={cn(arrow, 'left-0 justify-start')}><ChevronLeft className="h-4 w-4" /></button>}
        {more.after && <button type="button" tabIndex={-1} aria-hidden="true" data-more="after" onClick={() => along(1)} className={cn(arrow, 'right-0 justify-end')}><ChevronRight className="h-4 w-4" /></button>}
      </div>
      {end}
    </div>
  );
}
