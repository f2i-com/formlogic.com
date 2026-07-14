// FormLogic Flows — shared types (docs/FORMLOGIC_FLOWS.md, docs/contracts/flow-binding.schema.json,
// flow-run-request.schema.json, flow-run-result.schema.json).
//
// Flows are stored in FormLogic with engine 'f2i' and a WorkflowGraph-compatible graph JSON so the
// full F2I editor/compiler can be adopted later without a data migration. These types mirror the
// backend FlowService camelCase formats exactly (formatFlow/formatBinding/formatRun) plus the
// runtime shapes served by GET /api/app/{slug}/flows.

/** One node of a WorkflowGraph-compatible flow graph ({id,type,data,position?}). */
export interface WorkflowGraphNode {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
}

/** One edge of a WorkflowGraph ({source,target,sourceHandle?,targetHandle?}). */
export interface WorkflowGraphEdge {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

/** The stored flow graph shape (flow_definitions.flow_json). */
export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/** A flow_definitions row (owner CRUD shape — FlowService::formatFlow). */
export interface FlowDefinition {
  id: string;
  ownerUserId: string;
  appId: string | null;
  name: string;
  slug: string;
  description: string | null;
  engine: string;
  flowJson: WorkflowGraph;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  nodeCapabilities: string[] | null;
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FlowBindingMode = 'sync' | 'async' | 'background' | 'manual';

/** Sandboxed boolean expression over {event} — evaluated in QuickJS, never eval(). */
export interface FlowBindingCondition {
  type: 'expression';
  expr: string;
}

export type FlowOutputActionType =
  | 'formlogic.submitResponse'
  | 'formlogic.updateResponse'
  | 'formlogic.toast'
  | 'connector.request'
  | 'call.speak';

/** One binding output action (flow-binding.schema.json outputActions[]). */
export interface FlowOutputAction {
  type: FlowOutputActionType;
  form?: string;
  responseId?: string;
  /** Selector into $result or a literal object. */
  answers?: unknown;
  /** Selector/boolean expression gating this action. */
  when?: string;
  connectorId?: string;
  command?: string;
  payload?: unknown;
  message?: string;
}

export interface FlowRetryPolicy {
  maxAttempts?: number; // 1..5
  backoff?: 'none' | 'fixed' | 'exponential';
}

export interface FlowFallbackPolicy {
  onError?: 'log_and_continue' | 'surface_error';
  /** For sync live-call bindings: spoken/UI fallback when the flow times out or fails. */
  fallbackReply?: string;
}

/** An app_flow_bindings row (owner CRUD shape — FlowService::formatBinding).
 *  appId null = a WORKSPACE binding on a standalone form (/api/forms/{id}/flow-bindings). */
export interface FlowBinding {
  id: string;
  appId: string | null;
  formId: string | null;
  connectorId: string | null;
  flowDefinitionId: string;
  /** flow_definitions.slug within the same app. */
  flow: string;
  event: string;
  mode: FlowBindingMode;
  condition: FlowBindingCondition | null;
  inputMap: Record<string, unknown> | null;
  outputActions: FlowOutputAction[] | null;
  timeoutMs: number;
  retryPolicy: FlowRetryPolicy | null;
  fallbackPolicy: FlowFallbackPolicy | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Enabled flow definition as served to the app runtime (no owner-only fields). */
export interface RuntimeFlowDefinition {
  slug: string;
  name: string;
  engine: string;
  flowJson: WorkflowGraph;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  nodeCapabilities: string[] | null;
  version: number;
}

/** Enabled binding as served to the app runtime (GET /api/app/{slug}/flows). */
export interface RuntimeFlowBinding {
  id: string;
  flow: string;
  formId: string | null;
  connectorId: string | null;
  event: string;
  mode: FlowBindingMode;
  condition: FlowBindingCondition | null;
  inputMap: Record<string, unknown> | null;
  outputActions: FlowOutputAction[] | null;
  timeoutMs: number;
  retryPolicy: FlowRetryPolicy | null;
  fallbackPolicy: FlowFallbackPolicy | null;
  sortOrder: number;
}

export interface RuntimeFlows {
  flows: RuntimeFlowDefinition[];
  bindings: RuntimeFlowBinding[];
}

export type FlowRunStatus = 'queued' | 'running' | 'done' | 'error' | 'timeout' | 'cancelled';

export type FlowRunErrorCode =
  | 'node_failed'
  | 'timeout'
  | 'cancelled'
  | 'capability_denied'
  | 'invalid_flow'
  | 'runner_unavailable';

/** Error envelope per flow-run-result.schema.json. */
export interface FlowRunError {
  code: FlowRunErrorCode;
  message: string;
  nodeId?: string;
}

/** Which runtime claimed/executes a run. */
export type FlowRuntimeKind = 'browser' | 'desktop';

/** A flow_run_logs row (FlowService::formatRun). appId null = a workspace-flow run. */
export interface FlowRunLog {
  runId: string;
  appId: string | null;
  formId: string | null;
  responseId: string | null;
  bindingId: string | null;
  flowDefinitionId: string | null;
  flow: string | null;
  triggerEvent: string;
  correlationId: string;
  idempotencyKey: string;
  status: FlowRunStatus;
  /** Set when a 'queued' run was claimed (queued→running exactly once). */
  runtime: FlowRuntimeKind | null;
  /** Optional claimer instance id (e.g. a desktop install id). */
  claimedBy: string | null;
  inputSnapshot: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  outputActions: FlowOutputAction[] | null;
  error: FlowRunError | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Successful claim response (POST .../flow-runs/{runId}/claim → 200; 409 when already taken). */
export interface ClaimResult {
  run: FlowRunLog;
  claimed: true;
}

/**
 * Remote command relay (docs/API.md §connector:relay): a desktop_commands row. A web member
 * enqueues a connector command for the app owner's paired FormLogic Desktop runtime, which claims
 * (pending→claimed exactly-once) and completes it (claimed→done|failed). pending commands expire
 * 60s after creation.
 */
export type ConnectorCommandStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'expired';

export interface ConnectorCommand {
  commandId: string;
  appId: string | null;
  connectorId: string;
  command: string;
  payload: Record<string, unknown> | null;
  idempotencyKey: string;
  status: ConnectorCommandStatus;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  requestedByUserId: string;
  /** ROUTE-001: the ONE desktop instance this command is routed to (null = legacy fan-out). */
  targetInstanceId?: string | null;
  claimedBy: string | null;
  /** ROUTE-001: device names resolved by the server for the target / claimant, when known. */
  targetDeviceName?: string;
  claimedByDeviceName?: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
}

/** One flow_kv entry (docs/FORMLOGIC_FLOWS.md §9). appId null = the owner's workspace store. */
export interface FlowKvEntry {
  appId: string | null;
  scope: string;
  k: string;
  v: unknown;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Packaging (docs/FORMLOGIC_FLOWS.md §6): PackData gains optional flows/flowBindings,
// imported atomically by PackService::importPackFlows. `@pack:<packFormId>` form refs
// (binding formId and outputActions[].form) are remapped to the new form ids on import.
// ---------------------------------------------------------------------------

export interface PackFlowDefinition {
  /** Which app in the pack owns this flow; defaults to the pack's first app. */
  packAppId?: string;
  name: string;
  slug: string;
  description?: string;
  flowJson: WorkflowGraph;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  nodeCapabilities?: string[];
  enabled?: boolean;
}

export interface PackFlowBinding {
  /** Which app in the pack owns this binding; defaults to the pack's first app. */
  packAppId?: string;
  /** '@pack:<packFormId>' — raw form ids from a pack are never trusted. */
  formId?: string;
  connectorId?: string;
  flow: string;
  event: string;
  mode: FlowBindingMode;
  condition?: FlowBindingCondition;
  inputMap?: Record<string, unknown>;
  outputActions?: FlowOutputAction[];
  timeoutMs?: number;
  retryPolicy?: FlowRetryPolicy;
  fallbackPolicy?: FlowFallbackPolicy;
  enabled?: boolean;
  sortOrder?: number;
}
