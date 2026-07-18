// Types for sandboxed QuickJS logic hooks used by custom FormLogic apps.
//
// These types intentionally describe a capability/effect based runtime instead of
// direct browser/native/backend access. React renders the UI; QuickJS scripts
// return safe effects that the trusted host applies after permission checks.

export type CustomAppLogicRuntime = 'quickjs';

export type CustomAppLogicHookName =
  | 'onAppStart'
  | 'onScreenEnter'
  | 'onScreenLeave'
  | 'onButtonClick'
  | 'onBeforeSubmit'
  | 'onAfterSubmit'
  | 'onConnectorEvent'
  | 'onSyncConflict'
  | 'mapConnectorDataToForm'
  | 'calculateDashboardState';

export type CustomAppLogicPermission =
  | '*'
  | 'formlogic.forms.read'
  | 'formlogic.responses.write'
  | 'formlogic.responses.read'
  | 'formlogic.responses.manage'
  | 'storage.local'
  | 'ui.toast'
  | 'ui.navigate'
  | 'ui.setValues'
  | 'ui.reject'
  // FormLogic Flows (docs/FORMLOGIC_FLOWS.md §5): bare 'flow.run' grants every flow;
  // 'flow.<slug>.run' one flow; 'flow.*.run' every flow via the wildcard segment.
  | 'flow.run'
  | `flow.${string}.run`
  | `connector.${string}.${string}`
  | `${string}.*`;

export interface CustomAppLogicScript {
  id: string;
  hook: CustomAppLogicHookName;
  runtime: CustomAppLogicRuntime;
  source: string;
  description?: string;
  enabled?: boolean;
  permissions?: CustomAppLogicPermission[];
  budgetMs?: number;
}

export interface CustomAppLogicBundle {
  version: 1;
  runtime: CustomAppLogicRuntime;
  scripts: CustomAppLogicScript[];
  /** Optional app-wide grants; script-level permissions are added on top. */
  permissions?: CustomAppLogicPermission[];
  /** When true, every emitted effect must map to an explicit permission. */
  strictPermissions?: boolean;
  /**
   * Optional pack-shipped connector driver (spec: pack-embedded connectors).
   * The manifest declares the connector's identity + command surface; the demo
   * driver is a sandboxed QuickJS script the trusted host runs for simulator
   * sessions ONLY. Real hardware transport (FormLogic Desktop gateway / relay)
   * is always host-owned — the driver never sees tokens or live IO.
   */
  connector?: PackConnectorBundle;
}

// ── Pack-embedded connector drivers ──────────────────────────────────────────

/**
 * The declarative half of a pack-shipped connector: identity, command surface
 * and the demo driver's allowlists. Everything the host needs to route real
 * commands (desktop gateway + relay) comes from here; everything the DEMO
 * driver may do (emit events, run ceremonies) is capped by these declarations
 * so a driver script can never widen its own surface.
 */
export interface ConnectorDriverManifest {
  /** Dot-free slug — the id used in connector.<id>.<command> grants. */
  connectorId: string;
  /** Connector family, e.g. 'aokie_phone' (shown in status/summary rows). */
  kind: string;
  /** Human label for status copy ("<label> (FormLogic Desktop)" etc.). */
  label: string;
  /** Full command surface (the desktop plugin's contract list). */
  commands: string[];
  /**
   * Commands the desktop plugin journals durably — the host mints ONE
   * `ui-<command>-<id>` requestId per operator action for these, so a
   * capability-refresh retry re-sends the same body instead of acting twice.
   */
  journalledCommands?: string[];
  /** Event names the DEMO driver may emit (host-enforced allowlist). */
  demoEvents?: string[];
  /** Demo ceremony names the driver implements (e.g. 'simulate-call'). */
  demoCeremonies?: string[];
  /** Detail line for the demo status card. */
  demoStatusDetail?: string;
  /** True when this connector provides the volatile live-captions lane. */
  captions?: boolean;
}

/** The pack-shipped connector bundle stored on app customLogic. */
export interface PackConnectorBundle {
  manifest: ConnectorDriverManifest;
  /**
   * QuickJS demo-driver source (`function run(ctx) { ... }` convention, same
   * sandbox as app-logic scripts: zero IO, pure state-threaded — the host
   * passes `ctx.state` in and persists the returned `state`). Optional: a
   * manifest without a driver routes to real hardware only.
   */
  demoDriver?: string;
}

export interface CustomAppLogicInput {
  hook: CustomAppLogicHookName;
  answers?: Record<string, unknown>;
  values?: Record<string, unknown>;
  params?: Record<string, unknown>;
  /**
   * Read-only snapshot of this app's logic storage (the keys previously written via
   * `storage.set` effects), injected by the trusted host so scripts can implement
   * guards (e.g. idempotency-key dedupe) without any live IO in the sandbox.
   */
  storage?: Record<string, unknown>;
  meta?: {
    appSlug?: string;
    appId?: string;
    formId?: string;
    formKey?: string;
    screenId?: string;
    userRole?: string;
    nativeAvailable?: boolean;
    offline?: boolean;
    now?: string;
  };
  event?: unknown;
}

export type CustomAppLogicEffect =
  | {
      type: 'formlogic.submitResponse';
      formKey: string;
      answers: Record<string, unknown>;
      options?: Record<string, unknown>;
    }
  | {
      type: 'formlogic.listResponses';
      formKey: string;
      query?: Record<string, unknown>;
    }
  | {
      /**
       * Update an existing response. Scripts rarely know response ids, so the trusted
       * host also accepts a `match` ({field, value} over recent answers) to locate the
       * row; `upsert: true` creates the row when no match exists (e.g. SMS threads).
       */
      type: 'formlogic.updateResponse';
      formKey: string;
      responseId?: string;
      match?: { field: string; value: unknown };
      answers: Record<string, unknown>;
      upsert?: boolean;
    }
  | {
      type: 'connector.request';
      connectorId: string;
      command: string;
      payload?: unknown;
    }
  | {
      /** Run a FormLogic Flow by slug (docs/FORMLOGIC_FLOWS.md §5). Sync feeds the flow
       *  result back through onConnectorEvent; async/background just reserve+queue. */
      type: 'flow.run';
      flow: string;
      mode?: 'sync' | 'async';
      timeoutMs?: number;
      input?: Record<string, unknown>;
    }
  | { type: 'storage.get'; key: string }
  | { type: 'storage.set'; key: string; value: unknown }
  | { type: 'storage.remove'; key: string }
  | { type: 'ui.toast'; message: string; level?: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'ui.navigate'; screenId: string; params?: Record<string, unknown> }
  | { type: 'ui.setValues'; values: Record<string, unknown> }
  | { type: 'ui.reject'; message: string };

export interface CustomAppLogicUiPatch {
  setValues?: Record<string, unknown>;
  navigate?: { screenId: string; params?: Record<string, unknown> };
  toast?: { message: string; level?: 'info' | 'success' | 'warning' | 'error' };
}

export interface CustomAppLogicRunResult {
  ok: boolean;
  value?: unknown;
  effects: CustomAppLogicEffect[];
  ui?: CustomAppLogicUiPatch;
  reject?: boolean;
  message?: string;
  warnings?: string[];
  error?: string;
}
