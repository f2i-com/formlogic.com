import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { api, type AdminUser } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { cn, formatRelativeTime } from '../../lib/utils';
import { AdminError } from './adminUi';
import { LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH } from '../../components/ui/listLook';
import { useAdminQuery } from './useAdminQuery';

const PAGE_SIZE = 25;
// A number has a column of its own, set to the right so the digits line up; on a card it
// stands at the left under its name.
const numberCell = cn(LIST_CELL, 'tabular-nums text-gray-700 dark:text-slate-300 @xl/list:text-right');
// Flows, then the plan, join the table once the user's own column has room beside them: a
// name and an address stay whole before a column is added. A card shows them all.
const whenWider = '@xl/list:hidden @2xl/list:table-cell';
const whenWidest = '@xl/list:hidden @3xl/list:table-cell';
const pagerButton = 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800 max-sm:h-11 max-sm:w-11';

/** A word after a user's name saying what kind of account it is. */
function Mark({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return <span title={title} className={cn('whitespace-nowrap rounded px-1 text-[10px] font-semibold leading-4', tone)}>{children}</span>;
}

/**
 * /admin/users — the user directory (counts only, never record data).
 * A row opens the user's own PAGE at /admin/users/:userId.
 */
export function AdminUsers() {
  const navigate = useNavigate();
  const tz = useAdminTimezone();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const fetchUsers = useCallback(() => api.adminListUsers(search, page + 1, PAGE_SIZE), [search, page]);
  const { data, loading, error, refresh } = useAdminQuery(fetchUsers);
  const rows = data?.users ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shown = Math.min(Math.max(0, page), pages - 1);

  // The whole row opens the user's page; the name is also a real link, for a new tab and the keyboard.
  const open = (event: MouseEvent, user: AdminUser) => {
    if ((event.target as HTMLElement).closest('a, button')) return;
    navigate(`/admin/users/${user.id}`);
  };

  return (
    <div className="@container/list space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search email or name…"
            aria-label="Search users"
            className="h-10 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500 max-sm:h-11"
          />
        </div>
        <p className="text-sm text-gray-500 dark:text-slate-400">Find an account to manage access, view its resources, or restore a backup.</p>
      </div>
      {error && <AdminError message={error} onRetry={refresh} />}

      <div className={LIST_BOX}>
        <table className={LIST_TABLE} aria-busy={loading}>
          <caption className="sr-only">Users</caption>
          <thead className={LIST_HEAD}>
            <tr>
              <th scope="col" className={cn(LIST_TH, 'pl-3')}>User</th>
              <th scope="col" className={cn(LIST_TH, 'w-24')}>Presence</th>
              <th scope="col" className={cn(LIST_TH, 'w-12 text-right')}>Apps</th>
              <th scope="col" className={cn(LIST_TH, 'w-14 text-right')}>Forms</th>
              <th scope="col" className={cn(LIST_TH, 'w-14 text-right', whenWider)}>Flows</th>
              <th scope="col" className={cn(LIST_TH, 'w-20 pr-3 text-right')}>Records</th>
              <th scope="col" className={cn(LIST_TH, 'w-24 pr-3', whenWidest)}>Plan</th>
            </tr>
          </thead>
          <tbody className={LIST_BODY}>
            {loading && !data ? Array.from({ length: 6 }, (_, i) => (
              // Rows of the height the real ones have, so the list does not jump when they arrive.
              <tr key={i} className={cn(LIST_ROW, 'hover:bg-transparent dark:hover:bg-transparent')}>
                <td colSpan={7} className={cn(LIST_CELL, '@xl/list:px-3')}><div className="shimmer my-1 h-7 rounded bg-gray-100 dark:bg-slate-800" /></td>
              </tr>
            )) : rows.length === 0 ? (
              <tr className="block @xl/list:table-row">
                <td colSpan={7} className="block px-3 py-3 text-sm text-gray-500 dark:text-slate-400 @xl/list:table-cell">
                  {error ? 'User list unavailable' : search ? 'No users match your search' : 'No users yet'}
                </td>
              </tr>
            ) : rows.map((u) => (
              // A card: the name and address across the top, then the six facts under their names,
              // three across on a phone and all six once the card is wide enough for one line.
              <tr key={u.id} onClick={(event) => open(event, u)} className={cn(LIST_ROW, 'grid cursor-pointer grid-cols-3 gap-x-3 gap-y-1.5 @md/list:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))_minmax(0,1.5fr)] @max-xl/list:relative')}>
                {/* Name over email, in full: this column takes the width the others leave, and a
                    long address wraps before it is cut. On a card the link is the whole card, so
                    a finger has all of it to press. */}
                <th scope="row" className={cn(LIST_CELL, 'col-span-full font-normal @xl/list:py-0.5 @xl/list:pl-3')}>
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <Link to={`/admin/users/${u.id}`} className="font-semibold text-gray-900 [overflow-wrap:anywhere] hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-white dark:hover:text-primary-300 max-sm:text-[15px] @max-xl/list:after:absolute @max-xl/list:after:inset-0">{u.name || u.email}</Link>
                    {u.isAdmin && <Mark tone="bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">admin</Mark>}
                    {u.isDemo && <Mark tone="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">demo</Mark>}
                    {/* Code trust: this account's apps may ask for the host-JavaScript engine. */}
                    {u.codeTrustVerified && <Mark tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" title="Verified for host JavaScript">verified for host JavaScript</Mark>}
                  </span>
                  {u.name && <span className="block text-xs leading-4 text-gray-500 [overflow-wrap:anywhere] dark:text-slate-400">{u.email}</span>}
                </th>
                <td className={LIST_CELL}>
                  <span className={LIST_LABEL}>Presence</span>
                  {/* Compact relative time in the cell (the full admin-timezone timestamp is on hover). */}
                  {u.online
                    ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />online</span>
                    : <span className="whitespace-nowrap text-xs text-gray-500 dark:text-slate-400" title={u.lastSeenAt ? formatDateTimeInZone(u.lastSeenAt, tz) : undefined}>{u.lastSeenAt ? `seen ${formatRelativeTime(u.lastSeenAt)}` : 'never seen'}</span>}
                </td>
                <td className={numberCell}><span className={LIST_LABEL}>Apps</span>{(u.appsCount ?? 0).toLocaleString()}</td>
                <td className={numberCell}><span className={LIST_LABEL}>Forms</span>{(u.formsCount ?? 0).toLocaleString()}</td>
                <td className={cn(numberCell, whenWider)}><span className={LIST_LABEL}>Flows</span>{(u.flowsCount ?? 0).toLocaleString()}</td>
                <td className={cn(numberCell, '@xl/list:pr-3')}><span className={LIST_LABEL}>Records</span>{(u.responsesCount ?? 0).toLocaleString()}</td>
                <td className={cn(LIST_CELL, 'text-gray-700 dark:text-slate-300 @xl/list:pr-3', whenWidest)}><span className={LIST_LABEL}>Plan</span>{u.plan}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-gray-200 px-3 py-1 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">
            <span className="py-1 tabular-nums">
              {pages > 1
                ? `Showing ${(shown * PAGE_SIZE + 1).toLocaleString()}–${Math.min((shown + 1) * PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`
                : `${total.toLocaleString()} user${total === 1 ? '' : 's'}`}
            </span>
            {pages > 1 && (
              <span className="flex items-center gap-1">
                <button type="button" onClick={() => setPage(Math.max(0, shown - 1))} disabled={shown === 0} aria-label="Previous page" className={pagerButton}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
                <span className="tabular-nums">Page {shown + 1} of {pages}</span>
                <button type="button" onClick={() => setPage(Math.min(pages - 1, shown + 1))} disabled={shown >= pages - 1} aria-label="Next page" className={pagerButton}><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
