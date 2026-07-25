/**
 * RUN-302: typed data ports at RUN time — the readiness rule, TypeScript leg.
 *
 * Mirrors `backend/src/Services/Flows/DataPortRuntime.php` exactly, and both assert the same
 * corpus (`docs/contracts/fixtures/flow-data-port-cases.json`). The compiler already refuses
 * data wiring that cannot work (FLOW-206); this decides, at run time, whether a node may run and
 * with what inputs.
 *
 * The subtle cases are the unhappy ones, and they are why this is one shared rule rather than
 * three hand-written ones:
 *
 *   - A producer on an untaken branch never produces → its consumer is SKIPPED. Waiting would
 *     hang until the deadline; running would see an undefined input.
 *   - A FAILED producer is not the same as a skipped one — a fault to surface, not a branch not
 *     taken — so it BLOCKS instead.
 *   - A producer that succeeded without writing the port can never write it now: that is the
 *     deadlock case, refused immediately with a typed reason.
 *   - Terminal verdicts beat waiting, so two runtimes cannot disagree based on arrival order.
 *   - `null`, `false` and `0` are values. Falsiness is not absence.
 *
 * Artifacts pass by reference: a resolved input may carry an ArtifactRef, never bytes.
 *
 * Pure and deterministic — no clocks, no I/O, no randomness.
 */

export type DataPortVerdict = 'ready' | 'waiting' | 'skipped' | 'blocked';

export type NodeOutcomeState = 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'absent';

export interface NodeOutcome {
  state: NodeOutcomeState;
  outputs?: Record<string, unknown>;
}

/** Compiled data plan: consumer node id → input port → the (node, port) that produces it. */
export type DataPlan = Record<string, Record<string, { node: string; port: string }>>;

export interface DataPortReadiness {
  verdict: DataPortVerdict;
  inputs: Record<string, unknown>;
  /** Input ports whose resolved value is an ArtifactRef (a handle, never bytes). */
  artifactInputs: string[];
  waitingOn: string[];
  unsatisfied: string[];
  reason: string | null;
}

const ARTIFACT_ID = /^art_[a-z0-9]{24}$/;

/** The edge fields the plan reads. Deliberately structural: any graph shape with these fits. */
export interface DataEdgeLike {
  kind?: unknown;
  source?: unknown;
  target?: unknown;
  sourceHandle?: unknown;
  targetHandle?: unknown;
}

/** Is this value an ArtifactRef? Mirrors ArtifactService::isRef. */
export function isArtifactRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const id = (value as { $artifact?: unknown }).$artifact;
  return typeof id === 'string' && ARTIFACT_ID.test(id);
}

/** Decide whether `nodeId` may run, and with what inputs. */
export function dataPortReadiness(plan: DataPlan, outcomes: Record<string, NodeOutcome>, nodeId: string): DataPortReadiness {
  const ports = plan[nodeId];
  if (!ports || Object.keys(ports).length === 0) {
    // No data inputs — a control-only node, or a legacy graph with no data edges at all.
    return verdict('ready', {}, [], [], [], null);
  }

  const inputs: Record<string, unknown> = {};
  const artifactInputs: string[] = [];
  const waitingOn: string[] = [];
  // Terminal outcomes are gathered separately so they win over waiting regardless of the order
  // ports happen to be iterated in.
  const blockedPorts: string[] = [];
  const skippedPorts: string[] = [];
  let blockedReason: string | null = null;

  for (const [port, source] of Object.entries(ports)) {
    if (!source || typeof source.node !== 'string' || typeof source.port !== 'string') {
      skippedPorts.push(port); // a malformed plan entry can never be satisfied
      continue;
    }
    const outcome = outcomes[source.node];
    const state: NodeOutcomeState = outcome?.state ?? 'absent';

    if (state === 'succeeded') {
      const outputs = outcome?.outputs ?? {};
      if (Object.prototype.hasOwnProperty.call(outputs, source.port)) {
        // hasOwnProperty, NOT a truthiness check: a produced null/false/0 is a value.
        const value = outputs[source.port];
        inputs[port] = value;
        if (isArtifactRef(value)) artifactInputs.push(port);
        continue;
      }
      skippedPorts.push(port); // finished without writing the port — waiting can never end
      continue;
    }
    if (state === 'failed') {
      blockedPorts.push(port);
      blockedReason ??= 'data_producer_failed';
      continue;
    }
    if (state === 'cancelled') {
      blockedPorts.push(port);
      blockedReason ??= 'data_producer_cancelled';
      continue;
    }
    if (state === 'skipped') {
      skippedPorts.push(port);
      continue;
    }
    waitingOn.push(source.node);
  }

  if (blockedPorts.length > 0) return verdict('blocked', {}, [], [], blockedPorts, blockedReason);
  if (skippedPorts.length > 0) return verdict('skipped', {}, [], [], skippedPorts, 'data_input_unsatisfied');
  if (waitingOn.length > 0) return verdict('waiting', {}, [], [...new Set(waitingOn)], [], null);
  return verdict('ready', inputs, artifactInputs, [], [], null);
}

/**
 * Build the data plan from a compiled graph's data edges.
 *
 * Ambiguous fan-in is already refused at compile (FLOW-206), so first-writer-wins here is a
 * formality — written down so a corrupt plan degrades deterministically rather than by
 * iteration order.
 */
export function dataPlanFrom(graph: { edges?: ReadonlyArray<DataEdgeLike> } | null | undefined): DataPlan {
  const plan: DataPlan = {};
  for (const edge of graph?.edges ?? []) {
    if (!edge || edge.kind !== 'data') continue;
    const target = typeof edge.target === 'string' ? edge.target : '';
    const targetPort = typeof edge.targetHandle === 'string' ? edge.targetHandle : '';
    const source = typeof edge.source === 'string' ? edge.source : '';
    const sourcePort = typeof edge.sourceHandle === 'string' ? edge.sourceHandle : '';
    if (!target || !targetPort || !source || !sourcePort) continue; // incomplete edge = no wiring
    if (plan[target]?.[targetPort]) continue;
    plan[target] = { ...(plan[target] ?? {}), [targetPort]: { node: source, port: sourcePort } };
  }
  return plan;
}

function verdict(
  v: DataPortVerdict,
  inputs: Record<string, unknown>,
  artifactInputs: string[],
  waitingOn: string[],
  unsatisfied: string[],
  reason: string | null
): DataPortReadiness {
  return { verdict: v, inputs, artifactInputs, waitingOn, unsatisfied, reason };
}
