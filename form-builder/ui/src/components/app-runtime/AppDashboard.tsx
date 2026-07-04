import { useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Send, Eye, LayoutGrid, BarChart3, ArrowRight, Plus } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api } from '../../lib/api';
import { cn, parseServerDate, formatRelativeTime } from '../../lib/utils';
import type { AppRuntimeForm, AppSettings } from '../../types/app';

// Cheap-data budget: first page of at most this many viewable forms, fetched in parallel.
const STAT_FORMS_CAP = 6;
const SERVER_PAGE = 25; // rows per form in server mode (mirrors AppDataTable's page size)
const DEMO_PAGE = 200; // demo merges the browser overlay, so fetch a bounded batch and count it
const RECENT_LIMIT = 6;
const QUICK_ACTIONS_CAP = 6;

// Field types whose answer makes a sensible one-line record title, checked in form-field order.
const TITLE_FIELD_TYPES = new Set([
  'short_text', 'email', 'phone', 'url', 'dropdown', 'long_text', 'number', 'date', 'datetime', 'time',
]);

type RuntimeField = {
  id: string;
  label?: string;
  type: string;
  properties?: { options?: Array<{ value: string; label?: string }> };
};

type FormPulse = {
  form: AppRuntimeForm;
  rows: Record<string, unknown>[];
  total: number;
  capped?: boolean;
};

type RecentRow = {
  id: string;
  formId: string;
  formName: string;
  icon?: string;
  title: string;
  submittedAt: string;
};

type Pulse = {
  counts: Record<string, number>;
  total: number;
  totalApprox: boolean;
  week: number;
  weekApprox: boolean;
  recent: RecentRow[];
};

/** First non-empty text-ish answer, with choice values mapped back to their labels. */
function titleForRow(form: AppRuntimeForm, answers: Record<string, unknown> | undefined): string {
  if (answers) {
    const fields = (form.fields ?? []) as RuntimeField[];
    for (const field of fields) {
      if (!TITLE_FIELD_TYPES.has(field.type)) continue;
      const value = answers[field.id];
      if (value == null || typeof value === 'object') continue;
      let text = String(value).trim();
      if (!text) continue;
      const options = field.properties?.options;
      if (options?.length) {
        const match = options.find((o) => o.value === text);
        if (match?.label) text = match.label;
      }
      return text;
    }
  }
  return 'Untitled record';
}

const MICRO_LABEL = 'text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500';
const CARD_SHELL = 'rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50';

export function AppDashboard() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const {
    config, permissions, fetchResponsePage, fetchResponses,
    canSubmit, canViewOwn, canViewAll, canViewAnalytics, isOwner: checkOwner,
  } = useAppRuntimeStore();
  const redirectedRef = useRef(false);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [pulseFailed, setPulseFailed] = useState(false);

  const forms = useMemo(() => config?.forms || [], [config]);

  // Forms whose data the user can read — the only ones worth fetching counts/activity for.
  const viewableForms = useMemo(
    () => forms.filter((f) => canViewOwn(f.formId) || canViewAll(f.formId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canViewOwn/canViewAll are stable store actions; permissions is the state they read
    [forms, permissions]
  );
  const statForms = useMemo(() => viewableForms.slice(0, STAT_FORMS_CAP), [viewableForms]);
  const submittableForms = useMemo(
    () => forms.filter((f) => canSubmit(f.formId)).slice(0, QUICK_ACTIONS_CAP),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canSubmit is a stable store action; permissions is the state it reads
    [forms, permissions]
  );

  // Honor the app's configured landing page: redirect once per session to the
  // chosen form. Guarded by a ref + sessionStorage so returning to the
  // dashboard manually doesn't bounce the user back out.
  const landingPage = config?.app?.settings?.landingPage as string | undefined;
  useEffect(() => {
    if (redirectedRef.current || !landingPage || !appSlug) return;
    const key = `applanding:${appSlug}`;
    if (sessionStorage.getItem(key)) return;
    const target = forms.find((f) => f.formId === landingPage);
    if (target) {
      redirectedRef.current = true;
      sessionStorage.setItem(key, '1');
      // Send the user where they can actually act: the fill route if they can
      // submit, otherwise the data view if they can read. If they can do neither,
      // stay on the dashboard rather than bounce them to a "no permission" wall.
      if (canSubmit(landingPage)) {
        navigate(`/app/${appSlug}/form/${landingPage}`, { replace: true });
      } else if (canViewOwn(landingPage) || canViewAll(landingPage)) {
        navigate(`/app/${appSlug}/form/${landingPage}/responses`, { replace: true });
      }
    }
  }, [landingPage, appSlug, forms, navigate, canSubmit, canViewOwn, canViewAll]);

  // One cheap parallel round: the first page of each viewable form (existing
  // endpoints only). Yields per-form totals, a rolling-week count, and the
  // cross-form recent-activity list. Failures degrade to a plain form grid.
  const appId = config?.app?.id;
  useEffect(() => {
    if (!appId || statForms.length === 0) return;
    let cancelled = false;
    const serverMode = !api.isDemoMode();

    (async () => {
      const settled = await Promise.allSettled<FormPulse>(
        statForms.map(async (form) => {
          if (serverMode) {
            const { rows, total } = await fetchResponsePage(form.formId, { limit: SERVER_PAGE, offset: 0 });
            return { form, rows: rows as Record<string, unknown>[], total };
          }
          // Demo mode merges the per-browser overlay, so page totals aren't available.
          const rows = (await fetchResponses(form.formId, { limit: DEMO_PAGE })) as Record<string, unknown>[];
          return { form, rows, total: rows.length, capped: rows.length >= DEMO_PAGE };
        })
      );
      if (cancelled) return;

      const ok = settled.filter((s): s is PromiseFulfilledResult<FormPulse> => s.status === 'fulfilled').map((s) => s.value);
      if (ok.length === 0) {
        setPulseFailed(true);
        return;
      }

      const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const counts: Record<string, number> = {};
      let total = 0;
      let week = 0;
      let weekApprox = false;
      const recent: RecentRow[] = [];

      for (const { form, rows, total: formTotal } of ok) {
        counts[form.formId] = formTotal;
        total += formTotal;
        let inWeek = 0;
        for (const row of rows) {
          const submittedAt = String(row.submittedAt ?? '');
          const time = parseServerDate(submittedAt).getTime();
          if (!isNaN(time) && time >= weekStart) inWeek++;
          recent.push({
            id: String(row.id ?? ''),
            formId: form.formId,
            formName: form.displayName,
            icon: form.icon,
            title: titleForRow(form, row.answers as Record<string, unknown> | undefined),
            submittedAt,
          });
        }
        week += inWeek;
        // Every fetched row was inside the week and more rows exist — the true
        // week count is at least this, so surface it as a lower bound.
        if (rows.length > 0 && rows.length < formTotal && inWeek === rows.length) weekApprox = true;
      }

      recent.sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime());

      setPulse({
        counts,
        total,
        totalApprox:
          viewableForms.length > statForms.length ||
          ok.length < statForms.length ||
          ok.some((o) => o.capped),
        week,
        weekApprox,
        recent: recent.filter((r) => r.id).slice(0, RECENT_LIMIT),
      });
    })();

    return () => { cancelled = true; };
  }, [appId, statForms, viewableForms.length, fetchResponsePage, fetchResponses]);

  if (!config) return null;

  const isOwner = checkOwner();
  // settings.icon is set for marketplace apps; user-created apps may not have it.
  const settingsIcon = (config.app.settings as AppSettings & { icon?: string })?.icon;

  // One-line summary of what this user can actually do here.
  const nForms = forms.length;
  const formsWord = nForms === 1 ? '1 form' : `${nForms} forms`;
  const preposition = nForms === 1 ? 'in' : 'across';
  const canSubmitAny = submittableForms.length > 0;
  const canViewAny = viewableForms.length > 0;
  let summary: string;
  if (canSubmitAny && canViewAny) summary = `Submit records and browse data ${preposition} ${formsWord}.`;
  else if (canSubmitAny) summary = `Submit records ${preposition} ${formsWord}.`;
  else if (canViewAny) summary = `Browse records ${preposition} ${formsWord}.`;
  else summary = nForms > 0 ? `${formsWord} in this workspace.` : 'Your workspace home.';

  const statsLoading = statForms.length > 0 && !pulse && !pulseFailed;
  const showStats = statForms.length > 0 && !pulseFailed;
  const showRail = showStats && (statsLoading || (pulse?.recent.length ?? 0) > 0);

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header: app identity + what the user can do here */}
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl app-bg-primary-light overflow-hidden">
          {config.app.logoUrl ? (
            <img src={config.app.logoUrl} alt="" className="h-12 w-12 rounded-2xl object-cover" />
          ) : (
            <DynamicIcon
              name={settingsIcon}
              className="h-6 w-6 app-text-primary"
              fallback={<LayoutGrid className="h-6 w-6 app-text-primary" />}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl md:text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {config.app.name}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{summary}</p>
          {config.app.description && (
            <p className="mt-0.5 truncate text-sm text-gray-400 dark:text-slate-500">{config.app.description}</p>
          )}
        </div>
      </div>

      {forms.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No forms yet"
          description={
            isOwner
              ? 'Add forms to this app so you and your members can start capturing and browsing records.'
              : 'Nothing here yet — forms will appear as soon as the app owner adds them.'
          }
          action={
            isOwner ? (
              <button
                onClick={() => navigate(`/apps/${config.app.id}/forms`)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium app-btn-primary transition-colors focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <Plus className="h-4 w-4" /> Add forms
              </button>
            ) : undefined
          }
          className={cn(CARD_SHELL, 'border-dashed py-16')}
        />
      ) : (
        <>
          {/* Stat strip: totals from the first page of each viewable form */}
          {showStats && (
            statsLoading ? (
              <div className={cn(CARD_SHELL, 'mb-6 grid grid-cols-3 divide-x divide-gray-100 dark:divide-slate-800')} aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="px-4 py-3 sm:px-5">
                    <Skeleton className="h-3 w-14" />
                    <Skeleton className="mt-2 h-6 w-12" />
                  </div>
                ))}
              </div>
            ) : pulse && (
              <div className={cn(CARD_SHELL, 'mb-6 grid grid-cols-3 divide-x divide-gray-100 dark:divide-slate-800')}>
                <div className="min-w-0 px-4 py-3 sm:px-5">
                  <p className={MICRO_LABEL}>Records</p>
                  <p className="mt-0.5 truncate text-xl font-bold tabular-nums tracking-tight text-gray-900 dark:text-white sm:text-2xl">
                    {pulse.total.toLocaleString()}{pulse.totalApprox ? '+' : ''}
                  </p>
                </div>
                <div className="min-w-0 px-4 py-3 sm:px-5">
                  <p className={MICRO_LABEL}>Forms</p>
                  <p className="mt-0.5 truncate text-xl font-bold tabular-nums tracking-tight text-gray-900 dark:text-white sm:text-2xl">
                    {nForms.toLocaleString()}
                  </p>
                </div>
                <div className="min-w-0 px-4 py-3 sm:px-5">
                  <p className={MICRO_LABEL}>This week</p>
                  <p className="mt-0.5 truncate text-xl font-bold tabular-nums tracking-tight text-gray-900 dark:text-white sm:text-2xl">
                    {pulse.week.toLocaleString()}{pulse.weekApprox ? '+' : ''}
                  </p>
                </div>
              </div>
            )
          )}

          {/* Quick actions: one pill per submittable form */}
          {submittableForms.length > 0 && (
            <div className="mb-6">
              <h2 className={cn(MICRO_LABEL, 'mb-2.5')}>Quick actions</h2>
              <div className="flex flex-wrap gap-2">
                {submittableForms.map((form) => (
                  <button
                    key={form.formId}
                    onClick={() => navigate(`/app/${appSlug}/form/${form.formId}?new=1`)}
                    className="group inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-full border border-gray-200/80 bg-white py-1.5 pl-2 pr-3.5 text-sm font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 app-ring-primary dark:border-slate-700/60 dark:bg-slate-900/50 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full app-bg-primary-light">
                      <DynamicIcon name={form.icon} className="h-3.5 w-3.5 app-text-primary" />
                    </span>
                    <span className="max-w-[11rem] truncate">{form.displayName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={cn('grid items-start gap-6', showRail && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]')}>
            {/* Form cards */}
            <section className="min-w-0">
              <h2 className={cn(MICRO_LABEL, 'mb-2.5')}>Forms</h2>
              <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', !showRail && 'lg:grid-cols-3')}>
                {forms.map((form) => {
                  const showSubmit = canSubmit(form.formId);
                  const showView = canViewOwn(form.formId) || canViewAll(form.formId);
                  const showAnalytics = canViewAnalytics(form.formId);
                  const count = pulse?.counts[form.formId];

                  return (
                    <div
                      key={form.formId}
                      className={cn(
                        CARD_SHELL,
                        'group flex flex-col p-5 transition-colors duration-200',
                        'hover:border-gray-300 dark:hover:border-slate-600',
                        'focus-within:ring-2 app-ring-primary'
                      )}
                    >
                      <div className="flex items-start gap-3.5">
                        <div className="flex-shrink-0 rounded-xl p-2.5 app-bg-primary-light">
                          <DynamicIcon name={form.icon} className="h-5 w-5 app-text-primary" />
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <h3 className="truncate font-semibold tracking-tight text-gray-900 dark:text-white">{form.displayName}</h3>
                          {form.description ? (
                            <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-slate-500">{String(form.description)}</p>
                          ) : typeof count === 'number' ? (
                            <p className="mt-0.5 text-xs tabular-nums text-gray-400 dark:text-slate-500">
                              {count.toLocaleString()} {count === 1 ? 'record' : 'records'}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-1.5">
                        {showSubmit && (
                          <button
                            onClick={() => navigate(`/app/${appSlug}/form/${form.formId}?new=1`)}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium app-btn-primary transition-colors focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                          >
                            <Send className="h-3.5 w-3.5" /> Submit
                          </button>
                        )}
                        {showView && (
                          <button
                            onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/responses`)}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 app-ring-primary dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            <Eye className="h-3.5 w-3.5" /> View data
                          </button>
                        )}
                        {showAnalytics && (
                          <button
                            onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/analytics`)}
                            aria-label={`View analytics for ${form.displayName}`}
                            title="Analytics"
                            className="ml-auto inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 app-ring-primary dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                          >
                            <BarChart3 className="h-4 w-4" />
                          </button>
                        )}
                        {!showSubmit && !showView && !showAnalytics && (
                          <span className="text-sm text-gray-400 dark:text-slate-500">No actions available</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Recent activity: newest records across viewable forms */}
            {showRail && (
              <aside className="min-w-0">
                <h2 className={cn(MICRO_LABEL, 'mb-2.5')}>Recent activity</h2>
                {statsLoading ? (
                  <div className={cn(CARD_SHELL, 'divide-y divide-gray-100 dark:divide-slate-800')} aria-busy="true">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <Skeleton className="h-8 w-8 flex-shrink-0 rounded-lg" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Skeleton className="h-3.5 w-2/3" />
                          <Skeleton className="h-3 w-1/3" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : pulse && (
                  <div className={cn(CARD_SHELL, 'divide-y divide-gray-100 overflow-hidden dark:divide-slate-800')}>
                    {pulse.recent.map((row) => (
                      <button
                        key={`${row.formId}:${row.id}`}
                        onClick={() => navigate(`/app/${appSlug}/form/${row.formId}/responses/${row.id}`)}
                        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary dark:hover:bg-slate-800/50"
                      >
                        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg app-bg-primary-light">
                          <DynamicIcon name={row.icon} className="h-4 w-4 app-text-primary" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{row.title}</span>
                          <span className="block truncate text-xs text-gray-400 dark:text-slate-500">
                            {row.formName} · {formatRelativeTime(row.submittedAt)}
                          </span>
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => navigate(`/app/${appSlug}/records`)}
                      className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-xs font-medium app-text-primary transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary dark:hover:bg-slate-800/50"
                    >
                      Browse all records <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
