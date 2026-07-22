// FlowNodeRegistry (extensible-flows plan §10.5, Phase 1): ONE resolution point for node
// specs across providers — core today; installed-Pack and Service-projected providers
// register here later. The registry's other job is §4.5: an unknown node type resolves to
// a synthesized read-only PLACEHOLDER spec, so a node whose Pack/Service definition isn't
// installed stays visible, explainable, and deletable on the canvas instead of rendering
// as a broken default card. Placeholders are never insertable and never join the palette.
import { HelpCircle } from 'lucide-react';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext, type NodeSpec } from '../editor/nodeCatalog';
import { coreNodeProvider } from './coreNodeProvider';
import type { FlowNodeProvider } from './types';

/** Synthesize the §4.5 read-only placeholder for an unknown stored node type. */
export function missingNodeSpec(type: string): NodeSpec {
  return {
    type,
    label: type,
    category: 'missing',
    description:
      'Unknown node type — its definition is not installed (it may come from a Pack, a Desktop ' +
      'Service, or a newer FormLogic version). The node and its configuration are preserved ' +
      'read-only; runs that reach it fail with invalid_flow until the definition is available. ' +
      'You can delete the node, or install/enable whatever provides it.',
    icon: HelpCircle,
    accent: 'slate',
    executable: false,
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'out', label: 'Out' }],
    properties: [],
    missing: true,
  };
}

class FlowNodeRegistry {
  private providers: FlowNodeProvider[] = [coreNodeProvider];

  /** Register an additional provider (Pack/Service). Later registrations resolve after earlier ones. */
  register(provider: FlowNodeProvider): void {
    if (this.providers.some((p) => p.id === provider.id)) {
      throw new Error(`FlowNodeRegistry: provider '${provider.id}' is already registered`);
    }
    this.providers.push(provider);
  }

  /**
   * Resolve a stored node type to a spec. ALWAYS returns a spec: unknown types get the
   * missing-definition placeholder (check `spec.missing` when existence matters).
   */
  resolveNodeSpec(type: string, ctx: FlowEditorContext = EMPTY_FLOW_EDITOR_CONTEXT): NodeSpec {
    return this.resolveKnownNodeSpec(type, ctx) ?? missingNodeSpec(type);
  }

  /** Resolve without the placeholder fallback — undefined means no provider knows the type. */
  resolveKnownNodeSpec(type: string, ctx: FlowEditorContext = EMPTY_FLOW_EDITOR_CONTEXT): NodeSpec | undefined {
    for (const provider of this.providers) {
      const spec = provider.resolve(type, ctx);
      if (spec) return spec;
    }
    return undefined;
  }

  /** The raw candidate set across providers (palette source; call sites filter/group). */
  listNodeSpecs(ctx: FlowEditorContext = EMPTY_FLOW_EDITOR_CONTEXT): NodeSpec[] {
    const seen = new Set<string>();
    const out: NodeSpec[] = [];
    for (const provider of this.providers) {
      for (const spec of provider.list(ctx)) {
        if (seen.has(spec.type)) continue; // earlier provider wins (core shadows late arrivals)
        seen.add(spec.type);
        out.push(spec);
      }
    }
    return out;
  }
}

/** The app-wide registry instance (module singleton, like the catalog it wraps). */
export const flowNodeRegistry = new FlowNodeRegistry();
