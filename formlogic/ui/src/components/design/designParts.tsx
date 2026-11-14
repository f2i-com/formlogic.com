// The parts the database designer's steps and its diagram share: a table's details, a connection
// between two tables, the connection maker, and what the app's page may do with a table. Each
// edits a DatabaseDesign (lib/databaseDesign) and hands the changed one back.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Clock, KeyRound, Link2, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import {
  cleanName, designRoutes, FIELD_KINDS, KIND_LABEL, newField, newLink, ON_DELETE_LABEL, singular, tableById, words, withJoin,
  type DatabaseDesign, type DesignApi, type DesignField, type DesignLink, type DesignProblem, type DesignTable, type FieldKind, type OnDelete,
} from '../../lib/databaseDesign';
import { box, quietButton } from './designStyles';

/**
 * A question asked over the designer before something is undone, inside it: the site's own dialog
 * is put at the end of the page beneath the designer, where it could neither be seen nor answered.
 */
export function Confirm({ title, message, confirmLabel, onConfirm, onCancel }: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/40 p-4" onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
      <h2 id={titleId} className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button ref={cancel} type="button" onClick={onCancel} className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-200 dark:hover:bg-slate-800 sm:min-h-9">Cancel</button>
        <Button variant="danger" className="max-sm:min-h-11" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  </div>;
}

/** What is wrong, said under what it is about. */
export function Problems({ problems }: { problems: DesignProblem[] }) {
  if (!problems.length) return null;
  return <ul className="mt-1 space-y-0.5">{problems.map((problem, index) =>
    <li key={index} className="text-xs leading-5 text-red-700 dark:text-red-300">{problem.text}</li>)}</ul>;
}

/**
 * A name typed in words and kept as a name: "Due date" becomes due_date when the box is left (or
 * on Enter). While it is being typed it is the person's text, so spaces can be typed.
 */
export function NameInput({ value, onCommit, label, className, invalid, focusNow = false }: { value: string; onCommit: (name: string) => void; label: string; className?: string; invalid?: boolean; focusNow?: boolean }) {
  const [typing, setTyping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // A table just added: its name is chosen, to be typed over.
  useEffect(() => { if (focusNow) { input.current?.focus(); input.current?.select(); } }, [focusNow]);
  const commit = () => {
    if (typing === null) return;
    const next = cleanName(typing);
    setTyping(null);
    if (next !== value) onCommit(next);
  };
  return <input ref={input} aria-label={label} value={typing ?? value} spellCheck={false} autoCapitalize="none" autoComplete="off" aria-invalid={invalid || undefined}
    className={cn(box, 'font-mono', invalid && 'border-red-400 dark:border-red-500', className)}
    onFocus={() => setTyping(value)} onChange={event => setTyping(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); (event.target as HTMLInputElement).blur(); } if (event.key === 'Escape') setTyping(null); }} />;
}

function KindSelect({ value, onChange, label, className }: { value: FieldKind; onChange: (kind: FieldKind) => void; label: string; className?: string }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value as FieldKind)} className={cn(box, 'pr-8', className)}>
    {FIELD_KINDS.map(entry => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}
  </select>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-200 sm:min-h-9">
    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500 dark:border-slate-600" checked={checked} onChange={event => onChange(event.target.checked)} />
    {children}
  </label>;
}

/** A detail's default, in the box that fits its kind. */
function DefaultInput({ field, onChange }: { field: DesignField; onChange: (value: string) => void }) {
  const id = useId();
  const label = <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">When a new row is given none</label>;
  if (field.kind === 'boolean' || field.kind === 'choice') {
    const options = field.kind === 'boolean' ? [['yes', 'Yes'], ['no', 'No']] : field.choices.filter(Boolean).map(choice => [choice, choice]);
    return <div>{label}<select id={id} className={box} value={field.defaultValue} onChange={event => onChange(event.target.value)}>
      <option value="">{field.required && field.kind === 'boolean' ? 'No (the database’s own default)' : 'Nothing'}</option>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select></div>;
  }
  const type = field.kind === 'date' ? 'date' : field.kind === 'dateTime' ? 'datetime-local' : field.kind === 'email' ? 'email' : field.kind === 'url' ? 'url' : 'text';
  const numeric = field.kind === 'integer' || field.kind === 'decimal';
  return <div>{label}<input id={id} type={type} inputMode={numeric ? 'decimal' : undefined} className={box} value={field.defaultValue}
    placeholder={numeric ? '0' : 'Nothing'} onChange={event => onChange(event.target.value)} /></div>;
}

function ChoicesInput({ field, onChange }: { field: DesignField; onChange: (choices: string[]) => void }) {
  const [text, setText] = useState('');
  const id = useId();
  const add = () => {
    const choice = text.trim();
    if (!choice || field.choices.includes(choice)) { setText(''); return; }
    onChange([...field.choices, choice]);
    setText('');
  };
  return <div>
    <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Its choices</label>
    <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={`Choices of ${field.name}`}>
      {field.choices.map(choice => <li key={choice} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-0.5 text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">
        {choice}
        <button type="button" aria-label={`Remove the choice ${choice}`} onClick={() => onChange(field.choices.filter(other => other !== choice))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"><X className="h-3.5 w-3.5" /></button>
      </li>)}
    </ul>
    <div className="flex gap-2">
      <input id={id} className={box} value={text} placeholder="Add a choice" onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <Button size="sm" variant="secondary" className="h-11 shrink-0 sm:h-9" onClick={add} disabled={!text.trim()}>Add</Button>
    </div>
  </div>;
}

function FieldRow({ table, field, problems, onChange, onRemove }: { table: DesignTable; field: DesignField; problems: DesignProblem[]; onChange: (field: DesignField) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const more = `${table.id}-${field.id}-more`;
  const label = field.name || 'new detail';
  const hint = FIELD_KINDS.find(entry => entry.kind === field.kind)?.hint;
  return <li className="rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
    <div className="flex flex-wrap items-center gap-2">
      <NameInput label={`Name of the detail ${label}`} value={field.name} onCommit={name => onChange({ ...field, name })} invalid={problems.length > 0} className="flex-1 basis-40 sm:basis-48" />
      <div className="flex min-w-0 flex-1 basis-44 items-center gap-1 sm:flex-none">
        <KindSelect label={`What ${label} holds`} value={field.kind} className="sm:w-44"
          onChange={kind => onChange({ ...field, kind, defaultValue: '', choices: kind === 'choice' ? (field.choices.length ? field.choices : ['first', 'second']) : [] })} />
        <button type="button" className={quietButton} aria-expanded={open} aria-controls={more} aria-label={`More about ${label}`} onClick={() => setOpen(value => !value)}>
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
        <button type="button" className={cn(quietButton, 'hover:text-red-600 dark:hover:text-red-400')} aria-label={`Remove the detail ${label}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
    <div className="mt-1 flex flex-wrap gap-x-5">
      <Check checked={field.required} onChange={required => onChange({ ...field, required })}>Required</Check>
      <Check checked={field.unique} onChange={unique => onChange({ ...field, unique })}>No two the same</Check>
    </div>
    {open && <div id={more} className="mt-2 grid gap-3 border-t border-slate-100 pt-3 dark:border-slate-800 sm:grid-cols-2">
      {hint && <p className="text-xs leading-5 text-slate-500 dark:text-slate-400 sm:col-span-2">{KIND_LABEL[field.kind]}: {hint}.</p>}
      {field.kind === 'choice' && <ChoicesInput field={field} onChange={choices => onChange({ ...field, choices, defaultValue: choices.includes(field.defaultValue) ? field.defaultValue : '' })} />}
      <DefaultInput field={field} onChange={defaultValue => onChange({ ...field, defaultValue })} />
    </div>}
    <Problems problems={problems} />
  </li>;
}

/** The row every table has, and the ones it gets from its connections and its date: shown, not edited here. */
function FixedRow({ icon, name, says, children }: { icon: ReactNode; name: string; says: string; children?: ReactNode }) {
  return <li className="flex min-h-11 items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-1.5 text-sm dark:bg-slate-800/60">
    <span className="text-slate-400" aria-hidden="true">{icon}</span>
    <span className="font-mono text-slate-800 dark:text-slate-100">{name}</span>
    <span className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400">{says}</span>
    {children}
  </li>;
}

/** A table's details: its id, what the person adds, the columns its connections make, and when each row was added. */
export function FieldList({ design, table, problems, onChange }: { design: DatabaseDesign; table: DesignTable; problems: DesignProblem[]; onChange: (table: DesignTable) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FieldKind>('text');
  const one = words(singular(table.name || 'row'));
  const add = () => {
    const clean = cleanName(name);
    if (!clean) return;
    onChange({ ...table, fields: [...table.fields, newField(clean, kind)] });
    setName('');
    setKind('text');
  };
  const links = design.links.filter(link => link.from === table.id);
  return <div className="space-y-3">
    <ul className="space-y-2" aria-label={`Details of ${table.name}`}>
      <FixedRow icon={<KeyRound className="h-4 w-4" />} name="id" says="Numbered by the database" />
      {table.fields.map(field => <FieldRow key={field.id} table={table} field={field} problems={problems.filter(problem => problem.field === field.id)}
        onChange={next => onChange({ ...table, fields: table.fields.map(other => other.id === field.id ? next : other) })}
        onRemove={() => onChange({ ...table, fields: table.fields.filter(other => other.id !== field.id) })} />)}
      {links.map(link => <FixedRow key={link.id} icon={<Link2 className="h-4 w-4" />} name={link.column}
        says={`The ${words(singular(tableById(design, link.to)?.name ?? '?'))} it belongs to${link.required ? '' : ', if any'}`} />)}
      {table.stamped && <FixedRow icon={<Clock className="h-4 w-4" />} name="created_at" says="When it was added" />}
    </ul>
    <div className="rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-600">
      <p className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Add something to know about each {one}</p>
      <div className="flex flex-wrap gap-2">
        <input aria-label="Name of the new detail" className={cn(box, 'flex-1 basis-40')} value={name} placeholder="e.g. email, due date, price"
          onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <KindSelect label="What the new detail holds" value={kind} onChange={setKind} className="flex-1 basis-36 sm:w-44 sm:flex-none" />
        <Button size="sm" className="h-11 w-full sm:h-9 sm:w-auto" leftIcon={<Plus className="h-4 w-4" />} onClick={add} disabled={!cleanName(name)}>Add</Button>
      </div>
    </div>
    <Switch size="sm" label="Keep when each row was added" description="A created_at column the database fills in." checked={table.stamped} onChange={stamped => onChange({ ...table, stamped })} />
  </div>;
}

/** One connection, said as a sentence, with what it requires and what removing a row does. */
export function LinkCard({ design, link, problems, onChange, onRemove }: { design: DatabaseDesign; link: DesignLink; problems: DesignProblem[]; onChange: (link: DesignLink) => void; onRemove: () => void }) {
  const from = tableById(design, link.from);
  const to = tableById(design, link.to);
  const id = useId();
  if (!from || !to) return null;
  const many = words(singular(from.name));
  const one = words(singular(to.name));
  const article = (word: string) => /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
  return <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
    <div className="flex items-start gap-2">
      <p className="min-w-0 flex-1 text-sm leading-6 text-slate-800 dark:text-slate-100">
        Each <strong>{many}</strong> belongs to {link.required ? 'one' : 'at most one'} <strong>{one}</strong>{link.unique && <>, and each {one} has at most one {many}</>}
        <span className="mt-0.5 block font-mono text-xs text-slate-500 dark:text-slate-400">{from.name}.{link.column} → {to.name}.id</span>
      </p>
      <button type="button" className={cn(quietButton, 'hover:text-red-600 dark:hover:text-red-400')} aria-label={`Remove the connection from ${from.name} to ${to.name}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></button>
    </div>
    <div className="mt-2 space-y-3">
      <Switch size="sm" label={`Every ${many} must have ${article(one)}`} checked={link.required}
        onChange={required => onChange({ ...link, required, onDelete: required && link.onDelete === 'setNull' ? 'cascade' : link.onDelete })} />
      <Switch size="sm" label={`Each ${one} has at most one ${many}`} description={`One to one: no two ${words(from.name)} share ${article(one)}.`} checked={link.unique === true}
        onChange={unique => onChange({ ...link, unique })} />
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">When {article(one)} is removed</label>
        <select id={id} className={box} value={link.onDelete} onChange={event => onChange({ ...link, onDelete: event.target.value as OnDelete })}>
          {(['cascade', 'setNull', 'restrict'] as const).map(choice => <option key={choice} value={choice} disabled={choice === 'setNull' && link.required}>
            {ON_DELETE_LABEL[choice](one, words(from.name))}{choice === 'setNull' && link.required ? ' (not when every one must have one)' : ''}
          </option>)}
        </select>
      </div>
    </div>
    <Problems problems={problems} />
  </li>;
}

type Relation = 'belongsTo' | 'hasMany' | 'manyToMany';

/** Makes a connection from a sentence: each [a] belongs to one [b], has many [b], or many of each. */
export function AddConnection({ design, access, fixed, onChange }: { design: DatabaseDesign; access?: 'members' | 'application'; fixed?: string; onChange: (design: DatabaseDesign) => void }) {
  const tables = design.tables.filter(table => table.name);
  const [chosenFirst, setFirst] = useState('');
  const [relation, setRelation] = useState<Relation>('belongsTo');
  const [chosenSecond, setSecond] = useState('');
  if (tables.length < 1) return null;
  // What was chosen, while it is still there; otherwise the second table, and one not the first.
  const has = (id: string) => tables.some(table => table.id === id);
  const first = fixed ?? (has(chosenFirst) ? chosenFirst : (tables[1] ?? tables[0]).id);
  const second = has(chosenSecond) ? chosenSecond : (tables.find(table => table.id !== first) ?? tables[0]).id;
  const a = tableById(design, first);
  const b = tableById(design, second);
  const add = () => {
    if (!a || !b) return;
    if (relation === 'manyToMany') { if (a.id !== b.id) onChange(withJoin(design, a, b, access)); return; }
    const [from, to] = relation === 'belongsTo' ? [a, b] : [b, a];
    onChange({ ...design, links: [...design.links, newLink(design, from, to)] });
  };
  const select = (value: string, set: (id: string) => void, label: string) => <select aria-label={label} className={cn(box, 'flex-1 basis-32')} value={value} onChange={event => set(event.target.value)}>
    {tables.map(table => <option key={table.id} value={table.id}>{words(singular(table.name))}</option>)}
  </select>;
  return <div className="rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-600">
    <p className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Add a connection</p>
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <span>Each</span>
      {fixed ? <strong className="font-semibold">{words(singular(a?.name ?? ''))}</strong> : select(first, setFirst, 'The table it is from')}
      <select aria-label="How they are connected" className={cn(box, 'flex-1 basis-44')} value={relation} onChange={event => setRelation(event.target.value as Relation)}>
        <option value="belongsTo">belongs to one</option>
        <option value="hasMany">has many</option>
        <option value="manyToMany">has many, and each of those many of it</option>
      </select>
      {select(second, setSecond, 'The table it is to')}
      <Button size="sm" className="h-11 w-full sm:h-9 sm:w-auto" leftIcon={<Plus className="h-4 w-4" />} onClick={add} disabled={!a || !b || (relation === 'manyToMany' && a.id === b.id)}>Connect</Button>
    </div>
    {relation === 'manyToMany' && a && b && a.id !== b.id && <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
      A table {a.name}_{b.name} is added to keep which {words(singular(a.name))} has which {words(singular(b.name))}, each pair once.
    </p>}
  </div>;
}

const API_PARTS: { key: keyof DesignApi; label: string; method: string }[] = [
  { key: 'read', label: 'Read', method: 'GET' },
  { key: 'add', label: 'Add', method: 'POST' },
  { key: 'change', label: 'Change', method: 'PUT' },
  { key: 'remove', label: 'Remove', method: 'DELETE' },
];

/** What the app's page may do with a table, as four switches, with the routes they make. */
export function ApiChoice({ design, table, onChange }: { design: DatabaseDesign; table: DesignTable; onChange: (api: DesignApi) => void }) {
  const routes = designRoutes(design).filter(route => route.table === table.id);
  const nothingToChange = !table.fields.length && !design.links.some(link => link.from === table.id);
  return <fieldset>
    <legend className="sr-only">What the app’s page can do with {table.name}</legend>
    <div className="flex flex-wrap gap-2">
      {API_PARTS.map(part => {
        const off = part.key === 'change' && nothingToChange;
        return <label key={part.key} title={off ? 'It has no details to change yet' : undefined}
          className={cn('inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-medium focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-1 dark:focus-within:ring-offset-slate-900 sm:min-h-9',
            table.api[part.key] && !off ? 'border-primary-400 bg-primary-50 text-primary-800 dark:border-primary-500/60 dark:bg-primary-500/10 dark:text-primary-200' : 'border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300',
            off && 'cursor-not-allowed opacity-50')}>
          <input type="checkbox" className="sr-only" checked={table.api[part.key] && !off} disabled={off} onChange={event => onChange({ ...table.api, [part.key]: event.target.checked })} />
          {part.label}
        </label>;
      })}
    </div>
    <p className="mt-2 font-mono text-xs leading-5 text-slate-500 dark:text-slate-400">
      {routes.length ? routes.map(route => `${route.method} ${route.path}`).join(' · ') : 'No routes: only you change it, in the Data tab.'}
    </p>
  </fieldset>;
}
