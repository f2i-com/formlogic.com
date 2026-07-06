import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Sanitized failure message per FAILED report widget (only ids whose displayed result is null).
   *  Populated when the runner surfaced a message (the store's runReport throws the server's
   *  sanitized error); batch runs drop per-spec messages, so a Retry via the single endpoint is
   *  what usually fills this in. Never a raw stack/SQL — only what the API already returned. */
  reportErrors: Record<string, string>;
  listData: Record<string, WidgetRecord[]>;
  activity: ActivityRow[];
  /** Re-run JUST one report widget via the single-report runner (owner "Retry"). No-op for ids
   *  that aren't report widgets. Success replaces that widget's result; failure keeps the current
   *  data and records the sanitized message in reportErrors. */
  retryWidget: (id: string) => void;
  /** Widget ids currently re-running via retryWidget (drives the Retry button spinner). */
  retrying: Record<string, boolean>;
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

/** The message a runner surfaced for a failed run — already sanitized server-side (jsonResponse
 *  message strings), never a stack. Non-Error throws yield undefined (generic UI copy instead). */
const errorMessage = (e: unknown): string | undefined => (e instanceof Error && e.message ? e.message : undefined);

/**
 * Fetch everything a set of widgets needs: report specs (one batched round), list rows per form, and
 * the cross-form activity feed. Shared by the runtime renderer and the builder so both are WYSIWYG.
 *
 * `refreshToken` (optional): bump it to re-run the report, list AND activity widgets in the
 * BACKGROUND — same specs, no loading/refreshing states, previous data stays visible until the fresh
 * results land (and a widget whose re-run fails keeps its last good data). Powers dashboard
 * auto-refresh without flicker or a skeleton flash.
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
  const [reportErrors, setReportErrors] = useState<Record<string, string>>({});
  const [reportLoading, setReportLoading] = useState(true);
  // Tracks the last specs run, so a token bump with UNCHANGED specs is a background refresh while a
  // spec change (range picker, edited widget) keeps today's foreground loading/refreshing treatment.
  const lastSpecsKey = useRef<string | null>(null);
  // Mirror of reportResults so the main effect and retryWidget can compute next maps without
  // nesting decisions inside functional setState (the error map depends on the results map).
  const resultsRef = useRef<Record<string, AppReportResult | null>>({});
  const commitResults = useCallback((next: Record<string, AppReportResult | null>) => {
    resultsRef.current = next;
    setReportResults(next);
  }, []);
  // Live refs so retryWidget (stable identity) always sees the current specs/runner — hosts often
  // pass inline runner closures whose identity changes every render.
  const live = useRef({ specEntries, specsKey, runReport });
  live.current = { specEntries, specsKey, runReport };

  useEffect(() => {
    const background = refreshToken > 0 && lastSpecsKey.current === specsKey;
    lastSpecsKey.current = specsKey;
    if (specEntries.length === 0) { commitResults({}); setReportErrors({}); setReportLoading(false); return; }
    let cancelled = false;
    if (!background) setReportLoading(true);
    (async () => {
      const specs = specEntries.map(([, s]) => s);
      let results: (AppReportResult | null)[];
      let errors: (string | undefined)[] = specs.map(() => undefined);
      try {
        if (runBatch) {
          // Batch entries collapse failures to null (the batch endpoint drops per-spec messages).
          results = await runBatch(specs);
        } else {
          const settled = await Promise.all(specs.map((s) =>
            runReport(s).then(
              (r) => ({ r: r ?? null, e: undefined as string | undefined }),
              (err: unknown) => ({ r: null, e: errorMessage(err) })
            )
          ));
          results = settled.map((x) => x.r);
          errors = settled.map((x) => x.e);
        }
      } catch (err) {
        results = specs.map(() => null);
        errors = specs.map(() => errorMessage(err));
      }
      if (cancelled) return;
      const prev = resultsRef.current;
      const map: Record<string, AppReportResult | null> = background ? { ...prev } : {};
      specEntries.forEach(([id], i) => {
        const r = results[i] ?? null;
        // A failed background re-run keeps the widget's last good data (never blank a wallboard).
        if (!background || r !== null || prev[id] === undefined) map[id] = r;
      });
      commitResults(map);
      // Errors exist only for widgets whose DISPLAYED result is null (a bg failure that kept old
      // data shows the data, not an error). New messages win; otherwise the last one is kept.
      setReportErrors((prevErr) => {
        const next: Record<string, string> = {};
        specEntries.forEach(([id], i) => {
          if (map[id] !== null) return;
          const msg = errors[i] ?? prevErr[id];
          if (msg) next[id] = msg;
        });
        return next;
      });
      setReportLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey, refreshToken]);

  // ── Per-widget retry (owner "Retry" on a failed widget) ────────────────────
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const retrySeq = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const retryWidget = useCallback((id: string) => {
    const entry = live.current.specEntries.find(([wid]) => wid === id);
    if (!entry) return;
    const keyAtStart = live.current.specsKey;
    const seq = (retrySeq.current[id] = (retrySeq.current[id] ?? 0) + 1);
    setRetrying((m) => ({ ...m, [id]: true }));
    // Always the SINGLE runner: it re-runs just this spec and (unlike the batch) surfaces the
    // server's sanitized error message on failure.
    live.current.runReport(entry[1]).then(
      (r) => ({ r: r ?? null, e: undefined as string | undefined }),
      (err: unknown) => ({ r: null, e: errorMessage(err) })
    ).then(({ r, e }) => {
      if (!mounted.current || retrySeq.current[id] !== seq) return;
      setRetrying((m) => { const n = { ...m }; delete n[id]; return n; });
      // Specs changed while retrying — the main effect owns the fresh state; drop this result.
      if (live.current.specsKey !== keyAtStart) return;
      if (r !== null) {
        commitResults({ ...resultsRef.current, [id]: r });
        setReportErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
      } else if (e) {
        // Failure keeps whatever is displayed (null for a failed widget) and refreshes the detail.
        setReportErrors((prev) => ({ ...prev, [id]: e }));
      }
    });
  }, [commitResults]);

  // ── List widgets: newest rows per referenced form ──────────────────────────
  const [listData, setListData] = useState<Record<string, WidgetRecord[]>>({});
  const listKey = useMemo(
    () => JSON.stringify(widgets.filter((w) => w.kind === 'list' && w.list?.formId).map((w) => [w.id, w.list!.formId, w.list!.limit ?? 6])),
    [widgets]
  );
  const lastListKey = useRef<string | null>(null);
  useEffect(() => {
    const background = refreshToken > 0 && lastListKey.current === listKey;
    lastListKey.current = listKey;
    const items = widgets.filter((w) => w.kind === 'list' && w.list?.formId);
    if (items.length === 0 || !fetchRecent) { setListData({}); return; }
    let cancelled = false;
    (async () => {
      // null marks a failed fetch so a background refresh can keep that widget's last good rows.
      const out: Record<string, WidgetRecord[] | null> = {};
      await Promise.all(items.map(async (w) => {
        try { out[w.id] = await fetchRecent(w.list!.formId, Math.max(1, Math.min(w.list!.limit ?? 6, 25))); }
        catch { out[w.id] = null; }
      }));
      if (cancelled) return;
      setListData((prev) => {
        // Background merges into the previous map (rows stay visible, no skeleton flash);
        // foreground replaces it wholesale (today's behaviour, failures become empty lists).
        const map: Record<string, WidgetRecord[]> = background ? { ...prev } : {};
        for (const w of items) {
          const rows = out[w.id];
          if (rows) map[w.id] = rows;
          else if (!background) map[w.id] = [];
        }
        return map;
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, refreshToken]);

  // ── Activity built-in: newest records across viewable forms ────────────────
  const hasActivity = widgets.some((w) => w.kind === 'activity');
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const lastActivityKey = useRef<string | null>(null);
  useEffect(() => {
    if (!hasActivity || !fetchRecent) { setActivity([]); lastActivityKey.current = null; return; }
    const viewable = forms.filter((f) => (canViewForm ? canViewForm(f.formId) : true)).slice(0, 6);
    // A token bump with the same content inputs is a background refresh; anything else (forms or
    // widgets changed) keeps today's foreground replace.
    const key = `${listKey}|${viewable.map((f) => f.formId).join(',')}`;
    const background = refreshToken > 0 && lastActivityKey.current === key;
    lastActivityKey.current = key;
    let cancelled = false;
    (async () => {
      const rows: ActivityRow[] = [];
      const failed: string[] = [];
      await Promise.all(viewable.map(async (f) => {
        try {
          const recs = await fetchRecent(f.formId, 6);
          for (const r of recs) rows.push({ ...r, formId: f.formId, formName: f.displayName, icon: f.icon, title: autoTitle(fieldsOf(f), r.answers || {}) });
        } catch { failed.push(f.formId); }
      }));
      if (cancelled) return;
      setActivity((prev) => {
        // On a background refresh, a form whose fetch failed keeps its previously shown rows
        // instead of silently vanishing from the feed. Foreground keeps today's drop-on-error.
        const all = background && failed.length > 0
          ? [...rows, ...prev.filter((r) => failed.includes(r.formId))]
          : rows;
        all.sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime());
        return all.filter((r) => r.id).slice(0, 8);
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActivity, forms, listKey, refreshToken]);

  return { reportResults, reportLoading, reportErrors, listData, activity, retryWidget, retrying };
}
