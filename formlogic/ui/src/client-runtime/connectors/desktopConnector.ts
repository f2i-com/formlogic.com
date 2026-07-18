// Generic desktop-backed connector factory.
//
// A pack-declared connector whose hardware lives in a FormLogic Desktop plugin
// (connector id X) is reached through Desktop's gateway
// POST /api/connectors/X/request. This factory composes ONE BrowserConnector
// from two layers:
//
//   1. desktop-backed — when Desktop is detected AND paired, every request
//      routes through desktopClient.connectors.request(id, …). Real desktop
//      errors (capability_denied, command_failed, a genuine
//      connector_unavailable from the gateway) surface as typed
//      ConnectorErrors and are NEVER masked with demo data (the same
//      FALLBACKABLE_CODES policy as the native bridge, spec §41).
//   2. explicit simulator (audit FL-CONN-001) — the pack's demo driver answers
//      ONLY inside a deliberate simulator session (connectorSimulator.ts). It
//      is NEVER a fallback: with no session, an absent/unpaired Desktop is a
//      typed connector_unavailable — and once a REAL desktop route was
//      attempted, NOTHING falls back to the demo (faking success for a
//      mutation that never reached the hardware is worse than failing).
//
// The composed connector registers in BROWSER_CONNECTORS, so the existing
// routing (native bridge → browser connector) and the connector.<id>.<command>
// permission model apply unchanged.
import type { BrowserConnector, ConnectorStatusInfo } from './connectorTypes';
import { ConnectorError, type ConnectorErrorCode } from './connectorTypes';
import type { ConnectorDriverManifest } from '../../types/customAppLogic';
import { api } from '../../lib/api';
import { desktopClient } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { isDesktopPaired } from '../desktop/desktopPairing';
import { isSimulatorActive } from './connectorSimulator';
import { generateId } from '../../lib/utils';

/** The demo half a pack driver supplies (see packConnectorDriver.ts). */
export interface DemoConnectorFacade {
  status(): ConnectorStatusInfo;
  request(command: string, payload?: unknown): Promise<unknown>;
}

/**
 * One plugin-safe request id for one browser-side operator action. Minted only
 * for the manifest's journalled (durably-side-effecting) commands — the
 * desktop client's capability-refresh retry then reuses this exact body/id
 * rather than performing the physical action twice.
 */
export function createJournalledRequestId(
  manifest: Pick<ConnectorDriverManifest, 'journalledCommands'>,
  command: string
): string | undefined {
  if (!manifest.journalledCommands?.includes(command)) return undefined;
  return `ui-${command}-${generateId()}`;
}

/**
 * Desktop is a candidate route only when detected AND this origin holds a pairing token —
 * and NEVER for the shared Demo account. A demo session on a machine that happens to run
 * a paired FormLogic Desktop (the operator's own box, or any visitor who also uses the
 * real product) must not detect, display, or DRIVE the actual hardware bridge: the local
 * gateway bypasses the server's demo_readonly guard entirely (live report 2026-07-14 —
 * the demo's Device Setup showed the real dongle). In demo mode the simulator IS the
 * bridge, full stop.
 */
export function desktopRouteAvailable(): boolean {
  if (api.isDemoMode()) return false;
  return getDesktopInfo().available && isDesktopPaired();
}

/**
 * Compose the desktop-first BrowserConnector for a pack-declared connector.
 * `demo` is the pack driver's simulator façade (null = no demo driver: the
 * connector answers only against real hardware).
 */
export function createDesktopBackedConnector(
  manifest: ConnectorDriverManifest,
  demo: DemoConnectorFacade | null
): BrowserConnector {
  const id = manifest.connectorId;
  return {
    id,
    kind: manifest.kind,
    label: manifest.label,
    commands: [...manifest.commands],

    async status(): Promise<ConnectorStatusInfo> {
      if (!desktopRouteAvailable()) {
        if (demo && isSimulatorActive(id)) return demo.status();
        return {
          id,
          kind: manifest.kind,
          available: false,
          source: 'mock',
          label: manifest.label,
          detail: `FormLogic Desktop is not connected — connect and pair it to use ${manifest.label}.`,
        };
      }
      const res = await desktopClient.connectors.status(id);
      if (res.ok) {
        const s = res.data;
        return {
          id,
          kind: manifest.kind,
          available: s?.available === true,
          // Desktop is a loopback HTTP bridge — surfaced like the local_http source class.
          source: 'local_http',
          label: `${manifest.label} (FormLogic Desktop)`,
          detail: s?.detail ?? 'Served by FormLogic Desktop.',
        };
      }
      // FL-CONN-001: a desktop that WAS routable and now fails is reported unavailable —
      // never re-painted with the simulator's healthy-looking status.
      return {
        id,
        kind: manifest.kind,
        available: false,
        source: 'local_http',
        label: `${manifest.label} (FormLogic Desktop)`,
        detail: res.error.message,
      };
    },

    async request(command: string, payload?: unknown): Promise<unknown> {
      if (!desktopRouteAvailable()) {
        // FL-CONN-001: the simulator answers ONLY inside an explicit session. Otherwise an
        // absent/unpaired Desktop is a typed failure — a command with physical side effects
        // must never pretend to succeed against hardware that isn't there.
        if (demo && isSimulatorActive(id)) {
          return demo.request(command, payload);
        }
        throw new ConnectorError(
          'connector_unavailable',
          `FormLogic Desktop is not connected — "${command}" was not performed. Connect and pair FormLogic Desktop to use ${manifest.label}.`
        );
      }

      // The plugin durably journals physical actions. Mint the id once for this
      // operator action and pass it into desktopClient; its capability-refresh
      // retry reuses this exact body/id rather than performing the action twice.
      const requestId = createJournalledRequestId(manifest, command);
      const res = await desktopClient.connectors.request(
        id,
        command,
        payload,
        requestId ? { requestId } : undefined
      );
      if (res.ok) return res.data;

      // FL-CONN-001: once a REAL desktop route was attempted, NOTHING falls back to the
      // simulator — not on transport failure, not on auth_required, not on the old
      // "fallbackable" absent-ish codes. Faking success for a mutation that never
      // reached the hardware is strictly worse than a typed, actionable failure.
      if (res.transportFailure) {
        throw new ConnectorError(
          'connector_unavailable',
          `FormLogic Desktop did not respond — "${command}" was not performed. ${res.error?.message ?? ''}`.trim()
        );
      }
      throw new ConnectorError(res.error.code as ConnectorErrorCode, res.error.message);
    },
  };
}
