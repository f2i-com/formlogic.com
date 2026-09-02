// FormLogic Flows event dispatcher (docs/FORMLOGIC_FLOWS.md §5).
//
// Bridges events to the browser executor: desktop-event envelopes from the desktopEvents
// hub AND form events (`form.submitted`, fired from the app runtime's onAfterSubmit path)
// fan out to every enabled binding matching event_name. For each match the dispatcher
//   1. evaluates the binding condition in the QuickJS sandbox (never eval; an erroring
//      condition fails SAFE — the binding is skipped),
//   2. reserves the run log FIRST (idempotencyKey = flow:<binding>:<event key>, the UNIQUE
//      column being the cross-tab dedupe gate — an idempotent replay skips execution),
//   3. builds inputs via the binding inputMap selectors ($event.data.x / $app / literals),
//   4. executes with the binding's timeout/retry semantics (sync awaited; async tracked;
//      background fire-and-forget; manual only via the UI/`runFlowBySlug`),
//   5. applies outputActions in order (formlogic.* writes through the viewer's session),
//   6. PATCHes the run log terminal (result or flow-run-result error envelope).
//
// All browser bindings (api / store / QuickJS / connector client / toasts) are injected
// through a deps object so the whole pipeline is unit-testable without a DOM.
import { api, newIdempotencyKey } from '../../lib/api';
import { demoApplyFlowOverlay, demoApplyFormBindingOverlay } from '../../lib/demoLocal';
import { logger } from '../../lib/logger';
import { useAuthStore } from '../../stores/authStore';
import type {
  FlowBinding,
  FlowDefinition,
  FlowRunError,
  FlowRunLog,
  FlowRuntimeKind,
  RuntimeFlowBinding,
  RuntimeFlowDefinition,
  RuntimeFlows,
} from '../../types/flows';
import { subscribeDesktopEvents } from '../desktop/desktopEvents';
import {
  enqueueBrowserConnectorEvent,
  resetBrowserConnectorEventQueues,
} from '../desktop/browserEventQueue';
import { desktopClient, type DesktopAiChatRequest } from '../desktop/desktopClient';
import type { DesktopEventEnvelope } from '../desktop/desktopTypes';
import { resolveProviderRequest } from './aiProviders';
import { resolveDesktopLlmEndpoint } from './desktopLlm';
import {
  listAiSources,
  listDesktopServices,
  resolveDesktopServiceBase,
  type AiSourceListing,
} from './desktopService';
import { oaiyRouteAvailable } from '../oaiy/oaiyRuntime';
import { oaiyAiChat } from '../oaiy/oaiyAi';
import { executeFlow, type FlowRunOutcome } from './flowExecutor';
import { resolveExecutableGraph } from './compiledGraph';
import { invokeChildFlowWith, type ChildFlowBackend } from './childFlowInvoker';
import type { FlowExecutorDeps } from './nodes';
import {
  buildInputs,
  interpolateTemplate,
  resolveDeep,
  resolveSelector,
  scopeToContext,
  whenPasses,
  type SelectorScope,
} from './selectors';

const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_ATTEMPTS = 5;

/** Keep website flow routing on providers that Desktop explicitly advertises
 * for flows. Missing use-case metadata is accepted only for older builds. */
export function isDesktopFlowChatProvider(source: AiSourceListing, providerId: string): boolean {
  return source.kind === 'provider'
    && source.refId === providerId
    && source.enabled
    && (source.capabilities.length === 0 || source.capabilities.includes('chat'))
    && (source.useCases === undefined || source.useCases.includes('flows'));
}

/** Invoke an explicitly selected provider through paired Desktop without ever
 * exposing its credential to the website. Null means this Desktop does not
 * advertise that provider, allowing the existing browser-provider/local
 * compatibility path to continue. Once advertised, an invocation error is
 * terminal so a flow can never silently switch to a different provider. */
async function invokeDesktopNamedAiChat(
  providerId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const id = providerId.indexOf('provider:') === 0 ? providerId.slice(9) : providerId;
  const sources = await listAiSources();
  const selected = sources.find((source) => isDesktopFlowChatProvider(source, id));
  if (!selected) return null;
  // When OAIY is the paired runtime, the advertised providers ARE OAIY's, so the
  // chat runs through OAIY's credential-hidden gateway; otherwise FormLogic
  // Desktop. Either way the key never reaches the browser.
  const result = oaiyRouteAvailable()
    ? await oaiyAiChat(id, body, { signal })
    : await desktopClient.ai.chat(body as DesktopAiChatRequest, id, { signal });
  if (!result.ok) throw new Error(result.error.message || `Desktop AI provider '${id}' failed`);
  return result.data;
}

/** How often an active runtime polls for claimable 'queued' runs (docs §10). */
export const CLAIM_POLL_INTERVAL_MS = 20_000;
const CLAIM_BATCH_LIMIT = 10;

/**
 * Stable per-tab claimer id ('browser-…', stamped into flow_run_logs.claimed_by).
 * sessionStorage keeps it stable across reloads of the same tab; unit tests / non-DOM
 * environments fall back to a per-module id.
 */
let memoryInstanceId: string | null = null;
export function getClaimInstanceId(): string {
  if (!memoryInstanceId) memoryInstanceId = `browser-${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (typeof sessionStorage !== 'undefined') {
      const key = 'formlogic-flow-claimer';
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      sessionStorage.setItem(key, memoryInstanceId);
    }
  } catch {
    /* storage blocked — memory id is fine */
  }
  return memoryInstanceId;
}

/** Normalized trigger shared by desktop envelopes and form events. */
export interface FlowTriggerEvent {
  name: string;
  correlationId: string;
  idempotencyKey: string;
  data: unknown;
  connectorId?: string;
  source?: string;
  occurredAt?: string;
}

export interface FlowDispatcherDeps {
  getAppSlug(): string | null;
  /** App context handed to $app selectors ({slug, id, name}). */
  getAppContext(): Record<string, unknown>;
  fetchRuntimeFlows(slug: string): Promise<RuntimeFlows | null>;
  reserveRun(
    slug: string,
    payload: {
      flowSlug: string;
      bindingId?: string;
      triggerEvent: string;
      correlationId: string;
      idempotencyKey: string;
      inputSnapshot?: Record<string, unknown>;
      formId?: string;
      responseId?: string;
      /** Run lineage (plan §8.7): root/depth are SERVER-derived from the parent row. */
      parentRunId?: string;
      callNodeId?: string;
    }
  ): Promise<{ runId: string; idempotent?: boolean } | { error: string }>;
  completeRun(
    slug: string,
    runId: string,
    payload: { status: 'done' | 'error' | 'timeout' | 'cancelled'; result?: Record<string, unknown> | null; error?: FlowRunError | null; instanceId?: string }
  ): Promise<void>;
  /** Sandboxed condition evaluation (QuickJS — never eval). */
  evaluateCondition(expr: string, ctx: Record<string, unknown>): Promise<boolean>;
  executorDeps: FlowExecutorDeps;
  createResponse(formId: string, answers: Record<string, unknown>): Promise<unknown>;
  updateResponse(formId: string, responseId: string, answers: Record<string, unknown>): Promise<unknown>;
  connectorRequest(connectorId: string, command: string, payload?: unknown): Promise<unknown>;
  toast(message: string, level: 'info' | 'success' | 'warning' | 'error'): void;
  delay(ms: number): Promise<void>;
  // ── Queued-run claiming (docs §10) ────────────────────────────────────────────────────
  /** Claimable 'queued' runs for the active app, oldest first. */
  listQueuedRuns(slug: string, limit?: number): Promise<FlowRunLog[]>;
  /** Claim one queued run; {claimed:false} on 409 (another runtime won) or any error.
   *  `run` is the server's authoritative copy — the queued LIST omits input snapshots
   *  for non-owner members (FL-AUTH-001), so executors must prefer this over the listing. */
  claimRun(slug: string, runId: string, payload: { runtime: FlowRuntimeKind; instanceId?: string }): Promise<{ claimed: boolean; run?: FlowRunLog }>;
  // ── Workspace scope (the /flows page claim loop — docs §8/§10) ────────────────────────
  fetchWorkspaceFlows(): Promise<FlowDefinition[]>;
  listWorkspaceQueuedRuns(limit?: number): Promise<FlowRunLog[]>;
  claimWorkspaceRun(runId: string, payload: { runtime: FlowRuntimeKind; instanceId?: string }): Promise<{ claimed: boolean; run?: FlowRunLog }>;
  completeWorkspaceRun(
    runId: string,
    payload: { status: 'done' | 'error' | 'timeout' | 'cancelled'; result?: Record<string, unknown> | null; error?: FlowRunError | null; instanceId?: string }
  ): Promise<void>;
  /** Standalone-form bindings (GET /api/forms/{id}/flow-bindings) for workspace binding runs. */
  fetchFormBindings(formId: string): Promise<FlowBinding[]>;
  /** Executor capabilities OUTSIDE an app runtime (direct owner APIs, workspace KV). */
  workspaceExecutorDeps: FlowExecutorDeps;
  /**
   * True when a FormLogic Desktop flow runtime heartbeated recently. Connector
   * (aokie.*) events are DESKTOP-FIRST: the desktop has the local LLM + speech
   * services, so the browser defers those bindings/claims while the desktop is
   * alive and only takes over when its heartbeat goes stale (~90s). Optional —
   * absent (tests/legacy wiring) means "unknown", and the browser proceeds.
   */
  desktopRuntimeFresh?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Default (browser) deps — lazily bound so the module stays importable in tests.
// ---------------------------------------------------------------------------

async function defaultEvaluateCondition(expr: string, ctx: Record<string, unknown>): Promise<boolean> {
  const { evaluateCondition } = await import('../../lib/formlogic');
  return evaluateCondition(expr, ctx);
}

/** KV deps shared by both executor flavours; app-scoped while an app runtime is active. */
function buildKvDeps(): Pick<FlowExecutorDeps, 'kvGet' | 'kvSet' | 'kvList'> {
  return {
    kvGet: async (scope, k) => {
      if (currentSlug) {
        const res = await api.getAppFlowKv(currentSlug, { scope, k });
        return res.data?.entry?.v;
      }
      const res = await api.getFlowKv(scope, k);
      return res.data?.entry?.v; // missing key → 404 → undefined
    },
    kvSet: async (scope, k, v) => {
      const res = currentSlug
        ? await api.putAppFlowKv(currentSlug, { scope, k, v })
        : await api.putFlowKv({ scope, k, v });
      if (res.error) throw new Error(res.error);
      return res.data?.entry;
    },
    kvList: async (scope) => {
      const entries = currentSlug
        ? (await api.getAppFlowKv(currentSlug, { scope })).data?.entries
        : (await api.listFlowKv({ scope })).data?.entries;
      const out: Record<string, unknown> = {};
      for (const e of entries ?? []) out[e.k] = e.v;
      return out;
    },
  };
}

/**
 * §7.6 browser→Desktop service_action invoker — shared by BOTH scope builders (the
 * paired Desktop is machine-scoped, not app/workspace-scoped; the exact-action
 * capability mint is the authorization boundary). Maps the desktop client's typed
 * envelope onto the executor contract: transport failures and pairing gaps read as
 * `desktopUnreachable`, so the node degrades to its pre-route typed refusal.
 */
async function invokeDesktopServiceAction(
  req: import('./nodes').ServiceActionInvokeRequest,
): Promise<import('./nodes').ServiceActionInvokeResult> {
  const { desktopClient } = await import('../desktop/desktopClient');
  const result = await desktopClient.servicePlatform.invokeAction({
    definitionId: req.definitionId,
    actionId: req.actionId,
    connection: req.connection,
    input: req.input,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
  });
  if (!result.ok) {
    const desktopUnreachable =
      result.transportFailure === true
      || result.error.code === 'auth_required'
      || result.error.code === 'connector_unavailable';
    return { ok: false, code: result.error.code, message: result.error.message, desktopUnreachable };
  }
  const output = (result.data as { output?: unknown } | null)?.output;
  return { ok: true, output };
}

export function buildDefaultExecutorDeps(): FlowExecutorDeps {
  return {
    // Read live, not captured: the runtime app can change after these deps are built.
    get appSlug(): string | undefined {
      return currentSlug ?? undefined;
    },
    // NOTE: these forward the node's clamped `timeoutMs` (nodes.ts) as `budgetMs` — the
    // BINDING-level `defaultEvaluateCondition` above is a separate, 2-arg-only evaluator
    // and is NOT reused here for exactly that reason.
    evaluateBoolean: async (expr, ctx, budgetMs) => {
      const { evaluateCondition } = await import('../../lib/formlogic');
      return evaluateCondition(expr, ctx, budgetMs);
    },
    evaluateExpression: async (expr, ctx, budgetMs) => {
      // logic_block uses the non-swallowing variant: a timeout/error must fail the
      // flow run loudly (docs §4), not resolve to null like the calculated-field path.
      const { calculateValueForFlow } = await import('../../lib/formlogic');
      return calculateValueForFlow(expr, ctx, budgetMs);
    },
    listResponses: async (formId, query) => {
      const { useAppRuntimeStore } = await import('../../stores/appRuntimeStore');
      return useAppRuntimeStore.getState().fetchResponses(formId, {
        limit: typeof query?.limit === 'number' ? query.limit : undefined,
        offset: typeof query?.offset === 'number' ? query.offset : undefined,
        answersEq:
          query?.answersEq && typeof query.answersEq === 'object'
            ? (query.answersEq as Record<string, string>)
            : undefined,
        answersPhoneEq:
          query?.answersPhoneEq && typeof query.answersPhoneEq === 'object'
            ? (query.answersPhoneEq as Record<string, string>)
            : undefined,
        answersGte:
          query?.answersGte && typeof query.answersGte === 'object'
            ? (query.answersGte as Record<string, string>)
            : undefined,
        answersLte:
          query?.answersLte && typeof query.answersLte === 'object'
            ? (query.answersLte as Record<string, string>)
            : undefined,
      });
    },
    submitResponse: async (formId, answers) => {
      const { useAppRuntimeStore } = await import('../../stores/appRuntimeStore');
      return useAppRuntimeStore.getState().createResponse(formId, answers);
    },
    updateResponse: async (formId, responseId, answers) => {
      const { useAppRuntimeStore } = await import('../../stores/appRuntimeStore');
      return useAppRuntimeStore.getState().updateResponse(formId, responseId, { answers });
    },
    connectorRequest: async (connectorId, command, payload) => {
      const { getConnectorClient } = await import('../connectors/nativeConnectorClient');
      return getConnectorClient().request(connectorId, command, payload);
    },
    ...buildKvDeps(),
    resolveDesktopLlmEndpoint: () => resolveDesktopLlmEndpoint(),
    resolveAiProvider: (capability, providerId) => resolveProviderRequest(useAuthStore.getState().user?.id, capability, providerId),
    invokeDesktopAiChat: (providerId, body, signal) => invokeDesktopNamedAiChat(providerId, body, signal),
    getAppAiBase: () => {
      const v = appContext.aiBaseUrl;
      return typeof v === 'string' && v !== '' ? v : null;
    },
    resolveDesktopServiceBase: (id) => resolveDesktopServiceBase(id),
    listDesktopServices: () => listDesktopServices(),
    // flow_call's browser FlowInvoker (plan §8.5) — shared guard core + APP backend.
    invokeChildFlow: (req) => invokeChildFlowWith(appChildFlowBackend(), req),
    // service_action's §7.6 Desktop leg (machine-scoped — identical in both builders).
    invokeServiceAction: (req) => invokeDesktopServiceAction(req),
  };
}

/**
 * Executor deps for WORKSPACE-scope runs (the /flows page claim loop): no app runtime
 * store exists there, so formlogic.* nodes hit the owner APIs directly and KV uses the
 * workspace store. Same QuickJS sandbox, same connector client, same desktop AI routing.
 */
export function buildWorkspaceExecutorDeps(): FlowExecutorDeps {
  return {
    evaluateBoolean: async (expr, ctx, budgetMs) => {
      const { evaluateCondition } = await import('../../lib/formlogic');
      return evaluateCondition(expr, ctx, budgetMs);
    },
    evaluateExpression: async (expr, ctx, budgetMs) => {
      const { calculateValueForFlow } = await import('../../lib/formlogic');
      return calculateValueForFlow(expr, ctx, budgetMs);
    },
    listResponses: async (formId, query) => {
      const res = await api.getResponses(formId, {
        limit: typeof query?.limit === 'number' ? query.limit : undefined,
        offset: typeof query?.offset === 'number' ? query.offset : undefined,
        answersEq:
          query?.answersEq && typeof query.answersEq === 'object'
            ? (query.answersEq as Record<string, string>)
            : undefined,
        answersPhoneEq:
          query?.answersPhoneEq && typeof query.answersPhoneEq === 'object'
            ? (query.answersPhoneEq as Record<string, string>)
            : undefined,
        answersGte:
          query?.answersGte && typeof query.answersGte === 'object'
            ? (query.answersGte as Record<string, string>)
            : undefined,
        answersLte:
          query?.answersLte && typeof query.answersLte === 'object'
            ? (query.answersLte as Record<string, string>)
            : undefined,
      });
      if (res.error) throw new Error(res.error);
      return res.data?.responses ?? [];
    },
    submitResponse: async (formId, answers) => {
      const res = await api.submitResponse(formId, { answers });
      if (res.error) throw new Error(res.error);
      return res.data?.response;
    },
    updateResponse: async (formId, responseId, answers) => {
      const res = await api.updateResponse(formId, responseId, { answers });
      if (res.error) throw new Error(res.error);
      return res.data?.response;
    },
    connectorRequest: async (connectorId, command, payload) => {
      const { getConnectorClient } = await import('../connectors/nativeConnectorClient');
      return getConnectorClient().request(connectorId, command, payload);
    },
    kvGet: async (scope, k) => (await api.getFlowKv(scope, k)).data?.entry?.v,
    kvSet: async (scope, k, v) => {
      const res = await api.putFlowKv({ scope, k, v });
      if (res.error) throw new Error(res.error);
      return res.data?.entry;
    },
    kvList: async (scope) => {
      const out: Record<string, unknown> = {};
      for (const e of (await api.listFlowKv({ scope })).data?.entries ?? []) out[e.k] = e.v;
      return out;
    },
    resolveDesktopLlmEndpoint: () => resolveDesktopLlmEndpoint(),
    resolveAiProvider: (capability, providerId) => resolveProviderRequest(useAuthStore.getState().user?.id, capability, providerId),
    invokeDesktopAiChat: (providerId, body, signal) => invokeDesktopNamedAiChat(providerId, body, signal),
    getAppAiBase: () => null,
    resolveDesktopServiceBase: (id) => resolveDesktopServiceBase(id),
    listDesktopServices: () => listDesktopServices(),
    // flow_call in WORKSPACE scope (Test Run drawer + workspace queued runs): the shared
    // guard core with the owner-scoped backend. NOTE the two builders wire DIFFERENT
    // backends — a scope mix-up here silently strands flow_call (pinned by
    // childFlowInvoker.test.ts's wiring assertions).
    invokeChildFlow: (req) => invokeChildFlowWith(workspaceChildFlowBackend(), req),
    // service_action's §7.6 Desktop leg (machine-scoped — identical in both builders).
    invokeServiceAction: (req) => invokeDesktopServiceAction(req),
  };
}

function buildDefaultDeps(): FlowDispatcherDeps {
  const executorDeps = buildDefaultExecutorDeps();
  return {
    getAppSlug: () => currentSlug,
    getAppContext: () => appContext,
    fetchRuntimeFlows: async (slug) => {
      const res = await api.getAppFlows(slug);
      return res.data ?? null;
    },
    reserveRun: async (slug, payload) => {
      const res = await api.reserveFlowRun(slug, payload);
      if (res.error || !res.data) return { error: res.error ?? 'Reserve failed' };
      return { runId: res.data.runId, idempotent: res.data.idempotent };
    },
    completeRun: async (slug, runId, payload) => {
      const res = await api.completeFlowRun(slug, runId, payload);
      if (res.error) logger.warn('[flows] completeRun failed:', res.error);
    },
    evaluateCondition: defaultEvaluateCondition,
    executorDeps,
    createResponse: executorDeps.submitResponse,
    updateResponse: executorDeps.updateResponse,
    connectorRequest: executorDeps.connectorRequest,
    toast: (message, level) => {
      void import('../../stores/toastStore').then(({ toast }) => {
        if (level === 'error') toast.error(message);
        else if (level === 'success') toast.success(message);
        else if (level === 'warning') toast.warning(message);
        else toast.info(message);
      });
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    listQueuedRuns: async (slug, limit) => {
      const res = await api.listQueuedAppFlowRuns(slug, limit);
      return res.data?.runs ?? [];
    },
    claimRun: async (slug, runId, payload) => {
      const res = await api.claimAppFlowRun(slug, runId, payload);
      // 409 (already claimed) and every other failure mean the same thing here: not ours.
      return { claimed: !res.error && !!res.data, run: res.data?.run };
    },
    fetchWorkspaceFlows: async () => {
      const flows = (await api.listWorkspaceFlows()).data?.flows ?? [];
      return api.isDemoMode() ? demoApplyFlowOverlay(null, flows) : flows;
    },
    listWorkspaceQueuedRuns: async (limit) => (await api.listMyQueuedFlowRuns(limit)).data?.runs ?? [],
    claimWorkspaceRun: async (runId, payload) => {
      const res = await api.claimMyFlowRun(runId, payload);
      return { claimed: !res.error && !!res.data, run: res.data?.run };
    },
    completeWorkspaceRun: async (runId, payload) => {
      const res = await api.completeMyFlowRun(runId, payload);
      if (res.error) logger.warn('[flows] completeWorkspaceRun failed:', res.error);
    },
    fetchFormBindings: async (formId) => {
      const bindings = (await api.listFormFlowBindings(formId)).data?.bindings ?? [];
      return api.isDemoMode() ? demoApplyFormBindingOverlay(formId, bindings) : bindings;
    },
    workspaceExecutorDeps: buildWorkspaceExecutorDeps(),
    desktopRuntimeFresh: defaultDesktopRuntimeFresh,
  };
}

// ---------------------------------------------------------------------------
// Module state (one dispatcher per page — matches the desktop event hub).
// ---------------------------------------------------------------------------

let deps: FlowDispatcherDeps | null = null;
let runtime: RuntimeFlows | null = null;
let currentSlug: string | null = null;
let appContext: Record<string, unknown> = {};
let unsubscribeHub: (() => void) | null = null;
let startToken = 0; // invalidates in-flight loads after stop/restart
let claimTimer: ReturnType<typeof setInterval> | null = null;
let claimSweepInFlight = false;

function getDeps(): FlowDispatcherDeps {
  if (!deps) deps = buildDefaultDeps();
  return deps;
}

/** Override dispatcher deps (merged over the defaults). Test-only. */
export function __setFlowDispatcherDepsForTests(overrides: Partial<FlowDispatcherDeps>): void {
  deps = { ...buildDefaultDeps(), ...overrides };
}

/** Seed the loaded runtime flows directly (skips the fetch). Test-only. */
export function __setRuntimeFlowsForTests(flows: RuntimeFlows | null, slug: string | null): void {
  runtime = flows;
  currentSlug = slug;
}

/** Reset all dispatcher state. Test-only. */
export function __resetFlowDispatcherForTests(): void {
  unsubscribeHub?.();
  unsubscribeHub = null;
  stopClaimTimer();
  claimSweepInFlight = false;
  deps = null;
  runtime = null;
  currentSlug = null;
  appContext = {};
  startToken += 1;
  resetBrowserConnectorEventQueues();
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

/**
 * Start the dispatcher for an app: load its enabled flows/bindings and, when any event
 * bindings exist, subscribe to the desktop event hub. Returns a stop function. Safe to
 * call for apps without flows — everything stays inert on an empty set.
 */
export function startFlowDispatcher(
  appSlug: string,
  context?: Record<string, unknown>
): () => void {
  const token = ++startToken;
  currentSlug = appSlug;
  appContext = { slug: appSlug, ...(context ?? {}) };

  void (async () => {
    let flows: RuntimeFlows | null = null;
    try {
      flows = await getDeps().fetchRuntimeFlows(appSlug);
    } catch (err) {
      logger.warn('[flows] failed to load runtime flows:', err);
    }
    if (token !== startToken) return; // stopped/restarted while loading
    runtime = flows;
    const eventBindings = (flows?.bindings ?? []).filter(
      (b) => b.mode !== 'manual' && b.event !== 'form.submitted' && b.event !== 'manual'
    );
    if (eventBindings.length > 0 && !unsubscribeHub) {
      unsubscribeHub = subscribeDesktopEvents(onDesktopEvent);
    }
    // Queued-run claiming (docs §10): while this app session is open it picks up runs the
    // server enqueued (form.submitted bindings, ctx.flows.run intents) — immediately, then
    // every CLAIM_POLL_INTERVAL_MS. Nothing to execute without flow definitions.
    if ((flows?.flows.length ?? 0) > 0) {
      void claimQueuedAppRuns();
      // Clear any interval a prior (unstopped) start left running before we
      // reassign — a re-entrant startFlowDispatcher (app switch without cleanup)
      // would otherwise leak the old interval, which keeps polling forever.
      stopClaimTimer();
      claimTimer = setInterval(() => void claimQueuedAppRuns(), CLAIM_POLL_INTERVAL_MS);
    }
  })();

  return () => {
    if (token !== startToken) return; // a newer start owns the state now
    startToken += 1;
    unsubscribeHub?.();
    unsubscribeHub = null;
    stopClaimTimer();
    runtime = null;
    currentSlug = null;
    appContext = {};
    resetBrowserConnectorEventQueues();
  };
}

function stopClaimTimer(): void {
  if (claimTimer !== null) {
    clearInterval(claimTimer);
    claimTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Desktop-first routing for connector events.
// ---------------------------------------------------------------------------

/** Events owned by the desktop runtime while it is alive (local LLM + speech). */
export function isDesktopFirstEvent(name: string): boolean {
  return name.startsWith('aokie.');
}

/**
 * Shared desktop-first gate (audit FL-001: the browser must be a VIEWER, not a
 * second writer): true when this event belongs to the desktop runtime AND a
 * cloud-linked desktop flow runtime is heartbeating — the browser then skips
 * running raw app-logic/bindings for it. Used by both the flow dispatcher and
 * the app-logic connector-event bridge so the two writers can never disagree.
 * Fails open (false) — an unreachable probe must never strand an event.
 */
export async function shouldDeferEventToDesktop(eventName: string): Promise<boolean> {
  if (!isDesktopFirstEvent(eventName)) return false;
  try {
    const probe = getDeps().desktopRuntimeFresh;
    return probe ? await probe() : false;
  } catch {
    return false;
  }
}

let desktopFreshCache: { at: number; fresh: boolean } | null = null;

/** 30s-cached "is a desktop flow runtime heartbeating?" probe (default dep impl). */
export async function defaultDesktopRuntimeFresh(): Promise<boolean> {
  const now = Date.now();
  if (desktopFreshCache && now - desktopFreshCache.at < 30_000) return desktopFreshCache.fresh;
  let fresh = false;
  try {
    const res = await api.getDesktopConnections();
    // ROUTE-001 wrapped the payload as {connections:[...]} — the old
    // bare-array read silently saw ZERO rows, the probe reported "no
    // desktop", and the browser stopped deferring: every aokie.* record
    // got written TWICE (desktop runtime + browser app-logic — live
    // report 2026-07-13, duplicated transcript turns). Accept both
    // shapes.
    const data = res.data as unknown;
    const rows = Array.isArray(data)
      ? data
      : data && Array.isArray((data as { connections?: unknown }).connections)
        ? (data as { connections: unknown[] }).connections
        : [];
    fresh = rows.some((c) => {
      const raw = (c as { lastSeenAt?: unknown }).lastSeenAt;
      if (typeof raw !== 'string' || raw === '') return false;
      // The API serves MySQL TIMESTAMPs through a session pinned to UTC
      // (MySQLConnection SET time_zone '+00:00'), so the zone-less
      // "YYYY-MM-DD HH:MM:SS" wire format IS UTC — parse it that way.
      // Parsing it as LOCAL made every heartbeat look hours stale on any
      // non-UTC browser (Brisbane: 10h), the probe answered "no desktop"
      // forever, and the browser double-wrote every aokie.* record — the
      // REAL root cause behind the duplicated transcripts (2026-07-13;
      // the earlier {connections} shape fix was necessary but not enough).
      const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
        ? raw.replace(' ', 'T') + 'Z'
        : raw;
      const ms = Date.parse(normalised);
      return !Number.isNaN(ms) && now - ms < 90_000;
    });
  } catch {
    fresh = false; // can't tell → let the browser act (never strand an event)
  }
  desktopFreshCache = { at: now, fresh };
  return fresh;
}

/** Should the browser defer this event to the desktop runtime? Never throws. */
async function deferToDesktop(eventName: string): Promise<boolean> {
  return shouldDeferEventToDesktop(eventName);
}

function onDesktopEvent(envelope: DesktopEventEnvelope): void {
  void enqueueBrowserConnectorEvent(envelope, () =>
    handleEvent({
      name: envelope.name,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      data: envelope.data,
      connectorId: envelope.connectorId ?? envelope.source,
      source: envelope.source,
      occurredAt: envelope.occurredAt,
    })
  ).catch((error) => logger.warn('[flows] browser event queue task failed:', error));
}

/**
 * Feed a form event through the same binding pipeline as desktop events. Called from the
 * app runtime's onAfterSubmit path with the created response. Awaits sync bindings.
 */
export async function dispatchFormEvent(
  name: 'form.submitted' | string,
  detail: { formId: string; responseId?: string; answers?: Record<string, unknown> }
): Promise<void> {
  const key = detail.responseId ?? newIdempotencyKey();
  await handleEvent({
    name,
    correlationId: detail.responseId ?? key,
    idempotencyKey: `${name}:${detail.formId}:${key}`,
    data: detail,
  });
}

// ---------------------------------------------------------------------------
// Binding pipeline.
// ---------------------------------------------------------------------------

function findFlow(slug: string): RuntimeFlowDefinition | undefined {
  return runtime?.flows.find((f) => f.slug === slug);
}

/** flow_call target resolution — by STABLE id (plan §8.1; slugs are aliases). */
function findFlowById(flowId: string): RuntimeFlowDefinition | undefined {
  return runtime?.flows.find((f) => f.id === flowId);
}

/**
 * APP-runtime flow_call backend (plan §8.5): the shared invoker core
 * (childFlowInvoker.ts) owns the guards; this supplies the app runtime's flow list
 * (the allowlist), app-scoped run APIs, and app executor deps.
 */
function appChildFlowBackend(): ChildFlowBackend {
  return {
    scope: 'app runtime',
    resolveFlow: async (flowId) => {
      const d = getDeps();
      if (!d.getAppSlug()) throw new Error('dependency_missing: flow_call requires an app runtime');
      const flow = findFlowById(flowId);
      return flow ? { slug: flow.slug, flowJson: flow.flowJson, nodeCapabilities: flow.nodeCapabilities } : null;
    },
    reserveRun: async (flow, req) => {
      const d = getDeps();
      const slug = d.getAppSlug();
      if (!slug) return { error: 'no app runtime' };
      const correlationId = newIdempotencyKey();
      const reservation = await d.reserveRun(slug, {
        flowSlug: flow.slug,
        triggerEvent: 'flow.call',
        correlationId,
        idempotencyKey: `flowcall:${req.callNodeId}:${correlationId}`,
        inputSnapshot: req.inputs,
        // Lineage (plan §8.7): the server derives root/depth from the parent row.
        parentRunId: req.parentRunId,
        callNodeId: req.callNodeId,
      });
      return reservation;
    },
    completeRun: async (runId, outcome) => {
      const d = getDeps();
      const slug = d.getAppSlug();
      if (!slug) return;
      try {
        if (outcome.status === 'done') {
          await d.completeRun(slug, runId, { status: 'done', result: normalizeResult(outcome.result) ?? {} });
        } else {
          await d.completeRun(slug, runId, {
            status: outcome.status,
            error: outcome.error ?? { code: 'node_failed', message: 'Flow failed' },
          });
        }
      } catch (err) {
        logger.warn('[flows] child completeRun failed:', err);
      }
    },
    appContext: () => getDeps().getAppContext(),
    executorDeps: () => getDeps().executorDeps,
  };
}

/**
 * WORKSPACE flow_call backend: owner-scoped flow list + run APIs — what makes flow_call
 * work in the Test Run drawer and workspace queued runs (previously a typed refusal).
 * Children resolve only within the caller's own enabled workspace flows.
 */
function workspaceChildFlowBackend(): ChildFlowBackend {
  return {
    scope: 'workspace',
    resolveFlow: async (flowId) => {
      const flows = (await api.listWorkspaceFlows()).data?.flows ?? [];
      const flow = flows.find((f) => f.id === flowId && f.enabled);
      return flow ? { slug: flow.slug, flowJson: flow.flowJson, nodeCapabilities: flow.nodeCapabilities } : null;
    },
    reserveRun: async (flow, req) => {
      const correlationId = newIdempotencyKey();
      const res = await api.reserveMyFlowRun({
        flowSlug: flow.slug,
        triggerEvent: 'flow.call',
        correlationId,
        idempotencyKey: `flowcall:${req.callNodeId}:${correlationId}`,
        inputSnapshot: req.inputs,
        parentRunId: req.parentRunId,
        callNodeId: req.callNodeId,
      });
      if (res.error || !res.data) return { error: res.error ?? 'Reserve failed' };
      return { runId: res.data.run.runId };
    },
    completeRun: async (runId, outcome) => {
      try {
        if (outcome.status === 'done') {
          await api.completeMyFlowRun(runId, { status: 'done', result: normalizeResult(outcome.result) ?? {} });
        } else {
          await api.completeMyFlowRun(runId, {
            status: outcome.status,
            error: outcome.error ?? { code: 'node_failed', message: 'Flow failed' },
          });
        }
      } catch (err) {
        logger.warn('[flows] workspace child completeRun failed:', err);
      }
    },
    appContext: () => undefined,
    executorDeps: () => buildWorkspaceExecutorDeps(),
  };
}

function bindingMatches(binding: RuntimeFlowBinding, event: FlowTriggerEvent): boolean {
  if (binding.mode === 'manual') return false;
  if (binding.event !== event.name) return false;
  if (binding.formId) {
    const formId = (event.data as { formId?: unknown } | null)?.formId;
    if (formId !== binding.formId) return false;
  }
  if (binding.connectorId) {
    if (event.connectorId !== binding.connectorId && event.source !== binding.connectorId) return false;
  }
  return true;
}

async function handleEvent(event: FlowTriggerEvent): Promise<void> {
  const slug = getDeps().getAppSlug();
  if (!slug || !runtime) return;
  if (await deferToDesktop(event.name)) {
    logger.warn(`[flows] deferring ${event.name} to the desktop runtime (heartbeat fresh)`);
    return;
  }
  const matches = runtime.bindings.filter((b) => bindingMatches(b, event));
  for (const binding of matches) {
    if (binding.mode === 'sync') {
      await runBinding(slug, binding, event);
    } else {
      // async and background both run detached; async failures are logged (tracked),
      // background is fire-and-forget by contract — same handling in the browser.
      void runBinding(slug, binding, event).catch((err) => {
        logger.warn(`[flows] ${binding.mode} binding ${binding.id} failed:`, err);
      });
    }
  }
}

/** Evaluate a binding condition fail-SAFE: absent → true; error/false → skip. */
async function conditionPasses(binding: RuntimeFlowBinding, event: FlowTriggerEvent): Promise<boolean> {
  const expr = binding.condition?.expr;
  if (!expr) return true;
  try {
    return await getDeps().evaluateCondition(expr, { event: event as unknown as Record<string, unknown> });
  } catch (err) {
    logger.warn(`[flows] binding ${binding.id} condition errored (skipping):`, err);
    return false;
  }
}

function retryDelayMs(policy: RuntimeFlowBinding['retryPolicy'] | undefined, attempt: number): number {
  const backoff = policy?.backoff ?? 'exponential';
  if (backoff === 'none') return 0;
  if (backoff === 'fixed') return RETRY_BASE_DELAY_MS;
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** Wrap a non-object executor result so the stored result_json stays an object. */
function normalizeResult(result: unknown): Record<string, unknown> | null {
  if (result === undefined || result === null) return null;
  if (typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  return { value: result };
}

async function runBinding(
  slug: string,
  binding: RuntimeFlowBinding,
  event: FlowTriggerEvent
): Promise<FlowRunOutcome | null> {
  const d = getDeps();
  if (!(await conditionPasses(binding, event))) return null;

  const flow = findFlow(binding.flow);
  if (!flow) {
    logger.warn(`[flows] binding ${binding.id} references unknown/disabled flow '${binding.flow}'`);
    return null;
  }

  const scope: SelectorScope = { event, app: d.getAppContext() };
  const inputs = buildInputs(binding.inputMap, scope);

  // Reserve FIRST (docs §2): the UNIQUE idempotency key means duplicate events across
  // tabs/retries run the flow at most once.
  const idempotencyKey = `flow:${binding.id}:${event.idempotencyKey}`;
  const eventData = event.data as { formId?: unknown; responseId?: unknown } | null;
  let reservation: { runId: string; idempotent?: boolean } | { error: string };
  try {
    reservation = await d.reserveRun(slug, {
      flowSlug: binding.flow,
      bindingId: binding.id,
      triggerEvent: event.name,
      correlationId: event.correlationId,
      idempotencyKey,
      inputSnapshot: inputs,
      formId: typeof eventData?.formId === 'string' ? eventData.formId : undefined,
      responseId: typeof eventData?.responseId === 'string' ? eventData.responseId : undefined,
    });
  } catch (err) {
    logger.warn(`[flows] binding ${binding.id} reserve failed:`, err);
    return null;
  }
  if ('error' in reservation) {
    logger.warn(`[flows] binding ${binding.id} reserve rejected: ${reservation.error}`);
    return null;
  }
  if (reservation.idempotent) return null; // duplicate event — another reservation won

  const outcome = await executeAndComplete(slug, binding, flow, inputs, event, reservation.runId);

  // Fallback fires when the flow graph itself failed (unchanged) OR it succeeded but a
  // downstream output action threw (e.g. a sync/live-call binding's only reply-carrying
  // action) — the run log still reads 'done' either way; this is purely an in-memory
  // follow-up decision, not a change to what got persisted.
  if (outcome.status !== 'done' || (outcome.actionErrors && outcome.actionErrors.length > 0)) {
    applyFallback(binding, outcome);
  }
  return outcome;
}

/** The structural subset of a binding both scopes share (RuntimeFlowBinding ⊂, FlowBinding ⊂). */
type ClaimableBinding = Pick<
  RuntimeFlowBinding,
  'id' | 'flow' | 'condition' | 'inputMap' | 'outputActions' | 'timeoutMs' | 'retryPolicy' | 'fallbackPolicy' | 'mode'
>;

/** The flow fields execution needs (RuntimeFlowDefinition ⊂, FlowDefinition ⊂). */
type ExecutableFlow = Pick<RuntimeFlowDefinition, 'id' | 'slug' | 'flowJson' | 'nodeCapabilities'>;

/** The write capabilities outputActions go through (app-scoped by default; workspace injects its own). */
interface OutputActionDeps {
  createResponse(formId: string, answers: Record<string, unknown>): Promise<unknown>;
  updateResponse(formId: string, responseId: string, answers: Record<string, unknown>): Promise<unknown>;
  connectorRequest(connectorId: string, command: string, payload?: unknown): Promise<unknown>;
  toast(message: string, level: 'info' | 'success' | 'warning' | 'error'): void;
  kvSet?(scope: string, key: string, value: unknown): Promise<unknown>;
}

function appActionDeps(): OutputActionDeps {
  const d = getDeps();
  return {
    createResponse: d.createResponse,
    updateResponse: d.updateResponse,
    connectorRequest: d.connectorRequest,
    toast: d.toast,
    kvSet: d.executorDeps.kvSet?.bind(d.executorDeps),
  };
}

/** Retry → outputActions → complete, shared by live-event runs and claimed queued runs. */
async function executeRun(opts: {
  flow: ExecutableFlow;
  binding: ClaimableBinding | null;
  inputs: Record<string, unknown>;
  event?: FlowTriggerEvent;
  executorDeps: FlowExecutorDeps;
  actionDeps: OutputActionDeps;
  app: Record<string, unknown>;
  timeoutMs?: number;
  /** This run's reserved run-log id (flow_call lineage seed — plan §8.7). */
  runId?: string;
  complete(payload: {
    status: 'done' | 'error' | 'timeout' | 'cancelled';
    result?: Record<string, unknown> | null;
    error?: FlowRunError | null;
  }): Promise<void>;
}): Promise<FlowRunOutcome> {
  const d = getDeps();
  const { flow, binding, inputs, event } = opts;
  const maxAttempts = Math.min(Math.max(binding?.retryPolicy?.maxAttempts ?? 1, 1), MAX_RETRY_ATTEMPTS);

  let outcome: FlowRunOutcome = {
    status: 'error',
    error: { code: 'runner_unavailable', message: 'Flow was never executed' },
    nodesExecuted: 0,
  };
  // RUN-301: contributed nodes execute the SERVER-compiled canonical IR (the compiler is the
  // only lowering authority). Resolution is deterministic, so it happens ONCE outside the
  // retry loop; a blocked compile is a typed run error, never an unknown-node crash mid-run.
  const resolved = await resolveExecutableGraph(flow.id, flow.flowJson);
  if (!resolved.ok) {
    outcome = { status: 'error', error: resolved.error, nodesExecuted: 0 };
  } else {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      outcome = await executeFlow(resolved.graph, {
        inputs,
        event,
        app: opts.app,
        timeoutMs: opts.timeoutMs ?? binding?.timeoutMs,
        deps: opts.executorDeps,
        capabilities: flow.nodeCapabilities,
        flowSlug: flow.slug,
        // flow_call ancestry seed (plan §8.8) — absent id (older runtime payloads) leaves
        // flow_call refusing typed rather than running unguarded.
        callStack: flow.id ? [flow.id] : undefined,
        runId: opts.runId,
      });
      if (outcome.status === 'done') break;
      if (attempt < maxAttempts) {
        const wait = retryDelayMs(binding?.retryPolicy, attempt);
        if (wait > 0) await d.delay(wait);
      }
    }
  }

  const actionErrors: string[] = [];
  if (outcome.status === 'done' && binding) {
    const scope: SelectorScope = { event, app: opts.app, result: outcome.result, inputs };
    for (const action of binding.outputActions ?? []) {
      try {
        await applyOutputAction(action, scope, opts.actionDeps, flow.slug);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actionErrors.push(`${action.type}: ${msg}`);
        logger.warn(`[flows] binding ${binding.id} output action ${action.type} failed:`, msg);
      }
    }
  }

  try {
    if (outcome.status === 'done') {
      const result = normalizeResult(outcome.result) ?? {};
      if (actionErrors.length > 0) result.outputActionErrors = actionErrors;
      await opts.complete({ status: 'done', result });
    } else {
      await opts.complete({
        status: outcome.status,
        error: outcome.error ?? { code: 'node_failed', message: 'Flow failed' },
      });
    }
  } catch (err) {
    logger.warn('[flows] completeRun failed:', err);
  }

  // Surface the collected outputAction failures on the RETURNED outcome (in-memory only —
  // what was just persisted above via opts.complete is untouched: status stays 'done' when
  // the flow graph itself succeeded). This is what lets runBinding's fallback check below
  // catch "the flow succeeded but its only reply-carrying side effect didn't".
  if (actionErrors.length > 0) {
    outcome = { ...outcome, actionErrors };
  }

  return outcome;
}

async function executeAndComplete(
  slug: string,
  binding: RuntimeFlowBinding,
  flow: RuntimeFlowDefinition,
  inputs: Record<string, unknown>,
  event: FlowTriggerEvent,
  runId: string
): Promise<FlowRunOutcome> {
  const d = getDeps();
  return executeRun({
    flow,
    binding,
    inputs,
    event,
    executorDeps: d.executorDeps,
    actionDeps: appActionDeps(),
    app: d.getAppContext(),
    runId,
    complete: (payload) => d.completeRun(slug, runId, payload),
  });
}

function applyFallback(binding: RuntimeFlowBinding, outcome: FlowRunOutcome): void {
  const d = getDeps();
  const policy = binding.fallbackPolicy;
  // Sync (live-call) bindings surface the configured fallbackReply on failure/timeout.
  if (binding.mode === 'sync' && policy?.fallbackReply) {
    d.toast(policy.fallbackReply, 'warning');
    return;
  }
  if (policy?.onError === 'surface_error') {
    d.toast(outcome.error?.message ?? `Flow '${binding.flow}' failed`, 'error');
  }
  // Default log_and_continue: already logged; nothing surfaces to the viewer.
}

/**
 * 'formlogic.store' is new in flows-v1 and not yet carried by the foundation-owned
 * FlowOutputActionType union in types/flows.ts — local structural shape until it lands.
 * Backend whitelist + flow-binding.schema.json already accept it.
 */
interface StoreOutputActionShape {
  type: string;
  scope?: string;
  key?: string;
  value?: unknown;
  when?: string;
}

async function applyOutputAction(
  action: NonNullable<RuntimeFlowBinding['outputActions']>[number],
  scope: SelectorScope,
  deps: OutputActionDeps,
  flowSlug?: string
): Promise<void> {
  const d = deps;
  if (!whenPasses(action.when, scope)) return;
  const templateCtx = scopeToContext(scope);

  // formlogic.store {scope?, key, value}: persist part of the result into Flow KV (docs §9).
  if ((action as StoreOutputActionShape).type === 'formlogic.store') {
    const store = action as StoreOutputActionShape;
    if (!d.kvSet) throw new Error('this runtime has no KV access');
    const key = resolveSelector(store.key, scope);
    if (typeof key !== 'string' || key === '') throw new Error('store action key did not resolve');
    const kvScope = typeof store.scope === 'string' && store.scope !== ''
      ? store.scope
      : flowSlug
        ? `flow:${flowSlug}`
        : 'app';
    await d.kvSet(kvScope, key, resolveDeep(store.value, scope) ?? null);
    return;
  }

  switch (action.type) {
    case 'formlogic.toast':
      d.toast(interpolateTemplate(action.message ?? '', templateCtx), 'info');
      return;
    case 'formlogic.submitResponse': {
      if (!action.form) throw new Error('submitResponse action is missing form');
      const answers = resolveDeep(action.answers, scope);
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new Error('answers did not resolve to an object');
      }
      await d.createResponse(action.form, answers as Record<string, unknown>);
      return;
    }
    case 'formlogic.updateResponse': {
      if (!action.form) throw new Error('updateResponse action is missing form');
      const responseId = resolveSelector(action.responseId, scope);
      if (typeof responseId !== 'string' || responseId === '') {
        throw new Error('responseId did not resolve');
      }
      const answers = resolveDeep(action.answers, scope);
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new Error('answers did not resolve to an object');
      }
      await d.updateResponse(action.form, responseId, answers as Record<string, unknown>);
      return;
    }
    case 'connector.request': {
      if (!action.connectorId || !action.command) throw new Error('connector.request action is missing connectorId/command');
      await d.connectorRequest(action.connectorId, action.command, resolveDeep(action.payload, scope));
      return;
    }
    case 'call.speak': {
      // Speak into the live call via the aokie connector's operatorSpeak command; the
      // standard connector permission gate applies at the connector layer. Phase 0:
      // the triggering event's callId rides along so the plugin can refuse a stale
      // action (typed stale_call) instead of speaking it into the NEXT call.
      const speakPayload: Record<string, unknown> = {
        text: interpolateTemplate(action.message ?? '', templateCtx),
      };
      const speakCallId = resolveDeep('$event.data.callId', scope);
      if (typeof speakCallId === 'string' && speakCallId !== '') speakPayload.callId = speakCallId;
      // §9.2: when the triggering event IS a caller turn, name it — a newer
      // caller turn makes this action stale (typed stale_turn, benign here).
      const speakTurn = resolveDeep('$event.data.turn', scope);
      const speakSpeaker = resolveDeep('$event.data.speaker', scope);
      if (typeof speakTurn === 'number' && speakSpeaker === 'caller') {
        speakPayload.inResponseTo = speakTurn;
      }
      await d.connectorRequest('aokie', 'call.operatorSpeak', speakPayload);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Direct runs (flow.run effect + manual bindings / panel test-runs).
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
  input?: Record<string, unknown>;
  mode?: 'sync' | 'async';
  timeoutMs?: number;
  triggerEvent?: string;
}

/**
 * Run a flow by slug outside the event pipeline (the `flow.run` app-logic effect and
 * manual bindings). Reserves + completes a run log like any other run. Sync resolves with
 * the flow result; async resolves {queued:true} as soon as the run is reserved.
 */
export async function runFlowBySlug(flowSlug: string, options: RunFlowOptions = {}): Promise<unknown> {
  const d = getDeps();
  const slug = d.getAppSlug();
  if (!slug) throw new Error('Flows are not available outside an app runtime');
  const flow = findFlow(flowSlug);
  if (!flow) throw new Error(`Unknown or disabled flow '${flowSlug}'`);

  const correlationId = newIdempotencyKey();
  const reservation = await d.reserveRun(slug, {
    flowSlug,
    triggerEvent: options.triggerEvent ?? 'manual',
    correlationId,
    idempotencyKey: `flowrun:${flowSlug}:${correlationId}`,
    inputSnapshot: options.input,
  });
  if ('error' in reservation) throw new Error(reservation.error);

  const run = async (): Promise<unknown> => {
    // RUN-301: contributed nodes execute the server-compiled canonical IR; a blocked
    // compile completes the reserved run with the typed error below.
    const resolved = await resolveExecutableGraph(flow.id, flow.flowJson);
    const outcome: FlowRunOutcome = resolved.ok
      ? await executeFlow(resolved.graph, {
        inputs: options.input ?? {},
        app: d.getAppContext(),
        // Undefined → the executor's adaptive default (longer for AI/service flows).
        timeoutMs: options.timeoutMs,
        deps: d.executorDeps,
        capabilities: flow.nodeCapabilities,
        flowSlug: flow.slug,
        callStack: flow.id ? [flow.id] : undefined,
        runId: reservation.runId,
      })
      : { status: 'error', error: resolved.error, nodesExecuted: 0 };
    try {
      if (outcome.status === 'done') {
        await d.completeRun(slug, reservation.runId, { status: 'done', result: normalizeResult(outcome.result) ?? {} });
      } else {
        await d.completeRun(slug, reservation.runId, {
          status: outcome.status,
          error: outcome.error ?? { code: 'node_failed', message: 'Flow failed' },
        });
      }
    } catch (err) {
      logger.warn('[flows] completeRun failed:', err);
    }
    if (outcome.status !== 'done') {
      throw new Error(outcome.error?.message ?? `Flow '${flowSlug}' failed`);
    }
    return outcome.result;
  };

  if (options.mode === 'async') {
    void run().catch((err) => logger.warn(`[flows] async flow.run ${flowSlug} failed:`, err));
    return { queued: true, runId: reservation.runId };
  }
  return run();
}

// ---------------------------------------------------------------------------
// Queued-run claiming (docs/FORMLOGIC_FLOWS.md §10).
//
// The server enqueues 'queued' runs (form.submitted bindings on the real submission
// pipeline, ctx.flows.run script intents); an open runtime claims each exactly once
// (atomic queued→running; the loser of a race gets 409 and skips), executes it from the
// stored input_snapshot, and PATCHes the terminal status. Two loops share one engine:
//   - app scope: starts/stops with startFlowDispatcher (poll GET /app/{slug}/flow-runs/queued);
//   - workspace scope: startWorkspaceClaimLoop(), mounted by the /flows workspace page only
//     while it is open (poll GET /flow-runs/queued, workspace runs only).
// ---------------------------------------------------------------------------

/** Extract the stored trigger event from a queued run's input_snapshot ({event:{name,data}}). */
function snapshotEvent(run: FlowRunLog): FlowTriggerEvent | undefined {
  const raw = (run.inputSnapshot as { event?: unknown } | null)?.event;
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as { name?: unknown; data?: unknown };
  if (typeof e.name !== 'string' || e.name === '') return undefined;
  return {
    name: e.name,
    data: e.data,
    correlationId: run.correlationId,
    idempotencyKey: run.idempotencyKey,
  };
}

/**
 * Execute one CLAIMED run. `input_snapshot.event` drives the binding's inputMap selectors
 * exactly like a live event; script-intent runs (no binding) treat the snapshot as the
 * flow inputs verbatim. The binding condition is evaluated here (it never ran server-side)
 * — false/error completes the run 'cancelled', mirroring the live fail-safe skip.
 */
async function executeClaimedRun(opts: {
  run: FlowRunLog;
  flow: ExecutableFlow | null;
  binding: ClaimableBinding | null;
  app: Record<string, unknown>;
  executorDeps: FlowExecutorDeps;
  actionDeps: OutputActionDeps;
  complete(payload: {
    status: 'done' | 'error' | 'timeout' | 'cancelled';
    result?: Record<string, unknown> | null;
    error?: FlowRunError | null;
  }): Promise<void>;
}): Promise<FlowRunOutcome | null> {
  const { run, flow, binding } = opts;

  if (!flow) {
    // We claimed it, so finalize honestly: this runtime can't execute the flow.
    await opts.complete({
      status: 'error',
      error: { code: 'runner_unavailable', message: `Flow '${run.flow ?? run.flowDefinitionId ?? '?'}' is not loaded in this runtime` },
    }).catch((err) => logger.warn('[flows] completeRun failed:', err));
    return null;
  }

  const event = snapshotEvent(run);

  if (binding?.condition?.expr && event) {
    let passes = false;
    try {
      passes = await getDeps().evaluateCondition(binding.condition.expr, { event: event as unknown as Record<string, unknown> });
    } catch (err) {
      logger.warn(`[flows] claimed run ${run.runId} condition errored (cancelling):`, err);
    }
    if (!passes) {
      await opts.complete({
        status: 'cancelled',
        error: { code: 'cancelled', message: 'Binding condition evaluated false at claim time' },
      }).catch((err) => logger.warn('[flows] completeRun failed:', err));
      return null;
    }
  }

  let inputs: Record<string, unknown>;
  if (binding && event) {
    inputs = buildInputs(binding.inputMap, { event, app: opts.app });
  } else if (event) {
    inputs = {};
  } else {
    // ctx.flows.run intents: the snapshot IS the input object (docs §11).
    inputs = (run.inputSnapshot as Record<string, unknown> | null) ?? {};
  }

  return executeRun({
    flow,
    binding,
    inputs,
    event,
    executorDeps: opts.executorDeps,
    actionDeps: opts.actionDeps,
    app: opts.app,
    runId: run.runId,
    complete: opts.complete,
  });
}

/**
 * One claim sweep for the active app runtime: list queued → claim (runtime 'browser',
 * per-tab instanceId) → execute → complete. Exposed for tests and imperative refreshes;
 * normally driven by the dispatcher's 20s interval. Never throws.
 */
export async function claimQueuedAppRuns(): Promise<number> {
  const d = getDeps();
  const slug = d.getAppSlug();
  if (!slug || !runtime || claimSweepInFlight) return 0;
  claimSweepInFlight = true;
  let executed = 0;
  try {
    const runs = await d.listQueuedRuns(slug, CLAIM_BATCH_LIMIT);
    for (const run of runs) {
      if (await deferToDesktop(run.triggerEvent ?? '')) {
        continue; // desktop-first: its claim loop picks this up; we take over only when its heartbeat is stale
      }
      let claimed = false;
      let claimedRun = run;
      try {
        const claimRes = await d.claimRun(slug, run.runId, { runtime: 'browser', instanceId: getClaimInstanceId() });
        claimed = claimRes.claimed;
        // The queued LIST omits input snapshots for non-owner members (FL-AUTH-001);
        // the claim response is the authoritative run — execute from it.
        if (claimRes.run) claimedRun = claimRes.run;
      } catch (err) {
        logger.warn(`[flows] claim ${run.runId} failed:`, err);
      }
      if (!claimed) continue; // 409 — another tab/Desktop won the race
      const binding = claimedRun.bindingId ? runtime.bindings.find((b) => b.id === claimedRun.bindingId) ?? null : null;
      const flow = claimedRun.flow ? findFlow(claimedRun.flow) ?? null : null;
      await executeClaimedRun({
        run: claimedRun,
        flow,
        binding,
        app: d.getAppContext(),
        executorDeps: d.executorDeps,
        actionDeps: appActionDeps(),
        // instanceId binds the completion to OUR claim — the server 409s any other instance.
        complete: (payload) => d.completeRun(slug, claimedRun.runId, { ...payload, instanceId: getClaimInstanceId() }),
      });
      executed += 1;
    }
  } catch (err) {
    logger.warn('[flows] queued-run sweep failed:', err);
  } finally {
    claimSweepInFlight = false;
  }
  return executed;
}

/**
 * WORKSPACE claim loop — mount from the /flows workspace page only while it is open:
 *
 *   useEffect(() => startWorkspaceClaimLoop(), []);
 *
 * Claims ONLY workspace-scope runs (run.appId === null): app runs belong to their open app
 * session (or FormLogic Desktop). Standalone-form binding runs resolve their binding via
 * GET /api/forms/{id}/flow-bindings (cached per sweep). Returns a stop function.
 */
export function startWorkspaceClaimLoop(): () => void {
  let stopped = false;
  let sweeping = false;

  const sweep = async (): Promise<void> => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const d = getDeps();
      const flows = await d.fetchWorkspaceFlows();
      if (stopped || flows.length === 0) return;
      const bySlug = new Map(flows.filter((f) => f.enabled).map((f) => [f.slug, f]));
      const runs = (await d.listWorkspaceQueuedRuns(CLAIM_BATCH_LIMIT)).filter((r) => r.appId === null);
      const bindingsByForm = new Map<string, FlowBinding[]>();
      for (const run of runs) {
        if (stopped) return;
        let claimed = false;
        let claimedRun = run;
        try {
          const claimRes = await d.claimWorkspaceRun(run.runId, { runtime: 'browser', instanceId: getClaimInstanceId() });
          claimed = claimRes.claimed;
          if (claimRes.run) claimedRun = claimRes.run;
        } catch (err) {
          logger.warn(`[flows] workspace claim ${run.runId} failed:`, err);
        }
        if (!claimed) continue;
        let binding: FlowBinding | null = null;
        if (claimedRun.bindingId && claimedRun.formId) {
          if (!bindingsByForm.has(claimedRun.formId)) {
            try {
              bindingsByForm.set(claimedRun.formId, await d.fetchFormBindings(claimedRun.formId));
            } catch {
              bindingsByForm.set(claimedRun.formId, []);
            }
          }
          binding = bindingsByForm.get(claimedRun.formId)?.find((b) => b.id === claimedRun.bindingId) ?? null;
        }
        const flow = (claimedRun.flow ? bySlug.get(claimedRun.flow) : undefined) ?? null;
        const wsDeps = d.workspaceExecutorDeps;
        await executeClaimedRun({
          run: claimedRun,
          flow,
          binding,
          app: {},
          executorDeps: wsDeps,
          actionDeps: {
            createResponse: (formId, answers) => wsDeps.submitResponse(formId, answers),
            updateResponse: (formId, responseId, answers) => wsDeps.updateResponse(formId, responseId, answers),
            connectorRequest: (connectorId, command, payload) => wsDeps.connectorRequest(connectorId, command, payload),
            toast: d.toast,
            kvSet: wsDeps.kvSet?.bind(wsDeps),
          },
          complete: (payload) => d.completeWorkspaceRun(claimedRun.runId, { ...payload, instanceId: getClaimInstanceId() }),
        });
      }
    } catch (err) {
      logger.warn('[flows] workspace queued-run sweep failed:', err);
    } finally {
      sweeping = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), CLAIM_POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
