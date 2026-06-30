// Pure engine (no I/O): the planner prompt, the Pack assembler, and validation.
// This is the part that lifts cleanly into ui/src/lib/ai-app-builder/ for the in-app version.

// Field ids the expression prelude reserves — must mirror FormService::RESERVED_FIELD_IDS.
const RESERVED_IDS = new Set([
  '__isArr', 'validators', 'format', 'compliance', 'finance', 'safety',
  'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count', 'value',
]);
const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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

export const PLANNER_SYSTEM = `You are an application architect for FormLogic, a platform where an "app" bundles several linked forms.
Given a description, design a coherent multi-form app and respond with ONLY a JSON object:
{
  "app": { "name": "Short App Name", "description": "One sentence." },
  "forms": [ { "key": "snake_case_id", "title": "Form Title", "purpose": "what this form captures + any logic it needs" } ],
  "relations": [ { "from": "child_form_key", "to": "parent_form_key", "label": "Linked Field Label" } ],
  "roles": [ { "name": "Role Name", "level": "admin" } ]
}
Rules:
- Design the forms a real team would use for this domain — distinct, non-overlapping, in a sensible workflow order.
- "key" is a unique snake_case slug per form. Relations reference forms by their "key".
- A relation means the "from" form has a field linking to a record in the "to" form (e.g. an Interview links to a Candidate). Point child → parent. Only include relations that make real sense.
- "level" is one of: "admin" (full control), "contributor" (submit + see own), "viewer" (read all). Include 2-4 roles.
- Respond with ONLY the JSON object, no prose.`;

/** Build the per-form generation prompt fed to /api/ai/generate-form. */
export function formPrompt(plan, form) {
  const others = plan.forms.filter((f) => f.key !== form.key).map((f) => f.title).join(', ');
  return `Create the "${form.title}" form for an app called "${plan.app.name}". Purpose: ${form.purpose}\n`
    + `This form is part of a larger app alongside: ${others || '(none)'}. Generate only THIS form's own input fields`
    + ` (do NOT add fields that link to other forms — those are added separately). Include sensible field types,`
    + ` required flags, and validation.`;
}

const PERMS_BY_LEVEL = {
  admin: ['submit_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses'],
  contributor: ['submit_responses', 'view_own_responses'],
  viewer: ['view_all_responses'],
};

/**
 * Assemble a PackData from the plan + the AI-generated fields/scripts.
 * @param plan        the validated plan
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
      settings: {},
      theme: {},
      forms: plan.forms.map((f, i) => ({ packFormId: f.key, displayName: f.title, sortOrder: i, isVisible: true })),
      roles,
    }],
  };
}

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

/** Validate the assembled pack against the importer's constraints. Returns string[] of problems. */
export function validatePack(pack) {
  const errors = [];
  if (pack.formatVersion !== 1) errors.push('formatVersion must be 1');
  if (!pack.forms?.length || pack.forms.length > 50) errors.push(`forms count out of range (${pack.forms?.length})`);
  const formIds = new Set(pack.forms.map((f) => f.packFormId));
  for (const f of pack.forms) {
    if (!f.packFormId || !f.title) errors.push(`a form is missing packFormId/title`);
    if ((f.fields?.length || 0) > 200) errors.push(`form "${f.packFormId}" exceeds 200 fields`);
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
  }
  for (const app of pack.apps || []) {
    if (!app.packAppId || !app.name) errors.push('an app is missing packAppId/name');
    for (const m of app.forms || []) if (!formIds.has(m.packFormId)) errors.push(`app references unknown form "${m.packFormId}"`);
  }
  return errors;
}
