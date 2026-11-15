// The diagram's selection editor, extracted verbatim from DiagramCanvas.tsx
// (audit XR-02 — behavior-neutral split behind SelectionPanel.test.tsx).
import { useEffect, useState, type KeyboardEvent } from 'react';
import { readSelectionDraft, writeSelectionDraft, clearSelectionDraft } from './selectionDraft';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import type { BlueprintElement } from '../../types/blueprints';
import { DIAGRAM_INPUT_CLS, SKETCH_FIELD_TYPES, SKETCH_FIELD_WORDS, sketchFields, type SketchField } from './sketch';

const INPUT_CLS = DIAGRAM_INPUT_CLS;
/** A field's name over its control. */
const LABEL_CLS = 'mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300';
/** A line of help under a control. */
const HELP_CLS = 'text-[11px] leading-4 text-gray-500 dark:text-slate-400';

/** What is selected, in a word, for the panel's head. */
const KIND_NAMES: Record<string, string> = {
  form: 'Form', flow: 'Flow', actor: 'Actor', note: 'Note', text: 'Text',
  ink: 'Ink stroke', image: 'Image', shape: 'Shape',
  app: 'App', screen: 'Screen', event: 'Event', intelligence: 'Intelligence', service: 'Service', decision: 'Decision', group: 'Group',
};

/** What the panel shows of an element, one value to each box. */
interface PanelValues {
  title: string;
  notes: string;
  bodyText: string;
  fields: SketchField[];
  cardinality: string;
  fkField: string;
  edgeLabel: string;
}
const VALUE_KEYS = ['title', 'notes', 'bodyText', 'fields', 'cardinality', 'fkField', 'edgeLabel'] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The panel's values for an element as it stands, and the text of the sticky note on it. */
function valuesOf(element: BlueprintElement, linkedNoteText: string | null): PanelValues {
  const properties = element.properties as { title?: unknown; text?: unknown; cardinality?: unknown; fkField?: unknown; label?: unknown };
  return {
    title: String(properties.title ?? ''),
    notes: linkedNoteText ?? '',
    bodyText: String(properties.text ?? ''),
    fields: sketchFields(element.properties),
    cardinality: String(properties.cardinality ?? '1:N'),
    fkField: String(properties.fkField ?? ''),
    edgeLabel: String(properties.label ?? ''),
  };
}

/** What Save writes for these values: the element's properties with them put in, and a concept's note text. */
function toSave(element: BlueprintElement, values: PanelValues): { properties: Record<string, unknown>; noteText?: string } {
  if (element.elementType === 'edge') {
    const next: Record<string, unknown> = { ...element.properties };
    if (values.edgeLabel.trim() === '') delete next.label;
    else next.label = values.edgeLabel.trim();
    const edge = element.properties as { edgeType?: unknown; cardinality?: unknown };
    if (edge.edgeType === 'relation' && typeof edge.cardinality === 'string') {
      next.cardinality = values.cardinality;
      next.fkField = values.fkField.trim();
    }
    return { properties: next };
  }
  if (element.elementType === 'note' || element.elementType === 'text') {
    const next: Record<string, unknown> = { ...element.properties, text: values.bodyText };
    delete next.title;
    return { properties: next };
  }
  const next: Record<string, unknown> = {
    ...element.properties,
    title: values.title.trim() === '' ? 'Untitled' : values.title.trim(),
  };
  delete next.description; // superseded by the attached sticky note
  if (element.elementType === 'form') {
    next.fields = values.fields.filter((field) => field.name.trim() !== '').map((field) => ({ name: field.name.trim(), type: field.type }));
    return { properties: next };
  }
  return { properties: next, noteText: values.notes };
}

/** The values as they read once saved: a title trimmed, an empty field row dropped, and so on. */
function savedValues(element: BlueprintElement, linkedNoteText: string | null, values: PanelValues): PanelValues {
  const out = toSave(element, values);
  // The canvas makes a note for a concept only when there is something to write in it.
  const note = out.noteText === undefined || (linkedNoteText === null && out.noteText.trim() === '') ? linkedNoteText : out.noteText;
  return valuesOf({ ...element, properties: out.properties }, note);
}

/**
 * A form's fields changed here and elsewhere too: the list typed here, with a field left as it
 * was here taking what it is now (its type changed elsewhere, or gone if taken out elsewhere), and
 * what was added elsewhere after it. Fields are matched by name. `clash`: a field changed here
 * was changed elsewhere too (what was typed here is kept).
 */
function mergeFields(was: SketchField[], mine: SketchField[], now: SketchField[]): { fields: SketchField[]; clash: boolean } {
  const byName = (list: SketchField[]) => new Map(list.map((field) => [field.name.trim(), field]));
  const before = byName(was);
  const after = byName(now);
  const here = byName(mine);
  let clash = false;
  const kept = mine.flatMap((field) => {
    const old = before.get(field.name.trim());
    const current = after.get(field.name.trim());
    if (old && same(old, field)) return current ? [current] : [];
    if (old && !same(current, old) && !same(current, field)) clash = true;
    return [field];
  });
  const added = now.filter((field) => !before.has(field.name) && !here.has(field.name));
  return { fields: [...kept, ...added], clash };
}

/**
 * §11A D2: the selection editor — a right rail editing the selected element through the
 * gateway. Forms edit title + sketched fields; other concepts edit title + NOTES (saved
 * as a linked sticky post-it BESIDE the node, visible on the diagram); notes/text edit
 * their body; edges edit a relationship NAME (and, for form-form ER relations,
 * cardinality + FK). Everything can be deleted from here too.
 *
 * The panel stays open while the diagram comes back after a change, so the element can change
 * under it (its own Save landing, a field added on its card, another tab, Undo): what was not
 * touched here then takes the new value, and what was typed here stays (see the sync below).
 * Save writes the panel's values over the element as it is NOW, so it never puts back what the
 * panel opened with over a change made since.
 */
export function SelectionPanel({
  element,
  busy,
  linkedNoteText,
  onSave,
  onDelete,
  onClose,
  linkTargets = [],
  onLink,
}: {
  element: BlueprintElement;
  busy: boolean;
  /** The text of the sticky note attached to this concept (null = none yet). */
  linkedNoteText: string | null;
  onSave: (properties: Record<string, unknown>, noteText?: string) => void;
  onDelete: () => void;
  /** Lets go of the selection, which closes the panel; its head shows a close button for it. */
  onClose?: () => void;
  /** The other cards a line may be drawn to from here, in a few words each (none: no "Link to"). */
  linkTargets?: Array<{ id: string; label: string }>;
  /** Draws a line from this card to that one, meaning what the two are, as dragging one would. */
  onLink?: (targetId: string) => void;
}) {
  const isEdge = element.elementType === 'edge';
  const edgeProps = element.properties as { edgeType?: string; cardinality?: string; fkField?: string; label?: string };
  const isErRelation = isEdge && edgeProps.edgeType === 'relation' && typeof edgeProps.cardinality === 'string';
  const isForm = element.elementType === 'form';
  const isTexty = element.elementType === 'note' || element.elementType === 'text';
  const isDrawing = element.elementType === 'ink' || element.elementType === 'image' || element.elementType === 'shape';
  // The element as it stands, in the panel's values.
  const current = valuesOf(element, linkedNoteText);
  const currentKey = JSON.stringify(current);
  // Restore an unsaved draft from a previous mount, unless the element itself has moved
  // on since (see draftCache).
  const basedOn = JSON.stringify(element.properties ?? {});
  const [values, setValues] = useState<PanelValues>(() => {
    const restored = readSelectionDraft(element.id, basedOn);
    return restored ? { title: restored.title, notes: restored.notes, bodyText: restored.bodyText, fields: restored.fields, cardinality: restored.cardinality, fkField: restored.fkField, edgeLabel: restored.edgeLabel } : current;
  });
  const { title, notes, bodyText, fields, cardinality, fkField, edgeLabel } = values;
  const set = <K extends keyof PanelValues>(key: K, value: PanelValues[K] | ((previous: PanelValues[K]) => PanelValues[K])) =>
    setValues((previous) => ({ ...previous, [key]: typeof value === 'function' ? (value as (previous: PanelValues[K]) => PanelValues[K])(previous[key]) : value }));
  // The element as the panel last took it in: what was typed here is told apart from it.
  const [seen, setSeen] = useState<{ key: string; values: PanelValues }>({ key: currentKey, values: current });
  // What the last Save sent, until the element comes back: that change is this panel's own.
  const [sent, setSent] = useState<PanelValues | null>(null);
  // A value was changed here and elsewhere too: Save keeps what was typed here, and says so first.
  const [clashed, setClashed] = useState(false);

  // The element changed under the open panel (state set during render, the sanctioned pattern, so
  // the panel never shows the old values for a frame). Each value not touched here takes the new
  // one, and so does one typed here that reads now as it was saved (a title trimmed, an empty
  // field row dropped); one typed here stays. Without this the panel kept what it opened with,
  // and its next Save wrote that back over the change.
  if (currentKey !== seen.key) {
    const saved = savedValues(element, linkedNoteText, values);
    const next: PanelValues = { ...values };
    let clash = false;
    for (const key of VALUE_KEYS) {
      const mine = values[key];
      const was = seen.values[key];
      const now = current[key];
      if (same(mine, was) || same(saved[key], now)) Object.assign(next, { [key]: now });
      else if (same(now, was) || (sent !== null && same(now, sent[key]))) continue;
      else if (key === 'fields') {
        const merged = mergeFields(seen.values.fields, values.fields, current.fields);
        next.fields = merged.fields;
        clash ||= merged.clash;
      } else clash = true;
    }
    setValues(next);
    setSeen({ key: currentKey, values: current });
    setSent(null);
    if (clash) setClashed(true);
  }
  // What is typed here and not yet saved: said beside Save, so it is not left behind unawares.
  const dirty = !same(values, current);

  // Mirror the buffer into the cache on unmount, so a deselect preserves it.
  useEffect(() => () => {
    writeSelectionDraft(element.id, { basedOn, title, notes, bodyText, fields, cardinality, fkField, edgeLabel });
  }, [element.id, basedOn, title, notes, bodyText, fields, cardinality, fkField, edgeLabel]);

  const save = () => {
    // Committed — the draft is no longer unsaved work.
    clearSelectionDraft(element.id);
    setSent(savedValues(element, linkedNoteText, values));
    setClashed(false);
    const out = toSave(element, values);
    if (out.noteText === undefined) onSave(out.properties);
    else onSave(out.properties, out.noteText);
  };
  /** Enter in a one-line box saves, as Save does. */
  const saveOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    save();
  };

  // Desktop: a fixed right rail. Phones (audit FL-26): a bottom sheet — a 256px
  // side panel on a 390px viewport left ~134px of canvas, unusable.
  return (
    <div data-selection-panel className="scrollbar-thin border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900 max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--fl-mobile-nav-h)] max-md:z-40 max-md:max-h-[45dvh] max-md:overflow-y-auto max-md:rounded-t-2xl max-md:pb-[calc(var(--fl-mobile-fab-h)+0.5rem)] max-md:border-t max-md:shadow-2xl md:w-72 md:flex-none md:overflow-y-auto md:border-l">
      {/* The panel's head: what is selected, and the way to close the panel (on a phone it
          covers the foot of the canvas, where a tap to let go would otherwise have to land). */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
          {isEdge ? (isErRelation ? 'Relation' : 'Connector') : (KIND_NAMES[element.elementType] ?? 'Element')}
        </p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the panel"
            title="Close"
            className="-my-1 -mr-1 flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white max-md:h-11 max-md:w-11"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {isEdge ? (
        <>
          <label className={LABEL_CLS}>
            What to call this link (shown on the line)
          </label>
          <input
            value={edgeLabel}
            onChange={(e) => set('edgeLabel', e.target.value)}
            onKeyDown={saveOnEnter}
            placeholder={isErRelation ? 'places / belongs to…' : 'relates to…'}
            aria-label="Relationship name"
            className={INPUT_CLS + ' w-full'}
          />
          {isErRelation && (
            <>
              <label className={`mt-3 ${LABEL_CLS}`}>How many of each?</label>
              <select value={cardinality} onChange={(e) => set('cardinality', e.target.value)} aria-label="How many records link to each other" className={INPUT_CLS + ' w-full cursor-pointer'}>
                <option value="1:N">One of these has many of those</option>
                <option value="1:1">Exactly one each way</option>
                <option value="N:M">Many on both sides</option>
              </select>
              {cardinality !== 'N:M' && (
                <>
                  <label className={`mt-3 ${LABEL_CLS}`}>Name of the question added to the other form</label>
                  <input value={fkField} onChange={(e) => set('fkField', e.target.value)} onKeyDown={saveOnEnter} placeholder="customer" aria-label="Relation FK field" className={INPUT_CLS + ' w-full font-mono text-xs'} />
                </>
              )}
              {cardinality === 'N:M' && (
                <p className={`mt-2 ${HELP_CLS}`}>
                  Materialises as a junction form linking both sides.
                </p>
              )}
            </>
          )}
        </>
      ) : isDrawing ? (
        <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
          {element.elementType === 'ink' ? 'An ink stroke.' : element.elementType === 'image' ? 'An attached image.' : 'A shape.'} Delete it below, or press Delete.
        </p>
      ) : isTexty ? (
        <>
          <label className={LABEL_CLS}>
            {element.elementType === 'note' ? 'Note text' : 'Text'}
          </label>
          <textarea
            value={bodyText}
            onChange={(e) => set('bodyText', e.target.value)}
            rows={6}
            placeholder="Write…"
            aria-label="Body text"
            className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
          />
        </>
      ) : (
        <>
          <label className={LABEL_CLS}>
            {isForm ? 'Form title' : 'Title'}
          </label>
          <input value={title} onChange={(e) => set('title', e.target.value)} onKeyDown={saveOnEnter} aria-label="Entity title" className={INPUT_CLS + ' w-full'} />
          {!isForm && (
            <>
              <label className={`mt-3 ${LABEL_CLS}`}>Notes</label>
              <textarea
                value={notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={5}
                placeholder={element.elementType === 'flow'
                  ? 'When a booking arrives, check availability, then confirm by SMS…'
                  : 'Describe this concept…'}
                aria-label="Concept notes"
                className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
              />
              <p className={`mt-1 ${HELP_CLS}`}>
                Saves as a sticky note linked beside this node — visible right on the diagram.
              </p>
            </>
          )}
          {isForm && (
          <>
          <div className="mt-3 mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600 dark:text-slate-300">Fields</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => set('fields', (rows) => [...rows, { name: '', type: 'short_text' }])}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              Add
            </Button>
          </div>
          <div className="space-y-1.5">
            {fields.length === 0 && (
              <p className={HELP_CLS}>No fields sketched yet — the materialised form starts empty.</p>
            )}
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  value={field.name}
                  onChange={(e) => { const name = e.target.value; set('fields', (rows) => rows.map((row, i) => (i === index ? { ...row, name } : row))); }}
                  onKeyDown={saveOnEnter}
                  placeholder="field_name"
                  aria-label={`Field name ${index + 1}`}
                  className={INPUT_CLS + ' w-full font-mono text-xs'}
                />
                <select
                  value={field.type}
                  onChange={(e) => { const type = e.target.value; set('fields', (rows) => rows.map((row, i) => (i === index ? { ...row, type } : row))); }}
                  aria-label={`Field type ${index + 1}`}
                  className={INPUT_CLS + ' w-32 flex-none cursor-pointer text-xs'}
                >
                  {SKETCH_FIELD_TYPES.map((type) => <option key={type} value={type}>{SKETCH_FIELD_WORDS[type].long}</option>)}
                  {/* A type the panel does not offer (one an AI wrote) is kept, and shown as it is. */}
                  {!(SKETCH_FIELD_TYPES as readonly string[]).includes(field.type) && <option value={field.type}>{field.type}</option>}
                </select>
                {/* A finger's size on a phone; in the desktop rail it gives its room to the name. */}
                <Button
                  variant="ghost"
                  size="iconOnly"
                  className="h-11 w-11 flex-none md:h-8 md:w-8"
                  onClick={() => set('fields', (rows) => rows.filter((_, i) => i !== index))}
                  aria-label={`Remove field ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
            ))}
          </div>
          </>
          )}
        </>
      )}
      {/* A line to another card, without drawing one: a finger's way, and the keyboard's. */}
      {!isEdge && onLink && linkTargets.length > 0 && (
        <>
          <label htmlFor={`link-${element.id}`} className={`mt-3 ${LABEL_CLS}`}>Link to</label>
          <select
            id={`link-${element.id}`}
            value=""
            disabled={busy}
            onChange={(e) => { if (e.target.value) onLink(e.target.value); }}
            className={INPUT_CLS + ' w-full cursor-pointer'}
          >
            <option value="">Choose something to link this to…</option>
            {linkTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
          </select>
        </>
      )}
      {!isDrawing && (
        <>
          <Button size="sm" className="mt-3 w-full" isLoading={busy} disabled={busy} onClick={save}>
            Save
          </Button>
          {dirty && !busy && (clashed ? (
            // What was typed here was changed elsewhere too: the person chooses, nothing is lost unsaid.
            <p className={`mt-1 text-center ${HELP_CLS}`} role="status">
              Changed elsewhere too since you began. Save keeps what you typed here, or{' '}
              <button
                type="button"
                onClick={() => { setValues(current); setClashed(false); }}
                className="cursor-pointer font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-300 dark:hover:text-primary-200"
              >
                take the saved version
              </button>.
            </p>
          ) : <p className={`mt-1 text-center ${HELP_CLS}`} role="status">Not saved yet</p>)}
        </>
      )}
      <Button variant="outline" size="sm" className="mt-2 w-full" disabled={busy} onClick={onDelete}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5 text-red-500" />
        Delete {isEdge ? 'connector' : 'element'}
      </Button>
    </div>
  );
}
