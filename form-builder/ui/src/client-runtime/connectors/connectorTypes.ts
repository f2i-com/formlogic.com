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
}

declare global {
  interface Window {
    FormLogicNative?: FormLogicNativeBridge;
  }
}
