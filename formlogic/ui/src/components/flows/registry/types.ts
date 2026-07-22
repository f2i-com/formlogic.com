// FlowNodeRegistry provider contract (extensible-flows plan §10.5).
//
// A provider is one SOURCE of node specs: the compile-time core catalog today
// (coreNodeProvider); installed-Pack and Service-projected providers plug in behind the
// same interface later without the editor learning new lookup paths. Providers are
// resolution-only — runtime dispatch stays with each runtime's handler switch and is NOT
// routed through this registry.
import type { FlowEditorContext, NodeSpec } from '../editor/nodeCatalog';

export interface FlowNodeProvider {
  /** Stable provider id ('core', later 'pack', 'service', …) for diagnostics. */
  readonly id: string;
  /** Resolve a spec for a stored `node.type`, or undefined when this provider doesn't know it. */
  resolve(type: string, ctx: FlowEditorContext): NodeSpec | undefined;
  /**
   * Every spec this provider can offer (palette source). Availability filtering
   * (isNodeAvailableInContext, executable, category grouping) stays at the call sites —
   * list() is the raw candidate set, exactly like NODE_SPECS today.
   */
  list(ctx: FlowEditorContext): NodeSpec[];
}
