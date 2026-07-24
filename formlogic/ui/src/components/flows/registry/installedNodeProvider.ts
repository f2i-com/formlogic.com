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
import type { NodeHandleSpec, NodePropertySpec, NodeSpec } from '../editor/nodeCatalog';
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
    const handle = { id: port.id, label: port.id };
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
  // RUN-301: core-preset contributions are RUNNABLE — every run path executes the
  // server-compiled canonical IR (cloud at version mint; browser via /compile before
  // execution), so inserting one produces a node that genuinely runs. service-action
  // contributions stay display-only until service bindings (SRV-405) exist.
  const runnable = def.handler?.kind === 'core-preset';
  const runNote = runnable
    ? 'Runs wherever flows run — lowered to a built-in node by the server compiler (FormLogic Desktop needs an up-to-date build).'
    : 'Not yet runnable — service bindings for extension nodes arrive in a later update.';
  return {
    type: def.type,
    label: def.display?.label || def.type,
    category: 'installed',
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
