// Unified SQLite Database panel for FormLogic Form Apps: turns every form in the app into
// a real SQLite table, syncs field changes, connects SoftN apps / shared API backends, and
// lets multiple Form Apps or SoftN frontends share the exact same live SQLite database.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Box,
  CheckCircle2,
  Database,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  Table2,
  Unlink,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { api, type AppDatabaseState } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { softnWorkspacePath } from '../../lib/softnApps';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';

export function AppDatabasePanel({
  appId,
  appName,
  readOnly = false,
}: {
  appId: string;
  appName: string;
  readOnly?: boolean;
}) {
  const navigate = useNavigate();
  const fetchApps = useAppStore((s) => s.fetchApps);
  const [state, setState] = useState<AppDatabaseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [creatingSoftn, setCreatingSoftn] = useState<'app' | 'api' | null>(null);
  const [linkingTarget, setLinkingTarget] = useState<string>('');
  const [savingLink, setSavingLink] = useState(false);
  const [attachingForms, setAttachingForms] = useState(false);

  const load = useCallback(async () => {
    if (typeof api.getAppDatabase !== 'function') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.getAppDatabase(appId);
      if (res.data) {
        setState(res.data);
        setLinkingTarget(res.data.sharedDatabaseAppId ?? '');
      }
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => deferEffect(() => { void load(); }), [load]);

  if (readOnly || typeof api.getAppDatabase !== 'function') return null;

  const handleEnable = async () => {
    setEnabling(true);
    try {
      const res = await api.enableAppSqliteDatabase(appId);
      if (res.error || !res.data) {
        toast.error('Could not enable Unified SQLite', res.error || 'Please try again.');
        return;
      }
      setState(res.data);
      await Promise.all([fetchApps(), useFormStore.getState().refreshForms()]);
      const count = res.data.synced?.length ?? res.data.tables.length;
      toast.success(
        'Unified SQLite Database enabled!',
        `${count} form${count === 1 ? '' : 's'} synced as live SQLite table${count === 1 ? '' : 's'}. SoftN apps & other Form apps can now share this database.`
      );
    } finally {
      setEnabling(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncAppSqliteDatabase(appId);
      if (res.error || !res.data) {
        toast.error('Sync failed', res.error || 'Please try again.');
        return;
      }
      setState(res.data);
      await useFormStore.getState().refreshForms();
      toast.success('SQLite tables synced', `All ${res.data.tables.length} tables are up to date with your form fields.`);
    } finally {
      setSyncing(false);
    }
  };

  const handleCreateSoftn = async (mode: 'app' | 'api') => {
    setCreatingSoftn(mode);
    try {
      const res = await api.createSoftnAppFromFormDatabase(appId, {
        mode,
        name: mode === 'api' ? `${appName} API` : `${appName} SoftN App`,
      });
      if (res.error || !res.data?.app) {
        toast.error('Could not create SoftN app', res.error || 'Please try again.');
        return;
      }
      await Promise.all([fetchApps(), load()]);
      toast.success(
        mode === 'api' ? 'Shared API Backend created!' : 'SoftN App created on this SQLite database!',
        `Connected live to ${res.data.tables.length} SQLite table${res.data.tables.length === 1 ? '' : 's'}.`
      );
      navigate(softnWorkspacePath(res.data.app.id, mode === 'api' ? 'api' : 'overview'));
    } finally {
      setCreatingSoftn(null);
    }
  };

  const handleSaveSharedLink = async (nextTarget: string | null) => {
    setSavingLink(true);
    try {
      const res = await api.setAppSharedDatabase(appId, nextTarget);
      if (res.error || !res.data) {
        toast.error('Could not update database link', res.error || 'Please try again.');
        return;
      }
      setState(res.data);
      setLinkingTarget(res.data.sharedDatabaseAppId ?? '');
      await fetchApps();
      toast.success(
        nextTarget ? 'Connected to shared SQLite database' : 'Switched back to own database',
        nextTarget
          ? `This Form App is now linked to ${res.data.databaseOwner?.name ?? 'the selected app'}'s SQLite database.`
          : 'This Form App now uses its own database.'
      );
    } finally {
      setSavingLink(false);
    }
  };

  const handleAttachSharedForms = async () => {
    const sourceId = linkingTarget || state?.sharedDatabaseAppId;
    if (!sourceId) {
      toast.info('Select an app first', 'Choose a SoftN App or SQLite Form App whose tables you want to attach as forms.');
      return;
    }
    setAttachingForms(true);
    try {
      const res = await api.attachFormsFromSharedDatabase(appId, {
        sourceAppId: sourceId,
        includeCharts: true,
      });
      if (res.error || !res.data) {
        toast.error('Could not attach forms', res.error || 'Please try again.');
        return;
      }
      setState(res.data.database);
      await fetchApps();
      toast.success(
        'Forms & charts attached!',
        `Added ${res.data.formsCreated.length} live SQLite-backed form(s) and ${res.data.reportsCreated} starter chart(s) to ${appName}.`
      );
    } finally {
      setAttachingForms(false);
    }
  };

  const isSharingAnother = !!state?.sharedDatabaseAppId && state.databaseOwner && state.databaseOwner.id !== appId;

  return (
    <section
      id="settings-database"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">
              Unified SQLite Database &amp; SoftN Sharing
            </h3>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
              Use this Form App&apos;s forms as real tables inside a shared SQLite database — so SoftN apps, shared API backends, and multiple Form frontends all read and write the same live records.
            </p>
          </div>
        </div>
        {state?.unifiedSqlite && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            SQLite Active ({state.tables.length} {state.tables.length === 1 ? 'table' : 'tables'})
          </span>
        )}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading database status…
        </div>
      ) : !state ? null : !state.unifiedSqlite && !state.hasDatabase ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/60 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <p className="text-sm font-medium text-emerald-950 dark:text-emerald-100">
              Turn your {state.appForms.length} form{state.appForms.length === 1 ? '' : 's'} into real SQLite tables
            </p>
            <p className="mt-1 text-xs text-emerald-800/90 dark:text-emerald-200/80">
              Existing responses are safely copied over with zero data loss. Any new form fields automatically add SQLite columns, and you can connect one or more SoftN apps right to these tables.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={() => void handleEnable()}
                isLoading={enabling}
                leftIcon={<Sparkles className="h-4 w-4" />}
              >
                Enable Unified SQLite Database
              </Button>
            </div>
          </div>

          {state.eligibleTargets.length > 0 && (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Or connect this Form App to an existing SoftN / SQLite database
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Build a separate Form frontend &amp; charts dashboard directly on top of another app&apos;s live SQLite tables.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={linkingTarget}
                  onChange={(e) => setLinkingTarget(e.target.value)}
                  className="h-10 min-w-[220px] flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option value="">Choose an app with a SQLite database…</option>
                  {state.eligibleTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.softnApp ? 'SoftN App' : 'Form App SQLite'}{t.tables !== null ? ` · ${t.tables} tables` : ''})
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => void handleAttachSharedForms()}
                  disabled={!linkingTarget}
                  isLoading={attachingForms}
                  leftIcon={<Link2 className="h-4 w-4" />}
                >
                  Link &amp; Add Forms
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {isSharingAnother && state.databaseOwner && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 dark:border-indigo-500/30 dark:bg-indigo-500/10">
              <div className="text-sm text-indigo-950 dark:text-indigo-100">
                <span className="font-semibold">Shared SQLite Database:</span> Reading &amp; writing{' '}
                <Link
                  to={state.databaseOwner.softnApp ? softnWorkspacePath(state.databaseOwner.id, 'data') : `/apps/${state.databaseOwner.id}/settings`}
                  className="font-semibold underline"
                >
                  {state.databaseOwner.name}
                </Link>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSaveSharedLink(null)}
                isLoading={savingLink}
                leftIcon={<Unlink className="h-3.5 w-3.5" />}
              >
                Unlink
              </Button>
            </div>
          )}

          {/* Big straightforward action buttons */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={() => void handleCreateSoftn('app')}
              isLoading={creatingSoftn === 'app'}
              disabled={creatingSoftn !== null}
              leftIcon={<Box className="h-4 w-4" />}
            >
              Create SoftN App on this DB
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={() => void handleCreateSoftn('api')}
              isLoading={creatingSoftn === 'api'}
              disabled={creatingSoftn !== null}
              leftIcon={<Server className="h-4 w-4" />}
            >
              Add Shared API Backend
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={() => void handleSync()}
              isLoading={syncing}
              leftIcon={<RefreshCw className="h-4 w-4" />}
            >
              Sync Forms → SQLite
            </Button>
          </div>

          {/* Live SQLite tables list */}
          {state.tables.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700">
              <div className="border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
                SQLite Tables ({state.tables.length})
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {state.tables.map((tbl) => {
                  const matchedForm = state.linkedForms.find((f) => f.table === tbl.name);
                  return (
                    <div key={tbl.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <Table2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span className="font-mono font-semibold text-slate-900 dark:text-white">{tbl.name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {tbl.columns.length} cols · {tbl.rows} {tbl.rows === 1 ? 'row' : 'rows'}
                        </span>
                      </div>
                      {matchedForm && (
                        <Link
                          to={`/responses/${matchedForm.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
                        >
                          Form: {matchedForm.title}
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Connected SoftN Apps & Form Frontends */}
          {(state.connectedApps.length > 0 || state.linkedSoftnApp) && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-700 dark:bg-slate-800/40">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Connected Apps Sharing This SQLite Database
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {state.linkedSoftnApp && !state.connectedApps.some((c) => c.id === state.linkedSoftnApp?.id) && (
                  <Link
                    to={softnWorkspacePath(state.linkedSoftnApp.id, 'overview')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:border-indigo-400 dark:border-indigo-500/30 dark:bg-slate-900 dark:text-indigo-300"
                  >
                    <Box className="h-3.5 w-3.5" />
                    {state.linkedSoftnApp.name} (SoftN App)
                  </Link>
                )}
                {state.connectedApps.map((ca) => (
                  <Link
                    key={ca.id}
                    to={ca.softnApp ? softnWorkspacePath(ca.id, 'overview') : `/apps/${ca.id}/settings`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:border-primary-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    {ca.softnApp ? <Box className="h-3.5 w-3.5 text-indigo-500" /> : <Database className="h-3.5 w-3.5 text-emerald-500" />}
                    {ca.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Link to another SQLite DB */}
          {!isSharingAnother && state.eligibleTargets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                value={linkingTarget}
                onChange={(e) => setLinkingTarget(e.target.value)}
                className="h-9 min-w-[220px] flex-1 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                <option value="">Switch to share another app&apos;s SQLite DB…</option>
                {state.eligibleTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.softnApp ? 'SoftN App' : 'Form App SQLite'}{t.tables !== null ? ` · ${t.tables} tables` : ''})
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={!linkingTarget}
                isLoading={savingLink}
                onClick={() => void handleSaveSharedLink(linkingTarget)}
              >
                Share DB
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!linkingTarget}
                isLoading={attachingForms}
                onClick={() => void handleAttachSharedForms()}
              >
                Link &amp; Add Forms
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
