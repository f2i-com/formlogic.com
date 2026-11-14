// The database designer: how a backend is added to a SoftN app that has none. It is an
// entity-relationship diagram maker, starting empty: the owner adds tables, their details and the
// connections between them on the diagram, or writes the same design as Mermaid's ER diagram, or
// brings a schema made elsewhere (MySQL, SQL Server, SQLite). The backend is made from the design
// (lib/databaseDesign): its first migration, its API and its server block. Nothing is made until
// they create it; until then the design is kept in this browser, so a reload or a closed tab loses
// nothing. Full screen, on a phone as on a wide screen.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Code2, DatabaseZap, Network, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { BottomSheet } from '../ui/BottomSheet';
import { designProblems, designRoutes, readDesign, EMPTY_DESIGN, tableById, type DatabaseDesign, type DesignProblem } from '../../lib/databaseDesign';
import { DesignDiagram } from './DesignDiagram';
import { DesignReview } from './DesignReview';
import { MermaidView } from './MermaidView';
import { SqlImport } from './SqlImport';
import { TableEditor } from './TableEditor';
import { useMatches } from './useMatches';

export type DesignerMode = 'diagram' | 'mermaid';

const keyOf = (appId: string) => `formlogic:database-design:${appId}`;

/** The design kept for this app in this browser, or null: none, or storage that cannot be read. */
function readKept(appId: string): DatabaseDesign | null {
  try { return readDesign((JSON.parse(localStorage.getItem(keyOf(appId)) ?? 'null') as { design?: unknown } | null)?.design); }
  catch { return null; }
}

export function DatabaseDesigner({ appId, appName, access, mode, onMode, onClose, onCreate, waiting }: {
  appId: string;
  appName: string;
  access?: 'members' | 'application';
  mode: DesignerMode;
  onMode: (mode: DesignerMode) => void;
  onClose: () => void;
  /**
   * Make the backend from the design and install it; throws with the reason when it is refused.
   * Answers false when it went only into the draft of an app that is live (to publish later): the
   * design is then still kept here, so discarding the draft does not lose it.
   */
  onCreate: (design: DatabaseDesign) => Promise<boolean>;
  waiting?: string | null;
}) {
  const [design, setDesign] = useState<DatabaseDesign>(() => readKept(appId) ?? EMPTY_DESIGN);
  const [selected, setSelected] = useState<string | null>(null);
  // A table just added: its name is ready to type over.
  const [fresh, setFresh] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const made = useRef(false);
  const titleId = useId();
  const wide = useMatches('(min-width: 1024px)');
  const narrow = !useMatches('(min-width: 640px)');
  const problems = useMemo(() => designProblems(design), [design]);

  // Kept as it changes, until the backend is made from it.
  useEffect(() => {
    if (made.current) return;
    try {
      if (design.tables.length || design.links.length) localStorage.setItem(keyOf(appId), JSON.stringify({ design }));
      else localStorage.removeItem(keyOf(appId));
    } catch { /* a browser that keeps nothing: the design lasts while the page is open */ }
  }, [appId, design]);

  const change = (next: DatabaseDesign) => { setDesign(next); setError(''); };
  const select = (id: string | null) => { setSelected(id); if (id !== fresh) setFresh(null); };
  const create = async () => {
    setCreating(true); setError('');
    try {
      if (await onCreate(design)) {
        made.current = true;
        try { localStorage.removeItem(keyOf(appId)); } catch { /* nothing kept to clear */ }
      }
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'The backend could not be made.');
    } finally { setCreating(false); }
  };
  const fix = (problem: DesignProblem) => {
    setReviewing(false);
    if (mode !== 'diagram') onMode('diagram');
    if (problem.table) select(problem.table);
  };

  const open = mode === 'diagram' && selected ? tableById(design, selected) : undefined;
  // Keyed by its table: what was half typed or chosen in one table's editor never carries to the next.
  const editor = open && <TableEditor key={open.id} design={design} tableId={open.id} problems={problems} access={access} onChange={change} onOpen={select}
    onRemoved={() => select(null)} autoFocusName={open.id === fresh} />;
  const routes = designRoutes(design).length;

  return <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-[70] flex flex-col bg-white dark:bg-slate-950"
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape' && !reviewing && !importing && !target.closest('input, select, textarea, [role="dialog"] [role="dialog"]')) onClose();
    }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-2 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-slate-700 sm:px-4">
      <button type="button" onClick={onClose} aria-label="Close the designer" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white">
        <X className="h-5 w-5" />
      </button>
      <div className="min-w-0 flex-1">
        <h1 id={titleId} className="truncate text-sm font-semibold text-slate-900 dark:text-white sm:text-base">Design the database</h1>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{appName} · kept in this browser until you create it</p>
      </div>
      <Button variant="secondary" size="sm" className="shrink-0 max-sm:h-11 max-sm:w-11 max-sm:px-0" title="Paste an SQL schema"
        leftIcon={<DatabaseZap className="h-4 w-4" />} onClick={() => setImporting(true)}><span className="max-sm:sr-only">Paste SQL</span></Button>
      <div role="group" aria-label="Show it as" className="inline-flex shrink-0 rounded-lg border border-slate-300 p-0.5 dark:border-slate-600">
        {([['diagram', 'Diagram', Network], ['mermaid', 'Mermaid', Code2]] as const).map(([value, label, Icon]) =>
          <button key={value} type="button" aria-pressed={mode === value} aria-label={label} onClick={() => onMode(value)}
            className={cn('inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium sm:min-h-8',
              mode === value ? 'bg-primary-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
            <Icon className="h-4 w-4" aria-hidden="true" /><span className={cn(narrow && 'sr-only')}>{label}</span>
          </button>)}
      </div>
    </header>

    {notice && <p role="status" className="flex shrink-0 items-start gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-100">
      <span className="min-w-0 flex-1">{notice}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setNotice('')} className="-my-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-emerald-100 dark:hover:bg-emerald-900/60"><X className="h-4 w-4" /></button>
    </p>}

    {mode === 'mermaid'
      ? <div className="min-h-0 flex-1"><MermaidView design={design} problems={problems} access={access} onChange={change} wide={wide} narrow={narrow} /></div>
      : <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 bg-slate-50/70 dark:bg-slate-900/40">
          <DesignDiagram design={design} problems={problems} access={access} selected={selected} onSelect={select} onChange={change} narrow={narrow}
            onAdded={id => { setFresh(id); setSelected(id); }} onImport={() => setImporting(true)} onMermaid={() => onMode('mermaid')} />
        </div>
        {wide && open && <aside aria-label={`Table ${open.name}`} className="w-[28rem] shrink-0 overflow-y-auto border-l border-slate-200 p-4 dark:border-slate-700">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-white">{open.name || 'unnamed'}</h2>
            <Button variant="ghost" size="sm" onClick={() => select(null)}>Done</Button>
          </div>
          {editor}
        </aside>}
        {!wide && <BottomSheet title={open ? `Table ${open.name || 'unnamed'}` : ''} open={!!open} onClose={() => select(null)} expanded>
          <div className="overflow-y-auto p-4">{editor}</div>
        </BottomSheet>}
      </div>}

    <footer className="flex shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-slate-700 dark:bg-slate-900">
      <p className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300">
        {design.tables.length} {design.tables.length === 1 ? 'table' : 'tables'} · {design.links.length} {design.links.length === 1 ? 'connection' : 'connections'} · {routes} {routes === 1 ? 'route' : 'routes'}
        {problems.length > 0 && design.tables.length > 0 && <span className="text-red-600 dark:text-red-400"> · {problems.length} to fix</span>}
      </p>
      <Button className="shrink-0 max-sm:min-h-11" disabled={!design.tables.length} onClick={() => { setSelected(null); setReviewing(true); }}>Review and create</Button>
    </footer>

    {importing && <SqlImport design={design} access={access} onClose={() => setImporting(false)}
      onApply={(next, said) => { change(next); setSelected(null); setImporting(false); setNotice(said); if (mode !== 'diagram') onMode('diagram'); }} />}
    {reviewing && <DesignReview design={design} problems={problems} access={access} onChange={change} onFix={fix} onClose={() => setReviewing(false)}
      onCreate={() => void create()} creating={creating} waiting={waiting} error={error} />}
  </div>;
}
