// FormLogic Connect — connector abstraction (browser side).
//
// An app asks a connector for abstract commands (e.g. vehicle "status.read")
// and does not care whether the data came from mock data, a local HTTP bridge,
// Bluetooth, USB, or a vendor API (spec §41/§43). In the browser today the only
// real source is the mock connector; inside FormLogic Native Runtime the same
// calls are serviced by the signed native bridge (window.FormLogicNative).

export interface ConnectorSummary {
  id: string;
  kind: string;
  label: string;
  commands: string[];
}

export interface ConnectorStatusInfo {
  id: string;
  kind: string;
  available: boolean;
  /** Where this connector's data is coming from right now. */
  source: 'native' | 'mock' | 'local_http' | 'device';
  label?: string;
  detail?: string;
}

/** A connector implementation available inside the browser/PWA runtime. */
export interface BrowserConnector {
  id: string;
  kind: string;
  label: string;
  commands: string[];
  status(): Promise<ConnectorStatusInfo> | ConnectorStatusInfo;
  request(command: string, payload?: unknown): Promise<unknown>;
  /**
   * When true, this connector is ALWAYS serviced in the web layer — even inside the
   * native runtime where a bridge is present. Used by the `device` connector, whose
   * capabilities are the WebView's own Web APIs (geolocation, battery, sensors, …),
   * so they work identically in a browser, the PWA, and the native runtime.
   */
  preferLocal?: boolean;
  /**
   * Optional live stream for a command (e.g. geolocation watch, online/offline,
   * device orientation). Returns an unsubscribe function. One-shot reads use request().
   */
  subscribe?(command: string, callback: (event: unknown) => void, payload?: unknown): () => void;
}

// ---------------------------------------------------------------------------
// Typed connector errors (spec §41 hardening).
//
// A real native connector must be able to say WHY a call failed so the client can decide whether a
// browser/mock fallback is safe. The native bridge rejects with a JSON string `{code, message}` (or a
// ConnectorError); older runtimes reject with a bare string (no code) — treated as legacy.
// ---------------------------------------------------------------------------
export type ConnectorErrorCode =
  | 'origin_denied'
  | 'capability_denied'
  | 'connector_missing'
  | 'connector_unavailable'
  | 'command_failed'
  | 'ipc_unavailable';

export interface ConnectorErrorShape {
  code: ConnectorErrorCode;
  message: string;
}

export class ConnectorError extends Error {
  code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

/**
 * Extract the typed error code from a rejected bridge call. Returns null for a bare-string rejection
 * (a legacy runtime with no code), so the caller can apply rollout-compatible fallback.
 */
export function parseConnectorError(e: unknown): ConnectorErrorShape | null {
  if (e instanceof ConnectorError) return { code: e.code, message: e.message };
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (raw && raw.charAt(0) === '{') {
    try {
      const obj = JSON.parse(raw) as { code?: unknown; message?: unknown };
      if (obj && typeof obj.code === 'string') {
        return { code: obj.code as ConnectorErrorCode, message: typeof obj.message === 'string' ? obj.message : raw };
      }
    } catch {
      /* not JSON — a legacy bare-string error */
    }
  }
  return null;
}

/**
 * Codes for which falling back to a browser/mock connector is safe: the native side is absent or
 * unreachable. A capability denial or a genuine per-request failure from a REAL connector must NEVER
 * be masked with mock data, so those codes are deliberately excluded.
 */
export const FALLBACKABLE_CODES: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  'ipc_unavailable',
  'connector_missing',
]);

// ---------------------------------------------------------------------------
// FormLogic Native Runtime bridge (spec §38/§39).
//
// Present ONLY inside the signed native runtime; `undefined` in a normal browser.
// The bridge is the trusted path to real device connectors and offline sync; the
// web runtime feature-detects it and falls back to browser connectors.
// ---------------------------------------------------------------------------
export interface NativeRuntimeInfo {
  version: string;
  platform: string;
}

/** A queued offline submission as reported by the native runtime's persistent sync queue. */
export interface NativeSyncQueueItem {
  id: string;
  appSlug: string;
  formId: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  lastError: string | null;
}

export interface FormLogicNativeBridge {
  available: boolean;
  runtime: {
    getInfo(): Promise<NativeRuntimeInfo>;
    openExternal(url: string): Promise<void>;
  };
  connectors: {
    list(): Promise<ConnectorSummary[]>;
    status(connectorId: string): Promise<ConnectorStatusInfo>;
    request<T = unknown>(connectorId: string, command: string, payload?: unknown): Promise<T>;
    subscribe(
      connectorId: string,
      eventName: string,
      callback: (event: unknown) => void
    ): () => void;
  };
  /** Persistent offline sync queue (native runtime). Absent on older runtimes / in a browser. */
  sync?: {
    enqueueSubmission(item: {
      appSlug: string;
      formId: string;
      idempotencyKey: string;
      answers: Record<string, unknown>;
    }): Promise<{ id: string }>;
    getQueue(): Promise<NativeSyncQueueItem[]>;
    flush(): Promise<{ flushed: number; failed: number } | { pending: unknown[] }>;
  };
}

declare global {
  interface Window {
    FormLogicNative?: FormLogicNativeBridge;
  }
}
