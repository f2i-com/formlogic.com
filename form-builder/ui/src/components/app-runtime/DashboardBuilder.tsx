import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Plus, Trash2, Settings2, GripVertical, Save, Loader2,
  BarChart3, PieChart, Hash, Table2, List as ListIcon, Type, Zap, Activity,
  AreaChart, TrendingUp, ListOrdered, Target, Copy, Rows3,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ReportBuilder } from './ReportBuilder';
import { WidgetView } from './WidgetDashboard';
import {
  useWidgetData, GRID_ROW, GRID_GAP, DEFAULT_COLS,
  type WidgetDataDeps, type WidgetDataForm,
} from './widgetData';
import {
  buildDashboardTemplate, fieldsOf, firstFieldOf, firstDateRef, firstChoiceRef,
  CHOICE_TYPES, DATE_TYPES, NUMERIC_TYPES,
} from './dashboardTemplates';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { KIND_LABELS } from '../../types/app';
import type { AppKind, AppReport, AppReportSpec, AppRuntimeForm, DashboardScreen, DashboardWidget, DashboardWidgetKind } from '../../types/app';
import type { CustomScreen } from '../../types/form';

const uid = () => 'w_' + Math.random().toString(36).slice(2, 10);

type Layout = { x: number; y: number; w: number; h: number };
const overlaps = (a: Layout, b: Layout) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Minimum resizable height (grid rows) by widget kind. Text/actions/plain-KPI widgets are readable
 *  at 1 row; chart visualizations that need axis/legend space (bar/line/area/pie/donut/table) and
 *  list/activity widgets need at least 2 so their labels/legend never get squeezed or overlap. A KPI
 *  with a sparkline or a target progress bar renders extra content below the number (see the
 *  'kpi-trend'/'target' gallery presets, both shipped at h:2) and needs the same 2-row floor. */
function minHeightFor(w: DashboardWidget): number {
  if (w.kind === 'list' || w.kind === 'activity') return 2;
  if (w.kind === 'grid') return 3; // header + a few rows + pagination
  if (w.kind === 'report') return w.spec?.viz === 'kpi' && !w.spec?.sparkline && !w.spec?.target ? 1 : 2;
  return 1; // text, actions
}

/**
 * Vertical gravity compaction: float every widget up to fill gaps, treating the moving widget as a
 * fixed obstacle (so it stays under the cursor). Keeps the grid tidy — no overlaps, no drifting gaps.
 */
function gravityResolve(widgets: DashboardWidget[], movingId: string): DashboardWidget[] {
  const list = widgets.map((w) => ({ ...w, layout: { ...w.layout } }));
  const moving = list.find((w) => w.id === movingId);
  // The moving widget is a fixed obstacle from the start, so nothing can float into its cells.
  const placed: DashboardWidget[] = moving ? [moving] : [];
  const others = list
    .filter((w) => w.id !== movingId)
    .sort((a, b) => (a.layout.y - b.layout.y) || (a.layout.x - b.layout.x));
  for (const w of others) {
    let y = Math.max(0, w.layout.y);
    let guard = 0;
    while (y > 0 && !placed.some((p) => overlaps({ ...w.layout, y: y - 1 }, p.layout)) && guard++ < 500) y -= 1;
    guard = 0;
    while (placed.some((p) => overlaps({ ...w.layout, y }, p.layout)) && guard++ < 500) y += 1;
    w.layout.y = y;
    placed.push(w);
  }
  return list;
}

/**
 * Resolve a live drag/resize from a stable drag-start snapshot (so each frame is deterministic — no
 * accumulating drift). If the moving widget lands cleanly on a SINGLE same-size widget, swap the two
 * (the natural "swap" gesture for reordering equal cards); otherwise gravity-compact around it.
 */
function resolveDrag(base: DashboardWidget[], movingId: string, orig: Layout): DashboardWidget[] {
  const moving = base.find((w) => w.id === movingId);
  if (!moving) return base;
  const hits = base.filter((w) => w.id !== movingId && overlaps(moving.layout, w.layout));
  if (hits.length === 1 && hits[0].layout.w === moving.layout.w && hits[0].layout.h === moving.layout.h) {
    // Clean swap: move the single same-size collided widget into the moving widget's original slot.
    return base.map((w) => (w.id === hits[0].id ? { ...w, layout: { ...w.layout, x: orig.x, y: orig.y } } : w));
  }
  return gravityResolve(base, movingId);
}

// Field-type sets + fieldsOf/first*Ref live in ./dashboardTemplates (shared with the
// kind-template builder so gallery prefills and templates never drift).

/** Pick a sensible default group-by ref for a new chart: first choice/date field, else status. */
function defaultGroupRef(form?: AppRuntimeForm): { field: string; isDate: boolean } {
  const f = fieldsOf(form).find((x) => CHOICE_TYPES.has(x.type) || DATE_TYPES.has(x.type));
  if (!f) return { field: '__status', isDate: false };
  return { field: f.id, isDate: DATE_TYPES.has(f.type) };
}

function defaultSpec(form: AppRuntimeForm | undefined, viz: AppReportSpec['viz']): AppReportSpec {
  const formId = form?.formId ?? '';
  if (viz === 'kpi') return { formId, viz, measure: { fn: 'count' }, filters: [] };
  if (viz === 'table') return { formId, viz, columns: fieldsOf(form).slice(0, 4).map((f) => f.id), sort: { by: '__submitted_at', dir: 'desc' }, limit: 20, filters: [] };
  const g = defaultGroupRef(form);
  return { formId, viz, groupBy: { field: g.field, bucket: g.isDate ? 'month' : 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8, filters: [] };
}

// ── Widget preset gallery ──────────────────────────────────────────────────────
// Each preset prefills a sensible spec from the target form's fields (first date-ish field or
// __submitted_at for trends, first choice field for breakdowns, first number field for sums), so a
// freshly added widget shows real data immediately. Everything remains editable afterwards.

type GalleryPreset = {
  key: string;
  label: string;
  desc: string;
  Icon: typeof BarChart3;
  kind: DashboardWidgetKind;
  w: number;
  h: number;
  appOnly?: boolean;
  /** Prefilled spec for report widgets, derived from the target form's fields. */
  spec?: (form?: AppRuntimeForm) => AppReportSpec;
};

const GALLERY: GalleryPreset[] = [
  {
    key: 'kpi', label: 'KPI', desc: 'One big number — a count of records.', Icon: Hash, kind: 'report', w: 3, h: 1,
    spec: (form) => ({ formId: form?.formId ?? '', viz: 'kpi', measure: { fn: 'count' }, filters: [] }),
  },
  {
    key: 'kpi-trend', label: 'KPI + trend', desc: 'Last 30 days total with a mini trend.', Icon: TrendingUp, kind: 'report', w: 3, h: 2,
    spec: (form) => ({
      formId: form?.formId ?? '', viz: 'kpi', measure: { fn: 'count' }, filters: [],
      sparkline: true, groupBy: { field: firstDateRef(form), bucket: 'day' }, dateRange: { preset: '30d' },
    }),
  },
  {
    key: 'trend', label: 'Trend', desc: 'Area chart of records per day, last 30 days.', Icon: AreaChart, kind: 'report', w: 6, h: 3,
    spec: (form) => ({
      formId: form?.formId ?? '', viz: 'area', groupBy: { field: firstDateRef(form), bucket: 'day' },
      measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 40, dateRange: { preset: '30d' }, filters: [],
    }),
  },
  {
    key: 'breakdown', label: 'Breakdown', desc: 'Bar chart split by your first choice field.', Icon: BarChart3, kind: 'report', w: 6, h: 3,
    spec: (form) => ({
      formId: form?.formId ?? '', viz: 'bar', groupBy: { field: firstChoiceRef(form), bucket: 'none' },
      measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8, filters: [],
    }),
  },
  {
    key: 'top5', label: 'Top 5', desc: 'The five biggest groups, largest first.', Icon: ListOrdered, kind: 'report', w: 4, h: 3,
    spec: (form) => ({
      formId: form?.formId ?? '', viz: 'bar', groupBy: { field: firstChoiceRef(form), bucket: 'none' },
      measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', seriesOrder: 'value_desc', limit: 5, filters: [],
    }),
  },
  {
    key: 'target', label: 'Target KPI', desc: 'A number with progress toward a goal.', Icon: Target, kind: 'report', w: 3, h: 2,
    spec: (form) => {
      const num = firstFieldOf(form, NUMERIC_TYPES);
      return { formId: form?.formId ?? '', viz: 'kpi', measure: num ? { fn: 'sum', field: num.id } : { fn: 'count' }, target: 100, filters: [] };
    },
  },
  {
    key: 'donut', label: 'Proportions', desc: 'Donut of a choice field at a glance.', Icon: PieChart, kind: 'report', w: 4, h: 3,
    spec: (form) => ({
      formId: form?.formId ?? '', viz: 'donut', groupBy: { field: firstChoiceRef(form), bucket: 'none' },
      measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6, filters: [],
    }),
  },
  {
    key: 'table', label: 'Table', desc: 'Recent rows with the first few columns.', Icon: Table2, kind: 'report', w: 6, h: 3,
    spec: (form) => defaultSpec(form, 'table'),
  },
  { key: 'list', label: 'Recent list', desc: 'A compact list of the latest records.', Icon: ListIcon, kind: 'list', w: 4, h: 3 },
  { key: 'grid', label: 'Records grid', desc: 'A paginated grid of records; rows open their record.', Icon: Rows3, kind: 'grid', w: 6, h: 4 },
  { key: 'text', label: 'Text', desc: 'A note or section heading.', Icon: Type, kind: 'text', w: 6, h: 1 },
  { key: 'actions', label: 'Quick actions', desc: 'New-record buttons for every form.', Icon: Zap, kind: 'actions', w: 12, h: 1, appOnly: true },
  { key: 'activity', label: 'Recent activity', desc: 'Latest records across all forms.', Icon: Activity, kind: 'activity', w: 4, h: 3, appOnly: true },
];

export interface DashboardBuilderProps extends WidgetDataDeps {
  initial?: DashboardScreen;
  scope: 'app' | 'form';
  /** Forms available for widget queries/config. */
  builderForms: AppRuntimeForm[];
  submittableForms?: WidgetDataForm[];
  accent?: string;
  onSave: (screen: DashboardScreen) => Promise<boolean> | boolean;
  onCancel: () => void;
  title?: string;
}

type Interaction = { type: 'move' | 'resize'; id: string; startX: number; startY: number; orig: DashboardWidget['layout']; base: DashboardWidget[] };

export function DashboardBuilder(props: DashboardBuilderProps) {
  const { scope, builderForms, accent, onSave, onCancel } = props;
  const cols = props.initial?.cols ?? DEFAULT_COLS;
  const [widgets, setWidgets] = useState<DashboardWidget[]>(() => (props.initial?.widgets ?? []).map((w) => ({ ...w })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [interacting, setInteracting] = useState(false);
  // Dashboard-level date-range picker (shown at runtime only when a widget is time-aware).
  // Default ON; only an explicit false is persisted, so untouched dashboards stay unchanged.
  const [showRangePicker, setShowRangePicker] = useState(props.initial?.showRangePicker !== false);
  // Auto-refresh interval in seconds (30 | 60 | 300); 0 = off and nothing is persisted, so
  // untouched dashboards stay byte-identical. Unknown saved values fall back to off.
  const [refreshInterval, setRefreshInterval] = useState<number>(
    props.initial?.refreshInterval === 30 || props.initial?.refreshInterval === 60 || props.initial?.refreshInterval === 300
      ? props.initial.refreshInterval
      : 0
  );
  const [copyOpen, setCopyOpen] = useState(false);
  // Widget id pending delete confirmation (T-widget-delete-confirm): the Trash button no longer
  // deletes immediately — a stray click on a chart full of configuration would otherwise vanish
  // with no undo.
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // The app being edited (excluded from the copy-source list). Both builder hosts live inside the
  // app runtime, so the store is populated; falls back to undefined harmlessly elsewhere.
  const currentAppId = useAppRuntimeStore((s) => s.config?.app.id);
  const activeFormId = useAppRuntimeStore((s) => s.activeFormId);
  // The app's optional portal type (settings.appKind) picks which starter template the empty
  // state leads with. Defensive `in` check: server data could carry an unknown value.
  const storeKind = useAppRuntimeStore((s) => s.config?.app.settings?.appKind);
  const appKind: AppKind | undefined = storeKind && storeKind in KIND_LABELS ? storeKind : undefined;

  // ── Add-widget target form (T13) ────────────────────────────────────────────
  // Presets prefill their specs/lists from ONE selected form. Default = the most relevant form:
  // the runtime's active form when it's part of this dashboard's form set (form-scope builders
  // pass exactly that one form), else the first. Form-section dashboards are single-form, so the
  // picker is hidden there and the target stays locked to that form.
  const [targetFormId, setTargetFormId] = useState<string>(() =>
    (activeFormId && builderForms.some((f) => f.formId === activeFormId) ? activeFormId : builderForms[0]?.formId ?? '')
  );
  const targetForm = builderForms.find((f) => f.formId === targetFormId) ?? builderForms[0];
  const showFormPicker = scope === 'app' && builderForms.length > 1;

  // ── Unsaved-change tracking (T23) ───────────────────────────────────────────
  // A stable serialized compare against the state captured on mount (cols can't change in the
  // builder, so it isn't part of the snapshot). Saving re-baselines; Cancel/close confirm when
  // dirty, and a beforeunload handler guards page navigation/refresh while dirty.
  const snapshot = JSON.stringify({ widgets, showRangePicker, refreshInterval });
  const [cleanSnapshot, setCleanSnapshot] = useState(snapshot);
  const dirty = snapshot !== cleanSnapshot;
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const requestCancel = () => { if (dirty) setConfirmClose(true); else onCancel(); };

  // Suppress text selection during a drag/resize (mutating document.body must live in an effect).
  useEffect(() => {
    if (!interacting) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => { document.body.style.userSelect = prev; };
  }, [interacting]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const cellW = containerW > 0 ? (containerW - (cols - 1) * GRID_GAP) / cols : 0;

  const data = useWidgetData(widgets, props);

  // ── Drag + resize via pointer math on the fixed grid (with auto-move collision resolution) ──
  const interaction = useRef<Interaction | null>(null);
  useEffect(() => {
    if (cellW <= 0) return;
    const onMove = (e: PointerEvent) => {
      const it = interaction.current;
      if (!it) return;
      const dxCells = Math.round((e.clientX - it.startX) / (cellW + GRID_GAP));
      const dyCells = Math.round((e.clientY - it.startY) / (GRID_ROW + GRID_GAP));
      const movingWidget = it.base.find((w) => w.id === it.id);
      const patch = it.type === 'move'
        ? { x: Math.max(0, Math.min(it.orig.x + dxCells, cols - it.orig.w)), y: Math.max(0, it.orig.y + dyCells) }
        : { w: Math.max(1, Math.min(it.orig.w + dxCells, cols - it.orig.x)), h: Math.max(movingWidget ? minHeightFor(movingWidget) : 1, it.orig.h + dyCells) };
      // Recompute from the drag-start snapshot each frame → deterministic, no cumulative drift.
      const next = it.base.map((w) => (w.id === it.id ? { ...w, layout: { ...w.layout, ...patch } } : w));
      setWidgets(resolveDrag(next, it.id, it.orig));
    };
    const onUp = () => {
      if (interaction.current) { interaction.current = null; setInteracting(false); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [cellW, cols]);

  const startInteraction = (type: 'move' | 'resize', w: DashboardWidget, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(w.id);
    interaction.current = {
      type, id: w.id, startX: e.clientX, startY: e.clientY, orig: { ...w.layout },
      base: widgets.map((x) => ({ ...x, layout: { ...x.layout } })), // stable snapshot for deterministic reflow
    };
    setInteracting(true);
  };

  const addWidget = (preset: GalleryPreset) => {
    const form = targetForm;
    // A data widget must never be created with an empty formId (its query could never run).
    if ((preset.kind === 'report' || preset.kind === 'list' || preset.kind === 'grid') && !form?.formId) return;
    setAddOpen(false);
    const maxBottom = widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
    const w: DashboardWidget = {
      id: uid(),
      title: preset.label,
      layout: { x: 0, y: maxBottom, w: Math.min(preset.w, cols), h: preset.h },
      kind: preset.kind,
    };
    if (preset.kind === 'report') w.spec = preset.spec?.(form) ?? defaultSpec(form, 'bar');
    else if (preset.kind === 'list') w.list = { formId: form?.formId ?? '', limit: 6 };
    else if (preset.kind === 'grid') w.grid = { formId: form?.formId ?? '', pageSize: 10 };
    else if (preset.kind === 'text') w.text = { body: '' };
    setWidgets((ws) => [...ws, w]);
    setSelectedId(w.id);
    // Report + list + grid + text widgets open their config immediately so they're never left blank.
    if (preset.kind === 'report' || preset.kind === 'list' || preset.kind === 'grid' || preset.kind === 'text') setConfigId(w.id);
  };

  /**
   * Populate the DRAFT with a kind-specific starter layout (T30). Only ever offered while the
   * canvas is empty, so nothing is overwritten; the result flows through the normal dirty-tracking
   * + Save → server-sanitize path — nothing auto-saves.
   */
  const applyTemplate = (k: AppKind) => {
    const ws = buildDashboardTemplate(k, builderForms, scope);
    if (ws.length === 0) { setAddOpen(true); return; } // nothing to build from — fall back to the gallery
    setWidgets(ws);
    setSelectedId(null);
  };

  const removeWidget = (id: string) => {
    setWidgets((ws) => ws.filter((w) => w.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (configId === id) setConfigId(null);
  };

  const applyConfig = (id: string, patch: Partial<DashboardWidget>) => {
    setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };

  const handleSave = async () => {
    setSaving(true);
    // finally guarantees the button leaves the "Saving…" state even if onSave rejects — otherwise a
    // failed save would leave the builder stuck in a disabled/spinning state.
    try {
      const ok = await onSave({ version: 1, cols, widgets, ...(showRangePicker ? {} : { showRangePicker: false }), ...(refreshInterval ? { refreshInterval } : {}) });
      // A successful save re-baselines the dirty compare (hosts usually unmount us, but not always).
      if (ok) setCleanSnapshot(JSON.stringify({ widgets, showRangePicker, refreshInterval }));
    } finally {
      setSaving(false);
    }
  };

  const canvasHeight = useMemo(() => {
    const maxBottom = widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
    return Math.max(maxBottom, 4) * (GRID_ROW + GRID_GAP);
  }, [widgets]);

  const frameStyle = (w: DashboardWidget): CSSProperties => ({
    position: 'absolute',
    left: w.layout.x * (cellW + GRID_GAP),
    top: w.layout.y * (GRID_ROW + GRID_GAP),
    width: w.layout.w * cellW + (w.layout.w - 1) * GRID_GAP,
    height: w.layout.h * GRID_ROW + (w.layout.h - 1) * GRID_GAP,
  });

  const configWidget = widgets.find((w) => w.id === configId) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap px-1 pb-3 shrink-0">
        <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen(true)}>Add widget</Button>
        <Button size="sm" variant="outline" leftIcon={<Copy className="h-4 w-4" />} onClick={() => setCopyOpen(true)}>Copy from app…</Button>
        <label
          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-slate-400 cursor-pointer select-none"
          title="Show a date-range picker on the dashboard when any widget is time-based"
        >
          <input type="checkbox" className="app-accent rounded" checked={showRangePicker} onChange={(e) => setShowRangePicker(e.target.checked)} />
          Date range picker
        </label>
        <label
          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-slate-400 select-none"
          title="Automatically re-run the dashboard's data while it's being viewed"
        >
          Auto-refresh
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            aria-label="Auto-refresh interval"
            className="rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-xs text-gray-700 dark:text-slate-300 px-1.5 py-1 focus:outline-none focus:ring-2 app-ring-primary cursor-pointer"
          >
            <option value={0}>Off</option>
            <option value={30}>30s</option>
            <option value={60}>1m</option>
            <option value={300}>5m</option>
          </select>
        </label>
        <p className="text-xs text-gray-400 dark:text-slate-500 hidden sm:block">Drag the handle to move · drag the corner to resize · double-click a widget to edit it</p>
        <p className="text-xs text-gray-400 dark:text-slate-500 sm:hidden">Tip: the drag-and-drop grid is easier to arrange on a larger screen.</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={requestCancel}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>
            {saving ? 'Saving…' : 'Save dashboard'}
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl bg-gray-50/60 dark:bg-slate-950/40 border border-gray-200/70 dark:border-slate-800 p-3">
        <div ref={canvasRef} className="relative w-full" style={{ height: canvasHeight }} onClick={() => setSelectedId(null)}>
          {containerW > 0 && widgets.map((w) => {
            const selected = selectedId === w.id;
            const configurable = w.kind !== 'actions' && w.kind !== 'activity';
            return (
              <div
                key={w.id}
                style={frameStyle(w)}
                className="min-w-0 min-h-0"
                onClick={(e) => { e.stopPropagation(); setSelectedId(w.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); if (configurable) setConfigId(w.id); }}
              >
                <div className={`group relative h-full w-full rounded-2xl transition-shadow ${selected ? 'ring-2 app-ring-primary' : 'ring-1 ring-transparent hover:ring-gray-200 dark:hover:ring-slate-700'}`}>
                  {/* Editing chrome */}
                  <div className="absolute -top-2.5 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 [.ring-2_&]:opacity-100 transition-opacity">
                    <button type="button" title="Move" onPointerDown={(e) => startInteraction('move', w, e)} className="touch-none h-6 w-6 flex items-center justify-center rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm text-gray-500 hover:text-gray-800 dark:hover:text-white cursor-grab active:cursor-grabbing">
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                    {configurable && (
                      <button type="button" title={w.kind === 'report' ? 'Edit report' : 'Edit widget'} onClick={(e) => { e.stopPropagation(); setConfigId(w.id); }} className="h-6 inline-flex items-center gap-1 rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm px-2 text-[11px] font-medium text-gray-600 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white cursor-pointer">
                        <Settings2 className="h-3.5 w-3.5" /> Edit
                      </button>
                    )}
                    <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); setDeleteId(w.id); }} className="h-6 w-6 flex items-center justify-center rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm text-gray-500 hover:text-red-500 cursor-pointer">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Live widget content (identical to runtime) — pointer-events off so chrome/drag win */}
                  <div className="h-full w-full overflow-hidden pointer-events-none">
                    <WidgetView
                      widget={w}
                      reportResult={data.reportResults[w.id]}
                      reportLoading={data.reportLoading}
                      canEdit
                      errorDetail={data.reportErrors[w.id]}
                      listRows={data.listData[w.id]}
                      listError={data.listErrors[w.id]}
                      activity={data.activity}
                      activityError={data.activityError}
                      forms={builderForms as unknown as WidgetDataForm[]}
                      submittableForms={props.submittableForms}
                      primaryColor={scope === 'app' ? undefined : accent}
                    />
                  </div>

                  {/* Resize handle (SE corner) */}
                  <div
                    title="Resize"
                    onPointerDown={(e) => startInteraction('resize', w, e)}
                    className="touch-none absolute -bottom-1 -right-1 z-10 h-4 w-4 cursor-se-resize rounded-sm bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 shadow-sm"
                    style={{ backgroundImage: 'linear-gradient(135deg, transparent 45%, currentColor 45%, currentColor 55%, transparent 55%)', color: 'var(--app-primary, #6366f1)' }}
                  />
                </div>
              </div>
            );
          })}

          {widgets.length === 0 && (
            // Empty state (T30): lead with the app's own kind when it has one, else offer the three
            // generic starters. "Build from blank" is the classic add-widget gallery. Data templates
            // need at least one form, so with none attached only the blank path shows.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="flex flex-col items-center gap-2 text-gray-400 dark:text-slate-500">
                <Plus className="h-8 w-8" />
                <p className="text-sm max-w-sm">This dashboard is empty — start from a ready-made layout, or build it widget by widget.</p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {builderForms.length > 0 && (appKind ? (
                  <Button size="sm" onClick={() => applyTemplate(appKind)}>
                    Start with the {KIND_LABELS[appKind]} template
                  </Button>
                ) : (
                  (['admin', 'client', 'staff'] as const).map((k) => (
                    <Button key={k} size="sm" variant="outline" onClick={() => applyTemplate(k)}>
                      {KIND_LABELS[k]} template
                    </Button>
                  ))
                ))}
                <Button
                  size="sm"
                  variant={builderForms.length > 0 ? 'ghost' : 'primary'}
                  onClick={() => setAddOpen(true)}
                  leftIcon={builderForms.length > 0 ? undefined : <Plus className="h-4 w-4" />}
                >
                  Build from blank
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add-widget preset gallery */}
      {addOpen && (
        <Modal isOpen onClose={() => setAddOpen(false)} title="Add a widget" size="full">
          {/* Target-form picker (app dashboards over 2+ forms): presets prefill from this form.
              Form-section dashboards are single-form, so the picker never shows there. */}
          {showFormPicker && (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-4 sm:px-5 sm:pt-5">
              <label htmlFor="widget-target-form" className="text-sm font-medium text-gray-700 dark:text-slate-300">
                Create widgets for:
              </label>
              <select
                id="widget-target-form"
                value={targetForm?.formId ?? ''}
                onChange={(e) => setTargetFormId(e.target.value)}
                className="max-w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-2.5 py-1.5 focus:outline-none focus:ring-2 app-ring-primary cursor-pointer"
              >
                {builderForms.map((f) => <option key={f.formId} value={f.formId}>{f.displayName}</option>)}
              </select>
            </div>
          )}
          <div className="p-4 sm:p-5 grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {GALLERY.filter((p) => !p.appOnly || scope === 'app').map((p) => {
              // Data presets need a target form — with none available they can't create a widget.
              const needsForm = p.kind === 'report' || p.kind === 'list' || p.kind === 'grid';
              const blocked = needsForm && !targetForm?.formId;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => addWidget(p)}
                  disabled={blocked}
                  title={blocked ? 'Add a form first — this widget shows form data.' : undefined}
                  className="group flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-gray-200 dark:border-slate-700 p-3.5 text-left transition-all enabled:cursor-pointer enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-800/60 enabled:hover:ring-2 app-ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg app-bg-primary-light app-text-primary">
                    <p.Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{p.label}</span>
                  <span className="text-xs leading-snug text-gray-500 dark:text-slate-400">{p.desc}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}

      {/* Config: report widgets reuse the full ReportBuilder; others get a compact editor. */}
      {configWidget && configWidget.kind === 'report' && (
        <ReportBuilder
          report={{ id: configWidget.id, name: configWidget.title ?? '', type: 'builder', spec: configWidget.spec ?? defaultSpec(targetForm, 'bar') } as AppReport}
          forms={builderForms}
          runReport={props.runReport}
          onClose={() => setConfigId(null)}
          onSave={(r) => { applyConfig(configWidget.id, { title: r.name, spec: r.spec }); setConfigId(null); }}
        />
      )}
      {configWidget && configWidget.kind !== 'report' && (
        <SimpleWidgetConfig
          widget={configWidget}
          forms={builderForms}
          onClose={() => setConfigId(null)}
          onSave={(patch) => { applyConfig(configWidget.id, patch); setConfigId(null); }}
        />
      )}

      {/* Copy another owned app's dashboard into this draft (widgets on shared forms only). */}
      {copyOpen && (
        <CopyDashboardModal
          currentAppId={currentAppId}
          builderForms={builderForms}
          scope={scope}
          onClose={() => setCopyOpen(false)}
          onReplace={(copied, skipped, sourceName) => {
            setWidgets(copied);
            setSelectedId(null);
            setConfigId(null);
            setCopyOpen(false);
            toast.success(
              `Copied ${copied.length} widget${copied.length === 1 ? '' : 's'} from “${sourceName}”`,
              skipped > 0
                ? `${skipped} widget${skipped === 1 ? ' was' : 's were'} skipped — ${skipped === 1 ? "its form isn't" : "their forms aren't"} in this ${scope === 'app' ? 'app' : 'dashboard'}.`
                : undefined
            );
          }}
        />
      )}

      {/* Unsaved-changes guard for the builder's own Cancel exit (T23). */}
      <ConfirmDialog
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={() => { setConfirmClose(false); onCancel(); }}
        title="Discard unsaved changes?"
        message="This dashboard has unsaved changes. Closing the editor will discard them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        variant="danger"
      />

      {/* Widget delete confirmation — a stray click on the Trash icon must not vanish a
          configured widget with no way back. */}
      <ConfirmDialog
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => { if (deleteId) removeWidget(deleteId); setDeleteId(null); }}
        title="Delete this widget?"
        message="This removes the widget from the dashboard. You can't undo this once you save."
        confirmLabel="Delete widget"
        cancelLabel="Cancel"
        variant="danger"
      />
    </div>
  );
}

// ── Compact config for non-report widgets (list / text / actions / activity) ────

function SimpleWidgetConfig({ widget, forms, onClose, onSave }: {
  widget: DashboardWidget;
  forms: AppRuntimeForm[];
  onClose: () => void;
  onSave: (patch: Partial<DashboardWidget>) => void;
}) {
  const [title, setTitle] = useState(widget.title ?? '');
  // Fall back to the first available form when the stored formId no longer matches one in
  // `forms` (e.g. the form was removed from the app) — otherwise the select shows no matching
  // option and a save silently keeps the dead reference.
  const storedFormId = widget.list?.formId ?? widget.grid?.formId;
  const [formId, setFormId] = useState(
    storedFormId && forms.some((f) => f.formId === storedFormId) ? storedFormId : forms[0]?.formId ?? ''
  );
  const [titleField, setTitleField] = useState(widget.list?.titleField ?? '');
  const [subtitleField, setSubtitleField] = useState(widget.list?.subtitleField ?? '');
  const [metaField, setMetaField] = useState(widget.list?.metaField ?? '');
  const [linkToRecords, setLinkToRecords] = useState(widget.list?.linkToRecords === true);
  const [limit, setLimit] = useState(widget.list?.limit ?? 6);
  const [gridColumns, setGridColumns] = useState<string[]>(widget.grid?.columnFieldIds ?? []);
  const [gridPageSize, setGridPageSize] = useState(widget.grid?.pageSize ?? 10);
  const [body, setBody] = useState(widget.text?.body ?? '');

  const flds = fieldsOf(forms.find((f) => f.formId === formId));
  const sel = 'w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 app-ring-primary';
  const lbl = 'text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500';

  const save = () => {
    const patch: Partial<DashboardWidget> = { title: title.trim() || undefined };
    if (widget.kind === 'list') {
      patch.list = {
        formId,
        titleField: titleField || undefined,
        subtitleField: subtitleField || undefined,
        metaField: metaField || undefined,
        limit: Math.max(1, Math.min(limit, 25)),
        // Only an explicit true is stored — absent keeps today's plain (non-linking) list.
        ...(linkToRecords ? { linkToRecords: true } : {}),
      };
    }
    if (widget.kind === 'grid') {
      patch.grid = {
        formId,
        columnFieldIds: gridColumns.length ? gridColumns : undefined,
        pageSize: Math.max(1, Math.min(gridPageSize, 50)),
      };
    }
    if (widget.kind === 'text') patch.text = { body };
    onSave(patch);
  };

  const kindLabel = widget.kind === 'list' ? 'Record list' : widget.kind === 'grid' ? 'Records grid' : widget.kind === 'text' ? 'Text note' : widget.kind === 'actions' ? 'Quick actions' : 'Recent activity';

  return (
    <Modal isOpen onClose={onClose} title={`Configure · ${kindLabel}`} size="md">
      {/* Body scrolls on short viewports; the Save/Cancel footer stays pinned below it. */}
      <div className="flex max-h-[calc(90dvh_-_8rem)] flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div>
            <label className={lbl}>Title <span className="normal-case font-normal text-gray-400">(optional)</span></label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kindLabel} className={`mt-1.5 ${sel}`} />
          </div>

          {widget.kind === 'list' && (
            <>
              <div>
                <label className={lbl}>Records from</label>
                <select value={formId} onChange={(e) => { setFormId(e.target.value); setTitleField(''); setSubtitleField(''); setMetaField(''); }} className={`mt-1.5 ${sel}`}>
                  {forms.map((f) => <option key={f.formId} value={f.formId}>{f.displayName}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Title field</label>
                  <select value={titleField} onChange={(e) => setTitleField(e.target.value)} className={`mt-1.5 ${sel}`}>
                    <option value="">Auto</option>
                    {flds.map((f) => <option key={f.id} value={f.id}>{f.label ?? f.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Subtitle field</label>
                  <select value={subtitleField} onChange={(e) => setSubtitleField(e.target.value)} className={`mt-1.5 ${sel}`}>
                    <option value="">Date submitted</option>
                    {flds.map((f) => <option key={f.id} value={f.id}>{f.label ?? f.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Detail field</label>
                  <select value={metaField} onChange={(e) => setMetaField(e.target.value)} className={`mt-1.5 ${sel}`}>
                    <option value="">None</option>
                    {flds.map((f) => <option key={f.id} value={f.id}>{f.label ?? f.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Rows</label>
                  <input type="number" min={1} max={25} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 6)} className={`mt-1.5 ${sel}`} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" className="app-accent rounded" checked={linkToRecords} onChange={(e) => setLinkToRecords(e.target.checked)} />
                Link rows to their records
              </label>
            </>
          )}

          {widget.kind === 'grid' && (
            <>
              <div>
                <label className={lbl}>Records from</label>
                <select value={formId} onChange={(e) => { setFormId(e.target.value); setGridColumns([]); }} className={`mt-1.5 ${sel}`}>
                  {forms.map((f) => <option key={f.formId} value={f.formId}>{f.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl}>Columns <span className="normal-case font-normal text-gray-400">(none = automatic)</span></label>
                <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-800">
                  {flds.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-gray-400">This form has no fields.</p>
                  ) : flds.map((f) => (
                    <label key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50">
                      <input
                        type="checkbox"
                        className="app-accent rounded"
                        checked={gridColumns.includes(f.id)}
                        onChange={(e) => setGridColumns((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))}
                      />
                      {f.label ?? f.id}
                    </label>
                  ))}
                </div>
              </div>
              <div className="w-32">
                <label className={lbl}>Rows per page</label>
                <input type="number" min={1} max={50} value={gridPageSize} onChange={(e) => setGridPageSize(Number(e.target.value) || 10)} className={`mt-1.5 ${sel}`} />
              </div>
            </>
          )}

          {widget.kind === 'text' && (
            <div>
              <label className={lbl}>Text</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Add a note, heading, or instructions…" className={`mt-1.5 ${sel} resize-y`} />
            </div>
          )}

          {(widget.kind === 'actions' || widget.kind === 'activity') && (
            <p className="text-sm text-gray-500 dark:text-slate-400">
              {widget.kind === 'actions'
                ? 'Shows a “new record” button for every form the viewer can submit to.'
                : 'Shows the newest records across all forms the viewer can see.'}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save widget</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Copy dashboard from another owned app ───────────────────────────────────────

/**
 * Widgets that can survive a copy into THIS dashboard: report/list widgets only when their source
 * form is also in the current app (shared forms keep working — companion-app synergy), text always,
 * and the app-derived kinds (actions/activity) only on app-scope dashboards.
 */
function copyableWidgets(widgets: DashboardWidget[], formIds: Set<string>, scope: 'app' | 'form'): DashboardWidget[] {
  return widgets.filter((w) => {
    if (w.kind === 'report') return !!w.spec?.formId && formIds.has(w.spec.formId);
    if (w.kind === 'list') return !!w.list?.formId && formIds.has(w.list.formId);
    if (w.kind === 'grid') return !!w.grid?.formId && formIds.has(w.grid.formId);
    if (w.kind === 'text') return true;
    return scope === 'app';
  });
}

type CopySourceApp = { id: string; name: string; sharedForms: number; usable: number; total: number };
type CopyAppListItem = { id?: string; name?: string; ownerId?: string; customScreen?: CustomScreen | null };

/**
 * "Copy from app…": pick one of the owner's OTHER apps whose dashboard is COMPATIBLE with this one —
 * it must share at least one form with the current app AND have at least one widget that survives the
 * copy (apps with dashboards but zero usable widgets are excluded entirely). Each candidate shows its
 * shared-form count and usable/total widget counts, sorted by usable desc. On explicit confirm hands
 * back deep copies (fresh ids, layouts preserved) that REPLACE the current draft. List = api.getApps()
 * (ownerId is only present on apps the requester owns; the list rows carry the full customScreen);
 * each candidate's form set = api.getAppForms(); the picked app's dashboard = the owner-scoped
 * api.getApp() detail (server-fresh at copy time).
 */
function CopyDashboardModal({ currentAppId, builderForms, scope, onClose, onReplace }: {
  currentAppId?: string;
  builderForms: AppRuntimeForm[];
  scope: 'app' | 'form';
  onClose: () => void;
  onReplace: (widgets: DashboardWidget[], skipped: number, sourceName: string) => void;
}) {
  const [apps, setApps] = useState<CopySourceApp[] | null>(null); // null = loading (list + compatibility fan-out)
  const [pickedId, setPickedId] = useState('');
  const [detail, setDetail] = useState<{ name: string; widgets: DashboardWidget[] } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickSeq = useRef(0);

  const formIds = useMemo(() => new Set(builderForms.map((f) => f.formId)), [builderForms]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api.getApps();
      if (cancelled) return;
      if (res.error) { setError('Could not load your apps.'); setApps([]); return; }
      const list = (res.data?.apps ?? []) as CopyAppListItem[];
      const withDashboard = list.filter((a) => !!a.id && !!a.ownerId && a.id !== currentAppId
        && a.customScreen?.kind === 'dashboard' && (a.customScreen.dashboard?.widgets?.length ?? 0) > 0);
      // Compatibility pass: an app qualifies only when it shares >=1 form with this one AND at least
      // one of its widgets would survive the copy. Form lists load in parallel (same best-effort
      // pattern as fetchFormAppUsage); an app whose form list fails is treated as incompatible.
      const formLists = await Promise.allSettled(withDashboard.map((a) => api.getAppForms(a.id as string)));
      if (cancelled) return;
      const candidates: CopySourceApp[] = [];
      withDashboard.forEach((a, i) => {
        const fl = formLists[i];
        if (fl.status !== 'fulfilled' || fl.value.error) return;
        const candidateFormIds = ((fl.value.data?.forms ?? []) as Array<{ formId?: string }>)
          .map((f) => f.formId).filter((id): id is string => !!id);
        const sharedForms = candidateFormIds.filter((id) => formIds.has(id)).length;
        if (sharedForms === 0) return;
        const widgets = a.customScreen?.dashboard?.widgets ?? [];
        const usable = copyableWidgets(widgets, formIds, scope).length;
        if (usable === 0) return;
        candidates.push({ id: a.id as string, name: a.name || 'Untitled app', sharedForms, usable, total: widgets.length });
      });
      candidates.sort((x, y) => (y.usable - x.usable) || (y.sharedForms - x.sharedForms) || x.name.localeCompare(y.name));
      setApps(candidates);
    })();
    return () => { cancelled = true; };
  }, [currentAppId, formIds, scope]);

  const pick = async (id: string) => {
    setPickedId(id);
    setLoadingDetail(true);
    setError(null);
    setDetail(null);
    const seq = ++pickSeq.current; // stale-response protection when switching apps quickly
    const res = await api.getApp(id);
    if (seq !== pickSeq.current) return;
    setLoadingDetail(false);
    const app = res.data?.app as { name?: string; customScreen?: CustomScreen | null } | undefined;
    const dash = app?.customScreen?.kind === 'dashboard' ? app.customScreen.dashboard : undefined;
    if (res.error || !app || !dash) { setError("Could not load that app's dashboard."); return; }
    setDetail({ name: app.name || 'Untitled app', widgets: dash.widgets ?? [] });
  };

  const usable = useMemo(() => (detail ? copyableWidgets(detail.widgets, formIds, scope) : []), [detail, formIds, scope]);
  const skipped = detail ? detail.widgets.length - usable.length : 0;
  const hereLabel = scope === 'app' ? 'app' : 'dashboard';

  const confirm = () => {
    if (!detail || usable.length === 0) return;
    // Deep copies with fresh widget ids; layouts (x/y/w/h) come across verbatim.
    const copied = usable.map((w) => {
      const c = JSON.parse(JSON.stringify(w)) as DashboardWidget;
      c.id = uid();
      return c;
    });
    onReplace(copied, skipped, detail.name);
  };

  return (
    <Modal isOpen onClose={onClose} title="Copy dashboard from app" size="md">
      <div className="flex max-h-[calc(90dvh_-_8rem)] flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {apps === null ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
          ) : apps.length === 0 ? (
            error ? (
              <p className="py-4 text-center text-sm text-gray-500 dark:text-slate-400">{error}</p>
            ) : (
              <div className="py-4 text-center space-y-1.5">
                <p className="text-sm font-medium text-gray-700 dark:text-slate-300">No compatible apps to copy from.</p>
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Dashboards can only be copied between apps that share forms with this {hereLabel} — the widgets
                  point at those forms' data. Tip: “Create a companion app” (in the app's Forms manager) builds a
                  second app over these same forms, so its dashboards copy cleanly. Each app runs its own app-level
                  custom logic and screens; form-level logic travels with the shared forms.
                </p>
              </div>
            )
          ) : (
            <>
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Pick one of your apps — its dashboard widgets replace this draft. Only apps that share forms with
                this {hereLabel} are listed, and only widgets whose form is in this {hereLabel} are copied. Each app
                runs its own app-level custom logic and screens; form-level logic travels with the shared forms.
              </p>
              <div className="space-y-1.5" role="group" aria-label="Source app">
                {apps.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={pickedId === a.id}
                    onClick={() => pick(a.id)}
                    className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm cursor-pointer transition-colors ${pickedId === a.id ? 'app-border-primary app-bg-primary-light app-text-primary' : 'border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                  >
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="shrink-0 text-xs text-gray-400 dark:text-slate-500">
                      {a.sharedForms} shared form{a.sharedForms === 1 ? '' : 's'} · {a.usable}/{a.total} widget{a.total === 1 ? '' : 's'} will copy
                    </span>
                  </button>
                ))}
              </div>
              {loadingDetail && (
                <p className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking which widgets fit…</p>
              )}
              {error && !loadingDetail && <p className="text-xs text-red-500">{error}</p>}
              {detail && !loadingDetail && (
                <div className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-950/40 px-3 py-2.5 text-sm text-gray-700 dark:text-slate-300">
                  “{detail.name}” has {detail.widgets.length} widget{detail.widgets.length === 1 ? '' : 's'} — <strong>{usable.length}</strong> can be copied here
                  {skipped > 0 && <> ({skipped} skipped — their forms aren't in this {hereLabel})</>}.
                  {usable.length > 0
                    ? <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">Copying replaces every widget currently in this draft.</span>
                    : <span className="mt-1 block text-xs text-gray-400 dark:text-slate-500">None of its widgets use a form that's in this {hereLabel}.</span>}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={confirm} disabled={!detail || loadingDetail || usable.length === 0}>
            {usable.length > 0 ? `Replace draft · ${usable.length} widget${usable.length === 1 ? '' : 's'}` : 'Replace draft'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
