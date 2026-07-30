// FormLogic Desktop local-service routing for the desktop-service nodes (docs/FORMLOGIC_FLOWS.md §4).
//
// browser_action → the 'playwright-browser' service; image_gen → the 'krea2' service. When a node
// declares no explicit endpoint, the executor asks the PAIRED FormLogic Desktop for its managed
// services (GET /api/services) and returns the loopback base URL of the RUNNING service with that
// id — mirroring how llm_chat resolves a local AI service (desktopLlm.ts). Services run on their
// own loopback ports, so the resolved base is loopback-only by construction; nodes.ts re-checks
// isLoopbackUrl() before trusting it. No Desktop / not paired / service not running → null, and the
// node fails with an actionable "install & start the service in FormLogic Desktop" message.
import { desktopClient, type DesktopAiSource, type DesktopServiceSnapshot } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { getDesktopToken } from '../desktop/desktopPairing';
import { oaiyRouteAvailable } from '../oaiy/oaiyRuntime';
import { listOaiyServices } from '../oaiy/oaiyServices';
import { listOaiySources } from '../oaiy/oaiyAi';

/** Loopback base of a RUNNING service by id, from a service listing. Shared by
 *  the OAIY and FormLogic Desktop paths so both resolve a base identically. */
function pickServiceBase(services: DesktopServiceSnapshot[], serviceId: string): string | null {
  for (const s of services) {
    if (s.id !== serviceId) continue;
    if (s.status !== 'running') return null; // present but stopped — the caller surfaces "start it"
    const port = s.port || s.defaultPort || 0;
    if (!port) return null;
    return `http://127.0.0.1:${port}`;
  }
  return null;
}

/**
 * Resolve the loopback base URL (`http://127.0.0.1:<port>`) of a RUNNING local
 * service by its id, or null when no runtime is present / the service isn't
 * running. Never throws.
 *
 * OAIY Desktop (the successor) is preferred when paired; only an UNREACHABLE OAIY
 * falls through to FormLogic Desktop (an OAIY that answers but lacks the service
 * is an honest "start it there", not a reason to reach a different runtime).
 */
export async function resolveDesktopServiceBase(serviceId: string): Promise<string | null> {
  if (oaiyRouteAvailable()) {
    const services = await listOaiyServices();
    if (services !== null) return pickServiceBase(services, serviceId);
  }
  if (!getDesktopInfo().available || !getDesktopToken()) return null;
  const res = await desktopClient.services.list();
  if (!res.ok) return null;
  return pickServiceBase(res.data, serviceId);
}

/** One Desktop service, shaped for flow logic (the `desktop_services` node). */
export interface DesktopServiceListing {
  id: string;
  name: string;
  category: string;
  status: string;
  port: number;
  /** Loopback base URL when RUNNING (`http://127.0.0.1:<port>`), '' otherwise —
   *  so a logic block can compose endpoints only against live services. */
  url: string;
}

/** Map a service listing to the flow-logic shape. Shared by both runtimes. */
function toServiceListings(services: DesktopServiceSnapshot[]): DesktopServiceListing[] {
  return services.map((s) => {
    const port = s.port || s.defaultPort || 0;
    return {
      id: s.id,
      name: s.name,
      category: s.category ?? '',
      status: s.status,
      port,
      url: s.status === 'running' && port ? `http://127.0.0.1:${port}` : '',
    };
  });
}

/**
 * List the local runtime's managed services for flow logic (the
 * `desktop_services` node — source pickers resolve `service:<id>` records to
 * live loopback URLs at CONFIGURE time through this). OAIY Desktop is preferred
 * when paired; no runtime / unreachable → [] (the flow falls back to its legacy
 * fields). Never throws.
 */
export async function listDesktopServices(): Promise<DesktopServiceListing[]> {
  if (oaiyRouteAvailable()) {
    const services = await listOaiyServices();
    if (services !== null) return toServiceListings(services);
  }
  if (!getDesktopInfo().available || !getDesktopToken()) return [];
  const res = await desktopClient.services.list();
  if (!res.ok) return [];
  return toServiceListings(res.data);
}

/**
 * One entry of the desktop's `/api/ai/sources` union (SRC-202), normalised for
 * lane pickers: local service instances AND configured AI providers.
 */
export interface AiSourceListing {
  /** The lane-picker value: `service:<id>` or `provider:<id>`. */
  id: string;
  kind: 'service' | 'provider';
  /** The bare service/provider id (what follows the prefix in `id`). */
  refId: string;
  name: string;
  category: string;
  /** Service run state ('running'/'stopped'/…); the literal 'provider' for providers. */
  status: string;
  /** Capability tags ('chat' | 'transcription' | 'speech' | 'image'); an EMPTY
   *  set on a PROVIDER means unrestricted ("all") — legacy profiles. */
  capabilities: string[];
  /** Intended selector surfaces. Older Desktop builds omit this field. */
  useCases?: string[];
  /** Loopback base URL while a service is RUNNING (`http://127.0.0.1:<port>`), '' otherwise. */
  url: string;
  model: string;
  /** Providers can be disabled without deletion; services are always true. */
  enabled: boolean;
}

/** A well-formed DesktopAiSource (has a string id). */
function isValidAiSource(s: DesktopAiSource): s is DesktopAiSource {
  return !!s && typeof s.id === 'string';
}

/** Map a desktop AI-gateway source (from OAIY or FormLogic Desktop — the SAME
 *  `/api/ai/sources` shape) to a lane-picker listing. */
function mapDesktopAiSource(s: DesktopAiSource): AiSourceListing {
  const kind: 'service' | 'provider' = s.kind === 'provider' ? 'provider' : 'service';
  const refId = (kind === 'service' ? s.serviceId : s.providerId) ?? s.id.replace(/^(service|provider):/, '');
  const port = s.port ?? 0;
  return {
    id: s.id,
    kind,
    refId,
    name: typeof s.name === 'string' && s.name ? s.name : refId,
    category: s.category ?? '',
    status: kind === 'provider' ? 'provider' : (s.status ?? ''),
    capabilities: Array.isArray(s.capabilities) ? s.capabilities.filter((c) => typeof c === 'string') : [],
    ...(Array.isArray(s.useCases)
      ? { useCases: s.useCases.filter((useCase) => typeof useCase === 'string') }
      : {}),
    // Same running-only rule as listDesktopServices — a stopped service must
    // never hand a picker a dead URL.
    url: kind === 'service' && s.status === 'running' && port ? `http://127.0.0.1:${port}` : '',
    model: typeof s.model === 'string' ? s.model : '',
    enabled: kind === 'provider' ? s.enabled !== false : true,
  };
}

/**
 * List everything a receptionist lane picker can point at — the union the local
 * runtime's AI gateway serves (GET /api/ai/sources): managed services with
 * capability tags + configured AI providers. OAIY Desktop is preferred when
 * paired (its gateway now serves the same union, including credential-hidden
 * providers); FormLogic Desktop is the fallback. No runtime / unreachable /
 * pre-SRC-202 build → [] (callers degrade to listDesktopServices or saved ids).
 * Never throws.
 */
export async function listAiSources(): Promise<AiSourceListing[]> {
  if (oaiyRouteAvailable()) {
    const sources = await listOaiySources();
    if (sources !== null) return sources.filter(isValidAiSource).map(mapDesktopAiSource);
    // OAIY unreachable — fall through to FormLogic Desktop.
  }
  if (!getDesktopInfo().available || !getDesktopToken()) return [];
  const res = await desktopClient.ai.sources();
  if (!res.ok) return [];
  return res.data.filter(isValidAiSource).map(mapDesktopAiSource);
}
