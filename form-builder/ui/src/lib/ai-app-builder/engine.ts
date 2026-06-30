// AI App Builder — pure engine (no I/O): the per-form prompt, the Pack assembler, and validators.
// Ported from form-builder/tools/ai-app-builder/assemble.mjs so the harness and the in-app flow share
// the same logic.
import type { AppPlan, PlannedForm, GeneratedForm, GeneratedPack, PackField } from './types';

// Field ids the expression prelude reserves — must mirror FormService::RESERVED_FIELD_IDS.
const RESERVED_IDS = new Set([
  '__isArr', 'validators', 'format', 'compliance', 'finance', 'safety',
  'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count', 'value',
]);
const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function slug(text: string): string {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

/** A safe, unique field id derived from a label (mirrors the backend's generateFieldId rules). */
export function safeFieldId(label: string, used: Set<string>): string {
  let base = slug(label).slice(0, 32) || 'field';
  if (/^\d/.test(base)) base = `_${base}`;
  let id = base;
  let n = 1;
  while (used.has(id) || RESERVED_IDS.has(id) || !ID_RE.test(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

/** Build the per-form generation prompt fed to /api/ai/generate-form. */
export function formPrompt(plan: AppPlan, form: PlannedForm): string {
  const others = plan.forms.filter((f) => f.key !== form.key).map((f) => f.title).join(', ');
  return `Create the "${form.title}" form for an app called "${plan.app.name}". Purpose: ${form.purpose}\n`
    + `This form is part of a larger app alongside: ${others || '(none)'}. Generate only THIS form's own input fields`
    + ` (do NOT add fields that link to other forms — those are added separately). Include sensible field types,`
    + ` required flags, and validation.`;
}

const PERMS_BY_LEVEL: Record<string, string[]> = {
  admin: ['submit_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses'],
  contributor: ['submit_responses', 'view_own_responses'],
  viewer: ['view_all_responses'],
};

/** Assemble a Pack from the plan + the AI-generated fields/scripts (keyed by form key). */
export function assemblePack(plan: AppPlan, generated: Record<string, GeneratedForm>): GeneratedPack {
  const forms = plan.forms.map((f) => {
    const used = new Set<string>();
    const baseFields: PackField[] = (generated[f.key]?.fields || []).map((fld) => {
      const id = (ID_RE.test(fld.id || '') && !RESERVED_IDS.has(fld.id) && !used.has(fld.id))
        ? (used.add(fld.id), fld.id)
        : safeFieldId(fld.label || fld.id || 'field', used);
      return {
        id,
        type: fld.type,
        label: fld.label,
        description: fld.description || '',
        placeholder: fld.placeholder || '',
        required: !!fld.required,
        properties: fld.properties || {},
      };
    });
    // Inject the linked_record fields for relations where this form is the "from" side.
    const linkFields: PackField[] = plan.relations
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
      ...(generated[f.key]?.customScreen ? { customScreen: generated[f.key].customScreen } : {}),
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

/** Validate the plan before generating anything. Returns string[] of problems. */
export function validatePlan(plan: AppPlan): string[] {
  const errors: string[] = [];
  if (!plan?.app?.name) errors.push('The plan has no app name.');
  if (!plan?.forms?.length) errors.push('The plan has no forms.');
  const keys = new Set<string>();
  for (const f of plan?.forms || []) {
    if (!f.key || !slug(f.key)) errors.push(`Form "${f.title || '?'}" has no usable key.`);
    else if (keys.has(f.key)) errors.push(`Duplicate form key "${f.key}".`);
    else keys.add(f.key);
    if (!f.title) errors.push(`A form is missing a title.`);
  }
  for (const r of plan?.relations || []) {
    if (!keys.has(r.from) || !keys.has(r.to)) errors.push(`A relation references an unknown form.`);
    if (r.from === r.to) errors.push(`A form can't link to itself ("${r.from}").`);
  }
  return errors;
}

/** Validate the assembled pack against the importer's constraints. Returns string[] of problems. */
export function validatePack(pack: GeneratedPack): string[] {
  const errors: string[] = [];
  if (pack.formatVersion !== 1) errors.push('Pack format version must be 1.');
  if (!pack.forms?.length || pack.forms.length > 50) errors.push(`Form count out of range (${pack.forms?.length}).`);
  const formIds = new Set(pack.forms.map((f) => f.packFormId));
  for (const f of pack.forms) {
    if (!f.packFormId || !f.title) errors.push('A form is missing an id or title.');
    if ((f.fields?.length || 0) > 200) errors.push(`Form "${f.packFormId}" has too many fields.`);
    const seen = new Set<string>();
    for (const fld of f.fields || []) {
      if (!ID_RE.test(fld.id) || RESERVED_IDS.has(fld.id)) errors.push(`Form "${f.packFormId}" has an invalid field id "${fld.id}".`);
      if (seen.has(fld.id)) errors.push(`Form "${f.packFormId}" has a duplicate field id "${fld.id}".`);
      seen.add(fld.id);
      if (fld.type === 'linked_record') {
        const t = String(fld.properties?.targetFormId || '');
        const key = t.startsWith('@pack:') ? t.slice(6) : null;
        if (!key || !formIds.has(key)) errors.push(`A linked field in "${f.packFormId}" targets an unknown form.`);
      }
    }
  }
  return errors;
}
