// ── Kind-specific starter dashboards (T15/T30) ─────────────────────────────────
// buildDashboardTemplate(kind, forms) turns an app's portal type (settings.appKind)
// into a ready-made widget layout built ONLY from the passed attached forms. Every
// spec mirrors the DashboardBuilder preset-gallery prefills (same fields, same
// shapes), so the server-side dashboard sanitizer (AppReportService::sanitizeDashboard)
// accepts them verbatim — templates only populate the builder DRAFT and go through
// the normal save/sanitize path; nothing here auto-saves.
//
// This file is also the single home of the field-inspection helpers the builder's
// preset gallery uses (fieldsOf / firstDateRef / firstChoiceRef / the type sets) —
// DashboardBuilder imports them from here so the two never drift.

import type { AppKind, AppReportSpec, AppRuntimeForm, DashboardWidget, DashboardWidgetKind, WidgetLayout } from '../../types/app';

/** Field types that carry no per-record answer data — excluded from pickers and prefills. */
export const LAYOUT_TYPES = new Set(['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload']);
export const CHOICE_TYPES = new Set(['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio']);
export const DATE_TYPES = new Set(['date', 'datetime']);
export const NUMERIC_TYPES = new Set(['number', 'rating', 'scale']);

export type BuilderField = { id: string; label?: string; type: string };

export const fieldsOf = (form?: AppRuntimeForm): BuilderField[] =>
  ((form?.fields ?? []) as BuilderField[]).filter((f) => !LAYOUT_TYPES.has(f.type));

export const firstFieldOf = (form: AppRuntimeForm | undefined, types: Set<string>): BuilderField | undefined =>
  fieldsOf(form).find((f) => types.has(f.type));
/** First real date field, else the __submitted_at pseudo-field (always valid server-side). */
export const firstDateRef = (form?: AppRuntimeForm) => firstFieldOf(form, DATE_TYPES)?.id ?? '__submitted_at';
/** First choice-type field, else the __status pseudo-field (always valid server-side). */
export const firstChoiceRef = (form?: AppRuntimeForm) => firstFieldOf(form, CHOICE_TYPES)?.id ?? '__status';

const uid = () => 'w_' + Math.random().toString(36).slice(2, 10);

const make = (kind: DashboardWidgetKind, layout: WidgetLayout, title?: string, extra?: Partial<DashboardWidget>): DashboardWidget => ({
  id: uid(),
  kind,
  layout,
  ...(title ? { title } : {}),
  ...extra,
});

// Spec builders — identical shapes to the builder's GALLERY prefills (sanitizer-safe).
const countSpec = (formId: string): AppReportSpec => ({ formId, viz: 'kpi', measure: { fn: 'count' }, filters: [] });

const statusSpec = (formId: string, viz: 'bar' | 'donut'): AppReportSpec => ({
  formId, viz, groupBy: { field: '__status', bucket: 'none' },
  measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: viz === 'donut' ? 6 : 8, filters: [],
});

const trendSpec = (form: AppRuntimeForm): AppReportSpec => ({
  formId: form.formId, viz: 'area', groupBy: { field: firstDateRef(form), bucket: 'day' },
  measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 40, dateRange: { preset: '30d' }, filters: [],
});

const recentList = (form: AppRuntimeForm, layout: WidgetLayout, title: string): DashboardWidget =>
  make('list', layout, title, { list: { formId: form.formId, limit: 8, linkToRecords: true } });

/**
 * A starter widget set for one portal kind, built only from the given forms.
 * `scope` mirrors DashboardBuilder's: form-section dashboards can't host the
 * app-derived widgets (actions/activity), so those are omitted there.
 * 'internal'/'custom' have no bespoke layout — the admin console arrangement is
 * the most useful generic start. Returns [] when the kind needs form data but
 * none was passed (callers fall back to the add-widget gallery).
 */
export function buildDashboardTemplate(kind: AppKind, forms: AppRuntimeForm[], scope: 'app' | 'form' = 'app'): DashboardWidget[] {
  const app = scope === 'app';
  const primary = forms[0];
  const k: AppKind = kind === 'internal' || kind === 'custom' ? 'admin' : kind;

  if (k === 'public') {
    // Public intake: a welcome note + the intake quick actions. No data widgets — visitors submit and go.
    const out: DashboardWidget[] = [
      make('text', { x: 0, y: 0, w: 12, h: 1 }, 'Welcome', {
        text: { body: 'Welcome! Pick an action below to get started — it only takes a minute.' },
      }),
    ];
    if (app) out.push(make('actions', { x: 0, y: 1, w: 12, h: 1 }, 'Get started'));
    return out;
  }

  if (!primary) return []; // the remaining templates are built from real form data

  if (k === 'client') {
    // Client portal: submit quick-action, the member's own requests, and a status donut.
    const out: DashboardWidget[] = [];
    let y = 0;
    if (app) { out.push(make('actions', { x: 0, y, w: 12, h: 1 }, 'Submit a request')); y += 1; }
    out.push(recentList(primary, { x: 0, y, w: 6, h: 3 }, 'My requests'));
    out.push(make('report', { x: 6, y, w: 6, h: 3 }, 'Request status', { spec: statusSpec(primary.formId, 'donut') }));
    return out;
  }

  if (k === 'staff') {
    // Staff app: quick actions on top, the work queue beside a 30-day activity trend.
    const out: DashboardWidget[] = [];
    let y = 0;
    if (app) { out.push(make('actions', { x: 0, y, w: 12, h: 1 }, 'Quick actions')); y += 1; }
    out.push(recentList(primary, { x: 0, y, w: 6, h: 3 }, 'Work queue'));
    out.push(make('report', { x: 6, y, w: 6, h: 3 }, 'Activity — last 30 days', { spec: trendSpec(primary) }));
    return out;
  }

  // Admin console (also internal/custom): per-form KPIs, a status breakdown,
  // cross-form recent activity, and the latest records.
  const out: DashboardWidget[] = forms.slice(0, 4).map((f, i) =>
    make('report', { x: i * 3, y: 0, w: 3, h: 1 }, `${f.displayName} — total`, { spec: countSpec(f.formId) })
  );
  out.push(make('report', { x: 0, y: 1, w: 6, h: 3 }, 'Status breakdown', { spec: statusSpec(primary.formId, 'bar') }));
  if (app) {
    out.push(make('activity', { x: 6, y: 1, w: 6, h: 3 }, 'Recent activity'));
    out.push(recentList(primary, { x: 0, y: 4, w: 12, h: 3 }, `Latest ${primary.displayName} records`));
  } else {
    out.push(recentList(primary, { x: 6, y: 1, w: 6, h: 3 }, 'Latest records'));
  }
  return out;
}
