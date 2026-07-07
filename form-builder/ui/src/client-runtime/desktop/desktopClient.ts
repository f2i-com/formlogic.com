// FormLogic Desktop typed HTTP client (docs/FORMLOGIC_DESKTOP.md §2/§3).
//
// A thin fetch wrapper over the token-gated desktop API. Every call resolves a
// DesktopClientResult — it NEVER throws:
//   - network failure / timeout / non-JSON  → {ok:false, error:{code:'connector_unavailable'},
//     transportFailure:true} (the client-synthesised flavour — Desktop unreachable, safe
//     for a caller to treat as "absent");
//   - HTTP 401                              → {ok:false, error:{code:'auth_required'}} and the
//     stored pairing token is dropped (contract: auth_required is desktop-transport-only and
//     is handled HERE, before the connector layer — it never surfaces as a ConnectorError);
//   - a desktop-returned error envelope     → passed through verbatim ({ok:false, error:{code,…}}).
import {
  getDesktopBaseUrl,
  type DesktopClientResult,
  type DesktopConnectorRequestBody,
  type DesktopConnectorStatus,
  type DesktopConnectorSummary,
  type DesktopErrorShape,
  type DesktopPluginSummary,
  type DesktopTrustedOrigin,
} from './desktopTypes';
import { clearDesktopToken, desktopAuthHeaders } from './desktopPairing';

const FETCH_TIMEOUT_MS = 10_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

function isErrorShape(value: unknown): value is DesktopErrorShape {
  const v = value as { code?: unknown; message?: unknown } | null;
  return !!v && typeof v === 'object' && typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * One token-authenticated desktop call. Resolves the parsed JSON body as `data` on
 * success; all failure modes collapse to the typed error envelope described above.
 */
async function desktopFetch<T>(path: string, init: RequestInit = {}): Promise<DesktopClientResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${getDesktopBaseUrl()}${path}`, {
      credentials: 'omit',
      cache: 'no-store',
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...desktopAuthHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'connector_unavailable',
        message: e instanceof Error ? e.message : 'FormLogic Desktop is not reachable.',
      },
      transportFailure: true,
    };
  }

  const body = (await res.json().catch(() => null)) as unknown;

  if (res.status === 401) {
    // Missing/expired pairing token. Drop it so the UI flips to "not paired" and offers
    // to re-pair; per contract this code never reaches the connector layer.
    clearDesktopToken();
    const err = (body as { error?: unknown } | null)?.error;
    return {
      ok: false,
      error: isErrorShape(err) ? err : { code: 'auth_required', message: 'Pairing with FormLogic Desktop is required.' },
    };
  }

  // A desktop-returned typed error envelope ({ok:false, error:{code,message}}) wins at any status.
  const asEnvelope = body as { ok?: unknown; error?: unknown } | null;
  if (asEnvelope && asEnvelope.ok === false && isErrorShape(asEnvelope.error)) {
    return { ok: false, error: asEnvelope.error };
  }

  if (!res.ok || body === null) {
    return {
      ok: false,
      error: { code: 'command_failed', message: `FormLogic Desktop responded ${res.status}.` },
      ...(body === null && res.ok ? { transportFailure: true as const } : {}),
    };
  }

  return { ok: true, data: body as T };
}

/** Accept both `[...]` and `{key:[...]}` list shapes (the contract doesn't pin the wrapper). */
function unwrapList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const wrapped = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

function mapList<T>(res: DesktopClientResult<unknown>, key: string): DesktopClientResult<T[]> {
  if (!res.ok) return res;
  return { ok: true, data: unwrapList<T>(res.data, key) };
}

export interface DesktopInstanceInfo {
  name?: string;
  version?: string;
  platform?: string;
  apiVersion?: number;
  pluginApiVersion?: number;
  /** Stable id of this Desktop install, when the build provides one. */
  instanceId?: string;
}

/** A template-declared call contract for a Desktop-managed service (ServiceSnapshot.node). */
export interface DesktopServiceNodeSpec {
  endpoint?: string | null;
  method?: string | null;
  bodyTemplate?: string | null;
  responsePath?: string | null;
  /** 'openai' = OpenAI-compatible chat endpoint (llama.cpp, Ollama, LM Studio, vLLM, TGI). */
  apiFormat?: string | null;
  icon?: string | null;
}

/** Subset of Desktop's ServiceSnapshot (GET /api/services → RegistrySnapshot.services). */
export interface DesktopServiceSnapshot {
  id: string;
  name: string;
  description?: string;
  category?: string;
  status: string;
  port: number;
  defaultPort?: number;
  docsUrl?: string | null;
  /** How to call this service as a node, declared by its template (optional). */
  node?: DesktopServiceNodeSpec | null;
}

export const desktopClient = {
  /** GET /api/desktop/info — name, versions, platform (origin-gated). */
  info(): Promise<DesktopClientResult<DesktopInstanceInfo>> {
    return desktopFetch<DesktopInstanceInfo>('/api/desktop/info');
  },

  plugins: {
    list(): Promise<DesktopClientResult<DesktopPluginSummary[]>> {
      return desktopFetch<unknown>('/api/plugins').then((r) => mapList<DesktopPluginSummary>(r, 'plugins'));
    },
    get(id: string): Promise<DesktopClientResult<DesktopPluginSummary>> {
      return desktopFetch<DesktopPluginSummary>(`/api/plugins/${encodeURIComponent(id)}`);
    },
    start(id: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/start`, { method: 'POST' });
    },
    stop(id: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    },
    logs(id: string, tail = 100): Promise<DesktopClientResult<string[]>> {
      return desktopFetch<unknown>(`/api/plugins/${encodeURIComponent(id)}/logs?tail=${tail}`).then((r) =>
        mapList<string>(r, 'logs')
      );
    },
  },

  services: {
    /** GET /api/services — local AI/tool services managed by Desktop ({services:[...], dataDir}). */
    list(): Promise<DesktopClientResult<DesktopServiceSnapshot[]>> {
      return desktopFetch<unknown>('/api/services').then((r) => mapList<DesktopServiceSnapshot>(r, 'services'));
    },
  },

  connectors: {
    list(): Promise<DesktopClientResult<DesktopConnectorSummary[]>> {
      return desktopFetch<unknown>('/api/connectors').then((r) => mapList<DesktopConnectorSummary>(r, 'connectors'));
    },
    status(connectorId: string): Promise<DesktopClientResult<DesktopConnectorStatus>> {
      return desktopFetch<DesktopConnectorStatus>(`/api/connectors/${encodeURIComponent(connectorId)}/status`);
    },
    /**
     * POST /api/connectors/{id}/request — THE gateway FormLogic Web uses. Body/response
     * per connector-request/response.schema.json. Resolves the command's `data` payload
     * on success; the typed error envelope otherwise (never throws).
     */
    async request(
      connectorId: string,
      command: string,
      payload?: unknown,
      opts?: { timeoutMs?: number; requestId?: string }
    ): Promise<DesktopClientResult<unknown>> {
      const body: DesktopConnectorRequestBody = { connectorId, command };
      if (payload !== undefined) body.payload = payload;
      if (opts?.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs;
      if (opts?.requestId !== undefined) body.requestId = opts.requestId;
      const res = await desktopFetch<{ ok: true; data?: unknown; requestId?: string }>(
        `/api/connectors/${encodeURIComponent(connectorId)}/request`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!res.ok) return res;
      // Unwrap the connector-response success envelope to the command's data payload.
      return { ok: true, data: res.data?.data, requestId: res.data?.requestId };
    },
  },

  origins: {
    list(): Promise<DesktopClientResult<DesktopTrustedOrigin[]>> {
      return desktopFetch<unknown>('/api/origins').then((r) => mapList<DesktopTrustedOrigin>(r, 'origins'));
    },
    revoke(origin: string): Promise<DesktopClientResult<unknown>> {
      return desktopFetch<unknown>(`/api/origins/${encodeURIComponent(origin)}`, { method: 'DELETE' });
    },
  },
};
