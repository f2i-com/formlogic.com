// FormLogic Flows editor — node palette.
//
// Ported from f2i-web's NodePalette: nodes grouped by category, searchable, drag-to-add onto the
// canvas (or click-to-add at the viewport centre). Desktop-service-backed nodes (browser_action /
// image_gen / stt_transcribe / tts_speak) are fully insertable and render a functional "Runs on
// FormLogic Desktop" badge — they execute against a local Desktop service at run time.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, FolderPlus, MonitorDown, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/Button';
import {
  NODE_CATEGORIES,
  EMPTY_FLOW_EDITOR_CONTEXT,
  isNodeAvailableInContext,
  type FlowEditorContext,
  type NodeSpec,
} from './nodeCatalog';
import { flowNodeRegistry } from '../registry/FlowNodeRegistry';
import { useNodeGroupStore, type NodeGroup } from '../../../stores/nodeGroupStore';
import { useInstalledNodeStore } from '../../../stores/installedNodeStore';
import { ACCENT_CHIP } from './accents';
import { FlowDesktopPresenceContext } from './flowNodeContext';

// Tiles carry only icon + name now — the description lives in this hover popover, so it
// should appear promptly (but still late enough that drag-pickups don't flash it).
const HOVER_DELAY_MS = 300;
const DESKTOP_OFFLINE_NODE_TOOLTIP = 'FormLogic Desktop is offline — this node will fail at run time';

/** Compact "In / Out" handle summary for the hover popover. */
function handleSummary(handles: { label: string }[]): string {
  return handles.length === 0 ? '—' : handles.map((h) => h.label).join(' / ');
}

/** A delayed hover popover with a node's longer doc + a compact inputs/outputs summary (docs §4). */
function PaletteDoc({ spec, anchor, degraded }: { spec: NodeSpec; anchor: DOMRect; degraded: boolean }) {
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 220));
  const left = anchor.right + 8;
  return (
    <div
      role="tooltip"
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-64 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-xl"
    >
      <p className="text-xs font-semibold text-gray-900 dark:text-white">{spec.label}</p>
      <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-slate-400">{spec.doc ?? spec.description}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400 dark:text-slate-500">
        <span><span className="font-medium text-gray-500 dark:text-slate-400">In:</span> {handleSummary(spec.inputs)}</span>
        <span><span className="font-medium text-gray-500 dark:text-slate-400">Out:</span> {handleSummary(spec.outputs)}</span>
      </div>
      {spec.output && (
        <p className="mt-1.5 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
          <span className="font-medium text-gray-500 dark:text-slate-400">Output:</span> {spec.output}
        </p>
      )}
      {spec.requiresDesktopService && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-primary-600 dark:text-primary-300">
          <MonitorDown className="h-2.5 w-2.5" /> Runs on the {spec.requiresDesktopService} service in FormLogic Desktop
        </p>
      )}
      {degraded && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-2.5 w-2.5" /> {DESKTOP_OFFLINE_NODE_TOOLTIP}
        </p>
      )}
      {spec.capability && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-300">Requires the {spec.capability} capability</p>
      )}
    </div>
  );
}

/** dataTransfer MIME the canvas reads on drop. */
export const PALETTE_DND_MIME = 'application/x-formlogic-flow-node';

interface NodePaletteProps {
  /** Add a node at the viewport centre (click / keyboard). */
  onAddNode: (type: string) => void;
  /** App/connector context — hides connector-gated nodes (e.g. aokie_speak) when unavailable (docs §4). */
  context?: FlowEditorContext;
  /** Collapsed to a narrow icon-only rail (space-reclaiming; never hides the panel's existence). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Mobile bottom sheets reuse the same palette without drag affordances or fixed rail width. */
  draggable?: boolean;
  className?: string;
}

function PaletteItem({
  spec,
  onAddNode,
  draggable = true,
  organising = false,
  groups = [],
  currentGroupId,
}: {
  spec: NodeSpec;
  onAddNode: (type: string) => void;
  draggable?: boolean;
  /** Organise mode: the tile grows a "put this in a group" control instead of inserting. */
  organising?: boolean;
  groups?: NodeGroup[];
  currentGroupId?: string;
}) {
  const Icon = spec.icon;
  const disabled = !spec.executable;
  const desktop = spec.requiresDesktopService;
  const desktopPresence = useContext(FlowDesktopPresenceContext);
  const degraded = desktopPresence.kind === 'none' && (spec.category === 'desktop' || !!spec.requiresConnector);
  const btnRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [docRect, setDocRect] = useState<DOMRect | null>(null);

  const openDoc = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setDocRect(rect);
    }, HOVER_DELAY_MS);
  };
  const closeDoc = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setDocRect(null);
  };

  const assignNode = useNodeGroupStore((s) => s.assignNode);
  const unassignNode = useNodeGroupStore((s) => s.unassignNode);

  // Icon-first tile: big icon + name only; the description (and the desktop-service /
  // capability notes) live in the delayed hover/focus popover.
  return (
    <>
    <button
      ref={btnRef}
      type="button"
      draggable={draggable && !disabled}
      onDragStart={(e) => {
        if (disabled || !draggable) return;
        closeDoc();
        e.dataTransfer.setData(PALETTE_DND_MIME, spec.type);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => { if (!disabled) onAddNode(spec.type); }}
      onMouseEnter={openDoc}
      onMouseLeave={closeDoc}
      onFocus={openDoc}
      onBlur={closeDoc}
      disabled={disabled}
      aria-label={disabled ? `${spec.label} (not available)` : `Add ${spec.label} node`}
      className={cn(
        'group relative flex w-full flex-col items-center gap-1.5 rounded-xl border border-transparent px-1.5 py-2.5 text-center transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-55'
          : cn(
              draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
              'bg-white hover:border-primary-300 hover:bg-primary-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-800/40 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10',
            ),
        degraded && !disabled && 'opacity-60',
      )}
    >
      {desktop && (
        <span
          className={cn(
            'absolute right-1.5 top-1.5',
            degraded ? 'text-amber-500 dark:text-amber-400' : 'text-primary-400 dark:text-primary-300',
          )}
          aria-hidden="true"
        >
          <MonitorDown className="h-3 w-3" />
        </span>
      )}
      <span className={cn('flex h-10 w-10 flex-none items-center justify-center rounded-xl', ACCENT_CHIP[spec.accent] ?? ACCENT_CHIP.slate)}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="line-clamp-2 block w-full text-[11px] font-medium leading-tight text-gray-800 dark:text-slate-200">
        {spec.label}
      </span>
    </button>
    {organising && (
      // In organise mode the tile is not for inserting — it is for filing. A select rather than
      // drag-and-drop because this has to work on a phone and with a keyboard, and because the
      // set of groups is small enough to read at a glance.
      <select
        value={currentGroupId ?? ''}
        onChange={(e) => {
          const next = e.target.value;
          if (next === '') unassignNode(spec.type);
          else assignNode(spec.type, next);
        }}
        aria-label={`Group for ${spec.label}`}
        className="mt-1 w-full rounded-md border border-gray-300 bg-white px-1 py-0.5 text-[10px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
      >
        <option value="">Ungrouped</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>{group.name}</option>
        ))}
      </select>
    )}
    {docRect && <PaletteDoc spec={spec} anchor={docRect} degraded={degraded && !disabled} />}
    </>
  );
}

/**
 * One user-defined palette group: a collapsible section the person made themselves.
 *
 * While organising, it grows rename / reorder / delete controls. Deleting a group RELEASES its
 * nodes back to their default sections rather than hiding them — nothing a user installed
 * should be able to disappear from the palette because of a filing decision.
 */
function NodeGroupSection({
  group,
  specs,
  organising,
  groups,
  groupOfType,
  onAddNode,
  draggable,
  forceExpanded = false,
}: {
  group: NodeGroup;
  specs: NodeSpec[];
  organising: boolean;
  groups: NodeGroup[];
  groupOfType: Map<string, string>;
  onAddNode: (type: string) => void;
  draggable: boolean;
  forceExpanded?: boolean;
}) {
  const toggleCollapsed = useNodeGroupStore((s) => s.toggleCollapsed);
  const renameGroup = useNodeGroupStore((s) => s.renameGroup);
  const deleteGroup = useNodeGroupStore((s) => s.deleteGroup);
  const moveGroup = useNodeGroupStore((s) => s.moveGroup);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group.name);

  const collapsed = !!group.collapsed && !forceExpanded;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => toggleCollapsed(group.id)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 flex-none text-gray-400" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3 flex-none text-gray-400" aria-hidden="true" />
          )}
          {renaming ? (
            <input
              value={draft}
              autoFocus
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => { renameGroup(group.id, draft); setRenaming(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { renameGroup(group.id, draft); setRenaming(false); }
                if (e.key === 'Escape') { setDraft(group.name); setRenaming(false); }
              }}
              aria-label={`Rename group ${group.name}`}
              className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          ) : (
            <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
              {group.name}
            </span>
          )}
          <span className="flex-none text-[10px] text-gray-400 dark:text-slate-600">{specs.length}</span>
        </button>
        {organising && !renaming && (
          <span className="flex flex-none items-center">
            <button
              type="button"
              onClick={() => moveGroup(group.id, -1)}
              aria-label={`Move group ${group.name} up`}
              className="rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-slate-200"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => moveGroup(group.id, 1)}
              aria-label={`Move group ${group.name} down`}
              className="rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-slate-200"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => { setDraft(group.name); setRenaming(true); }}
              aria-label={`Rename group ${group.name}`}
              className="rounded p-0.5 text-[10px] text-gray-400 hover:text-gray-700 dark:hover:text-slate-200"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => deleteGroup(group.id)}
              aria-label={`Delete group ${group.name} (its nodes return to their usual sections)`}
              className="rounded p-0.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      {!collapsed && (
        specs.length === 0 ? (
          <p className="px-1 pb-1 text-[10px] text-gray-400 dark:text-slate-600">
            Empty — pick this group under a node below to file it here.
          </p>
        ) : (
          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(6.25rem,1fr))]">
            {specs.map((spec) => (
              <PaletteItem
                key={spec.type}
                spec={spec}
                onAddNode={onAddNode}
                draggable={draggable}
                organising={organising}
                groups={groups}
                currentGroupId={groupOfType.get(spec.type)}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

export function NodePalette({ onAddNode, context = EMPTY_FLOW_EDITOR_CONTEXT, collapsed = false, onToggleCollapsed, draggable = true, className }: NodePaletteProps) {
  const [query, setQuery] = useState('');

  // Collapsing swaps in a whole different (icon-rail) subtree, which unmounts the results list —
  // restore its scroll offset on re-expand rather than snapping back to the top every time.
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const resultsScrollTop = useRef(0);
  useEffect(() => {
    if (!collapsed && resultsRef.current) resultsRef.current.scrollTop = resultsScrollTop.current;
  }, [collapsed]);

  // FLOW-203/204: the palette lists through the REGISTRY (core + installed-package providers),
  // not the static catalog — installed extensions appear without a rebuild. `installedVersion`
  // re-runs the memo when definitions arrive/refresh (the registry itself is not reactive).
  const installedVersion = useInstalledNodeStore((s) => s.version);
  const userGroups = useNodeGroupStore((s) => s.groups);
  const [organising, setOrganising] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const createGroup = useNodeGroupStore((s) => s.createGroup);

  const { userSections, grouped } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: NodeSpec) =>
      q === '' ||
      s.label.toLowerCase().includes(q) ||
      s.type.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q);
    const specs = flowNodeRegistry.listNodeSpecs(context).filter((s) => isNodeAvailableInContext(s, context));
    const byType = new Map(specs.map((spec) => [spec.type, spec]));

    // A node in a user group appears THERE and nowhere else. Showing it twice would not be
    // organisation, it would be a duplicate to hunt through.
    const claimed = new Set<string>();
    const userSections = userGroups.map((group) => {
      const groupSpecs: NodeSpec[] = [];
      for (const type of group.nodeTypes) {
        const spec = byType.get(type);
        // A type with no spec is an extension that was uninstalled. It stays in the stored
        // group (reinstalling brings it straight back) but is not rendered as an empty tile.
        if (!spec) continue;
        claimed.add(type);
        if (match(spec)) groupSpecs.push(spec);
      }
      return { group, specs: groupSpecs };
    });

    const grouped = NODE_CATEGORIES.map((cat) => ({
      cat,
      specs: specs.filter((s) => s.category === cat.id && !claimed.has(s.type) && match(s)),
    })).filter((g) => g.specs.length > 0);

    return { userSections, grouped };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- installedVersion is the registry's change signal
  }, [query, context, installedVersion, userGroups]);

  const groupOfType = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of userGroups) for (const type of group.nodeTypes) map.set(type, group.id);
    return map;
  }, [userGroups]);

  // Organise mode shows every group, including the empty ones — you cannot file anything into a
  // group you cannot see.
  const visibleUserSections = organising ? userSections : userSections.filter((s) => s.specs.length > 0);

  if (collapsed) {
    return (
      <div className={cn('flex h-full min-h-0 w-14 flex-none flex-col items-center gap-2 bg-gray-100/50 py-2.5 dark:bg-slate-900/50', className)}>
        <Button
          variant="ghost"
          size="iconOnly"
          onClick={onToggleCollapsed}
          aria-label="Expand node palette"
          title="Expand node palette"
          className="h-8 w-8"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 w-64 flex-none flex-col bg-gray-100/50 dark:bg-slate-900/50', className)}>
      <div className="flex items-center gap-1.5 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search flow nodes"
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <Button
          variant={organising ? 'secondary' : 'ghost'}
          size="iconOnly"
          onClick={() => setOrganising((on) => !on)}
          aria-label={organising ? 'Done organising nodes' : 'Organise nodes into groups'}
          aria-pressed={organising}
          title={organising ? 'Done organising' : 'Organise into groups'}
          className="h-8 w-8 flex-none"
        >
          <Settings2 className="h-4 w-4" />
        </Button>
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="iconOnly"
            onClick={onToggleCollapsed}
            aria-label="Collapse node palette"
            title="Collapse node palette"
            className="h-8 w-8 flex-none"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>
      {organising && (
        // Only visible while organising: the palette's job is inserting nodes, and a permanent
        // "new group" box would take space from that for something done occasionally.
        <form
          className="flex items-center gap-1.5 px-2.5 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (createGroup(newGroupName)) setNewGroupName('');
          }}
        >
          <div className="relative min-w-0 flex-1">
            <FolderPlus className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New group name"
              aria-label="New node group name"
              maxLength={40}
              className="w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-8 pr-2.5 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={!newGroupName.trim()} className="flex-none">
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </form>
      )}
      <div
        ref={resultsRef}
        onScroll={(e) => { resultsScrollTop.current = e.currentTarget.scrollTop; }}
        className={cn(
          'scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5',
          // The docked rail sits behind the floating Desktop-connection chip (fixed
          // bottom-left) — leave clearance so the last tiles stay reachable.
          draggable && 'pb-16',
        )}
      >
        {grouped.length === 0 && visibleUserSections.length === 0 && (
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">No nodes match "{query}".</p>
        )}
        {/* The user's own groups come first: someone who bothered to organise their palette
            put the things they reach for most into it. */}
        {visibleUserSections.map(({ group, specs }) => (
          <NodeGroupSection
            key={group.id}
            group={group}
            specs={specs}
            organising={organising}
            groups={userGroups}
            groupOfType={groupOfType}
            onAddNode={onAddNode}
            draggable={draggable}
            // A search that matches inside a collapsed group must not hide its own result:
            // while searching, groups open regardless of their stored collapsed state.
            forceExpanded={query.trim() !== ''}
          />
        ))}
        {grouped.map(({ cat, specs }) => (
          <div key={cat.id}>
            <div className="mb-1.5 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">{cat.label}</p>
              {cat.hint && <p className="text-[10px] text-gray-400 dark:text-slate-600">{cat.hint}</p>}
            </div>
            {/* Icon tiles — auto-fill so the same palette works in the w-64 rail (2-up)
                and the full-width mobile sheet (3+-up). */}
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(6.25rem,1fr))]">
              {specs.map((spec) => (
                <PaletteItem
                  key={spec.type}
                  spec={spec}
                  onAddNode={onAddNode}
                  draggable={draggable}
                  organising={organising}
                  groups={userGroups}
                  currentGroupId={groupOfType.get(spec.type)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
