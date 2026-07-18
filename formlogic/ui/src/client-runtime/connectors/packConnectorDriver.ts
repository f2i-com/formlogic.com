// Pack-embedded connector drivers — registry, permission broker and the
// sandboxed demo-driver runtime (spec: self-contained packs).
//
// A pack ships its connector as DATA on the app's customLogic bundle:
//   customLogic.connector = { manifest, demoDriver? }
// The manifest declares identity + command surface; the demo driver is a
// QuickJS script (`function run(ctx)`, the exact app-logic sandbox: zero IO,
// memory/stack/budget-limited) that implements the connector's SIMULATOR as a
// pure state machine: the host passes `ctx.state` in and persists the returned
// `state` — the script never holds live references, timers or sockets.
//
// Trust model (the host is the broker; the driver only describes):
//  - TRANSPORT IS HOST-OWNED. Real commands route through the generic
//    desktop-backed connector (desktopConnector.ts): pairing tokens,
//    authenticated fetch, relay and rate caps never enter the sandbox.
//  - THE DEMO DRIVER IS GRANT-GATED. It activates only when the app declares
//    `connector.<id>.driver.demo` — a reviewable `connector.`-prefixed grant,
//    so the APP-502 install review lists it and stripping it leaves the
//    connector transport-only (real hardware keeps working; the simulator is
//    inert).
//  - EVERYTHING THE DRIVER EMITS IS CAPPED + ALLOWLISTED. Events must be named
//    in manifest.demoEvents, are bounded per run, and are provenance-stamped
//    `simulated: true` by the HOST (simulatedEnvelope) — a driver cannot omit
//    the stamp or invent event names the pack never declared.
//  - SIMULATION NEEDS AN EXPLICIT SESSION (audit FL-CONN-001, enforced by the
//    composed connector): demo answers never mask an absent/unpaired desktop.
import { runAppLogic } from '../../lib/formlogic/engine';
import { ConnectorError, type ConnectorErrorCode, type ConnectorStatusInfo } from './connectorTypes';
import type { PackConnectorBundle } from '../../types/customAppLogic';
import { collectConnectorGrants, type GrantSource } from './connectorGrants';
import { isPermissionGranted } from '../logic/appLogicPermissions';
import { emitLocalDesktopEvent } from '../desktop/desktopEvents';
import { enableSimulator, markSimulated, simulatedEnvelope } from './connectorSimulator';
import { createDesktopBackedConnector, type DemoConnectorFacade } from './desktopConnector';
import {
  isBuiltInConnectorId,
  registerBrowserConnector,
  unregisterBrowserConnector,
} from './nativeConnectorClient';

// ── Caps (host-enforced; a driver script can't change them) ─────────────────
const DRIVER_BUDGET_MS = 500; // per run() call — pure state transitions, no IO
const DRIVER_SOURCE_MAX = 128 * 1024;
const STATE_JSON_MAX = 32 * 1024;
const EVENTS_PER_RUN_MAX = 8;
const CEREMONY_STEPS_MAX = 40;
const CEREMONY_DELAY_MAX_MS = 8000;

const CONNECTOR_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// The sandbox evaluator. Production = runAppLogic (engine.ts → the browser
// Worker → the QuickJS WASM VM). Tests inject quickjs-host's runEval directly
// (same PRELUDE/JSON-ctx/budget semantics, no Worker — Vitest has none).
type DriverEvaluator = (source: string, ctx: Record<string, unknown>, budgetMs: number) => Promise<unknown>;
let driverEvaluator: DriverEvaluator = runAppLogic;
export function __setDriverEvaluatorForTests(fn: DriverEvaluator | null): void {
  driverEvaluator = fn ?? runAppLogic;
}

// Codes a driver may surface as typed refusals; anything else folds to
// command_failed so a driver can't fabricate host-level trust codes
// (origin_denied / capability_denied are the HOST's verdicts, never a demo's).
const DRIVER_ERROR_CODES: ReadonlySet<string> = new Set([
  'command_failed',
  'stale_call',
  'connector_unavailable',
]);

/** Validate a pack's connector manifest. Returns an error string or null. */
export function validateConnectorManifest(m: unknown): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest must be an object';
  const man = m as Record<string, unknown>;
  if (typeof man.connectorId !== 'string' || !CONNECTOR_ID_RE.test(man.connectorId)) {
    return 'connectorId must be a dot-free lowercase slug';
  }
  if (isBuiltInConnectorId(man.connectorId)) {
    return `connectorId "${man.connectorId}" is reserved for a built-in connector`;
  }
  if (typeof man.kind !== 'string' || !man.kind) return 'kind is required';
  if (typeof man.label !== 'string' || !man.label) return 'label is required';
  if (!Array.isArray(man.commands) || man.commands.length === 0 || man.commands.length > 64) {
    return 'commands must list 1-64 command names';
  }
  const lists: Array<[string, unknown, number]> = [
    ['commands', man.commands, 64],
    ['journalledCommands', man.journalledCommands, 64],
    ['demoEvents', man.demoEvents, 32],
    ['demoCeremonies', man.demoCeremonies, 8],
  ];
  for (const [name, list, cap] of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > cap) return `${name} must be an array of at most ${cap} names`;
    if (!list.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 80)) {
      return `${name} entries must be non-empty strings`;
    }
  }
  return null;
}

interface PackDriverInstance {
  bundle: PackConnectorBundle;
  /** True when the app's grants activate the demo driver. */
  demoActive: boolean;
  /** Threaded driver state (JSON value); reset with the registration. */
  state: unknown;
  /** Serializes driver runs — the state thread must never interleave. */
  chain: Promise<unknown>;
}

// One registry for the current app runtime (registration is app-scoped:
// syncPackConnectors replaces the set when the app changes).
const instances = new Map<string, PackDriverInstance>();

/** What one driver run() returned, after host-side normalization + caps. */
interface DriverRunOutput {
  result?: unknown;
  error?: { code: ConnectorErrorCode; message: string };
  delayMs: number;
  done: boolean;
}

/**
 * Run the driver once (serialized per connector), thread its state, and apply
 * its declared events through the allowlist. Throws only on host-side misuse
 * (driver crash / budget / oversized state) — driver-declared errors return
 * typed in the output.
 */
async function invokeDriver(
  id: string,
  inst: PackDriverInstance,
  fn: 'request' | 'ceremonyStep',
  input: Record<string, unknown>
): Promise<DriverRunOutput> {
  const source = inst.bundle.demoDriver;
  if (!source) {
    return { error: { code: 'command_failed', message: 'this connector has no demo driver' }, delayMs: 0, done: true };
  }
  const run = async (): Promise<DriverRunOutput> => {
    const ctx: Record<string, unknown> = {
      fn,
      ...input,
      state: inst.state ?? null,
      now: Date.now(),
    };
    let raw: unknown;
    try {
      raw = await driverEvaluator(source, ctx, DRIVER_BUDGET_MS);
    } catch (err) {
      throw new ConnectorError(
        'command_failed',
        `demo driver error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const out = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

    // Thread the state (size-capped so a runaway driver can't balloon memory).
    if ('state' in out) {
      const nextState = out.state ?? null;
      try {
        const json = JSON.stringify(nextState);
        if (json && json.length > STATE_JSON_MAX) {
          throw new ConnectorError('command_failed', 'demo driver state exceeded the size cap');
        }
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        throw new ConnectorError('command_failed', 'demo driver state must be JSON-serializable');
      }
      inst.state = nextState;
    }

    // Emit declared events — allowlisted names only, capped, host-stamped.
    const events = Array.isArray(out.events) ? out.events.slice(0, EVENTS_PER_RUN_MAX) : [];
    const allowed = new Set(inst.bundle.manifest.demoEvents ?? []);
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name : '';
      if (!allowed.has(name)) continue; // undeclared event names never leave the sandbox
      const correlationId = typeof e.correlationId === 'string' ? e.correlationId.slice(0, 200) : '';
      const idempotencyKey = typeof e.idempotencyKey === 'string' ? e.idempotencyKey.slice(0, 200) : '';
      if (!correlationId || !idempotencyKey) continue;
      emitLocalDesktopEvent(simulatedEnvelope(id, name, correlationId, idempotencyKey, e.data ?? {}));
    }

    // Typed refusal from the driver (code folded to a demo-safe set).
    let error: DriverRunOutput['error'];
    if (out.error && typeof out.error === 'object') {
      const e = out.error as Record<string, unknown>;
      const code = typeof e.code === 'string' && DRIVER_ERROR_CODES.has(e.code) ? (e.code as ConnectorErrorCode) : 'command_failed';
      error = { code, message: typeof e.message === 'string' ? e.message.slice(0, 500) : 'demo driver refused the command' };
    }

    return {
      result: out.result,
      error,
      delayMs: Math.max(0, Math.min(CEREMONY_DELAY_MAX_MS, typeof out.delayMs === 'number' ? out.delayMs : 0)),
      done: out.done === true,
    };
  };
  // Serialize on the instance chain so concurrent calls can't interleave state.
  const next = inst.chain.then(run, run);
  inst.chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** The simulator façade the composed connector calls inside a demo session. */
function buildDemoFacade(id: string, inst: PackDriverInstance): DemoConnectorFacade {
  const manifest = inst.bundle.manifest;
  return {
    status(): ConnectorStatusInfo {
      return {
        id,
        kind: manifest.kind,
        available: true,
        source: 'mock',
        label: `${manifest.label} (demo)`,
        detail: manifest.demoStatusDetail ?? `Simulated ${manifest.label} — FormLogic Desktop not connected.`,
      };
    },
    async request(command: string, payload?: unknown): Promise<unknown> {
      const out = await invokeDriver(id, inst, 'request', { command, payload: payload ?? null });
      if (out.error) throw new ConnectorError(out.error.code, out.error.message);
      if (out.result === undefined) {
        throw new ConnectorError('command_failed', `demo driver did not handle "${command}".`);
      }
      return markSimulated(out.result);
    },
  };
}

/** The reviewable grant that activates a pack's DEMO driver. */
export function demoDriverGrant(connectorId: string): string {
  return `connector.${connectorId}.driver.demo`;
}

/**
 * Register one pack connector: the composed desktop-first transport always;
 * the demo driver only when the app's grants include
 * `connector.<id>.driver.demo` (the install review's strip point).
 * Returns an error string (not thrown — a broken pack must not take the app
 * down) or null on success.
 */
export function registerPackConnector(bundle: PackConnectorBundle, grants: Set<string>): string | null {
  const invalid = validateConnectorManifest(bundle?.manifest);
  if (invalid) return `connector manifest rejected: ${invalid}`;
  const manifest = bundle.manifest;
  const id = manifest.connectorId;
  if (bundle.demoDriver !== undefined) {
    if (typeof bundle.demoDriver !== 'string' || bundle.demoDriver.length > DRIVER_SOURCE_MAX) {
      return 'demo driver must be a script of at most 128KB';
    }
  }
  const demoActive = !!bundle.demoDriver && isPermissionGranted(demoDriverGrant(id), grants);
  const inst: PackDriverInstance = { bundle, demoActive, state: null, chain: Promise.resolve() };
  try {
    registerBrowserConnector(
      createDesktopBackedConnector(manifest, demoActive ? buildDemoFacade(id, inst) : null)
    );
  } catch (err) {
    // Reserved-id / registry refusal (validateConnectorManifest already rejects the
    // known reserved ids, so this is defense in depth) — never take the app down.
    return err instanceof Error ? err.message : 'connector registration refused';
  }
  instances.set(id, inst);
  return null;
}

/** Remove one pack connector (and its browser-connector registration). */
export function unregisterPackConnector(connectorId: string): void {
  instances.delete(connectorId);
  unregisterBrowserConnector(connectorId);
}

/**
 * Reconcile the registry with the CURRENT app runtime config — called by the
 * app runtime store whenever an app loads/unloads or its customLogic changes.
 * Pack connectors are app-scoped: leaving the app unregisters them.
 */
export function syncPackConnectors(config: GrantSource): void {
  for (const id of [...instances.keys()]) unregisterPackConnector(id);
  const bundle = config?.app?.customLogic?.connector;
  if (!bundle) return;
  const err = registerPackConnector(bundle, collectConnectorGrants(config));
  if (err) {
    // Visible in the console, never fatal: the rest of the app still runs.
    console.warn(`[packConnector] ${err}`);
  }
}

/** The registered connector that provides the volatile captions lane, if any. */
export function captionsConnectorId(): string | null {
  for (const [id, inst] of instances) {
    if (inst.bundle.manifest.captions) return id;
  }
  return null;
}

export interface ConnectorCeremonyOutcome {
  status: 'done' | 'failed' | 'unavailable';
  message?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a pack-declared demo ceremony (e.g. 'simulate-call'): the driver's
 * scripted multi-step sequence, played by the HOST — the driver returns one
 * step's events + pacing at a time and the host owns the clock and the step
 * cap. Starting a ceremony is the explicit simulator opt-in for its connector
 * (FL-CONN-001): from here on this page session may use the simulated bridge.
 * Returns null when NO registered connector declares the ceremony (the caller
 * treats it as an unknown ceremony name).
 */
export async function runConnectorCeremony(
  name: string,
  options: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<ConnectorCeremonyOutcome | null> {
  let found: { id: string; inst: PackDriverInstance } | null = null;
  for (const [id, inst] of instances) {
    if (inst.bundle.manifest.demoCeremonies?.includes(name)) {
      found = { id, inst };
      break;
    }
  }
  if (!found) return null;
  if (!found.inst.demoActive) {
    return {
      status: 'unavailable',
      message: 'This app has not been granted the demo simulator permission.',
    };
  }
  const sleep = options.sleep ?? defaultSleep;
  enableSimulator(found.id);
  try {
    for (let step = 0; step < CEREMONY_STEPS_MAX; step++) {
      const out = await invokeDriver(found.id, found.inst, 'ceremonyStep', { ceremony: name, step });
      if (out.error) return { status: 'failed', message: out.error.message };
      if (out.done) return { status: 'done' };
      if (out.delayMs > 0) await sleep(out.delayMs);
    }
    // A driver that never says done is out of budget — truthful failure.
    return { status: 'failed', message: 'The demo sequence never completed.' };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : 'The demo sequence failed.' };
  }
}

/** Test-only: drop every registration + driver state. */
export function __resetPackConnectorsForTests(): void {
  for (const id of [...instances.keys()]) unregisterPackConnector(id);
}
