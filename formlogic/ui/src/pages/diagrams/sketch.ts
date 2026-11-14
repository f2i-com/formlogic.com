// Shared sketch-field helpers for the diagram surface (extracted from
// DiagramCanvas.tsx — audit XR-02). Both the canvas (card rendering, on-card
// field adds) and the SelectionPanel (field editing) read sketched fields
// through the same tolerant parser.

export const DIAGRAM_INPUT_CLS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

export type SketchField = { name: string; type: string };

export const SKETCH_FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'email', 'phone', 'checkbox', 'dropdown'] as const;

/** Each field type in words: briefly on a card, in full in the panel's list. A type not listed is shown as it is. */
export const SKETCH_FIELD_WORDS: Record<string, { short: string; long: string }> = {
  short_text: { short: 'text', long: 'Short text' },
  long_text: { short: 'long text', long: 'Long text' },
  number: { short: 'number', long: 'Number' },
  date: { short: 'date', long: 'Date' },
  email: { short: 'email', long: 'Email' },
  phone: { short: 'phone', long: 'Phone' },
  checkbox: { short: 'yes / no', long: 'Checkbox (yes or no)' },
  dropdown: { short: 'choice', long: 'Dropdown (one of a list)' },
};

export function sketchFields(properties: Record<string, unknown>): SketchField[] {
  const raw = properties.fields;
  if (!Array.isArray(raw)) return [];
  const out: SketchField[] = [];
  for (const row of raw) {
    const name = typeof (row as { name?: unknown })?.name === 'string' ? (row as { name: string }).name.trim() : '';
    if (name === '') continue;
    const type = typeof (row as { type?: unknown })?.type === 'string' ? (row as { type: string }).type : 'short_text';
    out.push({ name, type });
  }
  return out;
}
