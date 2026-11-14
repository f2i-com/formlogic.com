// A schema made elsewhere, brought into the design: pasted, or read from a .sql file, as MySQL,
// SQL Server or SQLite write it (lib/sqlSchema). What was read is shown, with what did not fit,
// before it is added to the design or takes its place.
import { useId, useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { adoptIds, mergeDesigns, type DatabaseDesign } from '../../lib/databaseDesign';
import { importSql, SCHEMA_TEXT_LIMIT, type SchemaImport } from '../../lib/sqlSchema';

export function SqlImport({ design, access, onApply, onClose }: {
  design: DatabaseDesign;
  access?: 'members' | 'application';
  /** The design with the schema in it, and what to say of it. */
  onApply: (next: DatabaseDesign, said: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [read, setRead] = useState<SchemaImport | null>(null);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const tooLong = text.length > SCHEMA_TEXT_LIMIT;

  const readIt = (source = text) => {
    setError('');
    if (source.length > SCHEMA_TEXT_LIMIT) { setRead(null); setError('That is more than a schema: paste the CREATE TABLE statements alone, without the rows.'); return; }
    setRead(importSql(source, access));
  };
  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.size > SCHEMA_TEXT_LIMIT) { setError(`${chosen.name} is more than a schema (${(chosen.size / 1024 / 1024).toFixed(1)} MB): export the schema alone, without the rows.`); return; }
    const source = await chosen.text();
    setText(source);
    readIt(source);
  };
  const tables = read?.design.tables.length ?? 0;
  const apply = (how: 'add' | 'replace') => {
    if (!read || !tables) return;
    const links = read.design.links.length;
    const said = `${tables} ${tables === 1 ? 'table' : 'tables'} and ${links} ${links === 1 ? 'connection' : 'connections'} from the schema`;
    if (how === 'add') {
      const { design: next, renamed } = mergeDesigns(design, read.design);
      onApply(next, `${said} added.${renamed.length ? ` ${renamed.join(' ')}` : ''}`);
    } else onApply(adoptIds(design, read.design, false), `${said} in place of the design.`);
  };

  return <div className="fixed inset-0 z-[75] flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-6" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-900 max-sm:h-[100dvh] sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-2xl"
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        // In the schema it would throw away what was pasted: Escape closes only from elsewhere.
        if (!(event.target instanceof HTMLTextAreaElement)) onClose();
      }}>
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-slate-700">
        <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold text-slate-900 dark:text-white">Paste an SQL schema</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
          The CREATE TABLE statements of a database made elsewhere, as MySQL, SQL Server or SQLite write them (an export of the schema, or what you wrote). Its tables, columns, keys and foreign keys become the design; rows and everything else are passed over.
        </p>
        <textarea aria-label="The schema" value={text} onChange={event => { setText(event.target.value); setRead(null); setError(''); }} spellCheck={false} autoCapitalize="none" autoComplete="off"
          placeholder={'CREATE TABLE customers (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  name VARCHAR(120) NOT NULL\n);'}
          className="h-56 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs leading-5 text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 sm:h-64" />
        <input ref={file} type="file" accept=".sql,.txt,.ddl,text/plain,application/sql" className="hidden" aria-label="Choose a .sql file" onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; void choose(chosen); }} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="max-sm:min-h-11" onClick={() => readIt()} disabled={!text.trim() || tooLong}>Read it</Button>
          <Button size="sm" variant="secondary" className="max-sm:min-h-11" leftIcon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()}>Choose a .sql file</Button>
        </div>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        {read && <div role="status" className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">
            {tables ? `Read as ${read.dialect === 'SQL' ? 'SQL' : read.dialect}: ${tables} ${tables === 1 ? 'table' : 'tables'}, ${read.design.links.length} ${read.design.links.length === 1 ? 'connection' : 'connections'}` : 'Nothing to bring in'}
          </p>
          {tables > 0 && <p className="mt-1 font-mono text-xs leading-5 text-slate-600 dark:text-slate-300">{read.design.tables.map(table => table.name).join(' · ')}</p>}
          {read.notes.length > 0 && <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-xs leading-5 text-slate-600 dark:text-slate-300">
            {read.notes.map((note, index) => <li key={index}>{note}</li>)}
          </ul>}
        </div>}
      </div>
      {read && tables > 0 && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-200 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-slate-700">
        {design.tables.length
          ? <>
            <Button variant="secondary" className="max-sm:min-h-11" onClick={() => apply('replace')}>Replace the design</Button>
            <Button className="max-sm:min-h-11" onClick={() => apply('add')}>Add to the design</Button>
          </>
          : <Button className="max-sm:min-h-11" onClick={() => apply('replace')}>Use it</Button>}
      </footer>}
    </section>
  </div>;
}
