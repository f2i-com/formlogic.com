// Local HTTP connector (spec §45).
//
// Reads vehicle telemetry from a local bridge (e.g. a Wi-Fi/USB gateway serving
// http://127.0.0.1:39291/status) and maps it to the SAME abstract commands as the
// mock connector — so an app can move from mock → local bridge without changing.
// Gracefully reports "unavailable" when no bridge is reachable.
import type { BrowserConnector, ConnectorStatusInfo } from './connectorTypes';
import type { VehicleStatus } from './vehicleConnector';

const DEFAULT_URL = 'http://127.0.0.1:39291';

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

export function createLocalHttpConnector(baseUrl: string = DEFAULT_URL): BrowserConnector {
  const url = baseUrl.replace(/\/+$/, '');

  async function read(): Promise<VehicleStatus | null> {
    try {
      const res = await fetch(`${url}/status`, { signal: timeoutSignal(3000), credentials: 'omit' });
      if (!res.ok) return null;
      return (await res.json()) as VehicleStatus;
    } catch {
      return null;
    }
  }

  return {
    id: 'local_http',
    kind: 'local_http',
    label: 'Vehicle (local bridge)',
    commands: ['identity.read', 'status.read', 'engineHours.read', 'faults.read', 'gps.read', 'production.read'],
    async status(): Promise<ConnectorStatusInfo> {
      const t = await read();
      return {
        id: 'local_http',
        kind: 'local_http',
        available: !!t,
        source: 'local_http',
        label: 'Vehicle (local bridge)',
        detail: t ? `Connected to ${url}` : `No bridge reachable at ${url}`,
      };
    },
    async request(command: string): Promise<unknown> {
      const t = await read();
      if (!t) throw new Error(`No local bridge at ${url}`);
      switch (command) {
        case 'identity.read':
          return { vehicleId: t.vehicleId, fleetNumber: t.fleetNumber, operatorId: t.operatorId };
        case 'status.read':
          return t;
        case 'engineHours.read':
          return { engineHours: t.engineHours, odometer: t.odometer };
        case 'faults.read':
          return { faultCodes: t.faultCodes ?? [], status: t.status };
        case 'gps.read':
          return { location: t.location };
        case 'production.read':
          return { payloadCount: null, tonnes: null, cycleCount: null };
        default:
          throw new Error(`Unknown vehicle command: ${command}`);
      }
    },
  };
}
