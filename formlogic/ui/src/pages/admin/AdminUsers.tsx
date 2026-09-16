import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { api, type AdminUser } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { formatRelativeTime } from '../../lib/utils';
import { AdminError } from './adminUi';
import { useAdminQuery } from './useAdminQuery';

/**
 * /admin/users — the user directory (counts only, never record data).
 * A row opens the user's own PAGE at /admin/users/:userId.
 */
export function AdminUsers() {
  const navigate = useNavigate();
  const tz = useAdminTimezone();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const PAGE_SIZE = 25;
  const fetchUsers = useCallback(() => api.adminListUsers(search, page + 1, PAGE_SIZE), [search, page]);
  const { data, loading, error, refresh } = useAdminQuery(fetchUsers);
  const rows = data?.users ?? [];
  const total = data?.total ?? 0;

  const columns: Column<AdminUser>[] = useMemo(() => [
    {
      key: 'email', label: 'User',
      render: (u) => (
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-white truncate">{u.email}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400 truncate">
            {u.name || '—'}
            {u.isAdmin && <span className="ml-2 text-primary-600 dark:text-primary-400 font-semibold">admin</span>}
            {u.isDemo && <span className="ml-2 text-amber-600 dark:text-amber-400 font-semibold">demo</span>}
            {/* Code trust: this account's apps may ask for the host-JavaScript engine. */}
            {u.codeTrustVerified && <span className="ml-2 text-emerald-600 dark:text-emerald-400 font-semibold" title="Verified for host JavaScript">verified for host JavaScript</span>}
          </p>
        </div>
      ),
    },
    {
      key: 'online', label: 'Presence',
      // Compact relative time in the cell (the full admin-timezone timestamp is
      // on hover) — the absolute string was too long for the column.
      render: (u) => u.online
        ? <Badge variant="success">online</Badge>
        : (
          <span className="text-xs text-gray-500 dark:text-slate-400" title={u.lastSeenAt ? formatDateTimeInZone(u.lastSeenAt, tz) : undefined}>
            {u.lastSeenAt ? `seen ${formatRelativeTime(u.lastSeenAt)}` : 'never seen'}
          </span>
        ),
    },
    {
      key: 'resources', label: 'Resources',
      render: (u) => (
        <span className="text-xs text-gray-600 dark:text-slate-300">
          {u.appsCount ?? 0} apps · {u.formsCount ?? 0} forms · {u.flowsCount ?? 0} flows
        </span>
      ),
    },
    {
      key: 'responsesCount', label: 'Records',
      render: (u) => <span className="text-xs text-gray-600 dark:text-slate-300">{(u.responsesCount ?? 0).toLocaleString()}</span>,
    },
    { key: 'plan', label: 'Plan', render: (u) => <span className="text-xs">{u.plan}</span> },
  ], [tz]);

  return (
    <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm text-gray-500 dark:text-slate-400">Find an account to manage access, view its resources, or restore a backup.</p>
      {error && <AdminError message={error} onRetry={refresh} />}
    <DataTable<AdminUser & Record<string, unknown>>
      data={rows as Array<AdminUser & Record<string, unknown>>}
      columns={columns as Column<AdminUser & Record<string, unknown>>[]}
      serverMode
      totalCount={total}
      page={page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      searchValue={search}
      onSearchChange={(v) => { setSearch(v); setPage(0); }}
      searchable
      searchPlaceholder="Search email or name…"
      isLoading={loading}
      onRowClick={(u) => navigate(`/admin/users/${String(u.id)}`)}
      emptyMessage={error ? "User list unavailable" : search ? "No users match your search" : "No users yet"}
    />
    </div>
  );
}
