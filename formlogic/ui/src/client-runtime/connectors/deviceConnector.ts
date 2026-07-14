// Device connector — the phone's own abilities as an abstract connector (spec §41).
//
// Implemented entirely with the WebView's standard Web APIs (geolocation, Battery,
// Network Information, device orientation/motion, clipboard, wake lock, vibration,
// user-agent client hints, Intl), so the SAME connector works in a plain browser, the
// installed PWA, AND the FormLogic Native Runtime — with NO native plugin or Rust code.
//
// Capabilities are feature-detected at runtime: `commands` and `status().detail` reflect
// what the current device/WebView actually exposes, so scripts and screens can branch.
// A loaded app requests device data the same way it requests any connector:
//   connector.request({ connectorId: 'device', command: 'gps.read' })
// gated by the permission `connector.device.gps.read` (see appLogicPermissions).
import type { BrowserConnector, ConnectorStatusInfo } from './connectorTypes';

// --- non-standard navigator/window surface (typed minimally so we stay strict) ---
interface UAData {
  platform?: string;
  getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
}
interface NetInfo {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  type?: string;
  saveData?: boolean;
}
interface BatteryLike {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}
interface WakeSentinel {
  release(): Promise<void>;
}
interface NavExtras {
  userAgentData?: UAData;
  connection?: NetInfo;
  deviceMemory?: number;
  getBattery?: () => Promise<BatteryLike>;
  wakeLock?: { request(type: 'screen'): Promise<WakeSentinel> };
  vibrate?: (pattern: number | number[]) => boolean;
}

function nav(): (Navigator & NavExtras) | undefined {
  return typeof navigator !== 'undefined' ? (navigator as Navigator & NavExtras) : undefined;
}
function win(): (Window & typeof globalThis) | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

/** Deterministic synthetic values so the connector is testable when a stock emulator
 *  WebView returns nothing. Enable with ?flDeviceMock or localStorage fl.device.mock=1. */
const MOCK: boolean = (() => {
  const w = win();
  if (!w) return false;
  try {
    if (new URLSearchParams(w.location.search).has('flDeviceMock')) return true;
    return w.localStorage.getItem('fl.device.mock') === '1';
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------
function detectCommands(): string[] {
  const n = nav();
  const w = win();
  const cmds = ['info.read', 'locale.read', 'screen.read', 'network.read'];
  if (n?.getBattery) cmds.push('battery.read');
  if (w && 'ondeviceorientation' in w) cmds.push('orientation.read');
  if (w && 'ondevicemotion' in w) cmds.push('motion.read');
  if (n && 'geolocation' in n) cmds.push('gps.read');
  if (n?.clipboard?.writeText) cmds.push('clipboard.write');
  if (n?.wakeLock) cmds.push('wakeLock.acquire', 'wakeLock.release');
  if (n?.vibrate) cmds.push('vibrate');
  return cmds;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------
async function readInfo() {
  const n = nav();
  let platform = (n as unknown as { platform?: string })?.platform || 'unknown';
  let model = '';
  let osVersion = '';
  const ua = n?.userAgentData;
  if (ua) {
    try {
      const hi = await ua.getHighEntropyValues(['platform', 'platformVersion', 'model']);
      platform = String(hi.platform ?? platform);
      osVersion = String(hi.platformVersion ?? '');
      model = String(hi.model ?? '');
    } catch {
      /* keep fallbacks */
    }
  }
  return {
    platform,
    model,
    osVersion,
    hardwareConcurrency: n?.hardwareConcurrency ?? null,
    deviceMemory: n?.deviceMemory ?? null,
    maxTouchPoints: n?.maxTouchPoints ?? 0,
    userAgent: n?.userAgent ?? '',
  };
}

function readLocale() {
  const n = nav();
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: n?.language ?? 'en',
    languages: n?.languages ? Array.from(n.languages) : [n?.language ?? 'en'],
  };
}

function readScreen() {
  const w = win();
  return {
    width: w?.screen.width ?? 0,
    height: w?.screen.height ?? 0,
    orientation: w?.screen.orientation?.type ?? 'unknown',
    pixelRatio: w?.devicePixelRatio ?? 1,
    colorScheme: w?.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  };
}

async function readBattery() {
  const n = nav();
  if (!n?.getBattery) throw new Error('Battery API not available on this device');
  const b = await n.getBattery();
  return {
    level: b.level,
    charging: b.charging,
    chargingTime: b.chargingTime,
    dischargingTime: b.dischargingTime,
  };
}

function readNetwork() {
  const n = nav();
  const c = n?.connection;
  return {
    online: n?.onLine ?? true,
    effectiveType: c?.effectiveType ?? null,
    downlink: c?.downlink ?? null,
    rtt: c?.rtt ?? null,
    type: c?.type ?? null,
    saveData: c?.saveData ?? null,
  };
}

/** Resolve with the first matching event, or reject after `ms` (static device / no sensor). */
function once<T>(event: string, map: (e: Event) => T, ms = 1500): Promise<T> {
  const w = win();
  return new Promise<T>((resolve, reject) => {
    if (!w) return reject(new Error('no window'));
    const handler = (e: Event) => {
      clearTimeout(timer);
      w.removeEventListener(event, handler);
      resolve(map(e));
    };
    const timer = setTimeout(() => {
      w.removeEventListener(event, handler);
      reject(new Error(`no ${event} within ${ms}ms (sensor may be idle)`));
    }, ms);
    w.addEventListener(event, handler);
  });
}

function readOrientation() {
  return once('deviceorientation', (e) => {
    const ev = e as DeviceOrientationEvent;
    return { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma };
  });
}

function readMotion() {
  return once('devicemotion', (e) => {
    const ev = e as DeviceMotionEvent;
    const xyz = (v: DeviceMotionEventAcceleration | null) => (v ? { x: v.x, y: v.y, z: v.z } : null);
    return {
      acceleration: xyz(ev.acceleration),
      accelerationIncludingGravity: xyz(ev.accelerationIncludingGravity),
      rotationRate: ev.rotationRate
        ? { alpha: ev.rotationRate.alpha, beta: ev.rotationRate.beta, gamma: ev.rotationRate.gamma }
        : null,
    };
  });
}

function readGps() {
  const n = nav();
  return new Promise((resolve, reject) => {
    if (!n?.geolocation) return reject(new Error('Geolocation not available'));
    n.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          altitude: p.coords.altitude,
          heading: p.coords.heading,
          speed: p.coords.speed,
          timestamp: p.timestamp,
        }),
      (err) => reject(new Error(err.message || 'Location permission denied')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

async function writeClipboard(payload: unknown) {
  const n = nav();
  const text = String((payload as { text?: unknown } | undefined)?.text ?? '');
  if (!n?.clipboard?.writeText) throw new Error('Clipboard not available');
  await n.clipboard.writeText(text.slice(0, 100_000));
  return { ok: true };
}

let sentinel: WakeSentinel | null = null;
async function acquireWakeLock() {
  const n = nav();
  if (!n?.wakeLock) throw new Error('Wake Lock not available');
  // Release any prior lock first so repeated acquires don't leak sentinels.
  if (sentinel) {
    try {
      await sentinel.release();
    } catch {
      /* ignore */
    }
    sentinel = null;
  }
  sentinel = await n.wakeLock.request('screen');
  return { ok: true };
}
async function releaseWakeLock() {
  if (sentinel) {
    await sentinel.release();
    sentinel = null;
  }
  return { ok: true };
}

function doVibrate(payload: unknown) {
  const n = nav();
  const pattern = (payload as { pattern?: number | number[] } | undefined)?.pattern ?? 200;
  const ok = n?.vibrate ? n.vibrate(pattern) : false;
  return { ok };
}

function mockResult(command: string): unknown {
  switch (command) {
    case 'info.read':
      return { platform: 'Android', model: 'Pixel (mock)', osVersion: '14', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5, userAgent: 'mock' };
    case 'locale.read':
      return { timezone: 'Australia/Brisbane', locale: 'en-AU', languages: ['en-AU', 'en'] };
    case 'screen.read':
      return { width: 412, height: 915, orientation: 'portrait-primary', pixelRatio: 2.625, colorScheme: 'dark' };
    case 'battery.read':
      return { level: 0.82, charging: true, chargingTime: 1200, dischargingTime: Infinity };
    case 'network.read':
      return { online: true, effectiveType: '4g', downlink: 10, rtt: 50, type: 'wifi', saveData: false };
    case 'orientation.read':
      return { alpha: 30, beta: 5, gamma: -3 };
    case 'motion.read':
      return { acceleration: { x: 0.01, y: 0.02, z: 9.8 }, accelerationIncludingGravity: { x: 0.01, y: 0.02, z: 9.8 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 } };
    case 'gps.read':
      return { lat: -27.4698, lng: 153.0251, accuracy: 12, altitude: 28, heading: null, speed: 0, timestamp: 0 };
    case 'clipboard.write':
    case 'wakeLock.acquire':
    case 'wakeLock.release':
    case 'vibrate':
      return { ok: true };
    default:
      throw new Error(`Unknown device command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------
export const deviceConnector: BrowserConnector = {
  id: 'device',
  kind: 'device',
  label: 'Device (phone abilities)',
  preferLocal: true,
  get commands() {
    return detectCommands();
  },

  status(): ConnectorStatusInfo {
    const cmds = detectCommands();
    const detail = MOCK
      ? 'mock device values (?flDeviceMock)'
      : [
          'info/locale/screen/network: ok',
          cmds.includes('battery.read') ? 'battery: ok' : 'battery: n/a',
          cmds.includes('gps.read') ? 'gps: permission-gated' : 'gps: n/a',
          cmds.includes('orientation.read') ? 'motion: sensor' : 'motion: n/a',
        ].join(' · ');
    return {
      id: 'device',
      kind: 'device',
      available: true,
      source: 'device',
      label: 'Device (phone abilities)',
      detail,
    };
  },

  async request(command: string, payload?: unknown): Promise<unknown> {
    if (MOCK) return mockResult(command);
    switch (command) {
      case 'info.read':
        return readInfo();
      case 'locale.read':
        return readLocale();
      case 'screen.read':
        return readScreen();
      case 'battery.read':
        return readBattery();
      case 'network.read':
        return readNetwork();
      case 'orientation.read':
        return readOrientation();
      case 'motion.read':
        return readMotion();
      case 'gps.read':
        return readGps();
      case 'clipboard.write':
        return writeClipboard(payload);
      case 'wakeLock.acquire':
        return acquireWakeLock();
      case 'wakeLock.release':
        return releaseWakeLock();
      case 'vibrate':
        return doVibrate(payload);
      default:
        throw new Error(`Unknown device command: ${command}`);
    }
  },

  subscribe(command: string, callback: (event: unknown) => void): () => void {
    const n = nav();
    const w = win();
    if (command === 'gps.read' && n?.geolocation) {
      const id = n.geolocation.watchPosition(
        (p) => callback({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        (err) => callback({ error: err.message }),
        { enableHighAccuracy: true }
      );
      return () => n.geolocation.clearWatch(id);
    }
    if (command === 'network.read' && w) {
      const on = () => callback(readNetwork());
      w.addEventListener('online', on);
      w.addEventListener('offline', on);
      return () => {
        w.removeEventListener('online', on);
        w.removeEventListener('offline', on);
      };
    }
    if (command === 'orientation.read' && w) {
      const handler = (e: Event) => {
        const ev = e as DeviceOrientationEvent;
        callback({ alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma });
      };
      w.addEventListener('deviceorientation', handler);
      return () => w.removeEventListener('deviceorientation', handler);
    }
    return () => {};
  },
};
