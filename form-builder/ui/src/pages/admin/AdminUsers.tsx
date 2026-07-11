import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { api, type AdminUser } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';

/**
 * /admin/users — the user directory (counts only, never record data).
 * A row opens the user's own PAGE at /admin/users/:userId.
 */
export function AdminUsers() {
  const navigate = useNavigate();
  const tz = useAdminTimezone();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // setState only inside the promise callback so the effect body stays render-clean
  // (loading starts true; later searches keep the previous rows visible).
  const load = useCallback(() => {
    api.adminListUsers(search, page + 1).then((r) => {
      if (r.data) { setRows(r.data.users); setTotal(r.data.total); }
      setLoading(false);
    });
  }, [search, page]);
  useEffect(() => { load(); }, [load]);

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
          </p>
        </div>
      ),
    },
    {
      key: 'online', label: 'Presence',
      render: (u) => u.online
        ? <Badge variant="success">online</Badge>
        : <span className="text-xs text-gray-500 dark:text-slate-400">{u.lastSeenAt ? `seen ${formatDateTimeInZone(u.lastSeenAt, tz)}` : 'never seen'}</span>,
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
    <DataTable<AdminUser & Record<string, unknown>>
      data={rows as Array<AdminUser & Record<string, unknown>>}
      columns={columns as Column<AdminUser & Record<string, unknown>>[]}
      serverMode
      totalCount={total}
      page={page}
      onPageChange={setPage}
      searchValue={search}
      onSearchChange={(v) => { setSearch(v); setPage(0); }}
      searchable
      searchPlaceholder="Search email or name…"
      isLoading={loading}
      onRowClick={(u) => navigate(`/admin/users/${String(u.id)}`)}
      emptyMessage="No users match"
    />
  );
}
