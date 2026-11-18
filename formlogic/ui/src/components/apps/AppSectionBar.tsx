import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, PanelLeft } from 'lucide-react';
import type { AppSectionItem } from '../layout/appSectionNavigation';
import { followAppLink, useScopedAppNavigation } from '../layout/useAppSectionSidebar';
import { cn } from '../../lib/utils';

interface AppSectionBarProps {
  items: readonly AppSectionItem[];
  section: string;
  trail: { label: string; to?: string }[];
  status?: ReactNode;
  hasSidebar: boolean;
  onLeave?: (to: string) => void;
}

export function AppSectionBar({ items, section, trail, status, hasSidebar, onLeave }: AppSectionBarProps) {
  const { key, pathname } = useLocation();
  const scope = useScopedAppNavigation(pathname);
  const leave = onLeave ?? scope?.navigation.leave;
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === key;
  // Browser Back and Forward can revisit a history entry in the same mounted workspace.
  if (openedAt !== null && !open) setOpenedAt(null);
  const disclosure = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tabbing = useRef(false);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!disclosure.current?.contains(event.target as Node)) setOpenedAt(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenedAt(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 pb-2 dark:border-slate-800">
    <nav aria-label="Current app location" className="min-w-0 flex-1">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
        {trail.map(({ label, to }, index) => <li key={index} className="flex min-w-0 max-w-full items-center gap-1">
          {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
          {to
            ? <Link to={to} title={label} onClick={event => followAppLink(event, to, pathname, leave)} className={cn('max-w-full truncate rounded py-1 font-medium text-slate-600 hover:underline dark:text-slate-300', index > 0 && 'font-mono text-xs')}>{label}</Link>
            : <span aria-current="page" title={label} className="truncate font-semibold text-slate-900 dark:text-slate-100">{label}</span>}
        </li>)}
      </ol>
    </nav>

    {status && <div className="order-last w-full sm:order-none sm:w-auto">{status}</div>}
    <div ref={disclosure} className={cn('relative shrink-0', hasSidebar && 'md:hidden')}
      onKeyDownCapture={event => { tabbing.current = event.key === 'Tab'; }}
      onPointerDownCapture={() => { tabbing.current = false; }}
      onBlur={event => {
        // WebKit can move focus to the outer page during a press on a link.
        if (tabbing.current && !event.currentTarget.contains(event.relatedTarget)) setOpenedAt(null);
      }}>
      <button type="button" ref={trigger} aria-expanded={open} aria-controls={panel}
        onClick={() => setOpenedAt(open ? null : key)}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
        <PanelLeft className="size-4" aria-hidden="true" />Sections<ChevronDown className={cn('size-3.5', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <nav id={panel} aria-label="App sections" hidden={!open}
        className="absolute right-0 z-40 mt-2 max-h-[65dvh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="grid grid-cols-2 gap-x-2">
          {([null, 'Build', 'Manage'] as const).map(group => {
            const entries = items.filter(item => item.group === group);
            if (!entries.length) return null;
            return <div key={group ?? 'overview'} className={group === null ? 'col-span-2 mb-1 border-b border-slate-200 pb-1 dark:border-slate-700' : undefined}>
              {group && <p className="px-2 pb-1 pt-2 text-xs font-medium text-slate-500 dark:text-slate-400">{group}</p>}
              {entries.map(({ value, label, to, icon: Icon }) => <Link key={value} to={to}
                aria-current={value === section ? 'page' : undefined}
                onClick={event => {
                  if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                  setOpenedAt(null);
                  trigger.current?.focus();
                  followAppLink(event, to, pathname, leave);
                }}
                className={cn('flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium',
                  value === section
                    ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-300'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800')}>
                <Icon className="size-4 shrink-0" aria-hidden="true" />{label}
              </Link>)}
            </div>;
          })}
        </div>
      </nav>
    </div>
  </div>;
}
