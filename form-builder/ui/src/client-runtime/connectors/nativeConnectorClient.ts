// Connector client — routes an app's connector requests to the right source.
//
// Priority: the signed native bridge (window.FormLogicNative) when present,
// otherwise the browser connector registry (mock connectors). Apps and app-logic
// call the SAME request(connectorId, command) regardless of where the data
// actually comes from (spec §40/§41).
//
// Exception: a browser connector marked `preferLocal` (the `device` connector, whose
// capabilities are the WebView's own Web APIs) is ALWAYS serviced in the web layer and
// merged into list() even when the native bridge is present — so phone abilities work
// identically in a browser, the PWA, and the native runtime.
import type {
  BrowserConnector,
  ConnectorStatusInfo,
  ConnectorSummary,
  FormLogicNativeBridge,
} from './connectorTypes';
import { ConnectorError, FALLBACKABLE_CODES, parseConnectorError } from './connectorTypes';
import { mockVehicleConnector } from './vehicleConnector';
import { createLocalHttpConnector } from './localHttpConnector';
import { deviceConnector } from './deviceConnector';

export interface ConnectorClient {
  isNativeAvailable(): boolean;
  list(): Promise<ConnectorSummary[]>;
  status(connectorId: string): Promise<ConnectorStatusInfo>;
  request(connectorId: string, command: string, payload?: unknown): Promise<unknown>;
  /** Subscribe to a connector's live stream (device sensors / online-offline). Returns
   *  an unsubscribe function; a no-op for connectors without streaming support. */
  subscribe(
    connectorId: string,
    command: string,
    callback: (event: unknown) => void,
    payload?: unknown
  ): () => void;
}

// Browser connector registry. `device` is web-serviced everywhere (preferLocal); the
// native runtime supplies vehicle/etc. over the bridge.
const localHttpConnector = createLocalHttpConnector();
const BROWSER_CONNECTORS: Record<string, BrowserConnector> = {
  [deviceConnector.id]: deviceConnector,
  [mockVehicleConnector.id]: mockVehicleConnector,
  [localHttpConnector.id]: localHttpConnector,
};

function nativeBridge() {
  const bridge = typeof window !== 'undefined' ? window.FormLogicNative : undefined;
  return bridge?.available ? bridge : undefined;
}

// ---------------------------------------------------------------------------
// Native manifest-verification readiness (shared cross-agent contract 1).
//
// The Rust page-load verifier fetches + verifies this origin's signed client manifest asynchronously.
// Until that completes, connector calls from an about-to-be-approved origin reject with origin_denied
// (a non-fallbackable code) — so an early onScreenEnter connector read fired during that window would
// be permanently denied even though the origin is legitimate. We therefore await runtime.ready() once
// per session (with a ~3s cap) before the first native read.
//
// We read the RAW bridge (not the `available` gate) because a FAILED verification flips
// available=false + deletes connectors/sync, yet leaves runtime.ready() callable — that's how we learn
// the denial was genuine and must NOT be masked with a browser mock.
// ---------------------------------------------------------------------------
const READY_TIMEOUT_MS = 3000;
let nativeReadyPromise: Promise<{ verified: boolean } | null> | null = null;

/** The raw native bridge if injected at all (even when marked unavailable by a failed verification). */
function rawNativeBridge(): FormLogicNativeBridge | undefined {
  return typeof window !== 'undefined' ? window.FormLogicNative : undefined;
}

/**
 * The origin's verification result, cached once per session. Resolves {verified} once verification
 * completes, or null when the runtime predates ready() (proceed best-effort). Never rejects. Callers
 * race this against a short timeout so the FIRST read isn't blocked indefinitely.
 */
function nativeReady(bridge: FormLogicNativeBridge): Promise<{ verified: boolean } | null> {
  if (!nativeReadyPromise) {
    const readyFn = bridge.runtime?.ready;
    nativeReadyPromise =
      typeof readyFn === 'function'
        ? Promise.resolve()
            .then(() => readyFn.call(bridge.runtime))
            .then((r) => (r && typeof r.verified === 'boolean' ? { verified: r.verified } : null))
            .catch(() => null)
        : Promise.resolve(null);
  }
  return nativeReadyPromise;
}

/**
 * True only when this origin's verification DEFINITIVELY failed (verified:false) — a genuine denial the
 * caller must not fall back to mock for. False for a plain browser (no native bridge), an older runtime
 * without ready(), a not-yet-resolved verification that exceeds the timeout (best-effort), or
 * verified:true.
 */
async function nativeVerificationDenied(): Promise<boolean> {
  const raw = rawNativeBridge();
  if (!raw?.runtime) return false; // not a native origin
  const ready = await Promise.race([
    nativeReady(raw),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), READY_TIMEOUT_MS); }),
  ]);
  return ready?.verified === false;
}

/** Reset the per-session readiness cache. Test-only. */
export function __resetNativeReadyForTests(): void {
  nativeReadyPromise = null;
}

/** The browser connector for `id` only if it must be serviced locally even under native. */
function localConnector(id: string): BrowserConnector | undefined {
  const c = BROWSER_CONNECTORS[id];
  return c?.preferLocal ? c : undefined;
}

function summarize(c: BrowserConnector): ConnectorSummary {
  return { id: c.id, kind: c.kind, label: c.label, commands: c.commands };
}

class DefaultConnectorClient implements ConnectorClient {
  isNativeAvailable(): boolean {
    return !!nativeBridge();
  }

  async list(): Promise<ConnectorSummary[]> {
    const bridge = nativeBridge();
    let native: ConnectorSummary[] = [];
    if (bridge) {
      // The bridge can be present but its IPC unavailable (e.g. a non-approved origin);
      // don't let that hide the web-serviced connectors (device).
      try {
        native = await bridge.connectors.list();
      } catch {
        native = [];
      }
    }
    // Merge: native list + browser connectors, with preferLocal browser entries winning
    // on id collision so device is always discoverable (and web-serviced) under native.
    const byId = new Map<string, ConnectorSummary>();
    for (const c of native) byId.set(c.id, c);
    for (const c of Object.values(BROWSER_CONNECTORS)) {
      if (!bridge || c.preferLocal || !byId.has(c.id)) byId.set(c.id, summarize(c));
    }
    return Array.from(byId.values());
  }

  async status(connectorId: string): Promise<ConnectorStatusInfo> {
    const local = localConnector(connectorId);
    if (local) return local.status();
    // Same verification gate as request(): a genuine denial surfaces (callers show "unavailable")
    // rather than being masked by a browser connector's status.
    if (await nativeVerificationDenied()) {
      throw new ConnectorError('origin_denied', 'This origin is not authorized to use native connectors.');
    }
    const bridge = nativeBridge();
    if (bridge) {
      // Resilient like list()/request(): the bridge can be present but its IPC
      // unavailable (non-approved origin), so fall back to a browser connector.
      try {
        return await bridge.connectors.status(connectorId);
      } catch (e) {
        // Same policy as request(): only mask an absent/unreachable native side. A capability denial
        // or a real failure must surface, not be papered over with a browser connector's status.
        const parsed = parseConnectorError(e);
        if (parsed !== null && !FALLBACKABLE_CODES.has(parsed.code)) throw e;
        /* else fall through to the browser connector */
      }
    }
    const connector = BROWSER_CONNECTORS[connectorId];
    if (connector) return connector.status();
    return {
      id: connectorId,
      kind: 'unknown',
      available: false,
      source: 'mock',
      detail: 'No connector available in this environment.',
    };
  }

  async request(connectorId: string, command: string, payload?: unknown): Promise<unknown> {
    // preferLocal connectors (device) are always web-serviced — no verification gate needed.
    const local = localConnector(connectorId);
    if (local) return local.request(command, payload);

    // Await this origin's signed-manifest verification before the first native read (contract 1), so
    // an early onScreenEnter read isn't lost to the pre-verification race. A definitive denial must
    // never be masked with mock data.
    if (await nativeVerificationDenied()) {
      throw new ConnectorError('origin_denied', 'This origin is not authorized to use native connectors.');
    }

    const bridge = nativeBridge();
    if (bridge) {
      try {
        return await bridge.connectors.request(connectorId, command, payload);
      } catch (e) {
        // The native bridge is present but the call failed. Fall back to a browser connector ONLY when
        // the native side is absent/unreachable (IPC dead, or the connector isn't provided natively —
        // FALLBACKABLE_CODES), or for a legacy runtime that sends no error code. NEVER mask a capability
        // denial or a genuine per-request failure from a REAL connector with mock data (spec §41).
        const fallback = BROWSER_CONNECTORS[connectorId];
        const parsed = parseConnectorError(e);
        const mayFallback = parsed === null || FALLBACKABLE_CODES.has(parsed.code);
        if (fallback && mayFallback) return fallback.request(command, payload);
        throw e;
      }
    }
    const connector = BROWSER_CONNECTORS[connectorId];
    if (!connector) {
      throw new Error(`Connector "${connectorId}" is not available in this environment.`);
    }
    return connector.request(command, payload);
  }

  subscribe(
    connectorId: string,
    command: string,
    callback: (event: unknown) => void,
    payload?: unknown
  ): () => void {
    const local = localConnector(connectorId) ?? BROWSER_CONNECTORS[connectorId];
    if (local?.subscribe) return local.subscribe(command, callback, payload);
    const bridge = nativeBridge();
    if (bridge?.connectors.subscribe) return bridge.connectors.subscribe(connectorId, command, callback);
    return () => {};
  }
}

let singleton: ConnectorClient | null = null;

export function getConnectorClient(): ConnectorClient {
  if (!singleton) singleton = new DefaultConnectorClient();
  return singleton;
}

/** Register an extra browser connector (used by tests / future connectors). */
export function registerBrowserConnector(connector: BrowserConnector): void {
  BROWSER_CONNECTORS[connector.id] = connector;
}
