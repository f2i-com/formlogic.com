import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Database,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type MarketplaceDemoField,
  type MarketplaceDemoSession,
  type MarketplaceDemoTable,
} from '../../lib/api';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';

interface DemoManagementViewProps {
  slug: string;
  appName: string;
  session: MarketplaceDemoSession | null;
  active: boolean;
  refreshTrigger: number;
  legacyFormAppSlug?: string | null;
  onDataMutated: () => void;
  onRequestReset?: () => void;
}

const CHART_PALETTE = ['#4f46e5', '#0d9488', '#d97706', '#2563eb', '#db2777', '#7c3aed', '#059669', '#ea580c'];

function formatCellValue(value: unknown, field?: MarketplaceDemoField): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (field && field.options.length > 0) {
    const match = field.options.find((opt) => opt.value === str);
    if (match) return match.label;
  }
  return str.length > 90 ? `${str.slice(0, 87)}…` : str;
}

function defaultFormValues(table: MarketplaceDemoTable, existing?: Record<string, unknown> | null): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of table.fields) {
    if (existing && existing[field.column] !== undefined && existing[field.column] !== null) {
      values[field.column] = String(existing[field.column]);
    } else if (field.type === 'dropdown' && field.options.length > 0 && field.required) {
      values[field.column] = field.options[0].value;
    } else {
      values[field.column] = '';
    }
  }
  return values;
}

function coerceFormPayload(table: MarketplaceDemoTable, draft: Record<string, string>): Record<string, unknown> {
  const colTypes = new Map(table.columns.map((c) => [c.name, c.type.toUpperCase()]));
  const payload: Record<string, unknown> = {};
  for (const field of table.fields) {
    const raw = draft[field.column] ?? '';
    const sqlType = colTypes.get(field.column) ?? '';
    if (raw === '') {
      payload[field.column] = '';
      continue;
    }
    if (field.type === 'number' || sqlType.includes('INT') || sqlType.includes('REAL') || sqlType.includes('NUM')) {
      const n = Number(raw);
      payload[field.column] = Number.isFinite(n) ? n : raw;
    } else {
      payload[field.column] = raw;
    }
  }
  return payload;
}

function statusPillClasses(value: string): string {
  const v = value.toLowerCase();
  if (['active', 'completed', 'done', 'paid', 'ready', 'approved', 'passed', 'resolved', 'delivered', 'open'].includes(v)) {
    return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30';
  }
  if (['pending', 'in_progress', 'in progress', 'scheduled', 'waiting', 'queued', 'draft', 'review', 'diagnosing'].includes(v)) {
    return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30';
  }
  if (['cancelled', 'failed', 'overdue', 'urgent', 'high', 'blocked', 'rejected', 'inactive'].includes(v)) {
    return 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30';
  }
  return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700';
}

export function DemoManagementView({
  slug,
  appName,
  session,
  active,
  refreshTrigger,
  legacyFormAppSlug,
  onDataMutated,
  onRequestReset,
}: DemoManagementViewProps) {
  const [tables, setTables] = useState<MarketplaceDemoTable[]>([]);
  const [selectedTableName, setSelectedTableName] = useState<string>('');
  const [showSystemTables, setShowSystemTables] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add / Edit form modal state
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const loadTables = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMarketplaceDemoTables(slug, session.token);
      if (res.error || !res.data) {
        setError(res.error || 'Could not load live sandbox tables.');
        return;
      }
      const nextTables = Array.isArray(res.data.tables) ? res.data.tables : [];
      setTables(nextTables);
      setSelectedTableName((prev) => {
        if (prev && nextTables.some((t) => t.name === prev)) return prev;
        const firstForm = nextTables.find((t) => t.isFormTable) ?? nextTables[0];
        return firstForm ? firstForm.name : '';
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load live sandbox tables.');
    } finally {
      setLoading(false);
    }
  }, [slug, session]);

  useEffect(() => {
    if (!session || !active) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getMarketplaceDemoTables(slug, session.token);
        if (cancelled) return;
        if (res.error || !res.data) {
          setError(res.error || 'Could not load live sandbox tables.');
          return;
        }
        const nextTables = Array.isArray(res.data.tables) ? res.data.tables : [];
        setError(null);
        setTables(nextTables);
        setSelectedTableName((prev) => {
          if (prev && nextTables.some((t) => t.name === prev)) return prev;
          const firstForm = nextTables.find((t) => t.isFormTable) ?? nextTables[0];
          return firstForm ? firstForm.name : '';
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load live sandbox tables.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, session, active, refreshTrigger]);

  const formTables = useMemo(() => tables.filter((t) => t.isFormTable), [tables]);
  const systemTables = useMemo(() => tables.filter((t) => !t.isFormTable), [tables]);
  const primaryTables = formTables.length > 0 ? formTables : tables;
  const activeTable = useMemo(
    () => tables.find((t) => t.name === selectedTableName) ?? primaryTables[0] ?? null,
    [tables, selectedTableName, primaryTables],
  );

  const totalDomainRecords = useMemo(
    () => primaryTables.reduce((sum, t) => sum + t.rowCount, 0),
    [primaryTables],
  );

  const recordsByTableChart = useMemo(
    () =>
      primaryTables.slice(0, 8).map((t) => ({
        name: t.title.length > 14 ? `${t.title.slice(0, 12)}…` : t.title,
        fullTitle: t.title,
        records: t.rowCount,
      })),
    [primaryTables],
  );

  const statusBreakdownChart = useMemo(() => {
    if (!activeTable) return { column: null as string | null, data: [] as { name: string; count: number }[] };
    const col = activeTable.statusColumn
      ?? activeTable.fields.find((f) => f.options.length > 0)?.column
      ?? null;
    if (!col) return { column: null, data: [] };
    const field = activeTable.fields.find((f) => f.column === col);
    const counts = new Map<string, number>();
    for (const row of activeTable.rows) {
      const label = formatCellValue(row[col], field);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const data = Array.from(counts.entries())
      .map(([name, count]) => ({ name: name.length > 16 ? `${name.slice(0, 14)}…` : name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    return { column: col, data };
  }, [activeTable]);

  const visibleColumns = useMemo(() => {
    if (!activeTable) return [] as { key: string; label: string; field?: MarketplaceDemoField }[];
    const fieldByCol = new Map(activeTable.fields.map((f) => [f.column, f]));
    const cols: { key: string; label: string; field?: MarketplaceDemoField }[] = [];
    if (activeTable.primaryKey) {
      cols.push({ key: activeTable.primaryKey, label: 'ID' });
    }
    for (const f of activeTable.fields) {
      if (f.column === activeTable.primaryKey) continue;
      cols.push({ key: f.column, label: f.label, field: f });
      if (cols.length >= 6) break;
    }
    if (cols.length <= 1) {
      for (const c of activeTable.columns) {
        if (c.name === activeTable.primaryKey) continue;
        cols.push({ key: c.name, label: c.name.replace(/_/g, ' '), field: fieldByCol.get(c.name) });
        if (cols.length >= 6) break;
      }
    }
    return cols;
  }, [activeTable]);

  const filteredRows = useMemo(() => {
    if (!activeTable) return [];
    const q = search.trim().toLowerCase();
    if (!q) return activeTable.rows;
    return activeTable.rows.filter((row) =>
      Object.values(row).some((val) => String(val ?? '').toLowerCase().includes(q)),
    );
  }, [activeTable, search]);

  const openCreateModal = () => {
    if (!activeTable) return;
    setEditingRow(null);
    setDraft(defaultFormValues(activeTable, null));
    setFormError(null);
    setEditorMode('create');
  };

  const openEditModal = (row: Record<string, unknown>) => {
    if (!activeTable) return;
    setEditingRow(row);
    setDraft(defaultFormValues(activeTable, row));
    setFormError(null);
    setEditorMode('edit');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !activeTable) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = coerceFormPayload(activeTable, draft);
      if (editorMode === 'edit' && editingRow && activeTable.primaryKey) {
        const pkVal = editingRow[activeTable.primaryKey];
        if (pkVal === undefined || pkVal === null) {
          setFormError('Could not determine record ID.');
          return;
        }
        const res = await api.updateMarketplaceDemoRecord(
          slug,
          session.token,
          activeTable.name,
          typeof pkVal === 'number' || typeof pkVal === 'string' ? pkVal : String(pkVal),
          payload,
        );
        if (res.error) {
          setFormError(res.error);
          return;
        }
        setNotice(`Updated record in ${activeTable.title}. Switch to SoftN App to see it live.`);
      } else {
        const res = await api.createMarketplaceDemoRecord(slug, session.token, activeTable.name, payload);
        if (res.error) {
          setFormError(res.error);
          return;
        }
        setNotice(`Added new record to ${activeTable.title}. Switch to SoftN App to see it live.`);
      }
      setEditorMode(null);
      setEditingRow(null);
      onDataMutated();
      await loadTables();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save record.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: Record<string, unknown>) => {
    if (!session || !activeTable || !activeTable.primaryKey) return;
    const pkVal = row[activeTable.primaryKey];
    if (pkVal === undefined || pkVal === null) return;
    const key = String(pkVal);
    setDeletingKey(key);
    setError(null);
    try {
      const res = await api.deleteMarketplaceDemoRecord(
        slug,
        session.token,
        activeTable.name,
        typeof pkVal === 'number' || typeof pkVal === 'string' ? pkVal : key,
      );
      if (res.error) {
        setError(res.error);
        return;
      }
      setNotice(`Deleted record #${key} from ${activeTable.title}. SoftN App stays in sync.`);
      onDataMutated();
      await loadTables();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete record.');
    } finally {
      setDeletingKey(null);
    }
  };

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Database className="h-8 w-8 animate-pulse text-primary-600 dark:text-primary-400" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Connecting to {appName} live SQLite sandbox…
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 py-5 dark:bg-slate-950 sm:px-6">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* Live-linked shared SQLite banner */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200/80 bg-gradient-to-r from-emerald-50/90 via-white to-indigo-50/70 px-4 py-3 shadow-xs dark:border-emerald-500/30 dark:from-emerald-500/10 dark:via-slate-900 dark:to-indigo-500/10">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <Database className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Live-Linked Shared SQLite Database
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Add, edit, or delete records here and switch back to <strong>SoftN App</strong> — both views read and write the exact same sandbox database.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadTables()}
              isLoading={loading}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              Sync now
            </Button>
            {onRequestReset && (
              <Button variant="outline" size="sm" onClick={onRequestReset}>
                Reset sandbox
              </Button>
            )}
            {legacyFormAppSlug && (
              <Link
                to={`/app/${encodeURIComponent(legacyFormAppSlug)}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Classic Form App
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>

        {notice && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              {notice}
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss message"
              className="rounded p-1 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200"
          >
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Linked Forms &amp; Tables
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{primaryTables.length}</p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Bound directly to {appName} SQLite schema
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Total Live Records
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{totalDomainRecords}</p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Shared live across SoftN UI &amp; Management
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Active Table
            </p>
            <p className="mt-1 truncate text-2xl font-bold text-slate-900 dark:text-white">
              {activeTable ? `${activeTable.title} (${activeTable.rowCount})` : '—'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {activeTable ? `SQLite table: ${activeTable.name}` : 'Select a form table below'}
            </p>
          </div>
        </div>

        {/* Live Charts Row */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Records by Form / Table
                </h2>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">Live SQLite counts</span>
            </div>
            <div className="h-52 w-full">
              {recordsByTableChart.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={recordsByTableChart} margin={{ top: 6, right: 12, left: -16, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="records" radius={[6, 6, 0, 0]}>
                      {recordsByTableChart.map((entry, idx) => (
                        <Cell key={entry.fullTitle} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">No table data yet</div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {activeTable && statusBreakdownChart.column
                    ? `${activeTable.title} by ${statusBreakdownChart.column.replace(/_/g, ' ')}`
                    : `${activeTable?.title ?? 'Table'} Breakdown`}
                </h2>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">Updates on edit</span>
            </div>
            <div className="h-52 w-full">
              {statusBreakdownChart.data.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusBreakdownChart.data} margin={{ top: 6, right: 12, left: -16, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      {statusBreakdownChart.data.map((entry, idx) => (
                        <Cell key={entry.name} fill={CHART_PALETTE[(idx + 1) % CHART_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  Select a table with categories or statuses to see live breakdown
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Main Split: Forms Sidebar + Live Records Table */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Management Forms
            </h2>
            <ul className="space-y-1">
              {primaryTables.map((t) => {
                const isSelected = activeTable?.name === t.name;
                return (
                  <li key={t.name}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTableName(t.name);
                        setSearch('');
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium transition',
                        isSelected
                          ? 'bg-primary-600 text-primary-foreground shadow-xs'
                          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ClipboardList className="h-4 w-4 shrink-0 opacity-85" aria-hidden="true" />
                        <span className="truncate">{t.title}</span>
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                          isSelected
                            ? 'bg-white/20 text-primary-foreground'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                        )}
                      >
                        {t.rowCount}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {systemTables.length > 0 && formTables.length > 0 && (
              <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowSystemTables((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  <span>Settings &amp; System ({systemTables.length})</span>
                  <span>{showSystemTables ? 'Hide' : 'Show'}</span>
                </button>
                {showSystemTables && (
                  <ul className="mt-1 space-y-1">
                    {systemTables.map((t) => {
                      const isSelected = activeTable?.name === t.name;
                      return (
                        <li key={t.name}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTableName(t.name);
                              setSearch('');
                            }}
                            className={cn(
                              'flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-left text-xs font-medium transition',
                              isSelected
                                ? 'bg-primary-600 text-primary-foreground'
                                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Table2 className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden="true" />
                              <span className="truncate">{t.title}</span>
                            </span>
                            <span className="tabular-nums opacity-80">{t.rowCount}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </aside>

          {/* Active Table Records & Actions */}
          <section className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-2xs dark:border-slate-800 dark:bg-slate-900">
            {activeTable ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5 dark:border-slate-800">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                        {activeTable.title}
                      </h2>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {activeTable.rowCount} {activeTable.rowCount === 1 ? 'record' : 'records'}
                      </span>
                    </div>
                    {activeTable.description && (
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {activeTable.description}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                      <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={`Search ${activeTable.title.toLowerCase()}…`}
                        aria-label={`Search ${activeTable.title}`}
                        className="h-9 w-48 rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:focus:bg-slate-800"
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={openCreateModal}
                      leftIcon={<Plus className="h-4 w-4" />}
                    >
                      Add {activeTable.title}
                    </Button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  {filteredRows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                        {search ? 'No matching records found' : `No records in ${activeTable.title} yet`}
                      </p>
                      {!search && (
                        <Button variant="primary" size="sm" onClick={openCreateModal} leftIcon={<Plus className="h-4 w-4" />}>
                          Add first record
                        </Button>
                      )}
                    </div>
                  ) : (
                    <table className="w-full border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
                          {visibleColumns.map((col) => (
                            <th key={col.key} className="px-4 py-2.5 whitespace-nowrap">
                              {col.label}
                            </th>
                          ))}
                          <th className="px-4 py-2.5 text-right whitespace-nowrap">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredRows.map((row, idx) => {
                          const pkVal = activeTable.primaryKey ? row[activeTable.primaryKey] : idx;
                          const rowKey = String(pkVal ?? idx);
                          return (
                            <tr key={rowKey} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                              {visibleColumns.map((col) => {
                                const raw = row[col.key];
                                const formatted = formatCellValue(raw, col.field);
                                const isStatus = col.key === activeTable.statusColumn && formatted !== '—';
                                return (
                                  <td key={col.key} className="max-w-[240px] truncate px-4 py-2.5 text-slate-800 dark:text-slate-200">
                                    {isStatus ? (
                                      <span
                                        className={cn(
                                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                                          statusPillClasses(String(raw ?? '')),
                                        )}
                                      >
                                        {formatted}
                                      </span>
                                    ) : (
                                      formatted
                                    )}
                                  </td>
                                );
                              })}
                              <td className="px-4 py-2.5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => openEditModal(row)}
                                    aria-label={`Edit record ${rowKey}`}
                                    className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                  >
                                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                    Edit
                                  </button>
                                  {activeTable.primaryKey && (
                                    <button
                                      type="button"
                                      disabled={deletingKey === rowKey}
                                      onClick={() => void handleDelete(row)}
                                      aria-label={`Delete record ${rowKey}`}
                                      className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-rose-200 px-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-950/40"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                      Delete
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : (
              <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {loading ? 'Loading live SQLite tables…' : 'No tables found in this sandbox.'}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Add / Edit Record Form Modal */}
      {editorMode && activeTable && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="demo-record-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
              <div>
                <h3 id="demo-record-modal-title" className="text-base font-semibold text-slate-900 dark:text-white">
                  {editorMode === 'edit' ? `Edit ${activeTable.title}` : `New ${activeTable.title}`}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Writes directly to live SQLite table <code className="font-mono">{activeTable.name}</code>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditorMode(null)}
                aria-label="Close form"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSave(e)} className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-3.5 overflow-y-auto px-5 py-4">
                {formError && (
                  <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
                    {formError}
                  </div>
                )}

                {activeTable.fields.map((field) => {
                  const id = `demo-field-${field.column}`;
                  const val = draft[field.column] ?? '';
                  const setVal = (next: string) => setDraft((prev) => ({ ...prev, [field.column]: next }));
                  return (
                    <div key={field.column} className="space-y-1">
                      <label htmlFor={id} className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                        {field.label}
                        {field.required && <span className="ml-0.5 text-rose-600">*</span>}
                      </label>
                      {field.options.length > 0 ? (
                        <select
                          id={id}
                          required={field.required}
                          value={val}
                          onChange={(e) => setVal(e.target.value)}
                          className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-primary-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        >
                          <option value="">Select {field.label}…</option>
                          {field.options.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : field.type === 'long_text' ? (
                        <textarea
                          id={id}
                          rows={3}
                          required={field.required}
                          value={val}
                          onChange={(e) => setVal(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        />
                      ) : (
                        <input
                          id={id}
                          type={
                            field.type === 'number'
                              ? 'number'
                              : field.type === 'date'
                                ? 'date'
                                : field.type === 'email'
                                  ? 'email'
                                  : 'text'
                          }
                          step={field.type === 'number' ? 'any' : undefined}
                          required={field.required}
                          value={val}
                          onChange={(e) => setVal(e.target.value)}
                          className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-primary-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/60">
                <Button type="button" variant="outline" size="sm" onClick={() => setEditorMode(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" isLoading={saving}>
                  {editorMode === 'edit' ? 'Save changes' : `Create ${activeTable.title}`}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
