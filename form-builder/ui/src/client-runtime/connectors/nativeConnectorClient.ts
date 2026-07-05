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
} from './connectorTypes';
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
    const bridge = nativeBridge();
    if (bridge) {
      // Resilient like list()/request(): the bridge can be present but its IPC
      // unavailable (non-approved origin), so fall back to a browser connector.
      try {
        return await bridge.connectors.status(connectorId);
      } catch {
        /* fall through to the browser connector */
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
    // preferLocal connectors (device) are always web-serviced.
    const local = localConnector(connectorId);
    if (local) return local.request(command, payload);

    const bridge = nativeBridge();
    if (bridge) {
      try {
        return await bridge.connectors.request(connectorId, command, payload);
      } catch (e) {
        // The native bridge is present but the call failed (e.g. denied on a non-approved
        // origin, or no such native connector). Fall back to a browser connector if we have
        // one. NOTE: today the only bridge connector is a mock, so this fallback is
        // demo-safe. When a REAL device connector lands, this should distinguish
        // "IPC/origin unavailable" from a genuine per-request failure so it doesn't mask
        // real errors with mock data.
        const fallback = BROWSER_CONNECTORS[connectorId];
        if (!fallback) throw e;
        return fallback.request(command, payload);
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
