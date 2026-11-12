// App data browser (manage-side): every form the app contains with its record count
// and quick links into the data — the owner responses view, the app runtime's records
// screen, and analytics. Reached from App settings → Manage → Records.
// One compact table, as the apps list is (components/apps/AppsTable): a row a form, the name
// taking the spare width, the actions as icons at the right. On a phone the same rows are cards.
import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useReturnTo } from '../../hooks/useReturnTo';
import { BarChart3, ExternalLink, Search, Table } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { PageBody } from '../../components/layout/PageBody';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Skeleton } from '../../components/ui/Skeleton';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
import { ExportDataMenu } from '../../components/apps/ExportDataMenu';
import { useAdminActing } from '../../components/admin/AdminActingContext';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { useFormStore } from '../../stores/formStore';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { cn } from '../../lib/utils';
import type { AppForm } from '../../types/app';
import { NativeAppPanel } from '../../components/studio/NativeAppPanel';

// An action in a table row, and the same action at a finger's size in a phone's card.
const small = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300';
const touch = 'inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300';

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
  const totals = `${rows.length.toLocaleString()} form${rows.length === 1 ? '' : 's'} · ${totalRecords.toLocaleString()} form record${totalRecords === 1 ? '' : 's'}`;

  /** What can be done with one form's records; `button` is the look for where they are drawn.
      A phone's card opens the records from the form's name, so it leaves that icon out. */
  const actions = (r: (typeof rows)[number], button: string, card = false) => (
    <>
      {!card && (
        <Link to={`/responses/${r.formId}`} title="View records" aria-label={`View records of ${r.name}`} className={button}>
          <Table className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
      <Link to={`/analytics/${r.formId}`} title="Analytics" aria-label={`Analytics for ${r.name}`} className={button}>
        <BarChart3 className="h-4 w-4" aria-hidden="true" />
      </Link>
      {app?.slug && (
        <a href={`/app/${app.slug}/form/${r.formId}/responses`} target="_blank" rel="noopener" title="Open in app" aria-label={`Open ${r.name} records in the app`} className={button}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      )}
    </>
  );
  const formIcon = (r: (typeof rows)[number], box: string) => (
    <span className={cn('flex flex-none items-center justify-center rounded-md bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400', box)} aria-hidden="true">
      <DynamicIcon name={r.icon} className="h-3.5 w-3.5" fallback={<Table className="h-3.5 w-3.5" />} />
    </span>
  );

  return (
    <div className="min-h-screen">
      <Header title="Records" back={{ onClick: () => navigate(backTo.path, { state: backTo.state }), label: `Back to ${backTo.label ?? "App settings"}` }} />
      <PageBody>
        {/* Which app, and what to do with all of its data: one row, then the forms. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="w-full sm:w-72">
            <Input
              placeholder="Search..."
              aria-label="Search forms"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              leftIcon={<Search className="h-4 w-4" />}
              className="py-2 text-sm max-sm:min-h-11 max-sm:text-base"
            />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-slate-400">
            <span className="font-medium text-gray-900 dark:text-white">{app?.name ?? 'This app'}</span>
            {' · '}{loading ? 'Loading…' : totals}
          </p>
          <div className="flex flex-none items-center gap-2 whitespace-nowrap">
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

        <div className="@container/list mt-3">
          {loading ? (
            <div className="space-y-1" role="status" aria-label="Loading forms">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-xl border border-gray-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/60">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">Couldn't load this app's forms</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{loadError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setReloadToken((n) => n + 1)}>Try again</Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-4 dark:border-slate-700">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">{query ? 'No forms match your search' : 'No forms in this app yet'}</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{query ? 'Try a different search term.' : 'Add forms to the app to start collecting data.'}</p>
              {query
                ? <Button variant="outline" size="sm" className="mt-3" onClick={() => setQuery('')}>Clear search</Button>
                : <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate(`/apps/${appId}/forms`)}>Manage forms</Button>}
            </div>
          ) : (
            <>
              {/* A phone: a card per form. Nothing scrolls sideways, and every action is a finger wide. */}
              <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @xl/list:hidden dark:border-slate-700 dark:bg-slate-900/60">
                {rows.map((r) => (
                  <li key={r.formId} className="flex items-center gap-2 border-b border-gray-100 py-1 pl-3 pr-1 last:border-b-0 dark:border-slate-800">
                    {formIcon(r, 'h-7 w-7')}
                    <Link to={`/responses/${r.formId}`} className="min-w-0 flex-1 py-1.5">
                      <span className="block truncate text-[15px] font-semibold text-gray-900 dark:text-white">{r.name}</span>
                      <span className="block text-xs tabular-nums text-gray-500 dark:text-slate-400">
                        {r.count.toLocaleString()} record{r.count === 1 ? '' : 's'}{r.isVisible ? '' : ' · hidden in app'}
                      </span>
                    </Link>
                    <span className="flex flex-none items-center">{actions(r, touch, true)}</span>
                  </li>
                ))}
              </ul>

              {/* With room for it: the table. */}
              <div className="hidden overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @xl/list:block dark:border-slate-700 dark:bg-slate-900/60">
                <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
                  <caption className="sr-only">Forms in this app and their records</caption>
                  <thead className="border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th scope="col" className="h-8 py-0 pl-3 pr-2 font-semibold uppercase tracking-wider">Form</th>
                      <th scope="col" className="w-28 px-2 text-right font-semibold uppercase tracking-wider">Records</th>
                      <th scope="col" className="w-32 px-2 font-semibold uppercase tracking-wider">In the app</th>
                      <th scope="col" className="w-[116px] px-2 pr-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.formId} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
                        <th scope="row" className="py-1 pl-3 pr-2 font-normal">
                          <div className="flex min-w-0 items-center gap-2">
                            {formIcon(r, 'h-6 w-6')}
                            <Link to={`/responses/${r.formId}`} title="View records" className="min-w-0 truncate font-semibold text-gray-900 hover:text-primary-700 dark:text-white dark:hover:text-primary-300">{r.name}</Link>
                          </div>
                        </th>
                        <td className="px-2 text-right tabular-nums text-gray-700 dark:text-slate-300">{r.count.toLocaleString()}</td>
                        <td className="truncate px-2 text-gray-500 dark:text-slate-400">{r.isVisible ? 'Shown' : 'Hidden in app'}</td>
                        <td className="py-0.5 pl-2 pr-2 text-right"><span className="inline-flex items-center justify-end gap-0.5">{actions(r, small)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="border-t border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">{totals}</div>
              </div>
            </>
          )}
        </div>

        {/* The app's own backend and database, for an app that has one. It used to stand above
            the forms, so the page's own list started halfway down the screen. */}
        {!acting && app && <div className="mt-6"><NativeAppPanel key={app.id} app={app} /></div>}
      </PageBody>
    </div>
  );
}

export default AppRecords;
