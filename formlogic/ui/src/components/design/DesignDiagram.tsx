// A database design drawn as an entity-relationship diagram: a card for each table with its
// details, and a line for each connection, crow's foot at the table with many rows, a bar (or a
// ring and a bar, when it is optional) at the one each belongs to. Tables are laid out by Dagre,
// the tables others belong to first: left to right on a wide screen, top to bottom on a phone.
// A card is dragged to move it (kept with the design), a line drawn from one card to another
// says "each of these belongs to one of those", and a tap opens the table. On a phone the same
// design can be read as a list.
import { useEffect, useRef, useState } from 'react';
import { Background, ConnectionMode, Controls, Handle, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodePositionChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './DesignDiagram.css';
import dagre from 'dagre';
import { AlertCircle, Clock, KeyRound, LayoutGrid, Link2, List, Network, Plus, Table2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { cleanName, KIND_LABEL, newField, newLink, newTable, singular, tableById, words, type DatabaseDesign, type DesignProblem, type DesignTable } from '../../lib/databaseDesign';

const CARD_WIDTH = 240;
const ROW = 25;
const HEAD = 42;

type Direction = 'LR' | 'TB';
interface TableData extends Record<string, unknown> {
  table: DesignTable; design: DatabaseDesign; direction: Direction; problems: number; readOnly: boolean;
  /** Add a detail typed on the card itself (a selected card, on a wide screen): text, renamed or changed in the editor. */
  onAddField?: (name: string) => void;
}

function rowsOf(design: DatabaseDesign, table: DesignTable): number {
  return 1 + table.fields.length + design.links.filter(link => link.from === table.id).length + (table.stamped ? 1 : 0);
}

/** Where each table goes when nobody has moved it: the tables others belong to first. */
function layout(design: DatabaseDesign, direction: Direction): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: direction, nodesep: direction === 'LR' ? 36 : 28, ranksep: direction === 'LR' ? 90 : 56, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const table of design.tables) graph.setNode(table.id, { width: CARD_WIDTH, height: HEAD + ROW * rowsOf(design, table) });
  for (const link of design.links) if (link.from !== link.to && tableById(design, link.from) && tableById(design, link.to)) graph.setEdge(link.to, link.from);
  dagre.layout(graph);
  const out: Record<string, { x: number; y: number }> = {};
  for (const table of design.tables) {
    const at = graph.node(table.id);
    out[table.id] = at ? { x: Math.round(at.x - CARD_WIDTH / 2), y: Math.round(at.y - (HEAD + ROW * rowsOf(design, table)) / 2) } : { x: 0, y: 0 };
  }
  return out;
}

function QuickAdd({ table, onAdd }: { table: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return <div className="border-t border-slate-200 p-1.5 dark:border-slate-700">
    {/* nodrag/nopan: typing and selecting here never moves the card or the canvas. */}
    <input aria-label={`Add a detail to ${table}`} value={name} placeholder="+ Add a detail, then Enter" spellCheck={false} autoCapitalize="none"
      onChange={event => setName(event.target.value)}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && name.trim()) { onAdd(name); setName(''); } }}
      className="nodrag nopan h-8 w-full rounded-md border border-dashed border-slate-300 bg-transparent px-2 font-mono text-xs text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-primary-500 focus:outline-none dark:border-slate-600 dark:text-white" />
  </div>;
}

function TableCard({ data, selected }: NodeProps<Node<TableData>>) {
  const { table, design, direction, problems, readOnly, onAddField } = data;
  const links = design.links.filter(link => link.from === table.id);
  const handle = cn('!h-3.5 !w-3.5 !border-2 !border-white !bg-primary-500 dark:!border-slate-900', readOnly && '!opacity-0');
  return <div className={cn('rounded-xl border bg-white text-left shadow-sm dark:bg-slate-900', selected ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-slate-300 dark:border-slate-600')} style={{ width: CARD_WIDTH }}>
    {/* Toward the table it belongs to, and toward the tables that belong to it. */}
    <Handle type="source" position={direction === 'LR' ? Position.Left : Position.Top} className={handle} isConnectable={!readOnly} />
    <Handle type="target" position={direction === 'LR' ? Position.Right : Position.Bottom} className={handle} isConnectable={!readOnly} />
    <div className="flex items-center gap-2 rounded-t-xl border-b border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800" style={{ height: HEAD }}>
      <Table2 className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-300" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-slate-900 dark:text-white">{table.name || 'unnamed'}</span>
      {problems > 0 && <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-label={`${problems} to fix`} />}
    </div>
    <ul className="py-0.5 font-mono text-xs">
      <Row icon={<KeyRound className="h-3 w-3 text-amber-500" />} name="id" kind="number" />
      {table.fields.map(field => <Row key={field.id} name={field.name || '?'} kind={KIND_LABEL[field.kind].toLowerCase()} strong={field.required} />)}
      {links.map(link => <Row key={link.id} icon={<Link2 className="h-3 w-3 text-primary-500" />} name={link.column} kind={`→ ${tableById(design, link.to)?.name ?? '?'}`} strong={link.required} />)}
      {table.stamped && <Row icon={<Clock className="h-3 w-3 text-slate-400" />} name="created_at" kind="added" />}
    </ul>
    {selected && !readOnly && onAddField && <QuickAdd table={table.name} onAdd={onAddField} />}
  </div>;
}

function Row({ icon, name, kind, strong }: { icon?: React.ReactNode; name: string; kind: string; strong?: boolean }) {
  return <li className="flex items-center gap-1.5 px-3" style={{ height: ROW }}>
    <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">{icon}</span>
    <span className={cn('min-w-0 flex-1 truncate', strong ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-200')}>{name}</span>
    <span className="max-w-[45%] shrink-0 truncate font-sans text-[11px] text-slate-500 dark:text-slate-400">{kind}</span>
  </li>;
}

const NODE_TYPES = { table: TableCard };

/** The ends of the lines: crow's foot (many), a bar (exactly one), a ring and a bar (one, if any). Drawn pointing at the card. */
function Markers() {
  const line = { stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' };
  return <svg width="0" height="0" className="absolute text-slate-500 dark:text-slate-400" aria-hidden="true">
    <defs>
      <marker id="design-many" viewBox="0 0 16 16" refX="16" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M2 8 L16 1 M2 8 L16 8 M2 8 L16 15" {...line} />
      </marker>
      <marker id="design-one" viewBox="0 0 16 16" refX="16" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M9 1 L9 15 M13 1 L13 15" {...line} />
      </marker>
      <marker id="design-zero-one" viewBox="0 0 20 16" refX="20" refY="8" markerWidth="20" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <circle cx="6" cy="8" r="4" {...line} fill="white" className="dark:fill-slate-900" />
        <path d="M15 1 L15 15" {...line} />
      </marker>
    </defs>
  </svg>;
}

function edgesOf(design: DatabaseDesign): Edge[] {
  return design.links.filter(link => tableById(design, link.from) && tableById(design, link.to)).map(link => ({
    id: link.id, source: link.from, target: link.to, type: 'smoothstep',
    // At the end of the rows that belong: many, or (one to one) one if any.
    markerStart: link.unique ? 'design-zero-one' : 'design-many', markerEnd: link.required ? 'design-one' : 'design-zero-one',
    style: { strokeWidth: 1.5 }, className: 'text-slate-500',
    ariaLabel: `${tableById(design, link.from)?.name}.${link.column} belongs to ${tableById(design, link.to)?.name}${link.unique ? ', one each' : ''}`,
  }));
}

/** A name for a new table, not taken yet. */
function freshName(design: DatabaseDesign): string {
  const taken = new Set(design.tables.map(table => table.name));
  if (!taken.has('new_table')) return 'new_table';
  for (let n = 2; ; n += 1) if (!taken.has(`new_table_${n}`)) return `new_table_${n}`;
}

export interface DesignDiagramProps {
  design: DatabaseDesign;
  problems: DesignProblem[];
  access?: 'members' | 'application';
  selected: string | null;
  onSelect: (tableId: string | null) => void;
  onChange: (design: DatabaseDesign) => void;
  /** A phone: top to bottom, and a list to read it as. */
  narrow: boolean;
  /** The picture beside the Mermaid text: nothing is moved, connected or opened. */
  readOnly?: boolean;
  /** A table was just added: it is opened, its name ready to type over. Without this, it is selected. */
  onAdded?: (tableId: string) => void;
  /** The ways to start an empty design from something made elsewhere. */
  onImport?: () => void;
  onMermaid?: () => void;
}

function Canvas({ design, problems, selected, onSelect, onChange, narrow, readOnly = false, tidied }: DesignDiagramProps & { tidied: number }) {
  const direction: Direction = narrow ? 'TB' : 'LR';
  // The whole design in view again after Tidy up, and when several tables arrive at once (a pasted
  // schema): once the cards are drawn and measured.
  const flow = useReactFlow();
  const count = design.tables.length;
  const seen = useRef({ count, tidied });
  useEffect(() => {
    const before = seen.current;
    seen.current = { count, tidied };
    if (tidied === before.tidied && count <= before.count + 1) return;
    const timer = window.setTimeout(() => { void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 }); }, 80);
    return () => window.clearTimeout(timer);
  }, [count, tidied, flow]);
  const [source, setSource] = useState<{ design: DatabaseDesign; direction: Direction; selected: string | null; tidied: number } | null>(null);
  const [nodes, setNodes] = useState<Node<TableData>[]>([]);
  // The cards follow the design (and the direction and what is open), each where it was moved or
  // where it was laid out; a card already drawn keeps what React Flow measured of it.
  if (!source || source.design !== design || source.direction !== direction || source.selected !== selected || source.tidied !== tidied) {
    const auto = layout(design, direction);
    setSource({ design, direction, selected, tidied });
    setNodes(current => {
      const drawn = new Map(current.map(node => [node.id, node]));
      const fresh = source?.direction !== direction || source?.tidied !== tidied;
      // Tables added since (one, or several at once from a pasted schema): laid out among
      // themselves, beyond the cards there are, so they cover none and none covers another.
      const placed = current.filter(node => design.tables.some(table => table.id === node.id));
      const beyond = placed.length ? Math.max(...placed.map(node => direction === 'LR' ? node.position.x + CARD_WIDTH : node.position.y + (node.measured?.height ?? 120))) + 48 : 0;
      const added = design.tables.filter(table => !table.at && !drawn.has(table.id));
      const along = (table: DesignTable) => direction === 'LR' ? auto[table.id].x : auto[table.id].y;
      const start = added.length ? Math.min(...added.map(along)) : 0;
      return design.tables.map(table => {
        const before = drawn.get(table.id);
        const after = beyond + along(table) - start;
        const position = table.at ?? (!fresh && before ? before.position : (before || !placed.length ? auto[table.id] : direction === 'LR' ? { x: after, y: auto[table.id].y } : { x: auto[table.id].x, y: after }));
        // A phone opens the table in a sheet over the canvas: the card's own box is for a wide screen.
        const onAddField = readOnly || narrow ? undefined : (name: string) => {
          const clean = cleanName(name);
          if (clean) onChange({ ...design, tables: design.tables.map(other => other.id === table.id ? { ...other, fields: [...other.fields, newField(clean)] } : other) });
        };
        return { ...(before ?? {}), id: table.id, type: 'table', position, selected: table.id === selected, draggable: !readOnly,
          data: { table, design, direction, readOnly, onAddField, problems: problems.filter(problem => problem.table === table.id).length } };
      });
    });
  }
  const onNodesChange = (changes: NodeChange<Node<TableData>>[]) => {
    setNodes(current => applyNodeChanges(changes.filter(change => change.type !== 'select' && change.type !== 'remove'), current));
    if (readOnly) return;
    // A card chosen from the keyboard (Tab to it, Enter) opens as a click does.
    const chosen = changes.filter(change => change.type === 'select' && change.selected).pop();
    if (chosen && chosen.type === 'select') onSelect(chosen.id);
    // A card moved with the arrow keys is kept where it went, as a dragged one is.
    const moved = changes.filter((change): change is NodePositionChange => change.type === 'position' && !!change.position && !change.dragging);
    if (moved.length) onChange({ ...design, tables: design.tables.map(table => {
      const position = moved.find(change => change.id === table.id)?.position;
      return position ? { ...table, at: { x: Math.round(position.x), y: Math.round(position.y) } } : table;
    }) });
  };
  const onConnect = (connection: Connection) => {
    const from = tableById(design, connection.source);
    const to = tableById(design, connection.target);
    if (!from || !to || readOnly) return;
    onChange({ ...design, links: [...design.links, newLink(design, from, to)] });
    onSelect(from.id);
  };
  return <ReactFlow
    nodes={nodes} edges={edgesOf(design)} nodeTypes={NODE_TYPES}
    onNodesChange={onNodesChange} onConnect={onConnect} connectionMode={ConnectionMode.Loose}
    onNodeClick={(_, node) => { if (!readOnly) onSelect(node.id); }}
    onEdgeClick={(_, edge) => { if (!readOnly) onSelect(edge.source); }}
    onPaneClick={() => { if (!readOnly) onSelect(null); }}
    onNodeDragStop={(_, node) => onChange({ ...design, tables: design.tables.map(table => table.id === node.id ? { ...table, at: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : table) })}
    nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable={!readOnly} deleteKeyCode={null}
    fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }}
    aria-label="Diagram of the database design">
    <Background gap={20} size={1} />
    <Controls showInteractive={false} position="bottom-left" />
  </ReactFlow>;
}

const toolButton = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 sm:min-h-9';

/** The design as a list: each table, what it holds, and what it belongs to. A phone's easier read. */
function TableList({ design, problems, onSelect }: DesignDiagramProps) {
  return <div className="h-full overflow-y-auto p-3">
    <ul className="mx-auto max-w-3xl space-y-2" aria-label="Tables of the design">
      {design.tables.map(table => {
        const count = problems.filter(problem => problem.table === table.id).length;
        const links = design.links.filter(link => link.from === table.id);
        return <li key={table.id}>
          <button type="button" onClick={() => onSelect(table.id)} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left hover:border-primary-400 dark:border-slate-700 dark:bg-slate-900">
            <span className="flex items-center gap-2">
              <Table2 className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-300" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-slate-900 dark:text-white">{table.name || 'unnamed'}</span>
              {count > 0 && <span className="text-xs font-medium text-red-600 dark:text-red-400">{count} to fix</span>}
            </span>
            <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">
              {table.fields.length ? table.fields.map(field => field.name || '?').join(', ') : 'No details yet'}
            </span>
            {links.length > 0 && <span className="mt-1.5 flex flex-wrap gap-1">{links.map(link => <span key={link.id} className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-800 dark:bg-primary-500/10 dark:text-primary-200">
              <Link2 className="h-3 w-3" aria-hidden="true" />each belongs to {link.required ? 'one' : 'at most one'} {words(singular(tableById(design, link.to)?.name ?? '?'))}{link.unique ? ', one each' : ''}
            </span>)}</span>}
          </button>
        </li>;
      })}
    </ul>
  </div>;
}

export function DesignDiagram(props: DesignDiagramProps) {
  const { design, access, readOnly, onChange, onSelect, onAdded, onImport, onMermaid } = props;
  const [asList, setAsList] = useState(false);
  // Tidy up lays every card out again: each time it is pressed is a new layout.
  const [tidied, setTidied] = useState(0);
  const list = asList && !readOnly;
  const add = () => {
    const table = newTable(freshName(design), access);
    onChange({ ...design, tables: [...design.tables, table] });
    if (onAdded) onAdded(table.id); else onSelect(table.id);
  };
  return <div className="fl-design-canvas flex h-full min-h-0 w-full flex-col">
    <Markers />
    {/* Its tools in a bar of their own, so none covers a card or another on a phone. */}
    {!readOnly && design.tables.length > 0 && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white/80 px-2 py-2 dark:border-slate-700 dark:bg-slate-900/80">
      <button type="button" onClick={add} className={toolButton}><Plus className="h-4 w-4" aria-hidden="true" /> Add a table</button>
      {!list && design.tables.length > 1 && <button type="button" aria-label="Tidy up" title="Lay the tables out again"
        onClick={() => { setTidied(count => count + 1); onChange({ ...design, tables: design.tables.map(table => ({ ...table, at: undefined })) }); }} className={toolButton}>
        <LayoutGrid className="h-4 w-4" aria-hidden="true" /><span className="max-sm:sr-only">Tidy up</span>
      </button>}
      {/* A list too, wide as on a phone: a phone's easier read, and a keyboard's way to each table. */}
      {<div role="group" aria-label="Show the design as" className="ml-auto inline-flex rounded-lg border border-slate-300 bg-white p-0.5 dark:border-slate-600 dark:bg-slate-900">
        {([[false, 'Diagram', Network], [true, 'List', List]] as const).map(([value, label, Icon]) =>
          <button key={label} type="button" aria-pressed={asList === value} onClick={() => setAsList(value)}
            className={cn('inline-flex min-h-10 items-center gap-1 rounded-md px-2.5 text-xs font-medium', asList === value ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-200' : 'text-slate-600 dark:text-slate-300')}>
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
          </button>)}
      </div>}
    </div>}
    <div className="relative min-h-0 flex-1">
      {list ? <TableList {...props} /> : design.tables.length === 0 && !readOnly
        // Empty: nothing chosen for the owner. The first table, or a design made elsewhere.
        ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <Network className="h-8 w-8 text-slate-300 dark:text-slate-600" aria-hidden="true" />
          <p className="max-w-xs text-sm leading-6 text-slate-600 dark:text-slate-300">An empty database. Add a table for each thing the app keeps, then its details, and connect them.</p>
          <button type="button" onClick={add} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700"><Plus className="h-4 w-4" aria-hidden="true" /> Add a table</button>
          {(onImport || onMermaid) && <p className="text-xs text-slate-500 dark:text-slate-400">
            {onImport && <button type="button" onClick={onImport} className="min-h-11 font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 sm:min-h-0">or paste an SQL schema</button>}
            {onImport && onMermaid && <span aria-hidden="true"> · </span>}
            {onMermaid && <button type="button" onClick={onMermaid} className="min-h-11 font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 sm:min-h-0">write it in Mermaid</button>}
          </p>}
        </div>
        : <ReactFlowProvider><Canvas {...props} tidied={tidied} /></ReactFlowProvider>}
    </div>
  </div>;
}
