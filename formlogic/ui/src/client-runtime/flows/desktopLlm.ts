// FormLogic Desktop local-AI routing for llm_chat (docs/FORMLOGIC_FLOWS.md §4).
//
// When a node declares no endpoint, the executor asks the PAIRED FormLogic Desktop for its
// managed local AI services (GET /api/services) and picks the first RUNNING one exposing an
// OpenAI-compatible chat endpoint — mirroring how f2i-web maps companion services into the
// flow palette (companionServices.ts). Services run on their own loopback ports, so the
// resolved endpoint is loopback-only by construction; nodes.ts re-checks isLoopbackUrl()
// before trusting it. No Desktop / not paired / no suitable service → null, and the
// executor falls through to the app's configured AI base.
import { desktopClient, type DesktopServiceSnapshot } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { getDesktopToken } from '../desktop/desktopPairing';
import { oaiyRouteAvailable } from '../oaiy/oaiyRuntime';
import { listOaiyServices } from '../oaiy/oaiyServices';

export interface DesktopLlmEndpoint {
  /** Full OpenAI-compatible chat-completions URL on the local machine. */
  endpoint: string;
  /** Human-readable service name (for diagnostics/toasts). */
  service: string;
}

/**
 * Pick the first running OpenAI-compatible service. An explicit template contract
 * (node.apiFormat === 'openai') wins; otherwise LLM-category services are assumed
 * OpenAI-compatible on /v1/chat/completions — the universal convention for llama.cpp,
 * Ollama, LM Studio, vLLM and TGI (same assumption f2i-web makes).
 */
export function pickDesktopLlmService(services: DesktopServiceSnapshot[]): DesktopLlmEndpoint | null {
  for (const s of services) {
    if (s.status !== 'running') continue;
    const port = s.port || s.defaultPort || 0;
    if (!port) continue;
    const node = s.node ?? null;
    if (node) {
      if (node.apiFormat !== 'openai') continue; // declared contract, but not chat-compatible
      return {
        endpoint: `http://127.0.0.1:${port}${node.endpoint || '/v1/chat/completions'}`,
        service: s.name || s.id,
      };
    }
    if ((s.category ?? '').toLowerCase() !== 'llm') continue;
    return { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, service: s.name || s.id };
  }
  return null;
}

/**
 * Resolve a local AI endpoint from whichever runtime is present, or null when
 * none is / none runs a suitable service. Never throws.
 *
 * OAIY Desktop (the successor) is preferred when paired: it hosts local AI
 * services just like FormLogic Desktop. If OAIY ANSWERS (even with no suitable
 * service) that answer stands — we do NOT silently fall back to a FormLogic
 * Desktop model the user didn't pick; only an UNREACHABLE OAIY (null) falls
 * through to FormLogic Desktop.
 */
export async function resolveDesktopLlmEndpoint(): Promise<DesktopLlmEndpoint | null> {
  if (oaiyRouteAvailable()) {
    const services = await listOaiyServices();
    if (services !== null) return pickDesktopLlmService(services);
    // OAIY vanished mid-call — fall through to FormLogic Desktop.
  }
  if (!getDesktopInfo().available || !getDesktopToken()) return null;
  const res = await desktopClient.services.list();
  if (!res.ok) return null;
  return pickDesktopLlmService(res.data);
}
