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
import { isSoftnApp, softnWorkspacePath } from '../../lib/softnApps';
import { cn, formatRelativeTime, parseServerDate } from '../../lib/utils';
import { holds, who } from '../../lib/appFacts';
import type { App, AppSummary } from '../../types/app';

type SortKey = 'name' | 'status' | 'changed';
type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;
export interface AppsTableProps {
  apps: App[];
  /** By app id; an app without an entry shows what it says itself. */
  summaries: Record<string, AppSummary>;
  packNames: Record<string, string>;
  canManage: (app: App) => boolean;
  /** Where the owner manages the app (a SoftN app's page, or the App Studio). */
  managePath: (app: App) => string;
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

export function AppsTable({ apps, summaries, packNames, canManage, managePath, onDelete, sortable = true, footer }: AppsTableProps) {
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
    const softn = isSoftnApp(app);
    const manage = canManage(app);
    const isLive = app.status === 'published';
    return {
      softn, manage, isLive,
      status: listedStatus(app, summary),
      tone: isLive ? 'text-emerald-700 dark:text-emerald-400' : app.status === 'archived' ? 'text-slate-500 dark:text-slate-400' : 'text-amber-700 dark:text-amber-300',
      dot: isLive ? 'bg-emerald-500' : app.status === 'archived' ? 'bg-slate-400' : 'bg-amber-500',
      address: summary?.domain || `/app/${app.slug}`,
      openAt: summary?.domain ? `https://${summary.domain}` : `/app/${app.slug}`,
      kind: isDemoLocalId(app.id) ? 'Browser only' : softn ? 'SoftN' : 'Forms',
      who: who(app, summary), holds: holds(app, summary),
      to: manage ? managePath(app) : `/app/${app.slug}`,
      hasData: manage && softn && summary?.tables != null,
      settings: softn ? softnWorkspacePath(app.id, 'settings') : `/apps/${app.id}/settings`,
    };
  };
  /** The four things to do with an app; `button` is the look for where they are drawn. */
  const actions = (app: App, f: ReturnType<typeof facts>, button: string): ReactNode => <>
    {f.isLive && <a href={f.openAt} target="_blank" rel="noopener noreferrer" aria-label={`Open ${app.name}`} title="Open the app" className={button}><ExternalLink className="h-4 w-4" aria-hidden="true" /></a>}
    {f.hasData && <Link to={softnWorkspacePath(app.id, 'data')} aria-label={`Data of ${app.name}`} title="Data" className={button}><Database className="h-4 w-4" aria-hidden="true" /></Link>}
    {f.manage && <Link to={f.settings} aria-label={`Settings of ${app.name}`} title="Settings" className={button}><Settings className="h-4 w-4" aria-hidden="true" /></Link>}
    {f.manage && onDelete && <button type="button" onClick={() => onDelete(app)} aria-label={`Remove ${app.name}`} title="Remove the app" className={cn(button, 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400')}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}
  </>;
  const totals = `${apps.length.toLocaleString()} app${apps.length === 1 ? '' : 's'} · ${live.toLocaleString()} live · ${(apps.length - live).toLocaleString()} not live`;
  // Under the rows: the counts, what the page gave in their place, or (null) nothing at all.
  const foot = footer === undefined ? totals : footer;

  // The columns follow the room the list really has (the sidebar takes its share), not the screen.
  return <div className="@container/list">
    {/* A phone: a card per app. Nothing scrolls sideways, and every action is a finger wide. */}
    <div className="@xl/list:hidden">
      {sortable && <label className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">Sort by
        <select value={chosen} onChange={event => setSort(SORTS.find(([id]) => id === event.target.value)?.[2] ?? null)}
          className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white">
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>}
      <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
        {rows.map(app => {
          const f = facts(app);
          return <li key={app.id} className="border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-slate-800">
            <div className="flex min-w-0 items-center gap-2">
              <AppTile app={app} size="sm" className="h-7 w-7 flex-none rounded-md" />
              <Link to={f.to} className="min-w-0 flex-1 truncate py-2.5 text-[15px] font-semibold text-slate-900 dark:text-white">{app.name}</Link>
              <span className={cn('inline-flex flex-none items-center gap-1.5 text-xs font-medium', f.tone)}><span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', f.dot)} />{f.status}</span>
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-slate-600 dark:text-slate-300">{f.address}</p>
            <div className="mt-1 flex items-center gap-2">
              {/* Each fact stays whole: the line breaks between facts, never inside "8 tables · 1.5 MB". */}
              <p className="flex min-w-0 flex-1 flex-wrap gap-x-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {[f.kind, f.who, f.holds, formatRelativeTime(app.updatedAt)].filter(Boolean).map(fact => <span key={fact} className="whitespace-nowrap">{fact}</span>)}
              </p>
              <span className="flex flex-none items-center">{actions(app, f, touch)}</span>
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
            <th scope="col" className="hidden w-[200px] px-2 font-semibold uppercase tracking-wider @5xl/list:table-cell">Address</th>
            {heading('status', 'Status', 'w-[92px]')}
            <th scope="col" className="hidden w-32 px-2 font-semibold uppercase tracking-wider @5xl/list:table-cell">Who can use it</th>
            <th scope="col" className="hidden w-[148px] px-2 font-semibold uppercase tracking-wider @3xl/list:table-cell">Data</th>
            {heading('changed', 'Changed', 'w-20')}
            <th scope="col" className={cn('px-2 pr-3 text-right font-semibold uppercase tracking-wider', onDelete ? 'w-[136px]' : 'w-[104px]')}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(app => {
            const f = facts(app);
            return <tr key={app.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
              <th scope="row" className="py-1 pl-3 pr-2 font-normal">
                <div className="flex min-w-0 items-center gap-2">
                  <AppTile app={app} size="sm" className="h-6 w-6 flex-none rounded-md" />
                  <Link to={f.to} className="min-w-0 truncate font-semibold text-slate-900 hover:text-primary-700 dark:text-white dark:hover:text-primary-300">{app.name}</Link>
                  <span className="flex-none rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{f.kind}</span>
                  {packNames[app.id] && <span className="hidden min-w-0 items-center gap-1 truncate text-[11px] text-slate-500 dark:text-slate-400 2xl:inline-flex"><Package className="h-3 w-3 flex-none" aria-hidden="true" /><span className="truncate">{packNames[app.id]}</span></span>}
                </div>
              </th>
              <td className="hidden px-2 @5xl/list:table-cell"><span className="block truncate font-mono text-xs text-slate-600 dark:text-slate-300">{f.address}</span></td>
              <td className="truncate px-2"><span className={cn('inline-flex items-center gap-1.5 font-medium', f.tone)}><span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', f.dot)} />{f.status}</span></td>
              <td className="hidden truncate px-2 text-slate-700 dark:text-slate-300 @5xl/list:table-cell">{f.who}</td>
              <td className="hidden truncate px-2 text-slate-700 dark:text-slate-300 @3xl/list:table-cell">{f.holds}</td>
              <td className="truncate px-2 text-slate-500 dark:text-slate-400">{formatRelativeTime(app.updatedAt)}</td>
              <td className="py-0.5 pl-2 pr-2 text-right"><span className="inline-flex items-center justify-end gap-0.5">{actions(app, f, small)}</span></td>
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
