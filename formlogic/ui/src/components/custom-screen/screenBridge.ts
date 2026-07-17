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
import { listAiSources, listDesktopServices, type AiSourceListing } from '../../client-runtime/flows/desktopService';

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
  /** Read records of ANOTHER form in THIS app (plan §8.3 records.query). The
   *  target is resolved to a sibling form by pack key / form id / display
   *  name; the SERVER enforces the member's per-form view permission (the same
   *  boundary related() already crosses), so a screen can only read what the
   *  member could read by navigating there. Returns projected rows; resolves
   *  [] for an unknown/forbidden form (never throws for authz). */
  queryRecords: (formTarget: string, opts?: { limit?: number }) => Promise<Array<Record<string, unknown>>>;
  /** The paired local desktop's AI-sources listing (capability-tagged managed
   *  services + configured providers — the SAME union GET /api/ai/sources
   *  serves), host-resolved because the sandbox has no network of its own.
   *  Read-only, no secrets (service/provider metadata only). null when there's
   *  no local desktop (remote console / demo / unpaired) — the caller then
   *  composes lane endpoints without a listing and lets the per-call flow
   *  resolve `service:` picks. */
  aiSources: () => Promise<AiSourceListing[] | null>;
  presence: () => Promise<AokiePresence>;
  /** Typed service.invoke (plan §8.3, APP-503): run a SERVER-REGISTERED
   *  operation. Resolves an outcome ({status done|failed, result?, error?}) —
   *  operation-level refusals (unknown op, forbidden, unavailable) resolve as
   *  failed; only bridge misuse (bad id shape, oversized input) rejects. */
  serviceInvoke: (
    operationId: string,
    input?: Record<string, unknown>
  ) => Promise<{ status: 'done' | 'failed'; result?: unknown; error?: Record<string, unknown> | null }>;
  /** Advisory permission introspection (plan §8.3 permissions.can): true when
   *  the app DECLARES the permission for this screen's scope — the same
   *  collectConnectorGrants truth the connector() gate applies, so a screen
   *  can grey out buttons instead of collecting rejects. ADVISORY ONLY: the
   *  native bridge and the server stay the real trust boundary. */
  can: (permission: string) => boolean;
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
  /** Resolve a sibling-form target ('pack key' / form id / display name) to a
   *  real form id in THIS app, or null. Cross-form reads can target ONLY forms
   *  the app actually has. */
  resolveForm: (formTarget: string) => string | null;
  /** Read another form's records (server enforces the member's view permission).
   *  Resolves [] on any refusal so pack code has one path. */
  queryResponses: (formId: string, limit: number) => Promise<Array<Record<string, unknown>>>;
  /** One-shot presence resolution (injectable for tests). */
  resolvePresence: () => Promise<AokiePresence>;
  /** Resolve the local desktop's AI-sources listing (injectable for tests);
   *  null when no local desktop is available. */
  resolveAiSources: () => Promise<AiSourceListing[] | null>;
  /** Typed service.invoke transport (api.invokeAppService — injectable for tests). */
  invokeService: (
    slug: string,
    operationId: string,
    input: Record<string, unknown>
  ) => Promise<{ data?: { operationId: string; result: unknown }; error?: unknown }>;
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

/** service.invoke input byte budget (the server registry enforces its own,
 *  usually tighter, per-operation cap). */
const SERVICE_INPUT_MAX = 16_384;

/** Operation ids are dot-separated slugs ('aokie.companion.devices.list') —
 *  never paths, so the lane structurally can't become a generic
 *  backend.fetch (the §8.3 rejection). */
const SERVICE_OPERATION_ID = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

/** Local refusals that are PROVABLY pre-transport (no connector code ran
 *  anywhere), and therefore safe to retry via the relay when no local bridge
 *  is present: 'connector_unavailable' from a browser connector that needs an
 *  absent desktop, and 'connector_missing' when the connector has no local
 *  implementation at all (a plugin-owned connector that only exists on the
 *  owner's desktop). Everything else stays local-final. */
const RELAY_ELIGIBLE_CODES = new Set(['connector_unavailable', 'connector_missing']);

/**
 * Normalize a connector result to the command's DATA payload. The desktop
 * gateway's success body is the envelope `{ ok: true, data: X }` (connectors.rs
 * "the JSON-RPC result IS the success body"). The LOCAL path already unwraps it
 * to X (desktopClient.connectors.request → `res.data.data`), but the RELAY
 * stores the raw envelope, so `runRelayCommand` returns `{ ok:true, data:X }`.
 * Without this, pack screens (which read `result.devices`, `result.connected`,
 * `result.settings`, …) get empty results on the relay path — e.g. Device Setup
 * showing "no dongles / no phones" while the plugin has both. Defensive: only
 * unwraps the exact `{ ok:true, data }` envelope, so an already-unwrapped local
 * result (which has no `ok` field) passes through untouched.
 */
function unwrapConnectorResult(result: unknown): unknown {
  if (
    result && typeof result === 'object' && !Array.isArray(result)
    && (result as { ok?: unknown }).ok === true
    && 'data' in (result as object)
  ) {
    return (result as { data: unknown }).data;
  }
  return result;
}

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
        return { status: 'done', result: unwrapConnectorResult(result), via: 'local' };
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
          result: unwrapConnectorResult(outcome.result ?? undefined),
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

    queryRecords: async (formTarget, opts) => {
      const target = String(formTarget || '');
      if (!target) throw new Error('queryRecords() needs a form target.');
      const resolved = deps.resolveForm(target);
      // A form this app doesn't have, or the screen's own form (use records()
      // for that) — resolve empty rather than reach anywhere unexpected.
      if (!resolved || resolved === deps.formId) return [];
      const limit = Math.min(500, Math.max(1, Number(opts?.limit) || 100));
      return deps.queryResponses(resolved, limit);
    },

    presence: () => deps.resolvePresence(),

    aiSources: () => deps.resolveAiSources(),

    serviceInvoke: async (operationId, input) => {
      const op = String(operationId || '');
      if (!SERVICE_OPERATION_ID.test(op) || op.length > 96) {
        throw new Error('service() needs a valid operation id (e.g. "aokie.companion.devices.list").');
      }
      const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      if (JSON.stringify(body).length > SERVICE_INPUT_MAX) {
        throw new Error('Service operation input is too large.');
      }
      try {
        const res = await deps.invokeService(deps.appSlug, op, body);
        if (res.error || !res.data) {
          // Unknown op / forbidden / unavailable — an OUTCOME, not an
          // exception, so pack code keeps one handling path.
          return {
            status: 'failed',
            error: { message: typeof res.error === 'string' ? res.error : 'Service operation failed' },
          };
        }
        return { status: 'done', result: res.data.result };
      } catch (err) {
        return {
          status: 'failed',
          error: { message: err instanceof Error ? err.message : 'Service operation failed' },
        };
      }
    },

    can: (permission) => {
      const p = String(permission || '');
      if (!p) return false;
      const grants = collectConnectorGrants(deps.config, { formId: deps.formId });
      return isPermissionGranted(p, grants);
    },

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
 * Resolve a FormLogic.host.openScreen target against the app's form list:
 * the pack's stable form key (settings.packFormId) wins, then a real form id,
 * then the display name (same precedence as app-logic's resolveFormKey).
 * STRICT — unknown targets return null (never a raw passthrough), so the
 * host only ever navigates to a screen the app actually has.
 */
export function resolveScreenTarget(target: string): string | null {
  const t = String(target || '');
  if (!t) return null;
  const forms = useAppRuntimeStore.getState().config?.forms ?? [];
  const hit =
    forms.find((f) => f.packFormId === t) ??
    forms.find((f) => f.formId === t) ??
    forms.find((f) => f.displayName === t);
  return hit?.formId ?? null;
}

/**
 * The AI-sources listing for a code screen's lane pickers, with the compiled
 * console's exact degrade path: the desktop's /api/ai/sources union first, then
 * a category-derived fallback over the plain /api/services list (older desktops),
 * else null (no local desktop — the caller composes without a listing and the
 * per-call flow resolves `service:` picks). The shared demo never attaches to a
 * real desktop, so it always returns null.
 */
export async function resolveScreenAiSources(): Promise<AiSourceListing[] | null> {
  if (api.isDemoMode()) return null;
  let list = await listAiSources().catch(() => [] as AiSourceListing[]);
  if (list.length === 0) {
    const svcs = await listDesktopServices().catch(() => []);
    list = svcs.map((s) => {
      const c = s.category.toLowerCase();
      const capabilities = c.includes('llm')
        ? ['chat']
        : c.includes('speech') || c.includes('voice')
          ? ['transcription', 'speech']
          : c.includes('image')
            ? ['image']
            : [];
      return {
        id: `service:${s.id}`,
        kind: 'service' as const,
        refId: s.id,
        name: s.name,
        category: s.category,
        status: s.status,
        capabilities,
        url: s.url,
        model: '',
        enabled: true,
      };
    });
  }
  return list.length > 0 ? list : null;
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
      resolveForm: (formTarget) => resolveScreenTarget(formTarget),
      queryResponses: async (fId, limit) => {
        // Same app API + per-form permission gate the app's own records views
        // use — a refusal (no view permission) resolves to [] here.
        const res = await api.getAppResponses(storeSlug, fId, { limit });
        const rows = (res.data?.responses ?? []) as Array<Record<string, unknown>>;
        return rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
      },
      resolvePresence: () => resolveScreenPresence(appId),
      resolveAiSources: () => resolveScreenAiSources(),
      invokeService: (slug, operationId, input) => api.invokeAppService(slug, operationId, input),
      demoMode: () => api.isDemoMode(),
    });
  }, [formId, appSlug, storeSlug, config, updateResponse]);
}
