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
// The Rust page-load verifier fetches + verifies the CURRENT page's signed client manifest
// asynchronously. Until that completes, a native connector call from an about-to-be-approved origin
// rejects with origin_denied (a NON-fallbackable code) — so an early onScreenEnter read fired during
// that window would be permanently denied even though the origin is legitimate. We therefore await
// runtime.ready() (with a short cap) before the first native read of each app.
//
// Per-app cache key (contract #3): a client manifest is signed PER APP (per /app/{slug}) and one native
// session can navigate BETWEEN apps on the platform origin, or BETWEEN custom domains, without a full
// reload. Caching the readiness result in ONE global promise would let App A's verified/failed result
// leak onto App B. So we cache per (origin + app slug) and re-derive when the location moves to a
// different app/domain (other-key entries are pruned so a stale result is never reused).
//
// Timeout policy (contract #4): a ready() that TIMES OUT must NOT be treated as a genuine denial —
// calling native during that window would return a non-fallbackable origin_denied and permanently
// poison a legitimate read. We classify readiness into four states (see classifyReadiness) and let each
// caller act: verified => native, denied => hard origin_denied, absent (older runtime) => best-effort,
// pending (timed out) => TEMPORARY native-unavailable => fall back to the browser connector.
//
// We read the RAW bridge (not the `available` gate) because a FAILED verification flips
// available=false + deletes connectors/sync, yet leaves runtime.ready() callable — that's how we learn
// the denial was genuine and must NOT be masked with a browser mock.
// ---------------------------------------------------------------------------
const READY_TIMEOUT_MS = 3000;

// The verification outcome for one app, resolved once per key per session:
//   {verified:true}  — manifest verified; native calls allowed
//   {verified:false} — verification DEFINITIVELY failed (a genuine origin denial)
//   null             — runtime predates ready(), OR ready() threw / returned malformed => best-effort
type ReadyResult = { verified: boolean } | null;

/** Decision for the native-readiness gate before a native connector call. */
export type NativeReadiness =
  | 'absent' // older runtime (no ready()) or malformed result => proceed best-effort (native, then fallback)
  | 'verified' // verified:true => call native
  | 'denied' // verified:false => hard deny (throw origin_denied; NO mock fallback)
  | 'pending'; // ready() still resolving past the cap => TEMPORARY native-unavailable => fall back

/**
 * Pure classifier for the readiness gate — unit-testable without a real bridge (contract #4). Kept
 * total so the four decision states are exhaustively documented and independently verifiable:
 *  - hasReadyFn=false            => 'absent'   (older runtime; no gate)
 *  - timedOut=true               => 'pending'  (still verifying — must NOT be read as a denial)
 *  - resolved.verified === true  => 'verified' (call native)
 *  - resolved.verified === false => 'denied'   (genuine denial; no fallback)
 *  - resolved === null           => 'absent'   (ready() threw / malformed => best-effort)
 */
export function classifyReadiness(
  hasReadyFn: boolean,
  timedOut: boolean,
  resolved: ReadyResult
): NativeReadiness {
  if (!hasReadyFn) return 'absent';
  if (timedOut) return 'pending';
  if (resolved?.verified === true) return 'verified';
  if (resolved?.verified === false) return 'denied';
  return 'absent';
}

// Per-(origin + app slug) readiness cache. A move to a different app/domain re-derives verification;
// entries for other keys are pruned on lookup so a stale verified/failed result is never reused.
const readinessCache = new Map<string, Promise<ReadyResult>>();

// Sentinel distinguishing "ready() timed out (still pending)" from "ready() resolved null (malformed)".
const READINESS_TIMEOUT = Symbol('readiness-timeout');

// Overridable so tests can exercise the pending/timeout path fast; production keeps the full cap.
let readyTimeoutMs = READY_TIMEOUT_MS;

/** The raw native bridge if injected at all (even when marked unavailable by a failed verification). */
function rawNativeBridge(): FormLogicNativeBridge | undefined {
  return typeof window !== 'undefined' ? window.FormLogicNative : undefined;
}

/**
 * Stable readiness key for the CURRENT app: origin + the /app/{slug} path segment. A custom domain
 * serves one app at its root (no /app/ segment), so the origin alone distinguishes it. Screens WITHIN
 * one app share a key (verification is reused); a different app/domain yields a different key (re-derive).
 */
function readinessKey(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  const origin = window.location.origin ?? '';
  const path = window.location.pathname ?? '';
  const m = /^\/app\/([^/]+)/.exec(path);
  return origin + '|' + (m ? m[1] : '');
}

/**
 * The current app's cached readiness promise. Prunes any other-key entries first so a prior app/domain's
 * verified/failed result can never be reused after navigation, then resolves runtime.ready() once for
 * this key. Resolves {verified} on completion, or null when the runtime predates ready(). Never rejects.
 */
function nativeReady(bridge: FormLogicNativeBridge, key: string): Promise<ReadyResult> {
  for (const k of readinessCache.keys()) {
    if (k !== key) readinessCache.delete(k);
  }
  let cached = readinessCache.get(key);
  if (!cached) {
    const readyFn = bridge.runtime?.ready;
    cached =
      typeof readyFn === 'function'
        ? Promise.resolve()
            .then(() => readyFn.call(bridge.runtime))
            .then((r): ReadyResult => (r && typeof r.verified === 'boolean' ? { verified: r.verified } : null))
            .catch((): ReadyResult => null)
        : Promise.resolve<ReadyResult>(null);
    readinessCache.set(key, cached);
  }
  return cached;
}

/**
 * Resolve the native-readiness decision for the current app: awaits runtime.ready() (cached per app)
 * raced against a short timeout, then classifies (contract #4). Never rejects; the caller decides how to
 * act on each state. Returns 'absent' for a non-native origin so the caller stays in the browser layer.
 */
async function resolveNativeReadiness(): Promise<NativeReadiness> {
  const raw = rawNativeBridge();
  if (!raw?.runtime) return 'absent'; // not a native origin — no gate
  const hasReadyFn = typeof raw.runtime.ready === 'function';
  if (!hasReadyFn) return classifyReadiness(false, false, null);

  const readyP = nativeReady(raw, readinessKey());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    readyP,
    new Promise<typeof READINESS_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(READINESS_TIMEOUT), readyTimeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (raced === READINESS_TIMEOUT) return classifyReadiness(true, true, null);
  return classifyReadiness(true, false, raced);
}

/** Reset the per-session readiness cache + timeout override. Test-only. */
export function __resetNativeReadyForTests(): void {
  readinessCache.clear();
  readyTimeoutMs = READY_TIMEOUT_MS;
}

/** Override the readiness timeout (ms) so tests can drive the pending/timeout path fast. Test-only. */
export function __setReadyTimeoutForTests(ms: number): void {
  readyTimeoutMs = ms;
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
    const readiness = await resolveNativeReadiness();
    if (readiness === 'denied') {
      throw new ConnectorError('origin_denied', 'This origin is not authorized to use native connectors.');
    }
    if (readiness === 'pending') {
      // ready() timed out (still verifying) — TEMPORARY, not a denial. Surface the browser connector's
      // status rather than a permanent origin_denied; a later call re-checks (likely resolved by then).
      const fallback = BROWSER_CONNECTORS[connectorId];
      if (fallback) return fallback.status();
      return {
        id: connectorId,
        kind: 'unknown',
        available: false,
        source: 'mock',
        detail: 'Native runtime is still verifying this app.',
      };
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

    // Gate on THIS app's signed-manifest verification before the first native read (contracts #1/#3/#4),
    // so an early onScreenEnter read isn't lost to the pre-verification race and a stale result from a
    // previously-open app/domain is never reused.
    const readiness = await resolveNativeReadiness();
    if (readiness === 'denied') {
      // Verification DEFINITIVELY failed — a genuine denial that must never be masked with mock data.
      throw new ConnectorError('origin_denied', 'This origin is not authorized to use native connectors.');
    }
    if (readiness === 'pending') {
      // ready() timed out (still verifying). Treat as TEMPORARY native-unavailable: service this request
      // from the browser connector rather than calling native and getting a non-fallbackable origin_denied
      // that would poison a legitimate origin. A later request re-checks readiness (likely resolved then).
      const fallback = BROWSER_CONNECTORS[connectorId];
      if (fallback) return fallback.request(command, payload);
      throw new ConnectorError(
        'connector_unavailable',
        `Connector "${connectorId}" is temporarily unavailable while the native runtime verifies this app.`
      );
    }

    // readiness is 'verified' (native ok) or 'absent' (older runtime / non-native origin) => best-effort.
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
