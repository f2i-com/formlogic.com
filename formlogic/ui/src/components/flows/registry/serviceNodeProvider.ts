import { Layers, Sparkles, Mic, Image, Volume2, FileText } from 'lucide-react';
import type { NodeSpec } from '../editor/nodeCatalog';
import type { FlowNodeProvider } from './types';
import { flowNodeRegistry } from './FlowNodeRegistry';
import type { DesktopServiceCatalog, DesktopServiceDefinition, DesktopServiceDefinitionAction } from '../../../client-runtime/desktop/desktopClient';

/**
 * SRV-406: service-action PROJECTIONS.
 *
 * Every invocable action in the Desktop's service catalog becomes its own palette entry, so
 * an author picks "Generate image — Acme Images" instead of inserting a generic
 * `service_action` and hand-typing a definition id and an action id they have to go and look
 * up. Both routes produce the SAME node — the projection just arrives pre-addressed — so
 * there is one execution protocol, not two.
 *
 * A projection is palette-only: `type` is a display identity, `insertAs` is what the graph
 * stores. `resolve()` therefore returns nothing, and a saved flow only ever contains real
 * `service_action` nodes. That keeps stored graphs independent of whatever the catalog
 * happened to contain when they were authored.
 *
 * Event-stream lanes are omitted: the host refuses to invoke them as flow nodes, so offering
 * one would be an entry that can only fail.
 */

const PROJECTION_PREFIX = 'service-projection:';

/** Host icon allowlist for a projected action — never a plugin-supplied component. */
const ICON_BY_CAPABILITY: Record<string, NodeSpec['icon']> = {
  'image.generate': Image,
  'audio.speech': Volume2,
  'audio.transcribe': Mic,
  'llm.chat': Sparkles,
  'text.complete': FileText,
};

function iconFor(action: DesktopServiceDefinitionAction, definition: DesktopServiceDefinition): NodeSpec['icon'] {
  const keys = [action.capability, ...(definition.capabilities ?? [])];
  for (const key of keys) {
    if (key && ICON_BY_CAPABILITY[key]) return ICON_BY_CAPABILITY[key];
  }
  return Layers;
}

/** Is this action invocable as a flow node at all? */
function isInvocable(action: DesktopServiceDefinitionAction): boolean {
  // Mirrors the host's own refusal (services/invocation.rs): event-stream lanes are not a
  // request/response invocation, so they are not offerable as nodes.
  const streaming = (action as { streaming?: { mode?: string } }).streaming;
  return streaming?.mode !== 'events';
}

/** Build the palette spec for one action of one definition. */
export function projectServiceAction(definition: DesktopServiceDefinition, action: DesktopServiceDefinitionAction): NodeSpec {
  const provenance = definition.provider ? ` (from ${definition.provider})` : '';
  return {
    type: `${PROJECTION_PREFIX}${definition.id}/${action.id}`,
    insertAs: 'service_action',
    label: action.title || action.id,
    category: 'desktop',
    description: `${definition.name || definition.id}${provenance}`,
    doc:
      `${action.description || action.title || action.id}\n\n` +
      `Runs "${action.id}" on ${definition.name || definition.id}${provenance}. Inserts a ` +
      `Service action node with the service and action already set — choose the connection ` +
      `that holds the credential, then supply the input its schema describes.` +
      (action.sideEffects && action.sideEffects !== 'none' ? `\n\nSide effects: ${action.sideEffects}.` : ''),
    icon: iconFor(action, definition),
    accent: 'cyan',
    executable: true,
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'out', label: 'Out' }],
    // The projection's whole job: arrive addressed. The remaining fields are the ordinary
    // service_action ones, so the property panel a user sees is the one they already know.
    defaultData: { definitionId: definition.id, actionId: action.id },
    properties: [],
  };
}

/** Session catalog snapshot, set by whoever fetched it (the editor on mount). */
let catalog: DesktopServiceCatalog | null = null;

/**
 * Publish a catalog snapshot to the palette. Passing null (Desktop unpaired/unreachable)
 * withdraws the projections rather than leaving stale entries that cannot run.
 */
export function setServiceCatalogForProjections(next: DesktopServiceCatalog | null): void {
  catalog = next;
  flowNodeRegistry.refresh();
}

export const serviceNodeProvider: FlowNodeProvider = {
  id: 'service',
  // Palette-only: stored graphs contain `service_action`, never a projection identity.
  resolve: () => undefined,
  list: () => {
    if (!catalog) return [];
    const out: NodeSpec[] = [];
    for (const definition of catalog.definitions) {
      for (const action of definition.actions ?? []) {
        if (!isInvocable(action)) continue;
        out.push(projectServiceAction(definition, action));
      }
    }
    return out;
  },
};

flowNodeRegistry.register(serviceNodeProvider);
