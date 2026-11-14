// One table of a database design, all of it in one place: its name, its details, its connections
// and what the app's page may do with it. The diagram opens it beside the canvas, or in a sheet on
// a phone.
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { singular, tableById, words, withoutLink, withoutTable, type DatabaseDesign, type DesignProblem, type DesignTable } from '../../lib/databaseDesign';
import { AddConnection, ApiChoice, Confirm, FieldList, LinkCard, NameInput, Problems } from './designParts';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="space-y-2">
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title}</h3>
    {children}
  </section>;
}

export function TableEditor({ design, tableId, problems, access, onChange, onOpen, onRemoved, autoFocusName = false }: {
  design: DatabaseDesign;
  tableId: string;
  problems: DesignProblem[];
  access?: 'members' | 'application';
  onChange: (design: DatabaseDesign) => void;
  /** Open another table: one whose rows belong to this one. */
  onOpen: (tableId: string) => void;
  onRemoved: () => void;
  /** A table just added: its name is chosen, ready to be typed over. */
  autoFocusName?: boolean;
}) {
  const [removing, setRemoving] = useState(false);
  const table = tableById(design, tableId);
  if (!table) return null;
  const change = (next: DesignTable) => onChange({ ...design, tables: design.tables.map(other => other.id === table.id ? next : other) });
  const outgoing = design.links.filter(link => link.from === table.id);
  const incoming = design.links.filter(link => link.to === table.id && link.from !== table.id);
  const mine = problems.filter(problem => problem.table === table.id);
  return <div className="space-y-5">
    <div>
      <p className="mb-1 text-xs font-semibold text-slate-600 dark:text-slate-300" aria-hidden="true">Table</p>
      <NameInput label="Name of the table" value={table.name} onCommit={name => change({ ...table, name })} invalid={mine.some(problem => problem.step === 'things')} focusNow={autoFocusName} />
      <Problems problems={mine.filter(problem => problem.step === 'things')} />
    </div>
    <Section title="Details">
      <FieldList design={design} table={table} problems={mine.filter(problem => problem.step === 'details')} onChange={change} />
    </Section>
    <Section title="Connections">
      {outgoing.length > 0 && <ul className="space-y-2">{outgoing.map(link => <LinkCard key={link.id} design={design} link={link} problems={problems.filter(problem => problem.link === link.id)}
        onChange={next => onChange({ ...design, links: design.links.map(other => other.id === link.id ? next : other) })}
        onRemove={() => onChange(withoutLink(design, link.id))} />)}</ul>}
      {incoming.length > 0 && <ul className="space-y-1">{incoming.map(link => {
        const from = tableById(design, link.from);
        return from && <li key={link.id} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-50 px-3 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
          <span className="min-w-0 flex-1">Each <strong>{words(singular(from.name))}</strong> belongs to {link.required ? 'one' : 'at most one'} {words(singular(table.name))}</span>
          <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={() => onOpen(from.id)}>Open {from.name}</Button>
        </li>;
      })}</ul>}
      {design.tables.length > 1 || outgoing.length ? null : <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">Add another table to connect this one to it.</p>}
      {design.tables.length > 1 && <AddConnection design={design} access={access} fixed={table.id} onChange={onChange} />}
      {table.uniqueLinks || outgoing.length >= 2 ? <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-primary-600" checked={table.uniqueLinks} onChange={event => change({ ...table, uniqueLinks: event.target.checked })} />
        Each combination of {outgoing.map(link => words(singular(tableById(design, link.to)?.name ?? ''))).join(' and ')} at most once
      </label> : null}
      <Problems problems={mine.filter(problem => problem.step === 'connections' && !problem.link)} />
    </Section>
    <Section title="What the app’s page can do">
      <ApiChoice design={design} table={table} onChange={api => change({ ...table, api })} />
    </Section>
    <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
      <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 dark:text-red-400 max-sm:min-h-11" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving(true)}>Remove this table</Button>
    </div>
    {removing && <Confirm title={`Remove ${table.name || 'this table'}?`} confirmLabel="Remove the table" onCancel={() => setRemoving(false)}
      message={`It leaves the design with its details${outgoing.length + incoming.length ? ' and its connections' : ''}. Nothing has been made yet, so nothing else is lost.`}
      onConfirm={() => { setRemoving(false); onChange(withoutTable(design, table.id)); onRemoved(); }} />}
  </div>;
}
