// OAIY Desktop runtime access for FormLogic Web.
//
// FormLogic's original companion is FormLogic Desktop on :17872. OAIY Desktop is
// the successor local runtime — a separate product on :17972 speaking the OAIY
// Bridge Protocol (contract: oaiy.com/protocol/README.md). This module is the
// thin, additive bridge to it: detect OAIY, hold a pairing token, and forward a
// connector command to a plugin running under OAIY's plugin host.
//
// It is deliberately shaped like the FormLogic Desktop client — never throws,
// resolves a `DesktopClientResult` — so the existing connector layer
// (desktopConnector.ts) can prefer an OAIY route with a three-line guard and
// keep ALL of its error handling unchanged. When OAIY is absent, nothing here
// runs and FormLogic Desktop stays the sole path.
//
// Genericity (the OAIY side): OAIY never learns FormLogic's domain. Every call
// carries `caller.product = 'formlogic'`; OAIY stores and echoes that, never
// parses it. See the protocol's caller-identity note.
import type {
  DesktopClientResult,
  DesktopErrorCode,
  DesktopErrorShape,
} from '../desktop/desktopTypes';

/** Loopback base URL of OAIY Desktop (protocol §Transport). */
export const OAIY_BASE_URL = 'http://127.0.0.1:17972';

/** Stable machine identity OAIY reports at /api/health. Matched exactly — a 200
 *  on a fixed loopback port is not proof it is OAIY (protocol §Handshake). */
export const OAIY_PRODUCT_ID = 'oaiy-desktop';

/** Protocol major this client speaks. */
const OAIY_PROTOCOL_MAJOR = 'oaiy-bridge/1';

const FETCH_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1500;

// Test-overridable base URL, mirroring desktopTypes.getDesktopBaseUrl().
let baseUrl = OAIY_BASE_URL;
export function getOaiyBaseUrl(): string {
  return baseUrl;
}
/** Test-only. */
export function __setOaiyBaseUrlForTests(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}
/** Test-only. */
export function __resetOaiyBaseUrlForTests(): void {
  baseUrl = OAIY_BASE_URL;
}

export interface OaiyHealth {
  status: string;
  product: string;
  protocol: string;
  version: string;
  deviceId?: string;
}

// ---------------------------------------------------------------------------
// Pairing token.
//
// OAIY's exec routes (connector commands, running a flow) are privileged — a
// loopback port is not a trust boundary. A browser served by oaiy.com or OAIY's
// own webview is trusted by Origin; FormLogic Web (a different origin) presents
// a bearer token instead, the generic non-browser-origin path the protocol
// defines. Stored per base URL so a test instance and production do not share.
// ---------------------------------------------------------------------------

// sessionStorage is absent in non-DOM environments (unit tests, SSR); fall back
// to an in-memory map with the same per-base keying, matching desktopPairing.
const memoryStore = new Map<string, string>();

function tokenKey(): string {
  return `oaiy.token:${getOaiyBaseUrl()}`;
}

export function getOaiyToken(): string | null {
  const key = tokenKey();
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem(key);
  } catch {
    /* storage blocked — fall through to memory */
  }
  return memoryStore.get(key) ?? null;
}

export function setOaiyToken(token: string | null): void {
  const key = tokenKey();
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (token) sessionStorage.setItem(key, token);
      else sessionStorage.removeItem(key);
      return;
    }
  } catch {
    /* storage blocked — fall through to memory */
  }
  if (token) memoryStore.set(key, token);
  else memoryStore.delete(key);
}

function authHeaders(): Record<string, string> {
  const t = getOaiyToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ---------------------------------------------------------------------------
// Detection.
//
// Demand-driven and cached, like desktopDetection. A single in-flight probe is
// shared; the result is cached briefly so a burst of connector calls does not
// each re-probe.
// ---------------------------------------------------------------------------

export interface OaiyInfo {
  available: boolean;
  product?: string;
  version?: string;
  deviceId?: string;
  baseUrl: string;
}

let cached: OaiyInfo = { available: false, baseUrl: OAIY_BASE_URL };
let cachedAt = 0;
const CACHE_MS = 4000;
let inflight: Promise<OaiyInfo> | null = null;

function majorOf(protocol: string): string {
  const [name, ver = ''] = protocol.split('/');
  return `${name}/${(ver.split('.')[0] ?? '')}`;
}

/** Probe /api/health, asserting the product identity + protocol major. Never
 *  throws — an unreachable OAIY is simply `{available:false}`. */
export async function probeOaiy(force = false): Promise<OaiyInfo> {
  const now = Date.now();
  if (!force && now - cachedAt < CACHE_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const base = getOaiyBaseUrl();
    let info: OaiyInfo = { available: false, baseUrl: base };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const resp = await fetch(`${base}/api/health`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const body = (await resp.json().catch(() => null)) as OaiyHealth | null;
        // Match the product EXACTLY; accept only a compatible protocol major.
        if (
          body?.product === OAIY_PRODUCT_ID &&
          majorOf(body.protocol ?? '') === OAIY_PROTOCOL_MAJOR
        ) {
          info = {
            available: true,
            product: body.product,
            version: body.version,
            deviceId: body.deviceId,
            baseUrl: base,
          };
        }
      }
    } catch {
      /* unreachable / timeout / CORS → not available */
    }
    cached = info;
    cachedAt = Date.now();
    inflight = null;
    return info;
  })();
  return inflight;
}

/** The last cached detection result, without probing. */
export function getOaiyInfo(): OaiyInfo {
  return cached;
}

/** Clear the cached detection state. Test-only. */
export function __resetOaiyDetectionForTests(): void {
  cached = { available: false, baseUrl: getOaiyBaseUrl() };
  cachedAt = 0;
  inflight = null;
}

/**
 * Should a connector route through OAIY? Detected AND we hold a token.
 *
 * The token gate is deliberate: without one, an OAIY exec call from FormLogic's
 * origin is refused (403), and attempting a route we know will fail — only to
 * fall back — is worse than not attempting it. In dev against a debug OAIY build
 * (which trusts loopback origins) a token is not needed, but production requires
 * it, so gating on it keeps the two honest.
 */
export function oaiyRouteAvailable(): boolean {
  return getOaiyInfo().available && getOaiyToken() !== null;
}

// ---------------------------------------------------------------------------
// Connector forwarding.
// ---------------------------------------------------------------------------

/** Map an OAIY Bridge error code to FormLogic's desktop-error taxonomy, so an
 *  OAIY refusal surfaces to a flow exactly as a FormLogic Desktop one would. */
export function mapOaiyErrorCode(code: string, httpStatus?: number): DesktopErrorCode {
  // A privileged route refused for want of (or with a stale) token is a pairing
  // problem, not a command failure — unless OAIY itself named it a capability
  // denial, which is a real per-command refusal.
  if (httpStatus === 401) return 'auth_required';
  if (httpStatus === 403) return code === 'capability_denied' ? 'capability_denied' : 'auth_required';
  switch (code) {
    case 'capability_denied':
      return 'capability_denied';
    case 'capability_unavailable':
    case 'runtime_unavailable':
    case 'connection_missing':
      return 'connector_unavailable';
    case 'timeout':
    case 'node_failed':
    case 'internal':
    default:
      return 'command_failed';
  }
}

/**
 * Forward one connector command to a plugin under OAIY Desktop.
 *
 * POST /api/bridge/connectors/{id}/request. OAIY's plugin host gates the command
 * against the plugin's manifest BEFORE forwarding, so an undeclared command is
 * refused without ever reaching the plugin. Returns FormLogic's
 * `DesktopClientResult`, so the caller's existing success/transport/error
 * handling applies unchanged.
 */
export async function oaiyConnectorRequest(
  connectorId: string,
  command: string,
  payload?: unknown,
  opts?: { idempotencyKey?: string },
): Promise<DesktopClientResult<unknown>> {
  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    resp = await fetch(
      `${getOaiyBaseUrl()}/api/bridge/connectors/${encodeURIComponent(connectorId)}/request`,
      {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
        body: JSON.stringify({
          command,
          payload,
          idempotencyKey: opts?.idempotencyKey,
        }),
      },
    );
    clearTimeout(timer);
  } catch {
    // Transport failure — OAIY unreachable. Marked so the caller treats it as
    // "absent" rather than a genuine command failure.
    return {
      ok: false,
      transportFailure: true,
      error: { code: 'connector_unavailable', message: 'OAIY Desktop did not respond.' },
    };
  }

  const text = await resp.text().catch(() => '');
  const json = text ? safeParse(text) : undefined;

  if (resp.ok) {
    // OAIY returns { ok: true, result }, where `result` is the plugin's RAW
    // connector.request response — the SDK envelope { ok, data? }. FormLogic
    // flows expect the inner `data` (exactly what FormLogic Desktop's gateway
    // returns, so a flow reading `$nodes.x.paired` works unchanged). OAIY stays
    // generic and passes the plugin's raw result through; this FormLogic-side
    // adapter applies FormLogic's expectation by unwrapping the envelope.
    const result = (json as { result?: unknown })?.result;
    const data = unwrapConnectorEnvelope(result);
    return { ok: true, data };
  }

  const err = (json as { error?: { code?: string; message?: string; detail?: string } })?.error;
  const error: DesktopErrorShape = {
    code: mapOaiyErrorCode(err?.code ?? '', resp.status),
    message: err?.message ?? `OAIY connector request failed (HTTP ${resp.status})`,
  };
  return { ok: false, error };
}

/** Status probe for a connector, mapped onto FormLogic's availability shape. A
 *  connector is "available" via OAIY when the runtime is up and its plugin
 *  advertises the connector as available in capability discovery. */
export async function oaiyConnectorAvailable(connectorId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${getOaiyBaseUrl()}/api/bridge/capabilities`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const body = (await resp.json().catch(() => null)) as
      | { capabilities?: Array<{ id: string; available: boolean }> }
      | null;
    const prefix = `connector.${connectorId}.`;
    return (body?.capabilities ?? []).some((c) => c.id.startsWith(prefix) && c.available);
  } catch {
    return false;
  }
}

/** Unwrap a plugin's `{ ok: true, data }` connector-response envelope to its
 *  inner `data`, matching FormLogic Desktop's gateway. A result that is not that
 *  envelope (a bare value, or a shape without the `ok` marker) passes through. */
export function unwrapConnectorEnvelope(result: unknown): unknown {
  if (
    result &&
    typeof result === 'object' &&
    (result as { ok?: unknown }).ok === true &&
    'data' in (result as object)
  ) {
    return (result as { data?: unknown }).data;
  }
  return result;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
