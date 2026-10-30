// OAIY Desktop local-service discovery for the desktop-backed flow nodes.
//
// OAIY Desktop is a local-AI-service host (llama.cpp, Ollama, …) just like
// FormLogic Desktop, and exposes the same `GET /api/services` listing. This maps
// OAIY's ServiceSnapshot onto the SAME shape FormLogic Desktop's
// desktopClient.services.list() returns, so the flow resolvers (desktopLlm.ts,
// desktopService.ts) pick a local LLM / service identically for either runtime —
// the flow node then hits the resolved loopback port directly.
//
// Like the rest of the OAIY seam this never throws: an unreachable OAIY resolves
// to null, which the resolvers treat as "OAIY vanished — try FormLogic Desktop".
import type { DesktopServiceSnapshot } from '../desktop/desktopClient';
import { getOaiyBaseUrl, getOaiyToken, oaiyLifecycleAction, type OaiyPluginActionResult } from './oaiyRuntime';

const FETCH_TIMEOUT_MS = 10_000;
/** A repair can reinstall a service while OAIY holds the request open. */
const REPAIR_TIMEOUT_MS = 120_000;

/** OAIY's `/api/services` item — a superset of the fields the resolvers read. */
interface OaiyServiceItem {
  id: string;
  name: string;
  category?: string;
  status: string;
  port: number;
  defaultPort?: number;
  docsUrl?: string | null;
}

/**
 * List OAIY Desktop's managed local services, mapped to the FormLogic Desktop
 * service shape. Returns null when OAIY is unreachable (so a caller can fall back
 * to FormLogic Desktop); an empty array means OAIY answered but runs no services.
 *
 * OAIY has no per-service `node` contract (that is a FormLogic Desktop template
 * field), so `node` is null and the LLM picker falls back to its category='llm'
 * convention — the universal OpenAI-compatible assumption.
 */
export async function listOaiyServices(): Promise<DesktopServiceSnapshot[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const token = getOaiyToken();
    const resp = await fetch(`${getOaiyBaseUrl()}/api/services`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as { services?: OaiyServiceItem[] } | null;
    if (!Array.isArray(body?.services)) return null;
    return body.services.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      status: s.status,
      port: s.port,
      defaultPort: s.defaultPort,
      docsUrl: s.docsUrl ?? null,
      node: null,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start, stop, restart or repair a service OAIY Desktop runs. Restart is a stop
 * and a start: OAIY has no route for it, and its own relay does the same.
 */
export async function oaiyServiceAction(id: string, action: 'start' | 'stop' | 'restart' | 'repair'): Promise<OaiyPluginActionResult> {
  const route = (verb: string) => `/api/services/${encodeURIComponent(id)}/${verb}`;
  if (action === 'repair') return oaiyLifecycleAction(route('repair'), 'service repair', REPAIR_TIMEOUT_MS);
  if (action === 'restart') {
    await oaiyLifecycleAction(route('stop'), 'service stop');
    return oaiyLifecycleAction(route('start'), 'service start');
  }
  return oaiyLifecycleAction(route(action), `service ${action}`);
}
