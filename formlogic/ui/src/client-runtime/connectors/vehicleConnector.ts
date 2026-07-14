// Mock vehicle connector (spec §44).
//
// Returns realistic cab telemetry with no hardware, so the MineCab demo — and
// any "map connector data to form fields" flow — works entirely in the browser.
// A real connector (local HTTP bridge, Bluetooth, CAN adapter) would implement
// the same BrowserConnector shape and the app would not need to change (§43).
import type { BrowserConnector, ConnectorStatusInfo } from './connectorTypes';

export interface VehicleStatus {
  vehicleId: string;
  fleetNumber: string;
  operatorId: string;
  engineHours: number;
  odometer: number;
  fuelPercent: number;
  faultCodes: string[];
  status: 'ready' | 'warning' | 'fault';
  location: { lat: number; lng: number };
}

const VEHICLE_ID = 'TRUCK-044';
const FLEET_NUMBER = 'F044';
const OPERATOR_ID = 'OP-918';

// A gentle, deterministic-ish jitter so repeated reads feel live without being
// random enough to make the demo confusing.
function currentTelemetry(): VehicleStatus {
  const minutes = Math.floor(Date.now() / 60000);
  const engineHours = 4120.7 + (minutes % 600) / 10; // creeps up over ~10h
  const fuelPercent = 45 + (minutes % 40); // 45–84%
  const lowFuel = fuelPercent < 50;
  return {
    vehicleId: VEHICLE_ID,
    fleetNumber: FLEET_NUMBER,
    operatorId: OPERATOR_ID,
    engineHours: Math.round(engineHours * 10) / 10,
    odometer: 87221 + (minutes % 300),
    fuelPercent,
    faultCodes: lowFuel ? ['P0123'] : [],
    status: lowFuel ? 'warning' : 'ready',
    location: { lat: -20.123, lng: 148.456 },
  };
}

export const mockVehicleConnector: BrowserConnector = {
  id: 'vehicle',
  kind: 'mock_vehicle',
  label: 'Vehicle (demo)',
  commands: [
    'identity.read',
    'status.read',
    'engineHours.read',
    'faults.read',
    'gps.read',
    'production.read',
  ],
  status(): ConnectorStatusInfo {
    return {
      id: 'vehicle',
      kind: 'mock_vehicle',
      available: true,
      source: 'mock',
      label: 'Vehicle (demo)',
      detail: 'Simulated telemetry — no device connected.',
    };
  },
  async request(command: string): Promise<unknown> {
    const t = currentTelemetry();
    switch (command) {
      case 'identity.read':
        return { vehicleId: t.vehicleId, fleetNumber: t.fleetNumber, operatorId: t.operatorId };
      case 'status.read':
        return t;
      case 'engineHours.read':
        return { engineHours: t.engineHours, odometer: t.odometer };
      case 'faults.read':
        return { faultCodes: t.faultCodes, status: t.status };
      case 'gps.read':
        return { location: t.location };
      case 'production.read':
        return { payloadCount: 12, tonnes: 1043.5, cycleCount: 12 };
      default:
        throw new Error(`Unknown vehicle command: ${command}`);
    }
  },
};
