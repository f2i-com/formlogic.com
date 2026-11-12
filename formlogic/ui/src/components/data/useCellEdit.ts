// Editing one value in place, the same in the grid and on a phone's cards: read the row (for the
// whole value, not the preview, and for the revision an update must carry), then update that one
// column. A refusal leaves the edit open with the server's sentence; a value that cannot be
// edited, or a row that cannot be read, says so at that value.
import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { NativeBrowse, NativeRecordField } from '../../lib/nativeHosting';
import { rowId } from './format';

/** The value being edited. `reading`: its row is on its way. */
export interface CellEdit { id: string; column: string; key: Record<string, string>; phase: 'reading' | 'editing' | 'saving'; revision?: string; original?: string | null; error?: string }

/** Why the value at a row of the page and a column was not opened for editing. */
export interface CellRefusal { index: number; column: string; text: string }

interface Options {
  appId: string;
  table: string;
  /** The page of rows on screen: a refusal belongs to it, and goes when the page is loaded again. */
  page: NativeBrowse;
  fields: Record<string, NativeRecordField>;
  /** False in read-only mode: nothing is edited. */
  editable: boolean;
  /** A value was saved: load the same page of rows again. */
  onSaved(): void;
  /** The server said the row changed under the edit: load the page again. */
  onStale(): void;
}

export function useCellEdit({ appId, table, page, fields, editable, onSaved, onStale }: Options) {
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const [refused, setRefused] = useState<(CellRefusal & { page: NativeBrowse }) | null>(null);
  // Each read and save is numbered: an answer to anything but the latest is dropped.
  const turn = useRef(0);
  const keys = page.keys ?? [];

  /** Why a value cannot be edited in place, or '' when it can. */
  const locked = (index: number, column: string): string => {
    const field = fields[column];
    if (!keys[index]) return 'This row has no key to find it by, so it cannot be changed here.';
    if (!field || field.readOnly) return `${column} cannot be changed here: it is binary, or the database works it out.`;
    if (field.primary) return 'A row’s key cannot be changed.';
    return '';
  };

  const cancel = () => { turn.current++; setEdit(null); };

  /** `held`: another edit is open and keeps its place, so the text in it is not lost. */
  const start = (index: number, column: string): 'started' | 'held' | 'locked' => {
    if (!editable) return 'locked';
    const key = keys[index], reason = locked(index, column);
    const refuse = (text: string) => setRefused({ page, index, column, text });
    if (reason || !key) { refuse(reason); return 'locked'; }
    if (edit && edit.phase !== 'reading') return 'held';
    const mine = ++turn.current, id = rowId(key);
    const unread = 'This row could not be read. Try again.';
    setEdit({ id, column, key, phase: 'reading' });
    setRefused(null);
    void api.manageNativeRecord(appId, { table, action: 'read', key }).then(result => {
      if (turn.current !== mine) return;
      const record = result.data?.record;
      if (result.error || !record) { setEdit(null); refuse(result.error || unread); return; }
      // The row itself says what it holds: a binary value, or text too long to edit, is not offered.
      if (record.fields.find(field => field.name === column)?.readOnly !== false || !(column in record.values)) {
        setEdit(null);
        refuse(`${column} cannot be changed here: this value is binary or too long to edit.`);
        return;
      }
      setEdit({ id, column, key, phase: 'editing', revision: record.revision, original: record.values[column] });
    }).catch(() => { if (turn.current === mine) { setEdit(null); refuse(unread); } });
    return 'started';
  };

  /** Save a value (null: NULL). `closed` is told when the edit closes, saved or with nothing to save. */
  const save = (value: string | null, closed?: () => void) => {
    if (!edit || edit.phase !== 'editing') return;
    if (value === edit.original) { cancel(); closed?.(); return; }
    const mine = ++turn.current;
    const unsaved = 'The change could not be saved. Try again.';
    setEdit({ ...edit, phase: 'saving', error: undefined });
    void api.manageNativeRecord(appId, { table, action: 'update', key: edit.key, revision: edit.revision, values: { [edit.column]: value } }).then(result => {
      if (turn.current !== mine) return;
      if (result.error) {
        // The server's sentence, beside the text the person typed.
        setEdit(current => current && { ...current, phase: 'editing', error: result.error });
        if (result.status === 409) onStale();
        return;
      }
      setEdit(null);
      closed?.();
      onSaved();
    }).catch(() => { if (turn.current === mine) setEdit(current => current && { ...current, phase: 'editing', error: unsaved }); });
  };

  /** What was refused, while the page it was refused on is still the one on screen. */
  const refusal: CellRefusal | null = refused && refused.page === page ? refused : null;
  return { edit, refusal, locked, start, save, cancel };
}
