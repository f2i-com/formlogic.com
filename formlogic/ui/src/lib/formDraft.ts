import type { FormField } from '../types/form';

/** Field types that never hold user-entered answers. */
export const NON_INPUT_FIELD_TYPES = new Set<string>([
  'section',
  'statement',
  'welcome_screen',
  'thank_you',
  'calculated',
  'hidden',
]);

/** Field types purely used for layout/chrome (never exported as data columns). */
export const LAYOUT_ONLY_FIELD_TYPES = new Set<string>([
  'section',
  'statement',
  'welcome_screen',
  'thank_you',
]);

export interface FormSection {
  index: number;
  id: string;
  title: string;
  description: string;
  /** Renderable fields inside this section (excludes the `section` header field itself, `welcome_screen`, `thank_you`, `hidden`). */
  fields: FormField[];
  /** Fillable input field IDs in this section (used for completion tracking). */
  inputFieldIds: string[];
  totalInputs: number;
  answeredCount: number;
  requiredCount: number;
  requiredAnsweredCount: number;
  errorCount: number;
  isComplete: boolean;
}

export interface GroupedFormSections {
  hasExplicitSections: boolean;
  welcomeField: FormField | null;
  sections: FormSection[];
  totalInputs: number;
  answeredCount: number;
  requiredCount: number;
  requiredAnsweredCount: number;
}

export function isAnswerFilled(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && trimmed !== 'typed:';
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

/**
 * Group a flat list of visible form fields into navigable sections.
 * Works identically for forms with explicit `section` dividers and flat forms (1 section).
 */
export function groupFieldsIntoSections(
  visibleFields: FormField[],
  answers: Record<string, unknown>,
  isFieldRequired: (fieldId: string) => boolean,
  errorFieldIds?: ReadonlySet<string>,
): GroupedFormSections {
  let welcomeField: FormField | null = null;
  let hasExplicitSections = false;

  for (const f of visibleFields) {
    if (f.type === 'section') hasExplicitSections = true;
  }

  const rawSections: Array<{ id: string; title: string; description: string; fields: FormField[] }> = [];
  let current: { id: string; title: string; description: string; fields: FormField[] } = {
    id: 'section_0',
    title: 'General',
    description: '',
    fields: [],
  };
  let started = !hasExplicitSections;

  for (const field of visibleFields) {
    if (field.type === 'thank_you' || field.type === 'hidden') continue;
    if (field.type === 'welcome_screen') {
      if (!welcomeField && rawSections.length === 0 && current.fields.length === 0) {
        welcomeField = field;
        continue;
      }
      // A mid-form welcome_screen stays inside the current section.
    }
    if (field.type === 'section') {
      if (started && current.fields.length > 0) {
        rawSections.push(current);
      }
      current = {
        id: field.id,
        title: field.label?.trim() || `Section ${rawSections.length + 1}`,
        description: field.description?.trim() || '',
        fields: [],
      };
      started = true;
      continue;
    }
    if (!started) {
      started = true;
    }
    current.fields.push(field);
  }

  if (started && (current.fields.length > 0 || rawSections.length === 0)) {
    rawSections.push(current);
  }

  let grandTotalInputs = 0;
  let grandAnswered = 0;
  let grandRequired = 0;
  let grandRequiredAnswered = 0;

  const sections: FormSection[] = rawSections.map((raw, index) => {
    const inputFieldIds: string[] = [];
    let answeredCount = 0;
    let requiredCount = 0;
    let requiredAnsweredCount = 0;
    let errorCount = 0;

    for (const f of raw.fields) {
      if (NON_INPUT_FIELD_TYPES.has(f.type)) continue;
      inputFieldIds.push(f.id);
      const filled = isAnswerFilled(answers[f.id]);
      const req = isFieldRequired(f.id);
      if (filled) answeredCount++;
      if (req) {
        requiredCount++;
        if (filled) requiredAnsweredCount++;
      }
      if (errorFieldIds?.has(f.id)) errorCount++;
    }

    grandTotalInputs += inputFieldIds.length;
    grandAnswered += answeredCount;
    grandRequired += requiredCount;
    grandRequiredAnswered += requiredAnsweredCount;

    return {
      index,
      id: raw.id,
      title: raw.title,
      description: raw.description,
      fields: raw.fields,
      inputFieldIds,
      totalInputs: inputFieldIds.length,
      answeredCount,
      requiredCount,
      requiredAnsweredCount,
      errorCount,
      isComplete: errorCount === 0 && (requiredCount > 0 ? requiredAnsweredCount >= requiredCount : answeredCount > 0),
    };
  });

  return {
    hasExplicitSections,
    welcomeField,
    sections,
    totalInputs: grandTotalInputs,
    answeredCount: grandAnswered,
    requiredCount: grandRequired,
    requiredAnsweredCount: grandRequiredAnswered,
  };
}

// ── Portable .json Form Progress Save & Re-Import ──────────────────────────

export const DRAFT_FILE_FORMAT = 'formlogic-form-draft' as const;
export const DRAFT_FILE_VERSION = 1 as const;
const MAX_DRAFT_JSON_BYTES = 2_500_000;

export interface FormDraftFieldSnapshot {
  id: string;
  label: string;
  type: string;
  section?: string;
  required: boolean;
}

export interface FormDraftFile {
  format: typeof DRAFT_FILE_FORMAT;
  version: typeof DRAFT_FILE_VERSION;
  formId: string;
  formTitle: string;
  savedAt: string;
  currentSectionIndex: number;
  currentStep?: number;
  answers: Record<string, unknown>;
  fields: FormDraftFieldSnapshot[];
}

export interface ParsedDraftImport {
  ok: true;
  answers: Record<string, unknown>;
  matchedCount: number;
  skippedCount: number;
  formIdMismatch: boolean;
  sourceFormId: string | null;
  sourceFormTitle: string | null;
  savedAt: string | null;
  currentSectionIndex: number;
  currentStep: number | null;
  warnings: string[];
}

export interface ParsedDraftImportError {
  ok: false;
  error: string;
}

function stripUnsafeKeys(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripUnsafeKeys(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = stripUnsafeKeys(v, depth + 1);
  }
  return out;
}

/**
 * Build a portable, self-describing `.json` draft object containing answers plus
 * human-readable field metadata (so both users and AI assistants can inspect/edit it).
 */
export function buildDraftJsonFile(
  form: { id: string; title: string; fields: FormField[] },
  answers: Record<string, unknown>,
  opts: { currentSectionIndex?: number; currentStep?: number } = {},
): FormDraftFile {
  let currentSectionTitle = 'General';
  const fieldSnapshots: FormDraftFieldSnapshot[] = [];
  const exportableIds = new Set<string>();

  for (const field of form.fields) {
    if (field.type === 'section') {
      currentSectionTitle = field.label?.trim() || currentSectionTitle;
      continue;
    }
    if (NON_INPUT_FIELD_TYPES.has(field.type)) continue;
    exportableIds.add(field.id);
    fieldSnapshots.push({
      id: field.id,
      label: field.label || field.id,
      type: field.type,
      section: currentSectionTitle,
      required: Boolean(field.required),
    });
  }

  const cleanAnswers: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(answers)) {
    if (!exportableIds.has(key)) continue;
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    cleanAnswers[key] = stripUnsafeKeys(val);
  }

  return {
    format: DRAFT_FILE_FORMAT,
    version: DRAFT_FILE_VERSION,
    formId: form.id,
    formTitle: form.title || 'Untitled Form',
    savedAt: new Date().toISOString(),
    currentSectionIndex: Math.max(0, Math.floor(opts.currentSectionIndex ?? 0)),
    ...(typeof opts.currentStep === 'number' && Number.isFinite(opts.currentStep)
      ? { currentStep: Math.max(0, Math.floor(opts.currentStep)) }
      : {}),
    answers: cleanAnswers,
    fields: fieldSnapshots,
  };
}

/** Trigger a browser download of `<slug>-progress-YYYY-MM-DD.json`. */
export function downloadDraftJsonFile(
  form: { id: string; title: string; fields: FormField[] },
  answers: Record<string, unknown>,
  opts: { currentSectionIndex?: number; currentStep?: number } = {},
): FormDraftFile {
  const payload = buildDraftJsonFile(form, answers, opts);
  const slug = (form.title || 'form')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'form';
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${slug}-progress-${stamp}.json`;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return payload;
}

function normalizeLabelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Safely parse and map a downloaded `.json` draft (or plain `{ fieldId: value }` object)
 * onto the target form's current fillable fields.
 */
export function parseAndMapDraftJson(
  rawText: string,
  form: { id: string; fields: FormField[] },
  opts: { allowLinkedRecord?: boolean } = {},
): ParsedDraftImport | ParsedDraftImportError {
  if (rawText.length > MAX_DRAFT_JSON_BYTES) {
    return { ok: false, error: 'This JSON file is too large (max 2.5 MB).' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'Could not read this file — please choose a valid .json progress file.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid progress file format (expected a JSON object).' };
  }

  const root = stripUnsafeKeys(parsed) as Record<string, unknown>;
  const isEnvelope = root.format === DRAFT_FILE_FORMAT || (typeof root.answers === 'object' && root.answers !== null && !Array.isArray(root.answers));
  const rawAnswers = (isEnvelope && root.answers && typeof root.answers === 'object' && !Array.isArray(root.answers))
    ? (root.answers as Record<string, unknown>)
    : root;

  const sourceFormId = typeof root.formId === 'string' && root.formId.trim() !== '' ? root.formId.trim() : null;
  const sourceFormTitle = typeof root.formTitle === 'string' && root.formTitle.trim() !== '' ? root.formTitle.trim() : null;
  const savedAt = typeof root.savedAt === 'string' && root.savedAt.trim() !== '' ? root.savedAt.trim() : null;
  const formIdMismatch = sourceFormId !== null && sourceFormId !== form.id;
  const currentSectionIndex = typeof root.currentSectionIndex === 'number' && Number.isFinite(root.currentSectionIndex)
    ? Math.max(0, Math.floor(root.currentSectionIndex))
    : 0;
  const currentStep = typeof root.currentStep === 'number' && Number.isFinite(root.currentStep)
    ? Math.max(0, Math.floor(root.currentStep))
    : null;

  // Build maps for target form fields (ID lookup + label fallback for renamed field IDs).
  const fieldById = new Map<string, FormField>();
  const fieldByLabel = new Map<string, FormField>();
  for (const field of form.fields) {
    if (NON_INPUT_FIELD_TYPES.has(field.type)) continue;
    if (!opts.allowLinkedRecord && field.type === 'linked_record') continue;
    fieldById.set(field.id, field);
    const norm = normalizeLabelKey(field.label || '');
    if (norm && !fieldByLabel.has(norm)) {
      fieldByLabel.set(norm, field);
    }
  }

  // Optional metadata snapshot in the file maps old field IDs -> labels for resilient matching.
  const sourceLabelById = new Map<string, string>();
  if (Array.isArray(root.fields)) {
    for (const entry of root.fields) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string' && typeof (entry as Record<string, unknown>).label === 'string') {
        sourceLabelById.set(
          String((entry as Record<string, unknown>).id),
          String((entry as Record<string, unknown>).label),
        );
      }
    }
  }

  const mapped: Record<string, unknown> = {};
  let matchedCount = 0;
  let skippedCount = 0;
  let skippedFileUploads = 0;

  for (const [key, val] of Object.entries(rawAnswers)) {
    if (val === undefined || val === null || val === '') continue;
    let target = fieldById.get(key);
    if (!target) {
      const srcLabel = sourceLabelById.get(key);
      if (srcLabel) {
        target = fieldByLabel.get(normalizeLabelKey(srcLabel));
      }
    }
    if (!target) {
      target = fieldByLabel.get(normalizeLabelKey(key));
    }
    if (!target) {
      skippedCount++;
      continue;
    }
    if (target.type === 'file_upload') {
      skippedFileUploads++;
      skippedCount++;
      continue;
    }
    mapped[target.id] = val;
    matchedCount++;
  }

  const warnings: string[] = [];
  if (formIdMismatch) {
    warnings.push(
      sourceFormTitle
        ? `This file was saved from "${sourceFormTitle}" (a different form). Only matching fields were restored.`
        : 'This file was saved from a different form. Only matching fields were restored.',
    );
  }
  if (skippedFileUploads > 0) {
    warnings.push(
      `${skippedFileUploads} file upload ${skippedFileUploads === 1 ? 'field needs' : 'fields need'} to be re-attached for security.`,
    );
  }

  if (matchedCount === 0) {
    return {
      ok: false,
      error: formIdMismatch
        ? 'None of the answers in this .json file match fields on this form.'
        : 'No saved answers were found in this .json file for this form.',
    };
  }

  return {
    ok: true,
    answers: mapped,
    matchedCount,
    skippedCount,
    formIdMismatch,
    sourceFormId,
    sourceFormTitle,
    savedAt,
    currentSectionIndex,
    currentStep,
    warnings,
  };
}

// ── Browser-local Save & Resume (NON-PRIVATE forms ONLY) ──────────────────

export interface LocalPublicDraftRecord {
  version: 1;
  formId: string;
  savedAt: string;
  currentSectionIndex: number;
  currentStep: number;
  answers: Record<string, unknown>;
}

const LOCAL_DRAFT_PREFIX = 'formlogic.publicDraft.';

export function loadLocalPublicDraft(formId: string): LocalPublicDraftRecord | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_DRAFT_PREFIX + formId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalPublicDraftRecord>;
    if (!parsed || parsed.version !== 1 || parsed.formId !== formId || !parsed.answers || typeof parsed.answers !== 'object') {
      return null;
    }
    const answers = stripUnsafeKeys(parsed.answers) as Record<string, unknown>;
    if (Object.keys(answers).length === 0) return null;
    return {
      version: 1,
      formId,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      currentSectionIndex: typeof parsed.currentSectionIndex === 'number' ? Math.max(0, parsed.currentSectionIndex) : 0,
      currentStep: typeof parsed.currentStep === 'number' ? Math.max(0, parsed.currentStep) : 0,
      answers,
    };
  } catch {
    return null;
  }
}

export function saveLocalPublicDraft(
  formId: string,
  answers: Record<string, unknown>,
  currentSectionIndex: number,
  currentStep: number,
): boolean {
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (isAnswerFilled(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) {
      window.localStorage.removeItem(LOCAL_DRAFT_PREFIX + formId);
      return false;
    }
    const record: LocalPublicDraftRecord = {
      version: 1,
      formId,
      savedAt: new Date().toISOString(),
      currentSectionIndex: Math.max(0, Math.floor(currentSectionIndex)),
      currentStep: Math.max(0, Math.floor(currentStep)),
      answers: clean,
    };
    window.localStorage.setItem(LOCAL_DRAFT_PREFIX + formId, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalPublicDraft(formId: string): void {
  try {
    window.localStorage.removeItem(LOCAL_DRAFT_PREFIX + formId);
  } catch {
    // Ignore restricted storage environments.
  }
}
