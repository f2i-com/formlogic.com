// Bridge v1 for pack-owned sandboxed code screens (plan §8.3, APP-501/503
// first slice): connector.invoke with TRANSPARENT local/relay routing, a
// bounded records.update, and a one-shot desktop-presence snapshot.
//
// Design rules (FormLogic_Plugin_Platform_Plan_v3 §8.3):
//  - GRANT-GATED: a screen may only invoke connector commands its app has
//    declared (`connector.<id>.<command>` — the SAME gate as useConnector,
//    matching the capabilities published in the signed client manifest);
//  - TRANSPARENT ROUTING: pack code never reimplements the aokieRelay
//    uncertain-outcome machine. When a LOCAL desktop bridge is present the
//    local transport is AUTHORITATIVE — its failures surface as failed and
//    never retry via the relay (an attempted desktop route that lost its
//    response also throws connector_unavailable, and the command may have
//    executed — aokieConnector.ts transportFailure). Only when NO local
//    bridge exists does the bridge try the local client (in-browser
//    connectors + the demo simulator need no desktop) and fall back to the
//    relay on the then-guaranteed-pre-transport connector_unavailable — so
//    exactly ONE transport ever executes a command;
//  - OUTCOMES RESOLVE: command-level failures resolve with status 'failed' /
//    'expired' / 'uncertain' (the relay's truthful give-up semantics) — only
//    bridge misuse (missing grant, no app context, oversized payload) rejects.
//
// createScreenBridge is pure (unit-tested in screenBridge.test.ts); the
// useScreenBridge hook assembles the live deps from the app-runtime store.
import { useMemo } from 'react';
import { api } from '../../lib/api';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { getConnectorClient } from '../../client-runtime/connectors/nativeConnectorClient';
import { parseConnectorError } from '../../client-runtime/connectors/connectorTypes';
import { collectConnectorGrants, type GrantSource } from '../../client-runtime/connectors/connectorGrants';
import { isPermissionGranted } from '../../client-runtime/logic/appLogicPermissions';
import { getDesktopInfo } from '../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired } from '../../client-runtime/desktop/desktopPairing';
import { runRelayCommand, type RelayApi, type RunRelayOptions } from './aokie/aokieRelay';
import { resolveRemoteRuntime, type AokiePresence } from './aokie/aokiePresence';

/** What FormLogic.connector() resolves inside the sandbox. Mirrors the relay's
 *  RelayOutcome semantics with the transport named — `uncertain` means a
 *  desktop CLAIMED the command but hadn't reported back when we gave up (the
 *  hardware may have acted; never treat it as a clean failure). */
export interface ConnectorInvokeOutcome {
  status: 'done' | 'failed' | 'expired' | 'uncertain';
  result?: unknown;
  error?: Record<string, unknown> | null;
  /** Which transport executed: the local connector client or the command relay. */
  via: 'local' | 'relay';
  /** Relay only: the machine the server says handled/targets the command. */
  handledBy?: string;
}

/** The host-side callbacks CustomScreenRuntime services bridge actions with.
 *  Absent (no app context) → the actions reject with an honest message. */
export interface ScreenBridge {
  connectorInvoke: (
    connectorId: string,
    command: string,
    payload?: Record<string, unknown>
  ) => Promise<ConnectorInvokeOutcome>;
  updateRecord: (responseId: string, answers: Record<string, unknown>) => Promise<unknown>;
  deleteRecords: (responseIds: string[]) => Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>;
  presence: () => Promise<AokiePresence>;
  /** The observe gate for the events/captions subscription lane: true when
   *  the app DECLARES any grant string targeting this connector — i.e. a
   *  permission whose second segment names the connector or is a wildcard
   *  ('*', 'connector.*', 'connector.<id>...', 'connector.*.<cmd>'). No
   *  dedicated observe grant exists yet — an app trusted to command a
   *  connector may watch its events. */
  canObserveConnector: (connectorId: string) => boolean;
  /** False in the shared demo session: live feeds come from the OPERATOR's
   *  real desktop, which the demo must never attach to (same rule as the
   *  command path's demo/simulator split — FL-CONN-001 class). */
  liveFeedsAllowed: () => boolean;
  /** True when a LOCAL desktop bridge is present right now (detected +
   *  paired, not demo). The captions lane requires it at subscribe time —
   *  its reader would otherwise retry a dead loopback fetch forever (the
   *  events hub self-gates, so events.subscribe may late-bind). */
  localBridgeAvailable: () => boolean;
}

export interface ScreenBridgeDeps {
  appSlug: string;
  formId: string;
  /** Runtime config for grant resolution (app + this form's customLogic). */
  config: GrantSource;
  /** Local transport: the browser/native connector client. */
  localRequest: (connectorId: string, command: string, payload?: unknown) => Promise<unknown>;
  /** True when a LOCAL desktop bridge is present (detected + paired, not
   *  demo). When true the local transport is authoritative — a local failure
   *  NEVER retries via the relay (a transport failure on an attempted
   *  desktop route throws the SAME typed connector_unavailable as the
   *  never-attempted case, and the command may have executed). */
  localBridgeAvailable: () => boolean;
  /** Relay transport (enqueue + poll — api satisfies this). */
  relayApi: RelayApi;
  /** Record write (server enforces edit permission — the client gate is advisory). */
  updateResponse: (
    formId: string,
    responseId: string,
    data: { answers: Record<string, unknown> }
  ) => Promise<unknown>;
  /** Per-record delete (server enforces delete permission). Resolves — never
   *  throws — so one refused row can't abort the rest of a batch. */
  deleteResponse: (formId: string, responseId: string) => Promise<{ ok: boolean; error?: string }>;
  /** One-shot presence resolution (injectable for tests). */
  resolvePresence: () => Promise<AokiePresence>;
  /** True in the shared demo session (live feeds are then refused). */
  demoMode: () => boolean;
  /** Test seam for the relay's poll cadence/clock. */
  relayOptions?: RunRelayOptions;
}

/** Payload byte budgets (JSON length) — same order of magnitude as submit's. */
const CONNECTOR_PAYLOAD_MAX = 65_536;
const UPDATE_ANSWERS_MAX = 262_144;

/** deleteRecords batch bound (plan §8.3: explicit IDs, SMALL max batch —
 *  deliberately never a records.clearAll). */
const DELETE_BATCH_MAX = 25;

/** Local refusals that are PROVABLY pre-transport (no connector code ran
 *  anywhere), and therefore safe to retry via the relay when no local bridge
 *  is present: 'connector_unavailable' from a browser connector that needs an
 *  absent desktop, and 'connector_missing' when the connector has no local
 *  implementation at all (a plugin-owned connector that only exists on the
 *  owner's desktop). Everything else stays local-final. */
const RELAY_ELIGIBLE_CODES = new Set(['connector_unavailable', 'connector_missing']);

export function createScreenBridge(deps: ScreenBridgeDeps): ScreenBridge {
  return {
    connectorInvoke: async (connectorId, command, payload) => {
      const cid = String(connectorId || '');
      const cmd = String(command || '');
      if (!cid || !cmd) throw new Error('connector() needs a connectorId and a command.');
      const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      if (JSON.stringify(body).length > CONNECTOR_PAYLOAD_MAX) {
        throw new Error('Connector payload is too large.');
      }
      // The same advisory grant gate as useConnector — the native bridge and
      // the server stay the real trust boundary.
      const grants = collectConnectorGrants(deps.config, { formId: deps.formId });
      const required = `connector.${cid}.${cmd}`;
      if (!isPermissionGranted(required, grants)) {
        throw new Error(`This app has not been granted the "${required}" connector permission.`);
      }

      // Route decision up front, like the compiled screens' tested fork
      // (aokieRelay dispatchCallCommand): a present local bridge is
      // authoritative, so a lost-response transport failure can never be
      // re-executed remotely.
      const localAuthoritative = deps.localBridgeAvailable();
      try {
        const result = await deps.localRequest(cid, cmd, body);
        return { status: 'done', result, via: 'local' };
      } catch (err) {
        const typed = parseConnectorError(err);
        if (localAuthoritative || !typed || !RELAY_ELIGIBLE_CODES.has(typed.code)) {
          // A real refusal from a live connector (validation, stale_call,
          // capability_denied, …) or ANY failure while a local bridge is
          // present — resolving it as failed keeps ONE uniform handling
          // pattern in pack code, and must NOT retry via the relay (the
          // command may have partially executed).
          return {
            status: 'failed',
            error: typed
              ? { code: typed.code, message: typed.message }
              : { message: err instanceof Error ? err.message : 'Command failed' },
            via: 'local',
          };
        }
      }

      // No local desktop, and the local client refused PRE-TRANSPORT → the
      // owner's command relay (a desktop elsewhere may claim it; 'expired' =
      // nobody did, 'uncertain' = claimed, unreported).
      try {
        const outcome = await runRelayCommand(deps.relayApi, deps.appSlug, cmd, body, {
          ...deps.relayOptions,
          connectorId: cid,
        });
        return {
          status: outcome.status,
          result: outcome.result ?? undefined,
          error: outcome.error ?? null,
          via: 'relay',
          ...(outcome.handledBy ? { handledBy: outcome.handledBy } : {}),
        };
      } catch (err) {
        // Enqueue itself failed (offline, demo read-only, …) — still an
        // outcome, not an exception, so pack code has one handling path.
        return {
          status: 'failed',
          error: { message: err instanceof Error ? err.message : 'Failed to reach the desktop runtime' },
          via: 'relay',
        };
      }
    },

    updateRecord: async (responseId, answers) => {
      const id = String(responseId || '');
      if (!id) throw new Error('updateRecord() needs a responseId.');
      const body = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
      if (JSON.stringify(body).length > UPDATE_ANSWERS_MAX) throw new Error('Update is too large.');
      const row = (await deps.updateResponse(deps.formId, id, { answers: body })) as Record<string, unknown>;
      // Same projection as records()/record() — never leak server metadata.
      return { id: row.id, answers: row.answers, submittedAt: row.submittedAt, status: row.status, tags: row.tags };
    },

    deleteRecords: async (responseIds) => {
      const ids = Array.isArray(responseIds) ? responseIds.map((v) => String(v || '')).filter(Boolean) : [];
      const unique = Array.from(new Set(ids));
      if (unique.length === 0) throw new Error('deleteRecords() needs at least one responseId.');
      if (unique.length > DELETE_BATCH_MAX) {
        throw new Error(`deleteRecords() is bounded to ${DELETE_BATCH_MAX} records per call.`);
      }
      // Sequential, per-id, each server-authorized — a refused row reports
      // itself and never aborts the remainder (bounded clears stay honest).
      const deleted: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const id of unique) {
        try {
          const res = await deps.deleteResponse(deps.formId, id);
          if (res.ok) deleted.push(id);
          else failed.push({ id, error: res.error || 'Delete failed' });
        } catch (err) {
          failed.push({ id, error: err instanceof Error ? err.message : 'Delete failed' });
        }
      }
      return { deleted, failed };
    },

    presence: () => deps.resolvePresence(),

    canObserveConnector: (connectorId) => {
      const cid = String(connectorId || '');
      if (!cid) return false;
      const grants = collectConnectorGrants(deps.config, { formId: deps.formId });
      for (const g of grants) {
        if (g === '*') return true;
        // Segment-based: 'connector.<id-or-*>[.anything]' — covers exact
        // commands, 'connector.<id>.*', 'connector.*' and inner-wildcard
        // forms like 'connector.*.status' (grantCovers' own semantics).
        const parts = g.split('.');
        if (parts[0] === 'connector' && (parts[1] === cid || parts[1] === '*')) return true;
      }
      return false;
    },

    liveFeedsAllowed: () => !deps.demoMode(),

    localBridgeAvailable: () => deps.localBridgeAvailable(),
  };
}

/**
 * One-shot presence snapshot with useAokiePresence's exact semantics: the
 * shared Demo account is always 'none' (a paired desktop on the same machine
 * must never read as the demo's runtime), a paired local bridge wins, else the
 * remote probe (desktop-connections freshness + recent desktop flow runs).
 */
export async function resolveScreenPresence(appId?: string): Promise<AokiePresence> {
  if (api.isDemoMode()) return { kind: 'none' };
  if (getDesktopInfo().available && isDesktopPaired()) return { kind: 'local' };
  const remote = await resolveRemoteRuntime(appId);
  return remote ? { kind: 'remote', ...remote } : { kind: 'none' };
}

/**
 * The live ScreenBridge for an app-runtime code screen, or undefined outside a
 * matching app context (builder previews, public links — the bridge actions
 * then reject with "not available on this screen").
 */
export function useScreenBridge(formId: string, appSlug?: string): ScreenBridge | undefined {
  const config = useAppRuntimeStore((s) => s.config);
  const storeSlug = useAppRuntimeStore((s) => s.appSlug);
  const updateResponse = useAppRuntimeStore((s) => s.updateResponse);
  return useMemo(() => {
    // The store must actually be initialized for THIS app — a stale store from
    // another app must never lend its grants (or its update writes).
    if (!formId || !storeSlug || !config || (appSlug && appSlug !== storeSlug)) return undefined;
    const appId = config.app?.id;
    return createScreenBridge({
      appSlug: storeSlug,
      formId,
      config,
      localRequest: (connectorId, command, payload) => getConnectorClient().request(connectorId, command, payload),
      // Same truth as aokieConnector.desktopRouteAvailable(): the demo
      // account never reads a same-machine desktop as its runtime.
      localBridgeAvailable: () => !api.isDemoMode() && getDesktopInfo().available && isDesktopPaired(),
      relayApi: api,
      updateResponse,
      // Straight to the app API (NOT the store's deleteResponse, which toasts
      // per failure — a bounded batch reports its own per-id outcomes).
      deleteResponse: async (fId, responseId) => {
        const res = await api.deleteAppResponse(storeSlug, fId, responseId);
        return res.error
          ? { ok: false, error: typeof res.error === 'string' ? res.error : 'Delete failed' }
          : { ok: true };
      },
      resolvePresence: () => resolveScreenPresence(appId),
      demoMode: () => api.isDemoMode(),
    });
  }, [formId, appSlug, storeSlug, config, updateResponse]);
}
