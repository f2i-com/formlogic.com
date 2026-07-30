import type { SketchField } from './sketch';

/**
 * Unsaved panel edits, keyed by element id and OUTLIVING the panel's mount.
 *
 * The panel is keyed by element id, so clicking another card unmounts it and every typed
 * field vanished — a renamed entity and a list of fields, gone, with no prompt and no
 * indication that Save was required. The draft now survives a deselect, so reselecting
 * the card shows the work back.
 *
 * `basedOn` pins the properties the draft was started from: if the element changed
 * elsewhere in the meantime (another commit, an undo), the fresh values win rather than a
 * stale draft silently overwriting them.
 */
export interface PanelDraft {
  basedOn: string;
  title: string;
  notes: string;
  bodyText: string;
  fields: SketchField[];
  cardinality: string;
  fkField: string;
  edgeLabel: string;
}
const draftCache = new Map<string, PanelDraft>();

/** The draft for an element, or null when there is none based on these exact properties. */
export function readSelectionDraft(elementId: string, basedOn: string): PanelDraft | null {
  const d = draftCache.get(elementId);
  return d && d.basedOn === basedOn ? d : null;
}

export function writeSelectionDraft(elementId: string, draft: PanelDraft): void {
  draftCache.set(elementId, draft);
}

/** Forget a draft once it has been committed or its element deleted. */
export function clearSelectionDraft(elementId: string): void {
  draftCache.delete(elementId);
}
