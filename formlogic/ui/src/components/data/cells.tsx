// What a cell holds, as it is shown and as it is edited. The grid, a phone's cards and a row's
// details all use these, so a value reads the same wherever it is.
import { useEffect, useRef, useState, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { cellKind, cellText } from './format';
import { focusRing, muted, primaryButton, smallButton } from './styles';

/**
 * A tick box drawn for both themes (the browser's own is white on the dark one). A real checkbox:
 * the mark over it is decoration.
 */
export function Tick({ indeterminate = false, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }) {
  return <span className={cn('relative inline-flex h-4 w-4 flex-none', className)}>
    <input type="checkbox" {...props} ref={node => { if (node) node.indeterminate = indeterminate; }}
      className={cn('peer h-full w-full cursor-pointer appearance-none rounded-[4px] border border-slate-400 bg-white checked:border-primary-600 checked:bg-primary-600 indeterminate:border-primary-600 indeterminate:bg-primary-600 dark:border-slate-500 dark:bg-slate-900 dark:checked:border-primary-500 dark:checked:bg-primary-500 dark:indeterminate:border-primary-500 dark:indeterminate:bg-primary-500', focusRing)} />
    <Check className="pointer-events-none absolute inset-0 m-auto hidden h-3 w-3 text-primary-foreground peer-checked:block" strokeWidth={3.4} aria-hidden="true" />
    <Minus className="pointer-events-none absolute inset-0 m-auto hidden h-3 w-3 text-primary-foreground peer-indeterminate:block" strokeWidth={3.4} aria-hidden="true" />
  </span>;
}

/**
 * Text as a value shows it. `mark`: what the rows were searched for, marked wherever the text holds
 * it, whatever its case, so a page of matches shows where each matched. `breaks`: the text is on one
 * line, where a line break would read as a space, so each is drawn as a muted ↵ (the break itself
 * stays in the text, for a screen reader and for a copy).
 */
export function Marked({ text, mark = '', breaks = false }: { text: string; mark?: string; breaks?: boolean }) {
  const sought = mark.trim().toLowerCase();
  const lines = breaks ? text.split('\n') : [text];
  const out: ReactNode[] = [];
  lines.forEach((line, at) => {
    if (at > 0) out.push(<span key={`break${at}`} data-break="" aria-hidden="true" className={cn('px-px', muted)}>↵</span>, '\n');
    const lower = line.toLowerCase();
    // Marked only where lower case keeps the text's length, so a place in one is a place in the other.
    if (!sought || lower.length !== line.length) { out.push(line); return; }
    let from = 0;
    for (let found = lower.indexOf(sought); found >= 0; found = lower.indexOf(sought, from)) {
      if (found > from) out.push(line.slice(from, found));
      out.push(<mark key={`mark${at}:${found}`} className="rounded-[2px] bg-amber-200/80 text-inherit dark:bg-amber-400/30">{line.slice(found, found + sought.length)}</mark>);
      from = found + sought.length;
    }
    if (from < line.length) out.push(line.slice(from));
  });
  return <>{out}</>;
}

/**
 * A value by the manager's rules: NULL in muted italics, an empty text named as one (it is not
 * NULL), a binary value as a muted `[binary]`, and a preview that was cut marked with an ellipsis
 * that says the text goes on. Anything else is shown exactly as stored. `wrap`: on several lines
 * (a card opened out, a row's details); otherwise on one, cut by its place, its line breaks drawn
 * as ↵. `mark`: the search, marked in the text (Marked).
 */
export function CellValue({ value, cut = false, wrap = false, mark }: { value: unknown; cut?: boolean; wrap?: boolean; mark?: string }) {
  const kind = cellKind(value);
  if (kind === 'null') return <span data-kind="null" className={cn('italic', muted)}>NULL</span>;
  if (kind === 'empty') return <span data-kind="empty" className={muted} title="An empty text. It is not NULL.">empty</span>;
  if (kind === 'binary') return <span data-kind="binary" className={muted}>[binary]</span>;
  const text = cellText(value);
  const more = <>
    <span className={cn('flex-none pl-0.5', muted)} title="This text is longer than the part shown." aria-hidden="true">…</span>
    <span className="sr-only"> (the text is longer than the part shown)</span>
  </>;
  if (wrap) return <span data-kind={cut ? 'cut' : 'value'} className="whitespace-pre-wrap [overflow-wrap:anywhere]"><Marked text={text} mark={mark} />{cut && more}</span>;
  if (!cut) return <span data-kind="value"><Marked text={text} mark={mark} breaks /></span>;
  return <span data-kind="cut" className="flex min-w-0 items-baseline"><span className="min-w-0 overflow-hidden whitespace-nowrap"><Marked text={text} mark={mark} breaks /></span>{more}</span>;
}

interface CellEditorProps {
  /** The box's name for a screen reader: "notes, row 8211". */
  label: string;
  /** The whole value as the row holds it: null for NULL. */
  original: string | null;
  numeric: boolean;
  /** The column may hold no value: NULL is offered, and an empty box is not saved without asking which is meant. */
  nullable: boolean;
  busy: boolean;
  /** The server's sentence, when it refused. */
  error?: string;
  /** Save and Cancel as buttons under a box as wide as its place: on a phone, where there is no Enter and Escape to rely on. */
  buttons?: boolean;
  /** `null`: save NULL. */
  onSave(value: string | null): void;
  /** `refocus`: the person left by the keyboard, so the focus goes back where the edit began. */
  onCancel(refocus: boolean): void;
}

/**
 * The box a value is edited in: one line, or a taller box for long text and text of several
 * lines. It keeps what is typed until it is saved or cancelled, so a refusal leaves the text where
 * it is. Enter saves and Escape cancels (in the taller box Shift+Enter starts a line).
 */
export function CellEditor({ label, original, numeric, nullable, busy, error, buttons = false, onSave, onCancel }: CellEditorProps) {
  const initial = original ?? '';
  const [text, setText] = useState(initial);
  const [tall] = useState(() => initial.includes('\n') || initial.length > 60);
  // An empty box on a column that may hold no value: empty text and NULL are different, so which is asked.
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.focus();
    try { node.setSelectionRange(node.value.length, node.value.length); } catch { /* a box that has no caret to place */ }
  }, []);

  const commit = () => {
    if (busy) return;
    if (text !== '' || !nullable) onSave(text);
    // A number column holds no empty text: cleared, the only value it can hold is none.
    else if (numeric) onSave(null);
    else setAsking(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A save on its way is not cancelled: its answer says what the row holds now.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(true); }
    // With buttons to save by, Enter in the taller box is a new line.
    else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !(tall && buttons)) { event.preventDefault(); commit(); }
  };
  // Clicking away from an untouched box closes it. A changed one stays until it is saved or cancelled.
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const to = event.relatedTarget as Node | null;
    if (to && event.currentTarget.closest('[data-cell-editor]')?.contains(to)) return;
    if (text === initial && !busy && !asking) onCancel(false);
  };
  const shared = {
    value: text, readOnly: busy, 'aria-label': label, 'aria-invalid': error ? true : undefined, 'aria-busy': busy || undefined,
    placeholder: original === null ? 'NULL' : undefined, spellCheck: false, autoComplete: 'off',
    onChange: (event: { target: { value: string } }) => { setText(event.target.value); if (event.target.value !== '') setAsking(false); },
    onKeyDown, onBlur,
  };
  const look = cn('block w-full min-w-0 rounded border-0 bg-white px-1.5 font-mono text-xs text-slate-900 outline-none ring-2 ring-primary-500 placeholder:italic placeholder:text-slate-500 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-400',
    numeric && !buttons && 'text-right', busy && 'opacity-70');
  const small = cn(smallButton, 'h-[22px] px-1.5 text-[11px]');

  // A press on one of the editor's own buttons leaves the focus in the box, so the box does not close under it.
  return <div data-cell-editor="" className="whitespace-normal text-left font-sans" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
    <div className="flex items-start gap-1">
      {tall
        ? <textarea ref={box} {...shared} rows={buttons ? 5 : 4} className={cn(look, 'resize-y py-1 leading-normal', buttons ? 'max-sm:py-2' : 'min-w-[20rem]')} />
        : <input ref={box} {...shared} type="text" inputMode={numeric ? 'decimal' : undefined} className={cn(look, buttons ? 'h-7 max-sm:h-10' : 'h-[22px]')}
            // In the grid the box is as wide as the value it opens on (the text is monospaced), up to a point, so the whole of it is in view.
            style={buttons ? undefined : { minWidth: `${Math.min(48, Math.max(12, initial.length + 3))}ch` }} />}
      {nullable && !buttons && <button type="button" className={small} disabled={busy} aria-label="Set to NULL" title="Save NULL: no value" onClick={() => onSave(null)}>NULL</button>}
    </div>
    {asking && <div role="group" aria-label="The box is empty" className={cn('mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-normal', muted)}>
      <span>The box is empty. Save</span>
      <button type="button" className={small} disabled={busy} onClick={() => onSave('')}>an empty text</button>
      <span>or</span>
      <button type="button" className={small} disabled={busy} onClick={() => onSave(null)}>NULL</button>
    </div>}
    {tall && !buttons && <p className={cn('mt-1 text-[11px]', muted)}>Enter saves · Shift+Enter starts a new line · Esc cancels</p>}
    {buttons && <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" className={primaryButton} disabled={busy} onClick={commit}>Save</button>
      <button type="button" className={cn(smallButton, 'h-7')} disabled={busy} onClick={() => onCancel(true)}>Cancel</button>
      {nullable && <button type="button" className={cn(smallButton, 'h-7')} disabled={busy} onClick={() => onSave(null)}>Set to NULL</button>}
    </div>}
    {error && <p role="alert" className="mt-1.5 max-w-[28rem] text-[11px] leading-normal text-red-700 dark:text-red-300">{error}</p>}
  </div>;
}
