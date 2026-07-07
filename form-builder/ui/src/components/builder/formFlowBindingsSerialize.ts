// Pure serialization for the on-submit flow-binding UI (docs/FORMLOGIC_FLOWS.md §5).
//
// Kept in its own module (no React) so the mapping builder is unit-tested without a DOM and
// the component file stays fast-refresh-clean. A form-field input row becomes a
// `$event.data.answers.<fieldId>` selector; a static row becomes a typed literal.
import type { FlowBindingMode } from '../../types/flows';

export const FORM_SUBMITTED_EVENT = 'form.submitted';

/** One input-mapping row: a flow input name fed by a form field or a static literal. */
export interface InputMappingRow {
  /** The flow's declared input name (inputMap key). */
  input: string;
  /** 'field' → a `$event.data.answers.<fieldId>` selector; 'static' → a typed literal. */
  source: 'field' | 'static';
  /** Form field id (when source === 'field'). */
  fieldId?: string;
  /** Raw static value (when source === 'static'); JSON-parsed if it looks like JSON. */
  staticValue?: string;
}

export interface BindingDraft {
  flow: string; // flow slug
  mode: FlowBindingMode;
  rows: InputMappingRow[];
  timeoutMs: number;
  enabled: boolean;
}

/** The `$event.data.answers.<fieldId>` selector generated for a field-sourced input row. */
export function fieldSelector(fieldId: string): string {
  return `$event.data.answers.${fieldId}`;
}

/** Parse a static value cell: valid JSON stays typed, anything else is a raw string. */
export function parseStaticValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return '';
  if (/^[{[]|^-?\d|^"|^(true|false|null)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON — treat as a raw string */
    }
  }
  return raw;
}

/**
 * Build the inputMap from mapping rows. Rows with a blank input name (or a field row with
 * no field) are dropped. Returns null when nothing maps — the binding then runs the flow
 * with no inputs.
 */
export function buildInputMap(rows: InputMappingRow[]): Record<string, unknown> | null {
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    const name = row.input.trim();
    if (name === '') continue;
    if (row.source === 'field') {
      if (!row.fieldId) continue;
      map[name] = fieldSelector(row.fieldId);
    } else {
      map[name] = parseStaticValue(row.staticValue ?? '');
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * Serialize a draft into the /api/forms/{id}/flow-bindings request body. Event is always
 * `form.submitted` — this panel only manages the on-submit trigger.
 */
export function buildBindingPayload(draft: BindingDraft): Record<string, unknown> {
  return {
    event: FORM_SUBMITTED_EVENT,
    flow: draft.flow,
    mode: draft.mode,
    inputMap: buildInputMap(draft.rows),
    timeoutMs: draft.timeoutMs,
    enabled: draft.enabled,
  };
}

/** Rehydrate an existing binding's inputMap into editable rows (selectors → field rows). */
export function rowsFromInputMap(inputMap: Record<string, unknown> | null | undefined): InputMappingRow[] {
  if (!inputMap) return [];
  return Object.entries(inputMap).map(([input, value]) => {
    if (typeof value === 'string' && value.startsWith('$event.data.answers.')) {
      return { input, source: 'field', fieldId: value.slice('$event.data.answers.'.length) };
    }
    return {
      input,
      source: 'static',
      staticValue: typeof value === 'string' ? value : JSON.stringify(value),
    };
  });
}
