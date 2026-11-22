// The apps list as one compact table: every app on one screen, with what an owner looks for first
// (its address, whether it is live and at which version, who can use it, how much data it holds).
// On a phone the same facts are a short card per app, with finger-sized actions, and a "Sort by"
// choice where the table has headings to press. What the apps themselves do not carry comes from
// GET /api/apps/summary, and a server from before that endpoint leaves those places empty.
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Database, ExternalLink, Package, Settings, Trash2 } from 'lucide-react';
import { AppTile } from './AppTile';
import { listedStatus } from '../../lib/appStatus';
import { isDemoLocalId } from '../../lib/demoLocal';
import { appClickPath, appDataLink, appSettingsPath } from '../../lib/appNavigation';
import { cn, formatRelativeTime, parseServerDate } from '../../lib/utils';
import { appTools, holds, who } from '../../lib/appFacts';
import { viewerOwnsApp, type App, type AppSummary } from '../../types/app';

type SortKey = 'name' | 'status' | 'changed';
type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;
export interface AppsTableProps {
  apps: App[];
  /** By app id; an app without an entry shows what it says itself. */
  summaries: Record<string, AppSummary>;
  packNames: Record<string, string>;
  userId: string | undefined;
  /** Left out where apps are only looked at (Home's short list): no app can be removed from there. */
  onDelete?: (app: App) => void;
  /** Home's short list is in the order it is given: its headings are not pressed to sort. */
  sortable?: boolean;
  /** What stands under the rows in place of the counts (Home's link to every app); null for nothing. */
  footer?: ReactNode;
}

/** The first press of a heading: names and statuses from A, changes from the newest. */
const firstDir = (key: SortKey): 'asc' | 'desc' => (key === 'changed' ? 'desc' : 'asc');
/** The phone's "Sort by" choices: the same sorts the headings give, one press each. */
const SORTS: readonly (readonly [string, string, Sort])[] = [
  ['', 'Last changed', null], ['name', 'Name, A to Z', { key: 'name', dir: 'asc' }], ['name-desc', 'Name, Z to A', { key: 'name', dir: 'desc' }],
  ['status', 'Status', { key: 'status', dir: 'asc' }], ['changed-asc', 'Oldest change first', { key: 'changed', dir: 'asc' }],
];

export function AppsTable({ apps, summaries, packNames, userId, onDelete, sortable = true, footer }: AppsTableProps) {
  // No sort chosen: the order the server gave, most recently changed first.
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => {
    if (!sort) return apps;
    const value = (app: App) => sort.key === 'name' ? app.name.toLowerCase() : sort.key === 'status' ? listedStatus(app, summaries[app.id]) : parseServerDate(app.updatedAt).getTime();
    return [...apps].sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1); });
  }, [apps, sort, summaries]);
  // A heading cycles: its first direction, the other one, then back to the server's order.
  const cycle = (key: SortKey) => setSort(current => current?.key !== key ? { key, dir: firstDir(key) } : current.dir === firstDir(key) ? { key, dir: firstDir(key) === 'asc' ? 'desc' : 'asc' } : null);
  const heading = (key: SortKey, label: string, className?: string) => sortable
    ? <th scope="col" aria-sort={sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cn('px-2 py-0 font-semibold', className)}>
      <button type="button" onClick={() => cycle(key)} className="inline-flex h-8 items-center gap-1 uppercase tracking-wider hover:text-slate-900 dark:hover:text-white">
        {label}{sort?.key === key && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />)}
      </button>
    </th>
    : <th scope="col" className={cn('h-8 px-2 py-0 font-semibold uppercase tracking-wider', className)}>{label}</th>;
  const live = apps.filter(app => app.status === 'published').length;
  const chosen = SORTS.find(([, , value]) => (value?.key ?? '') === (sort?.key ?? '') && (value?.dir ?? '') === (sort?.dir ?? ''))?.[0] ?? '';

  /** What one app's row, or its card, says and leads to. */
  const facts = (app: App) => {
    const summary = summaries[app.id];
    const manage = viewerOwnsApp(app, userId);
    const isLive = app.status === 'published';
    return {
      manage, isLive,
      status: listedStatus(app, summary),
      tone: isLive ? 'text-emerald-700 dark:text-emerald-400' : app.status === 'archived' ? 'text-slate-500 dark:text-slate-400' : 'text-amber-700 dark:text-amber-300',
      dot: isLive ? 'bg-emerald-500' : app.status === 'archived' ? 'bg-slate-400' : 'bg-amber-500',
      address: summary?.domain || `/app/${app.slug}`,
      openAt: summary?.domain ? `https://${summary.domain}` : `/app/${app.slug}`,
      kind: isDemoLocalId(app.id) ? 'Browser only' : appTools(app, summary).label,
      who: who(app, summary), holds: holds(app, summary),
      to: appClickPath(app, userId),
      data: manage ? appDataLink(app, summary) : undefined,
      settings: appSettingsPath(app),
    };
  };
  /**
   * The four things to do with an app, always in the same order; `button` is the look for where
   * they are drawn. In the table each has a place of its own (`places`): a row without one of them
   * leaves that place empty, so the same icon stands under the same icon all the way down the list.
   */
  const actions = (app: App, f: ReturnType<typeof facts>, button: string, places?: readonly boolean[]): ReactNode => {
    const empty = (place: number) => places?.[place] ? <span aria-hidden="true" data-empty-action className="inline-block h-8 w-8 flex-none" /> : null;
    return <>
    {f.isLive ? <a href={f.openAt} target="_blank" rel="noopener noreferrer" aria-label={`Open ${app.name}`} title="Open the app" className={button}><ExternalLink className="h-4 w-4" aria-hidden="true" /></a> : empty(0)}
    {f.data ? <Link to={f.data.to} aria-label={`Data of ${app.name}`} title={f.data.label} className={button}><Database className="h-4 w-4" aria-hidden="true" /></Link> : empty(1)}
    {f.manage ? <Link to={f.settings} aria-label={`Settings of ${app.name}`} title="Settings" className={button}><Settings className="h-4 w-4" aria-hidden="true" /></Link> : empty(2)}
    {f.manage && onDelete ? <button type="button" onClick={() => onDelete(app)} aria-label={`Remove ${app.name}`} title="Remove the app" className={cn(button, 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400')}><Trash2 className="h-4 w-4" aria-hidden="true" /></button> : empty(3)}
    </>;
  };
  // Each app with what is shown of it, worked out once for the cards and the table.
  const listed = rows.map(app => [app, facts(app)] as const);
  // The places the table keeps: one for each action that any app in the list has.
  const places = [listed.some(([, f]) => f.isLive), listed.some(([, f]) => f.data), listed.some(([, f]) => f.manage), !!onDelete && listed.some(([, f]) => f.manage)];
  const kept = places.filter(Boolean).length;
  const totals = `${apps.length.toLocaleString()} app${apps.length === 1 ? '' : 's'} · ${live.toLocaleString()} live · ${(apps.length - live).toLocaleString()} not live`;
  // Under the rows: the counts, what the page gave in their place, or (null) nothing at all.
  const foot = footer === undefined ? totals : footer;

  // The columns follow the room the list really has (the sidebar takes its share), not the screen.
  return <div className="@container/list">
    {/* A phone: a card per app. Nothing scrolls sideways, and every action is a finger wide. */}
    <div className="@xl/list:hidden">
      {sortable && apps.length > 1 && <label className="mb-2 flex items-center justify-end gap-2 text-xs text-slate-500 dark:text-slate-400">Sort by
        <select value={chosen} onChange={event => setSort(SORTS.find(([id]) => id === event.target.value)?.[2] ?? null)}
          className="min-h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white max-sm:min-h-11">
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>}
      <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
        {listed.map(([app, f]) => {
          return <li key={app.id} className="border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-slate-800">
            <div className="flex min-w-0 items-start gap-2.5">
              <AppTile app={app} size="sm" className="mt-1.5 size-8 flex-none rounded-lg" />
              <Link to={f.to} aria-label={app.name} aria-description={f.address} className="min-w-0 flex-1 rounded py-1 text-[15px] font-semibold leading-5 text-slate-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-white">
                <span className="block break-words">{app.name}</span>
                <span aria-hidden="true" title={f.address} className="mt-0.5 block truncate font-mono text-[11px] font-normal text-slate-600 dark:text-slate-400">{f.address}</span>
              </Link>
              <span className={cn('mt-1.5 inline-flex flex-none items-center gap-1.5 text-xs font-medium', f.tone)}><span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', f.dot)} />{f.status}</span>
            </div>
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
              {[f.kind, f.who, f.holds].filter(Boolean).map(fact => <span key={fact}>{fact}</span>)}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-1">
              <span className="text-xs text-slate-500 dark:text-slate-400">Updated {formatRelativeTime(app.updatedAt)}</span>
              <span className="ml-auto flex flex-none items-center">{actions(app, f, touch)}</span>
            </div>
          </li>;
        })}
      </ul>
      {foot !== null && <div className="px-1 pt-2 text-xs text-slate-500 dark:text-slate-400">{foot}</div>}
    </div>

    {/* With room for it: the table. Columns join as the list widens, so it never scrolls sideways. */}
    <div className="hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60 @xl/list:block">
      <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
        <caption className="sr-only">Your apps</caption>
        <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
          <tr>
            {heading('name', 'App', 'pl-3')}
            <th scope="col" className="hidden w-[104px] px-2 font-semibold uppercase tracking-wider @4xl/list:table-cell">App type</th>
            {heading('status', 'Status', 'w-[92px]')}
            <th scope="col" className="hidden w-32 px-2 font-semibold uppercase tracking-wider @5xl/list:table-cell">Who can use it</th>
            <th scope="col" className="hidden w-[164px] px-2 font-semibold uppercase tracking-wider @3xl/list:table-cell">Data</th>
            {heading('changed', 'Changed', 'w-20')}
            {/* As wide as its places: each is 32px, 2px apart, in a cell with 8px either side. */}
            <th scope="col" style={{ width: Math.max(1, kept) * 34 + 14 }} className="px-2 pr-3 text-right font-semibold uppercase tracking-wider"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {listed.map(([app, f]) => {
            return <tr key={app.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
              <th scope="row" className="py-2 pl-3 pr-2 font-normal">
                <div className="flex min-w-0 items-center gap-2.5">
                  <AppTile app={app} size="sm" className="size-8 flex-none rounded-lg" />
                  <div className="min-w-0">
                    <Link to={f.to} title={app.name} className="block truncate rounded text-sm font-semibold text-slate-900 hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-white dark:hover:text-primary-300">{app.name}</Link>
                    <div className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-slate-600 dark:text-slate-400">
                      <span className="truncate font-mono" title={f.address}>{f.address}</span>
                      {packNames[app.id] && <span title={packNames[app.id]} className="hidden min-w-0 items-center gap-1 truncate @5xl/list:inline-flex"><Package className="size-3 flex-none" aria-hidden="true" /><span className="truncate">{packNames[app.id]}</span></span>}
                    </div>
                  </div>
                </div>
              </th>
              <td className="hidden px-2 text-slate-600 dark:text-slate-300 @4xl/list:table-cell">{f.kind}</td>
              <td className="truncate px-2"><span className={cn('inline-flex items-center gap-1.5 font-medium', f.tone)}><span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', f.dot)} />{f.status}</span></td>
              <td className="hidden truncate px-2 text-slate-700 dark:text-slate-300 @5xl/list:table-cell">{f.who || '—'}</td>
              <td className="hidden break-words px-2 text-slate-700 dark:text-slate-300 @3xl/list:table-cell">{f.holds}</td>
              <td className="truncate px-2 text-slate-500 dark:text-slate-400">{formatRelativeTime(app.updatedAt)}</td>
              <td className="py-0.5 pl-2 pr-2 text-right"><span className="inline-flex items-center justify-end gap-0.5">{actions(app, f, small, places)}</span></td>
            </tr>;
          })}
        </tbody>
      </table>
      {foot !== null && <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">{foot}</div>}
    </div>
  </div>;
}

const small = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary-700 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300';
const touch = 'inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-primary-700 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300';
