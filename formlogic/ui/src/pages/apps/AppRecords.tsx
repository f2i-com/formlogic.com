// App data browser (manage-side): every form the app contains with its record count
// and quick links into the data — the owner responses view, the app runtime's records
// screen, and analytics. Reached from App settings → Manage → Records.
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReturnTo } from '../../hooks/useReturnTo';
import { ArrowLeft, BarChart3, ExternalLink, Inbox, Search, Table } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
import { ExportDataMenu } from '../../components/apps/ExportDataMenu';
import { useAdminActing } from '../../components/admin/AdminActingContext';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { useFormStore } from '../../stores/formStore';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import type { AppForm } from '../../types/app';

export function AppRecords() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  // Origin-relative Back: opened from the App Studio this returns to its step.
  const backTo = useReturnTo(`/apps/${appId}/settings?tab=manage`);
  // Acting admins see record COUNTS only — no data export.
  const acting = useAdminActing();
  const { getApp, fetchApps } = useAppStore();
  const ownerForms = useFormStore((s) => s.forms);
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState('');

  const app = appId ? getApp(appId) : undefined;
  useDocumentTitle(app ? `${app.name} — Records` : 'App records');

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    const run = async () => {
      // The apps list may not be loaded on a hard refresh straight to this URL.
      if (!useAppStore.getState().apps.length) await fetchApps();
      // Read the API directly: the store helper returns [] for a FAILURE too, which
      // rendered "No forms in this app yet" — the opposite of the truth — and invited
      // the owner to go add forms they already have.
      const res = await api.getAppForms(appId);
      if (cancelled) return;
      if (res.error) {
        setLoadError(typeof res.error === 'string' ? res.error : "Couldn't load this app's forms.");
        setLoading(false);
        return;
      }
      setLoadError(null);
      setAppForms([...((res.data?.forms ?? []) as AppForm[])].sort((a, b) => a.sortOrder - b.sortOrder));
      setLoading(false);
    };
    void run();
    return () => { cancelled = true; };
  }, [appId, fetchApps, reloadToken]);

  // Join app forms with the owner's form records for counts + status.
  const rows = useMemo(() => {
    const byId = new Map(ownerForms.map((f) => [f.id, f]));
    const q = query.trim().toLowerCase();
    return appForms
      .map((af) => {
        const f = byId.get(af.formId);
        return {
          formId: af.formId,
          name: af.displayName || f?.title || 'Untitled form',
          icon: (af.settings?.icon as string | undefined) ?? f?.icon,
          count: f?.responseCount ?? 0,
          isVisible: af.isVisible,
        };
      })
      .filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [appForms, ownerForms, query]);

  const totalRecords = useMemo(() => rows.reduce((sum, r) => sum + r.count, 0), [rows]);

  return (
    <div className="min-h-screen">
      <Header title="Records" />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
        <button
          type="button"
          onClick={() => navigate(backTo.path, { state: backTo.state })}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer mb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
        >
          <ArrowLeft className="h-4 w-4" /> {backTo.label ?? `${app?.name ?? 'App'} settings`}
        </button>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">Data in {app?.name ?? 'this app'}</h1>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
              {loading ? 'Loading…' : `${rows.length} form${rows.length === 1 ? '' : 's'} · ${totalRecords} record${totalRecords === 1 ? '' : 's'} total`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!acting && appId && (
              <ExportDataMenu appId={appId} appSlug={app?.slug ?? 'app'} />
            )}
            {app?.slug && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener')}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                Open app
              </Button>
            )}
          </div>
        </div>

        <Input
          placeholder="Search..."
          aria-label="Search forms"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          leftIcon={<Search className="h-4 w-4" />}
          className="w-full sm:max-w-sm mb-4"
        />

        {loading ? (
          <div className="space-y-2" role="status" aria-label="Loading forms">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : loadError ? (
          <EmptyState
            icon={Inbox}
            title="Couldn't load this app's forms"
            description={loadError}
            action={<Button variant="outline" onClick={() => setReloadToken((n) => n + 1)}>Try again</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={query ? 'No forms match your search' : 'No forms in this app yet'}
            description={query ? 'Try a different search term.' : 'Add forms to the app to start collecting data.'}
            action={query
              ? <Button variant="outline" onClick={() => setQuery('')}>Clear search</Button>
              : <Button variant="outline" onClick={() => navigate(`/apps/${appId}/forms`)}>Manage forms</Button>}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 divide-y divide-gray-100 dark:divide-slate-800">
            {rows.map((r) => (
              <div
                key={r.formId}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/responses/${r.formId}`)}
                // Only the row itself opens records — a bubbled Enter from the nested
                // Analytics / Open-in-app buttons used to be preventDefaulted here, so
                // those controls were unreachable without a mouse.
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/responses/${r.formId}`); }
                }}
                title="View records"
                className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
              >
                <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
                  <DynamicIcon name={r.icon} className="h-4.5 w-4.5" fallback={<Table className="h-4 w-4" />} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400">
                    {r.count} record{r.count === 1 ? '' : 's'}{r.isVisible ? '' : ' · hidden in app'}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 flex-none" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/responses/${r.formId}`)}
                    leftIcon={<Table className="h-4 w-4" />}
                  >
                    <span className="hidden sm:inline">View records</span>
                    <span className="sm:hidden">Records</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => navigate(`/analytics/${r.formId}`)}
                    title="Analytics"
                    aria-label={`Analytics for ${r.name}`}
                    className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
                  >
                    <BarChart3 className="h-4 w-4" />
                  </button>
                  {app?.slug && (
                    <button
                      type="button"
                      onClick={() => window.open(`/app/${app.slug}/form/${r.formId}/responses`, '_blank', 'noopener')}
                      title="Open in app"
                      aria-label={`Open ${r.name} records in the app`}
                      className="hidden sm:block p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default AppRecords;
