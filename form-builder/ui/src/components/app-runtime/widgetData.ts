import { useEffect, useMemo, useRef, useState } from 'react';
import { parseServerDate } from '../../lib/utils';
import type { AppReportResult, AppReportSpec, DashboardWidget } from '../../types/app';

// One grid row unit (px) and gap. A KPI is ~1 row, a chart ~3.
export const GRID_ROW = 116;
export const GRID_GAP = 16;
export const DEFAULT_COLS = 12;

export interface WidgetDataForm {
  formId: string;
  displayName: string;
  icon?: string;
  fields: unknown[];
}

export interface WidgetRecord {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
}

export type ActivityRow = WidgetRecord & { formId: string; formName: string; icon?: string; title: string };

export interface WidgetDataDeps {
  runReport: (spec: AppReportSpec) => Promise<AppReportResult | null>;
  runBatch?: (specs: AppReportSpec[]) => Promise<(AppReportResult | null)[]>;
  fetchRecent?: (formId: string, limit: number) => Promise<WidgetRecord[]>;
  forms: WidgetDataForm[];
  canViewForm?: (formId: string) => boolean;
}

export interface WidgetData {
  reportResults: Record<string, AppReportResult | null>;
  reportLoading: boolean;
  listData: Record<string, WidgetRecord[]>;
  activity: ActivityRow[];
}

type RtField = { id: string; label?: string; type: string; properties?: { options?: Array<{ value: string; label?: string }> } };

// Prefer human-readable text for a record title; only fall back to number/date when there's nothing
// text-like (so a list/activity row never reads as a bare "4380000" or a stray date).
const TEXT_TITLE_TYPES = ['short_text', 'email', 'phone', 'url', 'dropdown', 'long_text'];
const FALLBACK_TITLE_TYPES = ['number', 'date', 'datetime', 'time', 'rating', 'scale'];

export const fieldsOf = (form?: WidgetDataForm): RtField[] => ((form?.fields ?? []) as RtField[]);

/** Map a stored answer to display text, resolving choice option values → labels. */
export function displayAnswer(fields: RtField[], answers: Record<string, unknown>, fieldId?: string): string {
  if (!fieldId) return '';
  const raw = answers[fieldId];
  if (raw == null || typeof raw === 'object') return '';
  let text = String(raw).trim();
  if (!text) return '';
  const opts = fields.find((f) => f.id === fieldId)?.properties?.options;
  if (opts?.length) {
    const m = opts.find((o) => o.value === text);
    if (m?.label) text = m.label;
  }
  return text;
}

/** First non-empty text-like answer (choice values → labels); falls back to number/date only if none. */
export function autoTitle(fields: RtField[], answers: Record<string, unknown>): string {
  for (const types of [TEXT_TITLE_TYPES, FALLBACK_TITLE_TYPES]) {
    for (const f of fields) {
      if (!types.includes(f.type)) continue;
      const t = displayAnswer(fields, answers, f.id);
      if (t) return t;
    }
  }
  return 'Untitled record';
}

/**
 * Fetch everything a set of widgets needs: report specs (one batched round), list rows per form, and
 * the cross-form activity feed. Shared by the runtime renderer and the builder so both are WYSIWYG.
 *
 * `refreshToken` (optional): bump it to re-run the report widgets in the BACKGROUND — same specs, no
 * loading/refreshing states, previous data stays visible until the fresh results land (and a widget
 * whose re-run fails keeps its last good result). Powers dashboard auto-refresh without flicker.
 */
export function useWidgetData(widgets: DashboardWidget[], deps: WidgetDataDeps, refreshToken = 0): WidgetData {
  const { runReport, runBatch, fetchRecent, forms, canViewForm } = deps;

  // ── Report widgets: one batched round ──────────────────────────────────────
  const specEntries = useMemo(
    () => widgets.filter((w) => w.kind === 'report' && w.spec).map((w) => [w.id, w.spec!] as const),
    [widgets]
  );
  const specsKey = useMemo(() => JSON.stringify(specEntries), [specEntries]);
  const [reportResults, setReportResults] = useState<Record<string, AppReportResult | null>>({});
  const [reportLoading, setReportLoading] = useState(true);
  // Tracks the last specs run, so a token bump with UNCHANGED specs is a background refresh while a
  // spec change (range picker, edited widget) keeps today's foreground loading/refreshing treatment.
  const lastSpecsKey = useRef<string | null>(null);

  useEffect(() => {
    const background = refreshToken > 0 && lastSpecsKey.current === specsKey;
    lastSpecsKey.current = specsKey;
    if (specEntries.length === 0) { setReportResults({}); setReportLoading(false); return; }
    let cancelled = false;
    if (!background) setReportLoading(true);
    (async () => {
      const specs = specEntries.map(([, s]) => s);
      let results: (AppReportResult | null)[];
      try {
        results = runBatch ? await runBatch(specs) : await Promise.all(specs.map((s) => runReport(s).catch(() => null)));
      } catch {
        results = specs.map(() => null);
      }
      if (cancelled) return;
      setReportResults((prev) => {
        const map: Record<string, AppReportResult | null> = background ? { ...prev } : {};
        specEntries.forEach(([id], i) => {
          const r = results[i] ?? null;
          // A failed background re-run keeps the widget's last good data (never blank a wallboard).
          if (!background || r !== null || prev[id] === undefined) map[id] = r;
        });
        return map;
      });
      setReportLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey, refreshToken]);

  // ── List widgets: newest rows per referenced form ──────────────────────────
  const [listData, setListData] = useState<Record<string, WidgetRecord[]>>({});
  const listKey = useMemo(
    () => JSON.stringify(widgets.filter((w) => w.kind === 'list' && w.list?.formId).map((w) => [w.id, w.list!.formId, w.list!.limit ?? 6])),
    [widgets]
  );
  useEffect(() => {
    const items = widgets.filter((w) => w.kind === 'list' && w.list?.formId);
    if (items.length === 0 || !fetchRecent) { setListData({}); return; }
    let cancelled = false;
    (async () => {
      const out: Record<string, WidgetRecord[]> = {};
      await Promise.all(items.map(async (w) => {
        try { out[w.id] = await fetchRecent(w.list!.formId, Math.max(1, Math.min(w.list!.limit ?? 6, 25))); }
        catch { out[w.id] = []; }
      }));
      if (!cancelled) setListData(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  // ── Activity built-in: newest records across viewable forms ────────────────
  const hasActivity = widgets.some((w) => w.kind === 'activity');
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  useEffect(() => {
    if (!hasActivity || !fetchRecent) { setActivity([]); return; }
    const viewable = forms.filter((f) => (canViewForm ? canViewForm(f.formId) : true)).slice(0, 6);
    let cancelled = false;
    (async () => {
      const rows: ActivityRow[] = [];
      await Promise.all(viewable.map(async (f) => {
        try {
          const recs = await fetchRecent(f.formId, 6);
          for (const r of recs) rows.push({ ...r, formId: f.formId, formName: f.displayName, icon: f.icon, title: autoTitle(fieldsOf(f), r.answers || {}) });
        } catch { /* ignore */ }
      }));
      if (cancelled) return;
      rows.sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime());
      setActivity(rows.filter((r) => r.id).slice(0, 8));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActivity, forms, listKey]);

  return { reportResults, reportLoading, listData, activity };
}
