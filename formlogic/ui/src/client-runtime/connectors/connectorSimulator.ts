// Explicit connector simulator sessions (audit FL-CONN-001), connector-generic.
//
// A connector's demo driver may answer ONLY inside a deliberate simulator
// session: the shared Demo account, an explicit "Simulate …" ceremony (which
// starts a session), or a per-connector dev flag. A simulator is NEVER a
// fallback: with no session, an absent/unpaired Desktop is a typed
// connector_unavailable — faking success for a command that never reached real
// hardware is worse than failing. Every simulated result/event is provenance-
// stamped `simulated: true` so a record written from it can never masquerade
// as a real interaction.
import { api } from '../../lib/api';
import type { DesktopEventEnvelope } from '../desktop/desktopTypes';

// Page-lifetime opt-ins, per connector id.
const sessions = new Set<string>();

/** Start a deliberate simulator session for one connector (page-lifetime). */
export function enableSimulator(connectorId: string): void {
  sessions.add(connectorId);
}

/** True only inside a deliberate simulator session — the ONLY state where a demo driver answers. */
export function isSimulatorActive(connectorId: string): boolean {
  if (sessions.has(connectorId)) return true;
  if (api.isDemoMode()) return true;
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(`formlogic.connectorSimulator.${connectorId}`) === '1'
    );
  } catch {
    return false;
  }
}

/** Test-only. */
export function __resetSimulatorSessionsForTests(): void {
  sessions.clear();
}

/** Provenance stamp for a simulator RESULT (audit FL-CONN-001). Object results are
 *  stamped in place; a non-object result (a driver returning an array/primitive) is
 *  returned unchanged — results are screen-display data, not a record-provenance surface
 *  (event data, which IS, is stamped totally by stampEventData). */
export function markSimulated(data: unknown): unknown {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), simulated: true }
    : data;
}

/** Provenance for simulated EVENT data — TOTAL: a plain object is stamped in place,
 *  anything else (array/primitive/null) is wrapped as `{ value, simulated: true }` so
 *  a driver can never emit event data without the flag (records written from a
 *  simulated event can never masquerade as real). */
function stampEventData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), simulated: true }
    : { value: data ?? null, simulated: true };
}

/**
 * A local desktop-event envelope for a simulated connector event. Provenance is forced
 * HERE by the trusted host — a driver script cannot omit `simulated: true`, and the
 * idempotencyKey is namespaced `sim:` so a fabricated key can NEVER collide with (and
 * thereby suppress, via the hub's key dedupe) a real plugin event of the same name.
 */
export function simulatedEnvelope(
  connectorId: string,
  name: string,
  correlationId: string,
  idempotencyKey: string,
  data: unknown
): DesktopEventEnvelope {
  return {
    schemaVersion: 1,
    source: connectorId,
    name,
    correlationId,
    idempotencyKey: `sim:${idempotencyKey}`,
    occurredAt: new Date().toISOString(),
    data: stampEventData(data),
    pluginId: connectorId,
    connectorId,
  };
}
