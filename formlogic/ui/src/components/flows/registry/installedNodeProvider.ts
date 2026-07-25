// Installed-package node provider (ADR-010 / FLOW-201 + FLOW-204): adapts stored Flow Node
// Definition v1 contributions into the editor's internal NodeSpec and serves them through
// the FlowNodeRegistry — so an installed extension's nodes appear in the palette and render
// on the canvas WITHOUT a frontend rebuild.
//
// Contract boundaries (ADR-010):
//   - No serialized React ever: icons resolve through a host ALLOWLIST (unknown → Puzzle).
//   - Contributed specs are NOT executable yet — the palette shows them disabled with their
//     provenance, and stored instances render read-only; execution arrives with the
//     server-authoritative compiler (RUN-301). `executable: false` is what enforces that.
//   - Removing/uninstalling a package removes palette entries but never graph data: a stored
//     node whose definition disappears falls back to the registry's missing placeholder.
import {
  Bot, Boxes, Database, FileText, Image, Layers, MessageSquare, Mic, Puzzle, Send,
  Sparkles, Workflow, Wand2, type LucideIcon,
} from 'lucide-react';
import type { FlowNodeDefinitionV1 } from '../../../application-package/packageV2';
import { useInstalledNodeStore } from '../../../stores/installedNodeStore';
import { NODE_CATEGORIES, type NodeCategory, type NodeHandleSpec, type NodePropertySpec, type NodeSpec } from '../editor/nodeCatalog';
import { flowNodeRegistry } from './FlowNodeRegistry';
import type { FlowNodeProvider } from './types';

/** Host icon allowlist — definition `display.iconId` values the editor knows how to render. */
const ICON_BY_ID: Record<string, LucideIcon> = {
  'bot': Bot,
  'boxes': Boxes,
  'database': Database,
  'file-text': FileText,
  'image': Image,
  'image-sparkles': Sparkles,
  'layers': Layers,
  'message-square': MessageSquare,
  'mic': Mic,
  'puzzle': Puzzle,
  'send': Send,
  'sparkles': Sparkles,
  'wand': Wand2,
  'workflow': Workflow,
};

/** Map a declaration-subset property schema (+ optional uiHint) to a NodeProperties field type. */
function fieldTypeFor(schema: Record<string, unknown>, hint?: { control?: string }): NodePropertySpec['type'] {
  switch (hint?.control) {
    case 'textarea': return 'textarea';
    case 'number': return 'number';
    case 'checkbox': return 'boolean';
    case 'select': return 'select';
    case 'json': return 'code';
    case 'text': return 'text';
    // Host-owned pickers. A definition may REQUEST one; the host decides what it renders and
    // where the choices come from — the same allowlist rule as icons. Without these a packaged
    // node that supersedes a core one would be a downgrade in the editor: a free-text box where
    // the built-in offered a list of the AI services and Desktop services you actually have.
    case 'aiProvider': return 'aiProvider';
    case 'desktopService': return 'desktopService';
    case 'providerConnection': return 'providerConnection';
    case 'serviceDefinition': return 'serviceDefinition';
    case 'serviceActionId': return 'serviceActionId';
    default: break;
  }
  if (Array.isArray(schema.enum)) return 'select';
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object' || t === 'array') return 'code';
  return 'text';
}

/**
 * Adapt one Flow Node Definition v1 into the editor's internal NodeSpec (FLOW-201).
 * Defensive by design: the definition was validated at install, but a malformed field can
 * only degrade presentation, never throw.
 */
export function adaptInstalledDefinition(def: FlowNodeDefinitionV1, packageName?: string): NodeSpec {
  const inputs: NodeHandleSpec[] = [{ id: 'in', label: 'In' }];
  const outputs: NodeHandleSpec[] = [{ id: 'out', label: 'Out' }];
  for (const port of def.ports ?? []) {
    if (!port || typeof port.id !== 'string') continue;
    // FLOW-205: carry the declared schema so the editor can type-check wires. Control ports
    // carry none — only data ports participate in assignability.
    const isData = port.kind !== 'control';
    const handle: NodeHandleSpec = {
      id: port.id,
      label: port.id,
      ...(isData ? { data: true } : {}),
      ...(isData && port.schema !== undefined ? { schema: port.schema } : {}),
      ...(port.required === true ? { required: true } : {}),
    };
    if (port.direction === 'input') inputs.push(handle);
    else if (port.direction === 'output') outputs.push(handle);
  }

  const properties: NodePropertySpec[] = [];
  const config = def.configurationSchema;
  if (config && typeof config === 'object' && config.properties && typeof config.properties === 'object') {
    const required = Array.isArray(config.required) ? (config.required as unknown[]) : [];
    for (const [key, raw] of Object.entries(config.properties as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const schema = raw as Record<string, unknown>;
      const hint = def.uiHints?.[key];
      const prop: NodePropertySpec = {
        key,
        label: typeof schema.title === 'string' && schema.title !== '' ? schema.title : key,
        type: fieldTypeFor(schema, hint),
        required: required.includes(key) || undefined,
      };
      if (typeof schema.description === 'string' && schema.description !== '') prop.help = schema.description;
      if (schema.default !== undefined) prop.default = schema.default;
      if (Array.isArray(schema.enum)) {
        prop.options = (schema.enum as unknown[])
          .filter((v): v is string => typeof v === 'string')
          .map((v) => ({ value: v, label: v }));
      }
      if (prop.type === 'code') prop.language = 'json';
      properties.push(prop);
    }
  }

  const provenance = packageName ? `Contributed by "${packageName}".` : 'Contributed by an installed package.';
  // RUN-301 + SRV-405: both v1 handler kinds are RUNNABLE — every run path executes the
  // server-compiled canonical IR (cloud at version mint; browser via /compile before
  // execution), so inserting one produces a node that genuinely runs. A service-action
  // node additionally needs its service slot bound, and says so: unbound, the compiler
  // refuses it by name rather than producing a run that could only fail.
  const kind = def.handler?.kind;
  const runnable = kind === 'core-preset' || kind === 'service-action';
  const runNote = kind === 'service-action'
    ? 'Runs on FormLogic Desktop (or a paired browser) once this extension’s service slot is bound — bind it under Details on the installed extension.'
    : 'Runs wherever flows run — lowered to a built-in node by the server compiler (FormLogic Desktop needs an up-to-date build).';
  // Replacing a built-in in the palette is DECLARED, never inferred from what a node lowers to.
  // Most packages use a core preset as an implementation detail — a specialised "Greet someone"
  // built on `template` is not the Template node, and inferring otherwise made it silently take
  // the built-in away from everyone who installed it.
  const supersedes = kind === 'core-preset'
    && def.handler?.supersedesCore === true
    && typeof def.handler?.coreType === 'string'
    ? def.handler.coreType
    : undefined;

  return {
    type: def.type,
    label: def.display?.label || def.type,
    category: hostCategoryFor(def.display?.category),
    ...(supersedes ? { supersedesCoreType: supersedes } : {}),
    description: def.display?.description || def.display?.label || def.type,
    doc: `${def.display?.description || def.display?.label || def.type}\n\n${provenance} ${runNote}`,
    icon: (def.display?.iconId && ICON_BY_ID[def.display.iconId]) || Puzzle,
    accent: 'violet',
    executable: runnable,
    inputs,
    outputs,
    properties,
  };
}

/**
 * Map a definition's declared `display.category` onto a HOST category, or fall back to
 * "Installed extensions".
 *
 * An allowlist rather than a free string, for the same reason icons are: the palette's section
 * list is a presentation surface shared by every package, and an author who could invent
 * sections could fragment it or push their own to the top. Matching an existing section is a
 * legitimate request — an AI node belongs beside the other AI nodes — so that is what is
 * honoured, by id or by label, case-insensitively. Anything else lands under Installed
 * extensions, which is accurate rather than a failure.
 *
 * Users organise their own palette separately (see the node-groups store); that is a personal
 * preference and is deliberately NOT something a package can set.
 */
function hostCategoryFor(declared: unknown): NodeCategory {
  if (typeof declared !== 'string' || declared.trim() === '') return 'installed';
  const wanted = declared.trim().toLowerCase();
  const match = NODE_CATEGORIES.find(
    (category) => category.id === wanted || category.label.toLowerCase() === wanted
  );
  // 'installed' stays the home for anything unrecognised, and a package cannot claim the
  // desktop section — that one means "needs a local FormLogic Desktop service", which is a
  // host fact about how the node runs, not a label an author gets to choose.
  if (!match || match.id === 'desktop') return 'installed';
  return match.id;
}

// Adapted specs cached by digest so repeat resolutions return stable identities
// (React Flow and the palette memoize on object identity).
const specCache = new Map<string, NodeSpec>();

function specFor(type: string): NodeSpec | undefined {
  const entry = useInstalledNodeStore.getState().definitions.find((d) => d.enabled && d.type === type);
  if (!entry) return undefined;
  const cached = specCache.get(entry.digest);
  if (cached) return cached;
  const def = entry.definition;
  if (!def || typeof def !== 'object' || Array.isArray(def)) return undefined;
  const spec = adaptInstalledDefinition(def as FlowNodeDefinitionV1, entry.packageName);
  specCache.set(entry.digest, spec);
  return spec;
}

export const installedNodeProvider: FlowNodeProvider = {
  id: 'installed-packages',
  resolve: (type) => specFor(type),
  list: () => {
    const out: NodeSpec[] = [];
    for (const entry of useInstalledNodeStore.getState().definitions) {
      if (!entry.enabled) continue;
      const spec = specFor(entry.type);
      if (spec) out.push(spec);
    }
    return out;
  },
};

// Register once at module load — the flow editor imports this module for its side effect.
flowNodeRegistry.register(installedNodeProvider);
