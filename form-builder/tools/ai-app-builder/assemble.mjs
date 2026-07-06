// Pure engine (no I/O): the planner + dashboard prompts, the Pack assembler, the widget-dashboard
// sanitizer, and validation. Mirrors what the CURRENT backend import path accepts:
//   - PackService::validatePack / ::resolvePackDashboard (form/app shapes, @pack: refs, size caps)
//   - AppReportService::sanitizeDashboard / ::cleanChartSpec (widget kinds, spec rules, clamps)
//   - AppService::APP_KINDS (settings.appKind allowlist)
// docs/PACK_FORMAT.md documents the format; ui/src/data/packs/*.ts are reference packs.

// Field ids the expression prelude reserves — must mirror FormService::RESERVED_FIELD_IDS.
const RESERVED_IDS = new Set([
  '__isArr', 'validators', 'format', 'compliance', 'finance', 'safety',
  'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count', 'value',
]);
const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ── Widget-dashboard vocabulary (mirrors AppReportService + PackService::resolveSpecRefs) ──
export const APP_KINDS = ['admin', 'client', 'staff', 'public', 'internal', 'custom'];
const WIDGET_KINDS = new Set(['report', 'list', 'text', 'actions', 'activity']);
const VIZ = new Set(['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi']);
const AGG = new Set(['count', 'countDistinct', 'sum', 'avg', 'min', 'max']);
const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'empty', 'notempty', 'last_n_days', 'this_month', 'this_year', 'today', 'has', 'not_has']);
const HAVING_OPS = new Set(['eq', 'ne', 'gt', 'lt', 'gte', 'lte']);
const BUCKETS = new Set(['none', 'day', 'month', 'year']);
const PSEUDO = new Set(['__submitted_at', '__status']);
const MAX_WIDGETS = 60;

// Field-type groups for prompt hints + the fallback template (mirrors dashboardTemplates.ts).
const CHOICE_TYPES = new Set(['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio']);
const DATE_TYPES = new Set(['date', 'datetime']);
const NUMERIC_TYPES = new Set(['number', 'rating', 'scale', 'calculated']);

export function slug(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

/** A safe, unique field id derived from a label (mirrors the backend's generateFieldId rules). */
export function safeFieldId(label, used) {
  let base = slug(label).slice(0, 32) || 'field';
  if (/^\d/.test(base)) base = `_${base}`;
  let id = base, n = 1;
  while (used.has(id) || RESERVED_IDS.has(id) || !ID_RE.test(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

const toInt = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(toInt(v, d), hi));
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ── Prompts ──────────────────────────────────────────────────────────────────

export const PLANNER_SYSTEM = `You are an application architect for FormLogic, a platform where an "app" bundles several linked forms.
Given a description, design a coherent multi-form app and respond with ONLY a JSON object:
{
  "app": { "name": "Short App Name", "description": "One sentence.", "kind": "admin" },
  "forms": [ { "key": "snake_case_id", "title": "Form Title", "purpose": "what this form captures + any logic it needs" } ],
  "relations": [ { "from": "child_form_key", "to": "parent_form_key", "label": "Linked Field Label" } ],
  "roles": [ { "name": "Role Name", "level": "admin" } ]
}
Rules:
- Design the forms a real team would use for this domain — distinct, non-overlapping, in a sensible workflow order.
- "key" is a unique snake_case slug per form. Relations reference forms by their "key".
- A relation means the "from" form has a field linking to a record in the "to" form (e.g. an Interview links to a Candidate). Point child → parent. Only include relations that make real sense.
- "kind" is the app's audience, one of: "admin" (operations/admin console), "client" (customer-facing portal), "staff" (field/staff tool), "public" (anonymous intake), "internal" (internal tool), "custom".
- "level" is one of: "admin" (full control), "contributor" (submit + see own), "viewer" (read all). Include 2-4 roles.
- Respond with ONLY the JSON object, no prose.`;

/** Build the per-form generation prompt fed to /api/ai/generate-form. */
export function formPrompt(plan, form) {
  const others = plan.forms.filter((f) => f.key !== form.key).map((f) => f.title).join(', ');
  return `Create the "${form.title}" form for an app called "${plan.app.name}". Purpose: ${form.purpose}\n`
    + `This form is part of a larger app alongside: ${others || '(none)'}. Generate only THIS form's own input fields`
    + ` (do NOT add fields that link to other forms — those are added separately). Include sensible field types,`
    + ` required flags, and validation. Prefer concrete types the app's dashboard can chart: number for money/`
    + `quantities/durations, date for dates, dropdown for statuses and categories.`;
}

export const DASHBOARD_SYSTEM = `You design the home dashboard of a FormLogic app: a grid of data widgets over the app's forms.
Respond with ONLY a JSON object:
{ "cols": 12, "widgets": [
  { "id": "w1", "title": "Open jobs", "layout": { "x": 0, "y": 0, "w": 3, "h": 1 }, "kind": "report",
    "spec": { "formId": "@pack:jobs", "viz": "kpi", "measure": { "fn": "count" } } }
] }
Widget kinds:
- "report": a chart/KPI. Needs "spec": { "formId": "@pack:<formKey>", "viz": "kpi"|"bar"|"line"|"area"|"pie"|"donut"|"table", "groupBy"?: { "field": "<fieldId>", "bucket"?: "none"|"day"|"month"|"year" }, "measure"?: { "fn": "count"|"countDistinct"|"sum"|"avg"|"min"|"max", "field"?: "<fieldId>" }, "joins"?: [{ "via": "<linked_record fieldId on the base form>", "formId": "@pack:<targetKey>", "type": "left" }], "filters"?: [{ "field": "<fieldId>", "op": "eq", "value": "..." }], "sort"?: "asc"|"desc", "seriesSort"?: "value"|"label", "limit"?: number }.
- "list": recent records. Needs "list": { "formId": "@pack:<formKey>", "titleField"?: "<fieldId>", "subtitleField"?: "<fieldId>", "limit"?: 6 }.
- "text": a static note. Needs "text": { "body": "..." }.
- "actions": quick "new record" buttons for the app's forms. No config.
- "activity": a cross-form recent-submissions feed. No config.
Hard rules:
- Use ONLY the form keys and field ids listed by the user — never invent fields. Field refs on the BASE form are bare ids ("status"); the pseudo-fields "__submitted_at" (submission time) and "__status" (workflow status) exist on every form.
- A join is only valid through a linked_record field ON the base form: "via" is that field's id, and the join's "formId" must equal that field's target. Fields of a joined form are referenced as "@pack:<targetKey>::<fieldId>" (e.g. group child records by a parent's name).
- "sum"/"avg"/"min"/"max" need a numeric "field" (number/rating/scale). KPIs without a numeric field use { "fn": "count" }.
- "bar"/"pie"/"donut" group by a choice/status field (bucket "none"); "line"/"area" group by a date field or "__submitted_at" with bucket "day" or "month".
Layout (12-column grid, y = row): start with a row of 3-4 KPIs (w:3, h:1), then 2 charts (w:6, h:3), then a list + "activity" side by side (w:6, h:3), and finish with one "actions" row (w:12, h:1). 8-12 widgets total. No overlaps.
Respond with ONLY the JSON object, no prose.`;

/** Describe the assembled pack's forms + final field ids for the dashboard-design call. */
export function dashboardPrompt(plan, pack) {
  const lines = [];
  for (const f of pack.forms) {
    const plain = [], links = [];
    for (const fld of f.fields || []) {
      if (fld.type === 'linked_record') links.push(`${fld.id} (linked_record → ${fld.properties?.targetFormId})`);
      else plain.push(`${fld.id} (${fld.type})`);
    }
    lines.push(`- "${f.title}" — formId "@pack:${f.packFormId}": ${plain.join(', ') || '(no data fields)'}`
      + (links.length ? `; link fields: ${links.join(', ')}` : ''));
  }
  const kind = APP_KINDS.includes(plan.app?.kind) ? plan.app.kind : 'custom';
  return `Design the home dashboard for "${plan.app.name}" — ${plan.app.description || ''}\n`
    + `The app is a "${kind}" app. Forms and their field ids:\n${lines.join('\n')}\n`
    + `Lead with the numbers and breakdowns this team would check every morning.`;
}

// ── Widget-dashboard sanitizer (pure mirror of AppReportService::sanitizeDashboard, but STRICT:
//    where the server silently degrades a widget — e.g. sum-without-field becomes count — we DROP it
//    with a reason instead, because a degraded AI widget is a wrong-looking dashboard) ──────────────

/** Validate one chart spec against the pack. Returns { ok, error?, spec? } with @pack: refs kept. */
function cleanChartSpec(spec, byForm) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'report widget has no spec' };
  const baseRef = String(spec.formId || '');
  const baseFields = byForm.get(baseRef);
  if (!baseFields) return { ok: false, error: `spec.formId "${baseRef}" is not a form in this pack` };

  const clean = { formId: baseRef, viz: VIZ.has(spec.viz) ? spec.viz : 'bar' };

  // Joins: only along a real linked_record field on the base form pointing at the declared target.
  const joined = new Map();
  if (Array.isArray(spec.joins) && spec.joins.length) {
    const joins = [];
    for (const j of spec.joins) {
      const via = String(j?.via || '');
      const jf = String(j?.formId || '');
      const viaField = baseFields.get(via);
      if (!viaField || viaField.type !== 'linked_record') {
        return { ok: false, error: `join via "${via}" is not a linked_record field on ${baseRef}` };
      }
      if (String(viaField.properties?.targetFormId || '') !== jf) {
        return { ok: false, error: `join via "${via}" targets "${viaField.properties?.targetFormId}", not "${jf}"` };
      }
      if (!byForm.has(jf)) return { ok: false, error: `join form "${jf}" is not in this pack` };
      joins.push({ via, formId: jf, type: j?.type === 'inner' ? 'inner' : 'left' });
      joined.set(jf, byForm.get(jf));
    }
    clean.joins = joins;
  }

  // A field ref resolves if it's a pseudo-field, a base-form field, or "<joinedFormRef>::<fieldId>".
  const refValid = (ref) => {
    if (typeof ref !== 'string' || ref === '') return false;
    if (PSEUDO.has(ref)) return true;
    const i = ref.indexOf('::');
    if (i !== -1) {
      const jf = ref.slice(0, i), fid = ref.slice(i + 2);
      return joined.has(jf) && joined.get(jf).has(fid);
    }
    return baseFields.has(ref);
  };

  if (spec.groupBy && typeof spec.groupBy === 'object' && spec.groupBy.field !== undefined) {
    if (!refValid(spec.groupBy.field)) return { ok: false, error: `groupBy field "${spec.groupBy.field}" does not exist` };
    clean.groupBy = { field: String(spec.groupBy.field) };
    if (BUCKETS.has(spec.groupBy.bucket)) clean.groupBy.bucket = spec.groupBy.bucket;
  }

  if (spec.measure && typeof spec.measure === 'object') {
    const fn = AGG.has(spec.measure.fn) ? spec.measure.fn : 'count';
    const m = { fn };
    if (spec.measure.field !== undefined && spec.measure.field !== null) {
      if (!refValid(spec.measure.field)) return { ok: false, error: `measure field "${spec.measure.field}" does not exist` };
      m.field = String(spec.measure.field);
    } else if (['sum', 'avg', 'min', 'max'].includes(fn)) {
      return { ok: false, error: `measure "${fn}" needs a field` };
    }
    clean.measure = m;
  } else if (clean.viz !== 'table') {
    clean.measure = { fn: 'count' }; // a chart without a measure is a dead panel — count is always valid
  }

  if (Array.isArray(spec.filters) && spec.filters.length) {
    const filters = [];
    for (const f of spec.filters) {
      if (!f || typeof f !== 'object' || !refValid(f.field) || !FILTER_OPS.has(f.op)) continue;
      const out = { field: String(f.field), op: String(f.op) };
      if (f.value !== undefined && f.value !== null) out.value = String(f.value);
      filters.push(out);
    }
    if (filters.length) clean.filters = filters;
  }

  if (Array.isArray(spec.columns) && spec.columns.length) {
    const cols = spec.columns.map(String).filter(refValid).slice(0, 30);
    if (cols.length) clean.columns = cols;
    else if (clean.viz === 'table') return { ok: false, error: 'table columns reference no existing fields' };
  }

  if (spec.seriesSort === 'value' || spec.seriesSort === 'label') clean.seriesSort = spec.seriesSort;
  if (spec.sort === 'asc' || spec.sort === 'desc') clean.sort = spec.sort;
  else if (spec.sort && typeof spec.sort === 'object' && refValid(spec.sort.by)) {
    clean.sort = { by: String(spec.sort.by), dir: spec.sort.dir === 'desc' ? 'desc' : 'asc' };
  }
  if (spec.having && typeof spec.having === 'object' && HAVING_OPS.has(spec.having.op)
    && Number.isFinite(Number(spec.having.value))) {
    clean.having = { op: spec.having.op, value: Number(spec.having.value) };
  }
  if (spec.limit !== undefined) clean.limit = clampInt(spec.limit, 1, 1000, 10);
  // NOTE: dateRange / filterMode / presentation keys (color, format, …) are deliberately not carried:
  // PackService::resolveSpecRefs drops them on import, so emitting them would just be silently lost.
  return { ok: true, spec: clean };
}

/**
 * Sanitize a widget dashboard (AI- or template-built) against the assembled pack. Returns
 * { dashboard, dropped } where dropped[] explains every widget that was rejected. Refs stay in
 * portable @pack: form (the importer remaps them to real UUIDs).
 */
export function sanitizeDashboard(dashboard, pack) {
  const byForm = new Map();
  for (const f of pack.forms || []) {
    byForm.set(`@pack:${f.packFormId}`, new Map((f.fields || []).map((x) => [x.id, x])));
  }
  const cols = clampInt(dashboard?.cols, 1, 24, 12);
  const widgets = Array.isArray(dashboard?.widgets) ? dashboard.widgets : [];
  const out = [], dropped = [];
  let n = 0;
  for (const w of widgets.slice(0, MAX_WIDGETS)) {
    n++;
    const label = `widget #${n}${w?.title ? ` "${w.title}"` : ''}`;
    if (!w || typeof w !== 'object') { dropped.push(`${label}: not an object`); continue; }
    const kind = String(w.kind || '');
    if (!WIDGET_KINDS.has(kind)) { dropped.push(`${label}: unknown kind "${kind}"`); continue; }

    const layout = (w.layout && typeof w.layout === 'object') ? w.layout : {};
    const ww = clampInt(layout.w, 1, cols, 4);
    let x = clampInt(layout.x, 0, cols - 1, 0);
    if (x + ww > cols) x = Math.max(0, cols - ww);
    const clean = {
      id: String(w.id || '') || `w${n}`,
      kind,
      layout: { x, y: Math.max(0, toInt(layout.y, 0)), w: ww, h: clampInt(layout.h, 1, 12, 2) },
    };
    if (typeof w.title === 'string' && w.title.trim()) clean.title = w.title.trim().slice(0, 200);

    if (kind === 'report') {
      const res = cleanChartSpec(w.spec, byForm);
      if (!res.ok) { dropped.push(`${label}: ${res.error}`); continue; }
      clean.spec = res.spec;
    } else if (kind === 'list') {
      const fid = String(w.list?.formId || '');
      const fields = byForm.get(fid);
      if (!fields) { dropped.push(`${label}: list formId "${fid}" is not a form in this pack`); continue; }
      const list = { formId: fid, limit: clampInt(w.list?.limit, 1, 25, 6) };
      for (const k of ['titleField', 'subtitleField', 'metaField']) {
        const ref = String(w.list?.[k] || '');
        if (ref && fields.has(ref)) list[k] = ref;
      }
      if (typeof w.list?.linkToRecords === 'boolean') list.linkToRecords = w.list.linkToRecords;
      clean.list = list;
    } else if (kind === 'text') {
      const body = typeof w.text?.body === 'string' ? w.text.body.slice(0, 5000) : '';
      if (!body.trim()) { dropped.push(`${label}: text widget has no body`); continue; }
      clean.text = { body };
    }
    // actions/activity carry no extra config.
    out.push(clean);
  }
  return { dashboard: { version: 1, cols, widgets: out }, dropped };
}

/**
 * Deterministic fallback dashboard built from the assembled pack alone (no AI): per-form KPI counts,
 * a category breakdown + monthly trend on the busiest form, recent records + activity, quick actions.
 * Only uses refs that exist by construction, so it always survives the server sanitizer.
 */
export function buildFallbackDashboard(pack) {
  const forms = pack.forms || [];
  if (!forms.length) return { version: 1, cols: 12, widgets: [] };
  // The "busiest" form = the one with the most outgoing links (the transactional child), else the first.
  const primary = forms.reduce((best, f) => {
    const links = (f.fields || []).filter((x) => x.type === 'linked_record').length;
    return links > best.links ? { f, links } : best;
  }, { f: forms[0], links: -1 }).f;

  const firstOf = (form, types) => (form.fields || []).find((x) => types.has(x.type));
  const choice = firstOf(primary, CHOICE_TYPES);
  const date = firstOf(primary, DATE_TYPES);
  const title = firstOf(primary, new Set(['short_text', 'email']));

  const widgets = forms.slice(0, 4).map((f, i) => ({
    id: `k${i + 1}`, title: f.title, layout: { x: i * 3, y: 0, w: 3, h: 1 }, kind: 'report',
    spec: { formId: `@pack:${f.packFormId}`, viz: 'kpi', measure: { fn: 'count' } },
  }));
  widgets.push({
    id: 'c1', title: `${primary.title} by ${choice ? (choice.label || choice.id) : 'status'}`,
    layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report',
    spec: {
      formId: `@pack:${primary.packFormId}`, viz: 'bar',
      groupBy: { field: choice ? choice.id : '__status', bucket: 'none' },
      measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8,
    },
  });
  widgets.push({
    id: 'c2', title: `${primary.title} over time`, layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report',
    spec: {
      formId: `@pack:${primary.packFormId}`, viz: 'area',
      groupBy: { field: date ? date.id : '__submitted_at', bucket: 'month' },
      measure: { fn: 'count' }, seriesSort: 'label', limit: 12,
    },
  });
  widgets.push({
    id: 'l1', title: `Recent ${primary.title.toLowerCase()}`, layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'list',
    list: { formId: `@pack:${primary.packFormId}`, ...(title ? { titleField: title.id } : {}), limit: 6, linkToRecords: true },
  });
  widgets.push({ id: 'ac1', title: 'Recent activity', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'activity' });
  widgets.push({ id: 'qa1', title: 'Quick actions', layout: { x: 0, y: 7, w: 12, h: 1 }, kind: 'actions' });
  return { version: 1, cols: 12, widgets };
}

/** Attach a (sanitized) widget dashboard as the app's home screen. Returns the pack. */
export function attachAppDashboard(pack, dashboard) {
  const app = pack.apps?.[0];
  if (app && dashboard?.widgets?.length) {
    app.customScreen = { enabled: true, kind: 'dashboard', dashboard };
  }
  return pack;
}

// ── Assembler ────────────────────────────────────────────────────────────────

const PERMS_BY_LEVEL = {
  admin: ['submit_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses'],
  contributor: ['submit_responses', 'view_own_responses'],
  viewer: ['view_all_responses'],
};

/**
 * Assemble a PackData from the plan + the AI-generated fields/scripts.
 * @param plan        the validated plan (plan.app.kind, when valid, becomes settings.appKind)
 * @param generated   { [formKey]: { fields: Field[], logicScript?: string } }
 */
export function assemblePack(plan, generated) {
  const forms = plan.forms.map((f) => {
    const used = new Set();
    const baseFields = (generated[f.key]?.fields || []).map((fld) => ({
      id: ID_RE.test(fld.id || '') && !RESERVED_IDS.has(fld.id) && !used.has(fld.id)
        ? (used.add(fld.id), fld.id)
        : safeFieldId(fld.label || fld.id || 'field', used),
      type: fld.type,
      label: fld.label,
      description: fld.description || '',
      placeholder: fld.placeholder || '',
      required: !!fld.required,
      properties: fld.properties || {},
    }));
    // Inject the linked_record fields for relations where this form is the "from" side.
    const linkFields = plan.relations
      .filter((r) => r.from === f.key)
      .map((r) => ({
        id: safeFieldId(r.label || `${r.to}_link`, used),
        type: 'linked_record',
        label: r.label || `Linked ${r.to}`,
        required: false,
        properties: { targetFormId: `@pack:${r.to}` },
      }));
    return {
      packFormId: f.key,
      title: f.title,
      description: f.purpose || '',
      settings: {},
      theme: {},
      ...(generated[f.key]?.logicScript ? { logicScript: generated[f.key].logicScript } : {}),
      fields: [...baseFields, ...linkFields],
    };
  });

  const formKeys = plan.forms.map((f) => f.key);
  const roles = (plan.roles || []).map((r) => ({
    name: r.name,
    description: '',
    permissions: formKeys.flatMap((k) =>
      (PERMS_BY_LEVEL[r.level] || PERMS_BY_LEVEL.viewer).map((permission) => ({ packFormId: k, permission }))),
  }));

  // settings.appKind is server-validated (AppService::APP_KINDS) — only emit a valid value.
  const appKind = APP_KINDS.includes(plan.app?.kind) ? plan.app.kind : null;

  return {
    formatVersion: 1,
    packMeta: {
      id: `ai-${slug(plan.app.name) || 'app'}-${Date.now().toString(36)}`,
      name: plan.app.name,
      description: plan.app.description || '',
      version: '1.0.0',
      author: 'AI App Builder',
      tags: ['ai-generated'],
    },
    forms,
    apps: [{
      packAppId: 'app',
      name: plan.app.name,
      description: plan.app.description || '',
      settings: appKind ? { appKind } : {},
      theme: {},
      forms: plan.forms.map((f, i) => ({ packFormId: f.key, displayName: f.title, sortOrder: i, isVisible: true })),
      roles,
    }],
  };
}

// ── Validators ───────────────────────────────────────────────────────────────

/** Validate the AI plan before generating anything. Returns string[] of problems. */
export function validatePlan(plan) {
  const errors = [];
  if (!plan?.app?.name) errors.push('plan.app.name is missing');
  if (!Array.isArray(plan?.forms) || plan.forms.length === 0) errors.push('plan has no forms');
  const keys = new Set();
  for (const f of plan?.forms || []) {
    if (!f.key || !slug(f.key)) errors.push(`form "${f.title || '?'}" has no usable key`);
    else if (keys.has(f.key)) errors.push(`duplicate form key "${f.key}"`);
    else keys.add(f.key);
    if (!f.title) errors.push(`form "${f.key}" has no title`);
  }
  for (const r of plan?.relations || []) {
    if (!keys.has(r.from)) errors.push(`relation from unknown form "${r.from}"`);
    if (!keys.has(r.to)) errors.push(`relation to unknown form "${r.to}"`);
    if (r.from === r.to) errors.push(`relation cannot link a form to itself ("${r.from}")`);
  }
  return errors;
}

/**
 * Validate the assembled pack against the importer's constraints (PackService::validatePack + the
 * pieces the importer silently drops — dashboard widgets, role/nav refs — which for generated
 * content should be build errors, not silent holes). Returns string[] of problems.
 */
export function validatePack(pack) {
  const errors = [];
  if (pack.formatVersion !== 1) errors.push('formatVersion must be 1');
  if (!pack.forms?.length || pack.forms.length > 50) errors.push(`forms count out of range (${pack.forms?.length})`);
  const formIds = new Set(pack.forms.map((f) => f.packFormId));
  for (const f of pack.forms) {
    if (!f.packFormId || !f.title) errors.push(`a form is missing packFormId/title`);
    if ((f.fields?.length || 0) > 200) errors.push(`form "${f.packFormId}" exceeds 200 fields`);
    if (f.logicScript && Buffer.byteLength(String(f.logicScript), 'utf8') > 102400) {
      errors.push(`form "${f.packFormId}" logicScript exceeds the 100KB import cap`);
    }
    if (f.fields && jsonBytes(f.fields) > 512000) errors.push(`form "${f.packFormId}" fields exceed the 500KB import cap`);
    for (const [key, cap] of [['settings', 10240], ['theme', 10240], ['customScreen', 524288]]) {
      if (f[key] !== undefined && jsonBytes(f[key]) > cap) {
        errors.push(`form "${f.packFormId}" ${key} exceeds the ${Math.round(cap / 1024)}KB import cap`);
      }
    }
    const seen = new Set();
    for (const fld of f.fields || []) {
      if (!ID_RE.test(fld.id) || RESERVED_IDS.has(fld.id)) errors.push(`form "${f.packFormId}" has invalid field id "${fld.id}"`);
      if (seen.has(fld.id)) errors.push(`form "${f.packFormId}" has duplicate field id "${fld.id}"`);
      seen.add(fld.id);
      if (fld.type === 'linked_record') {
        const t = String(fld.properties?.targetFormId || '');
        const key = t.startsWith('@pack:') ? t.slice(6) : null;
        if (!key || !formIds.has(key)) errors.push(`linked_record "${fld.id}" in "${f.packFormId}" targets unknown form "${t}"`);
      }
    }
    // Form-level section screens (if a caller attaches them) must be intact dashboards too.
    if (f.customScreen?.kind === 'dashboard' && f.customScreen.dashboard) {
      for (const d of sanitizeDashboard(f.customScreen.dashboard, pack).dropped) {
        errors.push(`form "${f.packFormId}" dashboard: ${d}`);
      }
    }
  }
  for (const app of pack.apps || []) {
    if (!app.packAppId || !app.name) errors.push('an app is missing packAppId/name');
    for (const m of app.forms || []) if (!formIds.has(m.packFormId)) errors.push(`app references unknown form "${m.packFormId}"`);
    for (const [key, cap] of [['settings', 10240], ['theme', 10240], ['navConfig', 10240], ['reports', 262144], ['customScreen', 524288]]) {
      if (app[key] !== undefined && jsonBytes(app[key]) > cap) {
        errors.push(`app "${app.packAppId}" ${key} exceeds the ${Math.round(cap / 1024)}KB import cap`);
      }
    }
    // The importer silently skips permissions whose packFormId doesn't resolve — make that an error.
    for (const role of app.roles || []) {
      for (const p of role.permissions || []) {
        if (p.packFormId != null && !formIds.has(p.packFormId)) {
          errors.push(`role "${role.name}" grants "${p.permission}" on unknown form "${p.packFormId}"`);
        }
      }
    }
    // The importer drops dashboard widgets whose refs don't resolve — a generated pack must have none.
    if (app.customScreen?.kind === 'dashboard' && app.customScreen.dashboard) {
      for (const d of sanitizeDashboard(app.customScreen.dashboard, pack).dropped) {
        errors.push(`app "${app.packAppId}" dashboard: ${d}`);
      }
    }
  }
  return errors;
}
