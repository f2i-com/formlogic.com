// FormLogic Desktop local-service routing for the desktop-service nodes (docs/FORMLOGIC_FLOWS.md §4).
//
// browser_action → the 'playwright-browser' service; image_gen → the 'krea2' service. When a node
// declares no explicit endpoint, the executor asks the PAIRED FormLogic Desktop for its managed
// services (GET /api/services) and returns the loopback base URL of the RUNNING service with that
// id — mirroring how llm_chat resolves a local AI service (desktopLlm.ts). Services run on their
// own loopback ports, so the resolved base is loopback-only by construction; nodes.ts re-checks
// isLoopbackUrl() before trusting it. No Desktop / not paired / service not running → null, and the
// node fails with an actionable "install & start the service in FormLogic Desktop" message.
import { desktopClient } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { getDesktopToken } from '../desktop/desktopPairing';

/**
 * Resolve the loopback base URL (`http://127.0.0.1:<port>`) of a RUNNING FormLogic Desktop
 * service by its id, or null when Desktop is undetected, unpaired, unreachable, or the service
 * isn't running. Never throws.
 */
export async function resolveDesktopServiceBase(serviceId: string): Promise<string | null> {
  if (!getDesktopInfo().available || !getDesktopToken()) return null;
  const res = await desktopClient.services.list();
  if (!res.ok) return null;
  for (const s of res.data) {
    if (s.id !== serviceId) continue;
    if (s.status !== 'running') return null; // present but stopped — the caller surfaces "start it"
    const port = s.port || s.defaultPort || 0;
    if (!port) return null;
    return `http://127.0.0.1:${port}`;
  }
  return null;
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

/**
 * List the paired Desktop's managed services for flow logic (the
 * `desktop_services` node — source pickers resolve `service:<id>` records to
 * live loopback URLs at CONFIGURE time through this). Desktop undetected /
 * unpaired / unreachable → [] (the flow falls back to its legacy fields).
 * Never throws.
 */
export async function listDesktopServices(): Promise<DesktopServiceListing[]> {
  if (!getDesktopInfo().available || !getDesktopToken()) return [];
  const res = await desktopClient.services.list();
  if (!res.ok) return [];
  return res.data.map((s) => {
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
