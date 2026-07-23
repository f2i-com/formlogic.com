// The diagram's selection editor, extracted verbatim from DiagramCanvas.tsx
// (audit XR-02 — behavior-neutral split behind SelectionPanel.test.tsx).
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import type { BlueprintElement } from '../../types/blueprints';
import { DIAGRAM_INPUT_CLS, SKETCH_FIELD_TYPES, sketchFields, type SketchField } from './sketch';

const INPUT_CLS = DIAGRAM_INPUT_CLS;

/**
 * §11A D2: the selection editor — a right rail editing the selected element through the
 * gateway. Forms edit title + sketched fields; other concepts edit title + NOTES (saved
 * as a linked sticky post-it BESIDE the node, visible on the diagram); notes/text edit
 * their body; edges edit a relationship NAME (and, for form-form ER relations,
 * cardinality + FK). Everything can be deleted from here too.
 */
export function SelectionPanel({
  element,
  busy,
  linkedNoteText,
  onSave,
  onDelete,
}: {
  element: BlueprintElement;
  busy: boolean;
  /** The text of the sticky note attached to this concept (null = none yet). */
  linkedNoteText: string | null;
  onSave: (properties: Record<string, unknown>, noteText?: string) => void;
  onDelete: () => void;
}) {
  const isEdge = element.elementType === 'edge';
  const edgeProps = element.properties as { edgeType?: string; cardinality?: string; fkField?: string; label?: string };
  const isErRelation = isEdge && edgeProps.edgeType === 'relation' && typeof edgeProps.cardinality === 'string';
  const isForm = element.elementType === 'form';
  const isTexty = element.elementType === 'note' || element.elementType === 'text';
  const isDrawing = element.elementType === 'ink' || element.elementType === 'image' || element.elementType === 'shape';
  const [title, setTitle] = useState(String((element.properties as { title?: unknown }).title ?? ''));
  const [notes, setNotes] = useState(linkedNoteText ?? '');
  const [bodyText, setBodyText] = useState(String((element.properties as { text?: unknown }).text ?? ''));
  const [fields, setFields] = useState<SketchField[]>(() => sketchFields(element.properties));
  const [cardinality, setCardinality] = useState(String(edgeProps.cardinality ?? '1:N'));
  const [fkField, setFkField] = useState(String(edgeProps.fkField ?? ''));
  const [edgeLabel, setEdgeLabel] = useState(String(edgeProps.label ?? ''));

  const save = () => {
    if (isEdge) {
      const next: Record<string, unknown> = { ...element.properties };
      if (edgeLabel.trim() === '') delete next.label;
      else next.label = edgeLabel.trim();
      if (isErRelation) {
        next.cardinality = cardinality;
        next.fkField = fkField.trim();
      }
      onSave(next);
      return;
    }
    if (isTexty) {
      const next: Record<string, unknown> = { ...element.properties, text: bodyText };
      delete next.title;
      onSave(next);
      return;
    }
    const next: Record<string, unknown> = {
      ...element.properties,
      title: title.trim() === '' ? 'Untitled' : title.trim(),
    };
    delete next.description; // superseded by the attached sticky note
    if (isForm) {
      next.fields = fields.filter((field) => field.name.trim() !== '').map((field) => ({ name: field.name.trim(), type: field.type }));
      onSave(next);
      return;
    }
    onSave(next, notes);
  };

  // Desktop: a fixed right rail. Phones (audit FL-26): a bottom sheet — a 256px
  // side panel on a 390px viewport left ~134px of canvas, unusable.
  return (
    <div className="scrollbar-thin border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900 max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-40 max-md:max-h-[45dvh] max-md:overflow-y-auto max-md:rounded-t-2xl max-md:border-t max-md:shadow-2xl md:w-64 md:flex-none md:overflow-y-auto md:border-l">
      {isEdge ? (
        <>
          <p className="mb-2 text-xs font-medium text-gray-500 dark:text-slate-400">
            {isErRelation ? 'Relation' : 'Connector'}
          </p>
          <label className="mb-1 block text-[11px] text-gray-400 dark:text-slate-500">
            Relationship name (shown on the wire)
          </label>
          <input
            value={edgeLabel}
            onChange={(e) => setEdgeLabel(e.target.value)}
            placeholder={isErRelation ? 'places / belongs to…' : 'relates to…'}
            aria-label="Relationship name"
            className={INPUT_CLS + ' w-full'}
          />
          {isErRelation && (
            <>
              <label className="mt-3 mb-1 block text-[11px] text-gray-400 dark:text-slate-500">Cardinality</label>
              <select value={cardinality} onChange={(e) => setCardinality(e.target.value)} aria-label="Relation cardinality" className={INPUT_CLS + ' w-full cursor-pointer'}>
                <option value="1:N">1:N — one source, many targets</option>
                <option value="1:1">1:1 — one to one</option>
                <option value="N:M">N:M — many to many (junction form)</option>
              </select>
              {cardinality !== 'N:M' && (
                <>
                  <label className="mt-3 mb-1 block text-[11px] text-gray-400 dark:text-slate-500">FK field (created on the target form)</label>
                  <input value={fkField} onChange={(e) => setFkField(e.target.value)} placeholder="customer" aria-label="Relation FK field" className={INPUT_CLS + ' w-full font-mono text-xs'} />
                </>
              )}
              {cardinality === 'N:M' && (
                <p className="mt-2 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
                  Materialises as a junction form linking both sides.
                </p>
              )}
            </>
          )}
        </>
      ) : isDrawing ? (
        <p className="text-xs text-gray-400 dark:text-slate-500">
          {element.elementType === 'ink' ? 'An ink stroke.' : element.elementType === 'image' ? 'An attached image.' : 'A shape.'} Delete it below, or press Delete.
        </p>
      ) : isTexty ? (
        <>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
            {element.elementType === 'note' ? 'Note text' : 'Text'}
          </label>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={6}
            placeholder="Write…"
            aria-label="Body text"
            className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
          />
        </>
      ) : (
        <>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
            {isForm ? 'Form title' : 'Title'}
          </label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Entity title" className={INPUT_CLS + ' w-full'} />
          {!isForm && (
            <>
              <label className="mt-3 mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={5}
                placeholder={element.elementType === 'flow'
                  ? 'When a booking arrives, check availability, then confirm by SMS…'
                  : 'Describe this concept…'}
                aria-label="Concept notes"
                className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
              />
              <p className="mt-1 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
                Saves as a sticky note linked beside this node — visible right on the diagram.
              </p>
            </>
          )}
          {isForm && (
          <>
          <div className="mt-3 mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Fields</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFields((rows) => [...rows, { name: '', type: 'short_text' }])}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              Add
            </Button>
          </div>
          <div className="space-y-1.5">
            {fields.length === 0 && (
              <p className="text-[11px] text-gray-400 dark:text-slate-500">No fields sketched yet — the materialised form starts empty.</p>
            )}
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  value={field.name}
                  onChange={(e) => setFields((rows) => rows.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)))}
                  placeholder="field_name"
                  aria-label={`Field name ${index + 1}`}
                  className={INPUT_CLS + ' w-full font-mono text-xs'}
                />
                <select
                  value={field.type}
                  onChange={(e) => setFields((rows) => rows.map((row, i) => (i === index ? { ...row, type: e.target.value } : row)))}
                  aria-label={`Field type ${index + 1}`}
                  className={INPUT_CLS + ' w-24 flex-none cursor-pointer text-xs'}
                >
                  {SKETCH_FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <Button
                  variant="ghost"
                  size="iconOnly"
                  onClick={() => setFields((rows) => rows.filter((_, i) => i !== index))}
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
      {!isDrawing && (
        <Button size="sm" className="mt-3 w-full" isLoading={busy} disabled={busy} onClick={save}>
          Save
        </Button>
      )}
      <Button variant="outline" size="sm" className="mt-2 w-full" disabled={busy} onClick={onDelete}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5 text-red-500" />
        Delete {isEdge ? 'connector' : 'element'}
      </Button>
    </div>
  );
}
