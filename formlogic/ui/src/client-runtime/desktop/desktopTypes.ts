// FormLogic Desktop — shared browser-side types (docs/FORMLOGIC_DESKTOP.md §1/§2/§3,
// docs/contracts/desktop-event.schema.json, connector-request/response.schema.json).
//
// FormLogic Desktop is the local companion on 127.0.0.1:17872.
// These types mirror the frozen Phase 0 contracts; nothing here talks to the network —
// the detection/pairing/client/events modules build on this file.

/** Loopback base URL of FormLogic Desktop (contract §1). */
export const DESKTOP_BASE_URL = 'http://127.0.0.1:17872';

/**
 * Every loopback base a supported desktop runtime may answer on, in probe order.
 *
 * More than one because a desktop runtime is no longer a single product: OAIY
 * Desktop implements the same loopback contract on its own port. Detection tries
 * each until one answers with a recognised `companion`, then pins to it — so a
 * user running either (or, on a developer box, both) gets the one that is
 * actually there rather than a hardcoded guess.
 *
 * Order is preference: FormLogic's own runtime first.
 */
export const DESKTOP_BASE_URL_CANDIDATES = [
  'http://127.0.0.1:17872',
  'http://127.0.0.1:17972',
] as const;

// Overridable for tests (points the whole desktop stack at a mock server / distinct
// per-test "instance" so pairing-token namespacing is exercisable). Production never calls this.
let baseUrl = DESKTOP_BASE_URL;

/** The base URL every desktop module must use (single source of truth, test-overridable). */
export function getDesktopBaseUrl(): string {
  return baseUrl;
}

/** Override the desktop base URL. Test-only. */
export function __setDesktopBaseUrlForTests(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

/** Restore the production base URL. Test-only. */
export function __resetDesktopBaseUrlForTests(): void {
  baseUrl = DESKTOP_BASE_URL;
}

/**
 * Pin the base a probe found a live desktop on.
 *
 * Detection calls this; every other module then reads getDesktopBaseUrl() and
 * needs to know nothing about which runtime is running.
 */
export function setDiscoveredDesktopBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

/**
 * Companion ids accepted by detection (contract §1).
 *
 * A set, not one value: any runtime implementing the loopback contract is a
 * valid desktop for this app. OAIY Desktop reports `oaiy-desktop` and serves the
 * same /api/services, /api/plugins and control routes.
 */
export const DESKTOP_COMPANION_IDS = ['formlogic-desktop', 'oaiy-desktop'] as const;

/** GET /api/health response (unauthenticated, CORS-open). */
export interface DesktopHealth {
  status: string;
  companion: string;
  legacyCompanion?: string;
  version: string;
  apiVersion?: number;
  pluginApiVersion?: number;
}

// ---------------------------------------------------------------------------
// Event envelope — mirrors docs/contracts/desktop-event.schema.json exactly.
// ---------------------------------------------------------------------------

export type DesktopEventSeverity = 'debug' | 'info' | 'warning' | 'error';

export interface DesktopEventEnvelope {
  schemaVersion: 1;
  /** Origin subsystem: plugin id (e.g. "aokie") or "desktop" | "flows" | "models". */
  source: string;
  /** Dot-namespaced event name, e.g. "aokie.call.incoming". */
  name: string;
  /** Call/session/run id shared by all events of one logical interaction. */
  correlationId: string;
  /** Stable unique key for THIS occurrence — consumers dedupe on it (contract §7). */
  idempotencyKey: string;
  /** ISO-8601 UTC timestamp. */
  occurredAt: string;
  /** Event-specific payload (PII already minimised by the producer). */
  data: unknown;
  pluginId?: string;
  connectorId?: string;
  severity?: DesktopEventSeverity;
}

// ---------------------------------------------------------------------------
// Plugin / connector summaries (GET /api/plugins, GET /api/connectors).
// ---------------------------------------------------------------------------

/** Plugin lifecycle states (docs/DESKTOP_PLUGIN_SDK.md §2). */
export type DesktopPluginState =
  | 'installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'crashed'
  | 'disabled';

export interface DesktopPluginSummary {
  id: string;
  name?: string;
  version?: string;
  state: DesktopPluginState | string;
  /** Human-readable reason for a refused/disabled plugin, when Desktop provides one. */
  detail?: string;
  pluginApiVersion?: number;
}

export interface DesktopConnectorSummary {
  id: string;
  pluginId?: string;
  kind?: string;
  label?: string;
  commands?: string[];
}

export interface DesktopConnectorStatus {
  id: string;
  available: boolean;
  detail?: string;
}

export interface DesktopTrustedOrigin {
  origin: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Pairing (contract §3).
// ---------------------------------------------------------------------------

export type DesktopPairingStatus = 'pending' | 'approved' | 'denied';

/** POST /api/desktop/pairing-requests {origin} → {requestId}. */
export interface DesktopPairingRequest {
  requestId: string;
}

/** GET /api/desktop/pairing-requests/{id} poll result; token present only on approval. */
export interface DesktopPairingPollResult {
  status: DesktopPairingStatus;
  token?: string;
}

// ---------------------------------------------------------------------------
// Connector gateway request/response — mirror connector-request/response.schema.json.
// The error codes are intentionally the SAME set FormLogic's ConnectorError parses,
// plus 'auth_required' which is desktop-transport-only (handled by the desktop client
// before the connector layer; it never surfaces as a ConnectorError).
// ---------------------------------------------------------------------------

export type DesktopErrorCode =
  | 'origin_denied'
  | 'capability_denied'
  | 'connector_missing'
  | 'connector_unavailable'
  | 'command_failed'
  | 'ipc_unavailable'
  | 'auth_required';

export interface DesktopErrorShape {
  code: DesktopErrorCode;
  message: string;
}

/** Body of POST /api/connectors/{connectorId}/request. */
export interface DesktopConnectorRequestBody {
  connectorId: string;
  command: string;
  payload?: unknown;
  timeoutMs?: number;
  requestId?: string;
}

export type DesktopConnectorResponseBody =
  | { ok: true; data?: unknown; requestId?: string }
  | { ok: false; error: DesktopErrorShape; requestId?: string };

/**
 * The desktop client's result for any call. `transportFailure` marks errors synthesised
 * by the CLIENT (network failure / timeout / non-JSON body) rather than returned by
 * Desktop — callers use it to distinguish "Desktop unreachable" (safe to fall back to a
 * mock) from a REAL desktop-returned error with the same code (e.g. connector_unavailable
 * = plugin stopped — must never be masked with mock data).
 */
export type DesktopClientResult<T> =
  | { ok: true; data: T; requestId?: string }
  | { ok: false; error: DesktopErrorShape; requestId?: string; transportFailure?: boolean };
