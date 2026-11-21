// Shared-database, Management Form + Charts generator, and DB-linked automation hub
// shown at the top of a hosted SoftN app's Data section.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  Database,
  ExternalLink,
  LayoutDashboard,
  Link2,
  Loader2,
  Plus,
  Server,
  Sparkles,
  Table2,
  Unlink,
  Workflow,
  X,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { api } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { softnWorkspacePath } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import type { App } from '../../types/app';

function humanizeTableName(name: string): string {
  return name
    .replace(/^(?:ak|au|us|ohs)_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

interface DatabaseLinkState {
  appId: string;
  sharedDatabaseAppId: string | null;
  databaseAppId: string;
  databaseOwner: { id: string; name: string; slug: string } | null;
  eligibleTargets: { id: string; name: string; slug: string; tables: number | null; formDatabase?: boolean; softnApp?: boolean }[];
  connectedApps: { id: string; name: string; slug: string; softnApp: boolean }[];
  linkedForms: { id: string; title: string; table: string; status: string }[];
}

interface CreatedManagementResult {
  forms: { id: string; title: string }[];
  managementApp: App | null;
  reportsCreated: number;
}

export function SoftnDatabaseHub({
  app,
  readOnly,
  isOwner,
  activeTable,
  onDatabaseChanged,
}: {
  app: App;
  readOnly: boolean;
  isOwner: boolean;
  activeTable?: string;
  onDatabaseChanged?: () => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchApps = useAppStore((s) => s.fetchApps);
  const initialTool = searchParams.get('tool');
  const [openTool, setOpenTool] = useState<'manage' | 'share' | null>(
    initialTool === 'admin' || initialTool === 'manage'
      ? 'manage'
      : initialTool === 'share'
        ? 'share'
        : null,
  );
  const [linkState, setLinkState] = useState<DatabaseLinkState | null>(null);
  const [tables, setTables] = useState<Array<{ name: string; rows: number | null }>>([]);
  const [loading, setLoading] = useState(false);

  // Admin Panel CRUD Builder state (multi-select SQLite tables)
  const [selectedTables, setSelectedTables] = useState<string[] | null>(null);
  const [managementAppName, setManagementAppName] = useState(`${app.name} Admin Panel`);
  const [includeCharts, setIncludeCharts] = useState(true);
  const [creatingMgmt, setCreatingMgmt] = useState(false);
  const [createdMgmt, setCreatedMgmt] = useState<CreatedManagementResult | null>(null);

  // Shared DB link & secondary API backend state
  const [targetAppId, setTargetAppId] = useState<string>('');
  const [savingLink, setSavingLink] = useState(false);
  const [creatingApi, setCreatingApi] = useState(false);

  // Keep deep-linked ?tool=admin or ?tool=share responsive without leaving stale params
  useEffect(() => {
    const t = searchParams.get('tool');
    if (t === 'admin' || t === 'manage') {
      return deferEffect(() => {
        setOpenTool('manage');
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('tool');
          return next;
        }, { replace: true });
      });
    }
    if (t === 'share') {
      return deferEffect(() => {
        setOpenTool('share');
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('tool');
          return next;
        }, { replace: true });
      });
    }
    return undefined;
  }, [searchParams, setSearchParams]);

  const effectiveSelectedTables = useMemo(() => {
    if (selectedTables !== null) {
      const valid = new Set(tables.map((t) => t.name));
      return selectedTables.filter((name) => valid.has(name));
    }
    if (activeTable && tables.some((t) => t.name === activeTable)) {
      return tables.map((t) => t.name);
    }
    return tables.map((t) => t.name);
  }, [selectedTables, tables, activeTable]);

  const linkedByTable = useMemo(() => {
    const map = new Map<string, { id: string; title: string }>();
    for (const f of linkState?.linkedForms ?? []) {
      if (!map.has(f.table)) map.set(f.table, { id: f.id, title: f.title });
    }
    return map;
  }, [linkState]);

  const toggleTableSelection = (tableName: string) => {
    const current = effectiveSelectedTables;
    if (current.includes(tableName)) {
      setSelectedTables(current.filter((t) => t !== tableName));
    } else {
      setSelectedTables([...current, tableName]);
    }
  };

  const loadHub = useCallback(async () => {
    if (!isOwner || readOnly) return;
    if (typeof api.getNativeDatabaseLink !== 'function' || typeof api.getNativeDataSummary !== 'function') return;
    setLoading(true);
    try {
      const [linkRes, dataRes] = await Promise.all([
        api.getNativeDatabaseLink(app.id),
        api.getNativeDataSummary(app.id),
      ]);
      if (linkRes.data) {
        setLinkState(linkRes.data);
        setTargetAppId(linkRes.data.sharedDatabaseAppId ?? '');
      }
      if (dataRes.data) {
        const list = dataRes.data.summary?.tables
          ? dataRes.data.summary.tables.map((t) => ({ name: t.name, rows: t.rows }))
          : (dataRes.data.tables ?? []).map((name) => ({ name, rows: null }));
        setTables(list);
      }
    } finally {
      setLoading(false);
    }
  }, [app.id, isOwner, readOnly]);

  useEffect(() => deferEffect(() => { void loadHub(); }), [loadHub]);

  if (!isOwner || readOnly) return null;

  const isSharingAnother = !!linkState?.sharedDatabaseAppId && linkState.databaseOwner && linkState.databaseOwner.id !== app.id;
  const connectedCount = linkState?.connectedApps.length ?? 0;
  const linkedFormsCount = linkState?.linkedForms.length ?? 0;

  const handleCreateManagement = async () => {
    if (tables.length === 0) {
      toast.info('No tables yet', 'Open your app or run a backend route once to create database tables first.');
      return;
    }
    if (effectiveSelectedTables.length === 0) {
      toast.info('Select at least one table', 'Choose one or more SQLite tables to include in your Admin Panel.');
      return;
    }
    setCreatingMgmt(true);
    setCreatedMgmt(null);
    try {
      const payload =
        effectiveSelectedTables.length === 1
          ? { table: effectiveSelectedTables[0], appName: managementAppName.trim() || `${app.name} Admin Panel`, includeCharts }
          : { tables: effectiveSelectedTables, appName: managementAppName.trim() || `${app.name} Admin Panel`, includeCharts };
      const res = await api.createManagementFormFromTable(app.id, payload);
      if (res.error || !res.data) {
        toast.error('Could not build Admin Panel', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      setCreatedMgmt({
        forms: res.data.forms,
        managementApp: res.data.managementApp,
        reportsCreated: res.data.reportsCreated,
      });
      toast.success(
        'Admin Panel built!',
        `${res.data.forms.length} live CRUD form${res.data.forms.length === 1 ? '' : 's'} and ${res.data.reportsCreated} chart${res.data.reportsCreated === 1 ? '' : 's'} connected to this SQLite database.`,
      );
      await Promise.all([fetchApps(), loadHub()]);
    } finally {
      setCreatingMgmt(false);
    }
  };

  const handleSaveDatabaseLink = async (nextTarget: string | null) => {
    setSavingLink(true);
    try {
      const res = await api.setNativeDatabaseLink(app.id, nextTarget);
      if (res.error || !res.data) {
        toast.error('Could not update database link', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      setLinkState(res.data);
      setTargetAppId(res.data.sharedDatabaseAppId ?? '');
      await fetchApps();
      onDatabaseChanged?.();
      toast.success(
        nextTarget ? 'Database linked' : 'Database unlinked',
        nextTarget
          ? `This app now reads and writes ${res.data.databaseOwner?.name ?? 'the selected app'}'s SQLite database directly.`
          : 'This app is now using its own standalone SQLite database.',
      );
    } finally {
      setSavingLink(false);
    }
  };

  const handleCreateSharedApiBackend = async () => {
    setCreatingApi(true);
    try {
      const res = await api.createSharedApiBackend(app.id, { name: `${app.name} API` });
      if (res.error || !res.data?.app) {
        toast.error('Could not create shared-DB API backend', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      await fetchApps();
      toast.success('Shared-DB API backend created', `Connected directly to ${app.name}'s SQLite database.`);
      navigate(softnWorkspacePath(res.data.app.id, 'api'));
    } finally {
      setCreatingApi(false);
    }
  };

  return (
    <section
      aria-label="Database actions"
      className="mt-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      {/* Always-visible big, easy-to-use action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <Database className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" />
            {isSharingAnother ? (
              <span>
                Shared DB from{' '}
                <Link
                  to={softnWorkspacePath(linkState.databaseOwner!.id, 'data')}
                  className="text-primary-700 underline underline-offset-2 dark:text-primary-300"
                >
                  {linkState.databaseOwner!.name}
                </Link>
              </span>
            ) : (
              <span>Primary SQLite DB</span>
            )}
          </span>
          {connectedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Link2 className="h-3 w-3" />
              {connectedCount} shared {connectedCount === 1 ? 'app' : 'apps'}
            </span>
          )}
          {linkedFormsCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <BarChart3 className="h-3 w-3" />
              {linkedFormsCount} linked {linkedFormsCount === 1 ? 'form' : 'forms'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={openTool === 'manage' ? 'primary' : 'primary'}
            onClick={() => setOpenTool((cur) => (cur === 'manage' ? null : 'manage'))}
            leftIcon={<LayoutDashboard className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            Build Admin Panel (CRUD)
          </Button>
          <Button
            size="sm"
            variant={openTool === 'share' ? 'primary' : 'outline'}
            onClick={() => setOpenTool((cur) => (cur === 'share' ? null : 'share'))}
            leftIcon={<Link2 className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            Share Database
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleCreateSharedApiBackend()}
            isLoading={creatingApi}
            leftIcon={<Server className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            + API Backend
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(softnWorkspacePath(app.id, 'automations'))}
            leftIcon={<Workflow className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            Link Flow
          </Button>
        </div>
      </div>

      {/* Expandable Tool 1: Visual 1-Click Admin Panel CRUD & Charts Builder over SQLite tables */}
      {openTool === 'manage' && (
        <div className="mt-3 rounded-xl border border-primary-200/80 bg-gradient-to-br from-primary-50/60 via-white to-indigo-50/40 p-4 dark:border-primary-500/30 dark:from-primary-500/10 dark:via-slate-900 dark:to-indigo-500/10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
                <Sparkles className="h-4 w-4 text-primary-600 dark:text-primary-400" />
                1-Click Admin Panel CRUD Builder
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                Pick the SQLite tables you want to manage and FormLogic generates a ready-to-use Admin Panel with Create / Edit / Delete forms, searchable data tables, KPI cards, and charts — reading and writing this exact SQLite database live.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpenTool(null)}
              aria-label="Close panel"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Step 1: Visual SQLite table selector cards */}
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                1. Choose SQLite tables ({effectiveSelectedTables.length} of {tables.length} selected)
              </span>
              {tables.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setSelectedTables(tables.map((t) => t.name))}
                    className="cursor-pointer font-medium text-primary-600 hover:underline dark:text-primary-400"
                  >
                    Select all
                  </button>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <button
                    type="button"
                    onClick={() => setSelectedTables(tables.filter((t) => !linkedByTable.has(t.name)).map((t) => t.name))}
                    className="cursor-pointer font-medium text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-white"
                  >
                    Only new
                  </button>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <button
                    type="button"
                    onClick={() => setSelectedTables([])}
                    className="cursor-pointer font-medium text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            {loading ? (
              <p className="mt-2.5 flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Inspecting SQLite tables…
              </p>
            ) : tables.length === 0 ? (
              <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                No SQLite tables detected yet. Open your SoftN app or run a backend route once so its schema initializes, then come back here.
              </div>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tables.map((t) => {
                  const checked = effectiveSelectedTables.includes(t.name);
                  const existingForm = linkedByTable.get(t.name);
                  return (
                    <button
                      key={t.name}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => toggleTableSelection(t.name)}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-left transition-all',
                        checked
                          ? 'border-primary-400 bg-white shadow-xs ring-1 ring-primary-200 dark:border-primary-500/60 dark:bg-slate-900 dark:ring-primary-500/20'
                          : 'border-slate-200 bg-white/70 opacity-75 hover:opacity-100 dark:border-slate-700 dark:bg-slate-900/60',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                          checked
                            ? 'border-primary-600 bg-primary-600 text-white'
                            : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800',
                        )}
                      >
                        {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                            {humanizeTableName(t.name)}
                          </span>
                          {t.rows !== null && (
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {t.rows} {t.rows === 1 ? 'row' : 'rows'}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Table2 className="h-3 w-3" />
                            {t.name}
                          </span>
                          {existingForm && (
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                              Linked form
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 2: Name, Charts toggle & 1-click Build */}
          <div className="mt-4 grid gap-3 border-t border-primary-200/60 pt-4 dark:border-primary-500/20 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                  2. Admin Panel name
                </span>
                <input
                  type="text"
                  value={managementAppName}
                  onChange={(e) => setManagementAppName(e.target.value)}
                  disabled={creatingMgmt}
                  placeholder={`${app.name} Admin Panel`}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                />
              </label>
              <Switch
                checked={includeCharts}
                onChange={setIncludeCharts}
                label="Include KPI cards, breakdown charts & live records dashboard"
                size="sm"
              />
            </div>

            <Button
              size="lg"
              onClick={() => void handleCreateManagement()}
              isLoading={creatingMgmt}
              disabled={loading || effectiveSelectedTables.length === 0}
              leftIcon={<LayoutDashboard className="h-4 w-4" />}
              className="min-h-11 px-5 font-semibold"
            >
              Build Admin Panel ({effectiveSelectedTables.length})
            </Button>
          </div>

          {effectiveSelectedTables.length > 0 && !createdMgmt && (
            <p className="mt-2.5 text-xs text-slate-600 dark:text-slate-400">
              Will generate <strong>{effectiveSelectedTables.length}</strong> live CRUD {effectiveSelectedTables.length === 1 ? 'form' : 'forms'}
              {includeCharts ? ' + starter KPIs & charts' : ''} inside a dedicated FormLogic Admin App backed directly by this SQLite database.
            </p>
          )}

          {createdMgmt && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/15">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-emerald-900 dark:text-emerald-100">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    Admin Panel ready! Created <strong>{createdMgmt.forms.length}</strong> live CRUD {createdMgmt.forms.length === 1 ? 'form' : 'forms'}
                    {createdMgmt.reportsCreated > 0 ? ` and ${createdMgmt.reportsCreated} starter charts` : ''} synced to SQLite.
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {createdMgmt.managementApp && (
                    <>
                      <a
                        href={`/app/${encodeURIComponent(createdMgmt.managementApp.slug)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open Live Admin Panel
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/apps/${createdMgmt.managementApp!.id}/studio`)}
                        rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
                      >
                        Customize in Studio
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {createdMgmt.forms.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-emerald-200/80 pt-2.5 dark:border-emerald-500/20">
                  <span className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">Generated forms:</span>
                  {createdMgmt.forms.map((f) => (
                    <Link
                      key={f.id}
                      to={`/builder/${f.id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-300/80 bg-white px-2 py-0.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100/60 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-emerald-200"
                    >
                      {f.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {linkState && linkState.linkedForms.length > 0 && (
            <div className="mt-3 border-t border-primary-200/60 pt-3 dark:border-primary-500/20">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                All forms linked to this SQLite database ({linkState.linkedForms.length})
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {linkState.linkedForms.map((f) => (
                  <Link
                    key={f.id}
                    to={`/builder/${f.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-primary-400 hover:text-primary-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-primary-500"
                  >
                    <span>{f.title}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                      {f.table}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expandable Tool 2: Share Database Across Apps */}
      {openTool === 'share' && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/50">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                <Link2 className="h-4 w-4 text-primary-600 dark:text-primary-400" />
                Share SQLite Database Across Apps
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                Connect multiple SoftN apps, PHP/Rust/JS apps, or secondary API backends in your account to the exact same live SQLite database (WAL mode, real-time sync).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpenTool(null)}
              aria-label="Close panel"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/70 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {loading ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading database links…
            </p>
          ) : (
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-700 dark:bg-slate-900">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Which database does {app.name} use?</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <select
                    value={targetAppId}
                    onChange={(e) => setTargetAppId(e.target.value)}
                    disabled={savingLink || connectedCount > 0}
                    className="h-10 min-w-0 flex-1 cursor-pointer rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                  >
                    <option value="">Use {app.name}&rsquo;s own database</option>
                    {(linkState?.eligibleTargets ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        Share database of: {t.name} ({t.formDatabase ? 'Form App SQLite' : 'SoftN App'}{t.tables !== null ? ` · ${t.tables} tables` : ''})
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={() => void handleSaveDatabaseLink(targetAppId || null)}
                    isLoading={savingLink}
                    disabled={connectedCount > 0 || targetAppId === (linkState?.sharedDatabaseAppId ?? '')}
                    className="h-10 px-4 font-semibold"
                  >
                    Apply
                  </Button>
                </div>
                {connectedCount > 0 && (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Other apps already connect to this app&rsquo;s database. Unlink them first if you want this app to point elsewhere.
                  </p>
                )}
                {isSharingAnother && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2.5"
                    onClick={() => void handleSaveDatabaseLink(null)}
                    isLoading={savingLink}
                    leftIcon={<Unlink className="h-3.5 w-3.5" />}
                  >
                    Disconnect &amp; use own database
                  </Button>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Connected apps &amp; API backends</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCreateSharedApiBackend()}
                    isLoading={creatingApi}
                    leftIcon={<Plus className="h-3.5 w-3.5" />}
                  >
                    New API Backend
                  </Button>
                </div>
                {linkState && linkState.connectedApps.length > 0 ? (
                  <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                    {linkState.connectedApps.map((sibling) => (
                      <li key={sibling.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{sibling.name}</span>
                        <Link
                          to={sibling.softnApp ? softnWorkspacePath(sibling.id, 'api') : `/apps/${sibling.id}/studio`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600 hover:underline dark:text-primary-400"
                        >
                          Open <ArrowRight className="h-3 w-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    No other apps connected yet. Spin up a dedicated <strong>API Backend</strong> on this database, or link any other SoftN app from its Data tab.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
