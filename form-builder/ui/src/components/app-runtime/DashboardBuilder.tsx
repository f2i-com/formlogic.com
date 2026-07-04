import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Plus, Trash2, Settings2, GripVertical, Save, Loader2,
  BarChart3, Hash, Table2, List as ListIcon, Type, Zap, Activity,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ReportBuilder } from './ReportBuilder';
import { WidgetView } from './WidgetDashboard';
import {
  useWidgetData, GRID_ROW, GRID_GAP, DEFAULT_COLS,
  type WidgetDataDeps, type WidgetDataForm,
} from './widgetData';
import type { AppReport, AppReportSpec, AppRuntimeForm, DashboardScreen, DashboardWidget, DashboardWidgetKind } from '../../types/app';

const uid = () => 'w_' + Math.random().toString(36).slice(2, 10);

type Layout = { x: number; y: number; w: number; h: number };
const overlaps = (a: Layout, b: Layout) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

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

const LAYOUT_TYPES = new Set(['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload']);
const CHOICE_TYPES = new Set(['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio']);
const DATE_TYPES = new Set(['date', 'datetime']);

type BuilderField = { id: string; label?: string; type: string };

const fieldsOf = (form?: AppRuntimeForm): BuilderField[] => ((form?.fields ?? []) as BuilderField[]).filter((f) => !LAYOUT_TYPES.has(f.type));

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

type Preset = { key: string; label: string; Icon: typeof BarChart3; kind: DashboardWidgetKind; viz?: AppReportSpec['viz']; w: number; h: number; appOnly?: boolean };
const PRESETS: Preset[] = [
  { key: 'bar', label: 'Bar chart', Icon: BarChart3, kind: 'report', viz: 'bar', w: 6, h: 3 },
  { key: 'line', label: 'Line / trend', Icon: BarChart3, kind: 'report', viz: 'line', w: 6, h: 3 },
  { key: 'pie', label: 'Pie / donut', Icon: BarChart3, kind: 'report', viz: 'donut', w: 4, h: 3 },
  { key: 'kpi', label: 'Number (KPI)', Icon: Hash, kind: 'report', viz: 'kpi', w: 3, h: 1 },
  { key: 'table', label: 'Table', Icon: Table2, kind: 'report', viz: 'table', w: 6, h: 3 },
  { key: 'list', label: 'Record list', Icon: ListIcon, kind: 'list', w: 4, h: 3 },
  { key: 'text', label: 'Text note', Icon: Type, kind: 'text', w: 6, h: 1 },
  { key: 'actions', label: 'Quick actions', Icon: Zap, kind: 'actions', w: 12, h: 1, appOnly: true },
  { key: 'activity', label: 'Recent activity', Icon: Activity, kind: 'activity', w: 4, h: 3, appOnly: true },
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
      const patch = it.type === 'move'
        ? { x: Math.max(0, Math.min(it.orig.x + dxCells, cols - it.orig.w)), y: Math.max(0, it.orig.y + dyCells) }
        : { w: Math.max(1, Math.min(it.orig.w + dxCells, cols - it.orig.x)), h: Math.max(1, it.orig.h + dyCells) };
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

  const addWidget = (preset: Preset) => {
    setAddOpen(false);
    const maxBottom = widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
    const form = builderForms[0];
    const w: DashboardWidget = {
      id: uid(),
      title: preset.kind === 'report' ? '' : preset.label,
      layout: { x: 0, y: maxBottom, w: Math.min(preset.w, cols), h: preset.h },
      kind: preset.kind,
    };
    if (preset.kind === 'report') w.spec = defaultSpec(form, preset.viz ?? 'bar');
    else if (preset.kind === 'list') w.list = { formId: form?.formId ?? '', limit: 6 };
    else if (preset.kind === 'text') w.text = { body: '' };
    setWidgets((ws) => [...ws, w]);
    setSelectedId(w.id);
    // Report + list + text widgets open their config immediately so they're never left blank.
    if (preset.kind === 'report' || preset.kind === 'list' || preset.kind === 'text') setConfigId(w.id);
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
      await onSave({ version: 1, cols, widgets });
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
        <div className="relative">
          <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen((o) => !o)}>Add widget</Button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} aria-hidden="true" />
              <div className="absolute left-0 top-full mt-1 z-20 w-56 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1.5">
                {PRESETS.filter((pr) => !pr.appOnly || scope === 'app').map((pr) => (
                  <button
                    key={pr.key}
                    type="button"
                    onClick={() => addWidget(pr)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <pr.Icon className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                    {pr.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-gray-400 dark:text-slate-500 hidden sm:block">Drag the handle to move · drag the corner to resize</p>
        <p className="text-xs text-gray-400 dark:text-slate-500 sm:hidden">Tip: the drag-and-drop grid is easier to arrange on a larger screen.</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
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
            return (
              <div key={w.id} style={frameStyle(w)} className="min-w-0 min-h-0" onClick={(e) => { e.stopPropagation(); setSelectedId(w.id); }}>
                <div className={`group relative h-full w-full rounded-2xl transition-shadow ${selected ? 'ring-2 app-ring-primary' : 'ring-1 ring-transparent hover:ring-gray-200 dark:hover:ring-slate-700'}`}>
                  {/* Editing chrome */}
                  <div className="absolute -top-2.5 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 [.ring-2_&]:opacity-100 transition-opacity">
                    <button type="button" title="Move" onPointerDown={(e) => startInteraction('move', w, e)} className="touch-none h-6 w-6 flex items-center justify-center rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm text-gray-500 hover:text-gray-800 dark:hover:text-white cursor-grab active:cursor-grabbing">
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                    {w.kind !== 'actions' && w.kind !== 'activity' && (
                      <button type="button" title="Configure" onClick={(e) => { e.stopPropagation(); setConfigId(w.id); }} className="h-6 w-6 flex items-center justify-center rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm text-gray-500 hover:text-gray-800 dark:hover:text-white cursor-pointer">
                        <Settings2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); removeWidget(w.id); }} className="h-6 w-6 flex items-center justify-center rounded-md bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-sm text-gray-500 hover:text-red-500 cursor-pointer">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Live widget content (identical to runtime) — pointer-events off so chrome/drag win */}
                  <div className="h-full w-full overflow-hidden pointer-events-none">
                    <WidgetView
                      widget={w}
                      reportResult={data.reportResults[w.id]}
                      reportLoading={data.reportLoading}
                      listRows={data.listData[w.id]}
                      activity={data.activity}
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
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-gray-400 dark:text-slate-500 pointer-events-none">
              <Plus className="h-8 w-8 mb-2" />
              <p className="text-sm">Add your first widget to build this dashboard.</p>
            </div>
          )}
        </div>
      </div>

      {/* Config: report widgets reuse the full ReportBuilder; others get a compact editor. */}
      {configWidget && configWidget.kind === 'report' && (
        <ReportBuilder
          report={{ id: configWidget.id, name: configWidget.title ?? '', type: 'builder', spec: configWidget.spec ?? defaultSpec(builderForms[0], 'bar') } as AppReport}
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
  const [formId, setFormId] = useState(widget.list?.formId ?? forms[0]?.formId ?? '');
  const [titleField, setTitleField] = useState(widget.list?.titleField ?? '');
  const [subtitleField, setSubtitleField] = useState(widget.list?.subtitleField ?? '');
  const [limit, setLimit] = useState(widget.list?.limit ?? 6);
  const [body, setBody] = useState(widget.text?.body ?? '');

  const flds = fieldsOf(forms.find((f) => f.formId === formId));
  const sel = 'w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 app-ring-primary';
  const lbl = 'text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500';

  const save = () => {
    const patch: Partial<DashboardWidget> = { title: title.trim() || undefined };
    if (widget.kind === 'list') patch.list = { formId, titleField: titleField || undefined, subtitleField: subtitleField || undefined, limit: Math.max(1, Math.min(limit, 25)) };
    if (widget.kind === 'text') patch.text = { body };
    onSave(patch);
  };

  const kindLabel = widget.kind === 'list' ? 'Record list' : widget.kind === 'text' ? 'Text note' : widget.kind === 'actions' ? 'Quick actions' : 'Recent activity';

  return (
    <Modal isOpen onClose={onClose} title={`Configure · ${kindLabel}`} size="md">
      <div className="p-5 space-y-4">
        <div>
          <label className={lbl}>Title <span className="normal-case font-normal text-gray-400">(optional)</span></label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kindLabel} className={`mt-1.5 ${sel}`} />
        </div>

        {widget.kind === 'list' && (
          <>
            <div>
              <label className={lbl}>Records from</label>
              <select value={formId} onChange={(e) => { setFormId(e.target.value); setTitleField(''); setSubtitleField(''); }} className={`mt-1.5 ${sel}`}>
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
            </div>
            <div>
              <label className={lbl}>Rows</label>
              <input type="number" min={1} max={25} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 6)} className={`mt-1.5 w-24 ${sel}`} />
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
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save}>Save widget</Button>
      </div>
    </Modal>
  );
}
