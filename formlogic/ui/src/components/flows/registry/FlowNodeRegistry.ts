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

/** FLOW-202: one type offered by more than one provider; the EARLIER provider keeps it. */
export interface NodeTypeCollision {
  type: string;
  /** The provider whose spec is used. */
  ownedBy: string;
  /** The provider whose spec is shadowed. */
  shadowedProvider: string;
}

class FlowNodeRegistry {
  private providers: FlowNodeProvider[] = [coreNodeProvider];
  /** Bumped on any provider-set change; memo dependency for consumers that cache specs. */
  private revision = 0;
  private collisions: NodeTypeCollision[] = [];

  /** Register an additional provider (Pack/Service). Later registrations resolve after earlier ones. */
  register(provider: FlowNodeProvider): void {
    if (this.providers.some((p) => p.id === provider.id)) {
      throw new Error(`FlowNodeRegistry: provider '${provider.id}' is already registered`);
    }
    this.providers.push(provider);
    this.revision++;
  }

  /**
   * FLOW-202: remove a provider (its source went away — a pack uninstalled, a Desktop
   * unpaired). Stored graph nodes it owned fall back to the §4.5 placeholder rather than
   * disappearing, which is the whole point of resolving through one registry.
   * Returns false when nothing was registered under that id. 'core' can never be removed.
   */
  unregister(providerId: string): boolean {
    if (providerId === coreNodeProvider.id) {
      throw new Error('FlowNodeRegistry: the core provider cannot be unregistered');
    }
    const next = this.providers.filter((p) => p.id !== providerId);
    if (next.length === this.providers.length) return false;
    this.providers = next;
    this.revision++;
    return true;
  }

  /** Which providers are registered, in resolution order. */
  listProviders(): string[] {
    return this.providers.map((p) => p.id);
  }

  /**
   * FLOW-202: signal that a provider's underlying source changed (a pack installed, the
   * Desktop catalog refreshed) WITHOUT changing the provider set. Consumers memoize on
   * `registryRevision()`, so this is how a live palette picks new specs up.
   */
  refresh(): number {
    this.revision++;
    return this.revision;
  }

  /** Monotonic revision — a stable memo dependency for palette/canvas consumers. */
  registryRevision(): number {
    return this.revision;
  }

  /**
   * Collisions observed during the most recent listNodeSpecs() pass. Surfacing them beats
   * silently dropping a shadowed spec: a package whose node never appears is otherwise
   * indistinguishable from one that failed to install.
   */
  lastCollisions(): NodeTypeCollision[] {
    return [...this.collisions];
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

  /**
   * SRV-406: resolve a PALETTE identity (which may be a projection) rather than a stored node
   * type. Insertion paths use this; stored-graph resolution stays on resolveNodeSpec, so a
   * projection can never be mistaken for a real node type in a saved flow.
   */
  resolvePaletteSpec(type: string, ctx: FlowEditorContext = EMPTY_FLOW_EDITOR_CONTEXT): NodeSpec | undefined {
    return this.resolveKnownNodeSpec(type, ctx) ?? this.listNodeSpecs(ctx).find((s) => s.type === type);
  }

  /** The raw candidate set across providers (palette source; call sites filter/group). */
  listNodeSpecs(ctx: FlowEditorContext = EMPTY_FLOW_EDITOR_CONTEXT): NodeSpec[] {
    const owner = new Map<string, string>();
    const out: NodeSpec[] = [];
    const collisions: NodeTypeCollision[] = [];
    for (const provider of this.providers) {
      for (const spec of provider.list(ctx)) {
        const existing = owner.get(spec.type);
        if (existing !== undefined) {
          // Earlier provider wins (core shadows late arrivals) — but RECORD it, so a
          // shadowed contribution can be explained instead of just vanishing.
          collisions.push({ type: spec.type, ownedBy: existing, shadowedProvider: provider.id });
          continue;
        }
        owner.set(spec.type, provider.id);
        out.push(spec);
      }
    }
    this.collisions = collisions;

    // A packaged node that LOWERS to a core type supersedes that core type in the palette.
    //
    // Without this, installing a pack that provides "LLM Chat" leaves the built-in "LLM chat"
    // sitting beside it: two entries that insert different node types and do the same thing.
    // The packaged one wins because it is the one the owner chose to install, and because it
    // can be updated without a release of this app.
    //
    // Only the PALETTE is affected. `resolveNodeSpec` is untouched, so a flow that already
    // contains the core type keeps its editor and its properties exactly as before — nothing
    // stored is invalidated by installing a pack.
    const superseded = new Set<string>();
    for (const spec of out) {
      if (spec.supersedesCoreType) superseded.add(spec.supersedesCoreType);
    }
    if (superseded.size === 0) return out;
    return out.filter((spec) => !superseded.has(spec.type));
  }
}

/** The app-wide registry instance (module singleton, like the catalog it wraps). */
export const flowNodeRegistry = new FlowNodeRegistry();
