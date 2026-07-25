import type { Connection } from '@xyflow/react';
import type { NodeHandleSpec, NodeSpec } from './nodeCatalog';
import { schemaAssignability, wireAllowed, type AssignabilityResult } from '../../../lib/schema/flowAssignability';

/**
 * FLOW-205: typed wire validation for the canvas.
 *
 * The §6.4 lattice already knows whether one port's value can flow into another; this is the
 * editor's consumer of it. Two rules shape the behaviour, both chosen so the check can never
 * be worse than no check at all:
 *
 *   1. **Only DATA ports are typed.** Control wires (the implicit in/out handles) carry
 *      execution order, not values, and are always allowed.
 *   2. **Unknown is permissive, never punitive.** Core nodes mostly declare no port schemas
 *      yet, so an absent schema normalizes to `any` → `runtime-checkable` (amber). A wire is
 *      only REFUSED when the lattice positively proves the values cannot flow — an author
 *      is never blocked because the host lacks type information.
 */

export type WireVerdict = {
  /** May this connection be created? */
  allowed: boolean;
  /** Absent for control wires and unremarkable data wires. */
  assignability?: AssignabilityResult;
  /** Editor-facing reason, present whenever the verdict is worth surfacing. */
  message?: string;
};

const CONTROL_OK: WireVerdict = { allowed: true };

function handleOf(spec: NodeSpec | undefined, side: 'inputs' | 'outputs', handleId: string | null | undefined): NodeHandleSpec | undefined {
  if (!spec) return undefined;
  const handles = side === 'inputs' ? spec.inputs : spec.outputs;
  if (!handles) return undefined;
  // A null/absent handle id means React Flow's default handle — the control port.
  if (!handleId) return handles[0];
  return handles.find((h) => h.id === handleId);
}

/**
 * Judge one proposed connection. `resolve` maps a node id to its NodeSpec (the editor passes
 * a registry lookup); an unknown node yields an allowed wire, because refusing to connect a
 * node the host cannot describe would strand graphs built by a newer version.
 */
export function checkWire(
  connection: Connection,
  resolve: (nodeId: string) => NodeSpec | undefined,
): WireVerdict {
  const source = handleOf(resolve(connection.source), 'outputs', connection.sourceHandle);
  const target = handleOf(resolve(connection.target), 'inputs', connection.targetHandle);
  if (!source || !target) return CONTROL_OK;
  // Mixing a control handle with a data port is a wiring mistake worth naming: the values
  // an author expects to flow would not.
  if (Boolean(source.data) !== Boolean(target.data)) {
    return {
      allowed: false,
      message: source.data
        ? `“${source.label}” carries data — connect it to a data input, not a control handle.`
        : `“${target.label}” expects data — connect a data output to it, not a control handle.`,
    };
  }
  if (!source.data || !target.data) return CONTROL_OK;

  const assignability = schemaAssignability(source.schema, target.schema);
  const allowed = wireAllowed(assignability);
  if (allowed && assignability.level === 'exact') {
    return { allowed: true, assignability };
  }
  const detail = assignability.note ? ` (${assignability.note})` : '';
  return {
    allowed,
    assignability,
    message: allowed
      ? `“${source.label}” → “${target.label}”: ${assignability.level.replace('-', ' ')}${detail}.`
      : assignability.level === 'conversion-required'
        ? `“${source.label}” can’t feed “${target.label}” directly${detail} — convert the value first.`
        : `“${source.label}” can’t feed “${target.label}”${detail}.`,
  };
}
