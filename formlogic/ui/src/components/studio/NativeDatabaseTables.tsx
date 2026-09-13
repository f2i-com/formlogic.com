import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, Table2, ChevronRight } from 'lucide-react';
import type { NativeTableState } from './useNativeTables';
import { NativeEditor } from './NativeAppPanel';
import { Button } from '../ui/Button';

export function NativeDatabaseTables({ app, database }: {
  app: { id: string; name: string; slug: string }; database: NativeTableState;
}) {
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ tab: 'backend'|'records'; table?: string } | null>(null);
  if (!database.installed && !database.error && !database.loading) return null;
  const matches = database.tables.filter(table => table.toLowerCase().includes(query.trim().toLowerCase()));
  return <section aria-label="App database tables" className="col-span-full min-w-0 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50 sm:p-5">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div><h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><Database className="h-4 w-4" />App database</h3><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">{database.loading ? 'Loading database tables…' : `${database.tables.length} SQLite tables used by this app’s backend. Open a table to browse its records.`}</p></div>
      {database.installed && <Button variant="secondary" className="min-h-11 shrink-0" onClick={() => setEditor({ tab: 'backend' })}>Backend code</Button>}
    </div>
    {database.error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">Could not load database tables. Reload this section to try again.</p>}
    {database.installed && <>
      <label className="mt-4 block text-sm font-medium text-slate-800 dark:text-slate-200">Find a table<input type="search" aria-label="Search database tables" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search users, messages, appointments…" className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white" /></label>
      <div className="mt-4 grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">{matches.map(table => <button key={table} type="button" onClick={() => setEditor({ tab: 'records', table })} aria-label={`Browse ${table} records`} className="flex min-h-14 min-w-0 items-center gap-3 rounded-xl border border-slate-200 p-3 text-left text-sm text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><Table2 className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-300" /><span className="min-w-0 flex-1 break-words">{table}</span><ChevronRight className="h-4 w-4 shrink-0" /></button>)}</div>
      {!matches.length && !database.loading && <p className="mt-3 text-sm text-slate-500">{query ? 'No tables match your search.' : 'The installed backend has no application tables yet.'}</p>}
      <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-400">These are the app’s live tables. FormLogic forms can be added below and have their own response storage. <Link to={`/apps/${app.id}/studio/automations`} className="text-indigo-700 underline dark:text-indigo-300">Connect record changes to a flow</Link>.</p>
    </>}
    {editor && <NativeEditor app={app} initialTab={editor.tab} initialTable={editor.table} onClose={() => setEditor(null)} />}
  </section>;
}
