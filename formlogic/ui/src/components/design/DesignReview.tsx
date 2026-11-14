// The last look before a design is made into the app's backend: what is left to fix (each a way to
// it), what the app's page may do with each table, the API that makes, and what is written. Over
// the designer, full screen on a phone.
import { ArrowLeft, FileCode2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { STARTER_ORIGIN } from '../../lib/softnBackend';
import { backendLogic, designRoutes, migrationSql, type DatabaseDesign, type DesignProblem } from '../../lib/databaseDesign';
import { ApiChoice } from './designParts';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DesignReview({ design, problems, access, onChange, onFix, onClose, onCreate, creating, waiting, error }: {
  design: DatabaseDesign;
  problems: DesignProblem[];
  access?: 'members' | 'application';
  onChange: (design: DatabaseDesign) => void;
  /** Go to what a problem is about. */
  onFix: (problem: DesignProblem) => void;
  onClose: () => void;
  onCreate: () => void;
  creating: boolean;
  waiting?: string | null;
  error?: string;
}) {
  const routes = designRoutes(design);
  return <div role="dialog" aria-modal="true" aria-label="Review and create" className="fixed inset-0 z-[75] flex flex-col bg-white dark:bg-slate-950"
    onKeyDown={event => { if (event.key === 'Escape' && !creating) { event.stopPropagation(); onClose(); } }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-2 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-slate-700 sm:px-4">
      <Button variant="ghost" className="max-sm:min-h-11" leftIcon={<ArrowLeft className="h-4 w-4" />} onClick={onClose}>Back to the design</Button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white sm:text-xl">{problems.length ? 'Nearly there' : 'Ready to make it'}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {count(design.tables.length, 'table', 'tables')}, {count(design.links.length, 'connection', 'connections')}, and {count(routes.length, 'route', 'routes')} for the app’s page.
        </p>
        {problems.length > 0 && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-950/30">
          <p className="text-sm font-semibold text-red-800 dark:text-red-200">{count(problems.length, 'thing', 'things')} to fix first</p>
          <ul className="mt-1 space-y-1">{problems.map((problem, index) => <li key={index} className="flex flex-wrap items-center gap-x-2 text-sm text-red-800 dark:text-red-200">
            <span className="min-w-0 flex-1">{problem.text}</span>
            {problem.table && <button type="button" className="min-h-11 font-medium underline underline-offset-2 sm:min-h-0" onClick={() => onFix(problem)}>Fix it</button>}
          </li>)}</ul>
        </div>}

        <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">What the app’s page can do</h3>
        <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {access === 'application' ? 'Anyone with the link can open this app, so anyone can do what you allow here: give the page only what it needs. ' : 'Only the people you invite can open this app, and do what you allow here. '}
          You change every row yourself in the Data tab, whatever you choose.
        </p>
        <ul className="mt-2 space-y-2">{design.tables.map(table => <li key={table.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <p className="mb-2 font-mono text-sm font-semibold text-slate-900 dark:text-white">{table.name || 'unnamed'}</p>
          <ApiChoice design={design} table={table} onChange={api => onChange({ ...design, tables: design.tables.map(other => other.id === table.id ? { ...other, api } : other) })} />
        </li>)}</ul>
        <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          The page calls them at <span className="break-all font-mono text-xs">{STARTER_ORIGIN}{routes[0]?.path ?? '/api/…'}</span> with <span className="font-mono text-xs">softn.net.fetch</span>; each answers JSON: a list as <span className="font-mono text-xs">rows</span>, one row as <span className="font-mono text-xs">row</span>. AI Studio can connect the page to them.
        </p>

        <details className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-medium text-slate-800 dark:text-slate-100"><FileCode2 className="h-4 w-4 text-slate-400" aria-hidden="true" />What is made</summary>
          <div className="space-y-3 border-t border-slate-200 p-3 dark:border-slate-700">
            <p className="font-mono text-xs text-slate-500 dark:text-slate-400">server/migrations/001.sql</p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-5 text-slate-100">{migrationSql(design)}</pre>
            <p className="font-mono text-xs text-slate-500 dark:text-slate-400">server/main.logic</p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-5 text-slate-100">{backendLogic(design)}</pre>
          </div>
        </details>
        <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Once it is made, the tables are the app’s database: rows are kept through every new version. A later change to the tables is a new migration, made in the source code or by AI Studio; the API is yours to change there too.
        </p>
        {waiting && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{waiting}</p>}
        {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      </div>
    </div>
    <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-2">
        <Button variant="ghost" className="max-sm:min-h-11" onClick={onClose}>Keep designing</Button>
        <Button className="max-sm:min-h-11" onClick={onCreate} isLoading={creating} disabled={problems.length > 0 || !!waiting}>Create the backend</Button>
      </div>
    </footer>
  </div>;
}
