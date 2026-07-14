// Bridge between the app runtime and the sandboxed app-logic host.
//
// Reads the current app's customLogic bundle from the runtime store, wires the
// effect handlers to real runtime capabilities (set form values, toast, ask a
// connector, submit a response), and exposes typed run functions for the form
// view to call at its lifecycle seams (screen-enter / before-submit / after-submit).
// The QuickJS scripts themselves stay fully sandboxed — this hook is the trusted
// host that applies only permitted effects.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { toast } from '../../stores/toastStore';
import { getConnectorClient } from '../connectors/nativeConnectorClient';
import { runFlowBySlug } from '../flows/flowDispatcher';
import type { AppLogicEffectHandlers } from './appLogicEffects';
import { runHook, type AppLogicHookOutcome } from './appLogicHost';
import type { CustomAppLogicBundle, CustomAppLogicHookName, CustomAppLogicInput } from '../../types/customAppLogic';

// Backoff schedule for the updateResponse match lookup (~6s worst case; the last 0
// means "final attempt, no trailing sleep"). Exported for tests.
export const UPDATE_MATCH_RETRY_DELAYS_MS: readonly number[] = [400, 800, 1600, 3200, 0];

/**
 * Find a response id whose answers[field] === value, retrying on the given backoff
 * schedule. Submits ride the offline-first queue, so a follow-up event (call.answered
 * ~1s after call.incoming) can arrive before the original row is server-visible —
 * events outrunning writes is normal, and this absorbs it. Exported for tests.
 */
export async function findResponseIdByMatch(
  fetchRows: () => Promise<Array<{ id?: unknown; answers?: Record<string, unknown> }>>,
  match: { field: string; value: unknown },
  delays: readonly number[] = UPDATE_MATCH_RETRY_DELAYS_MS
): Promise<string | null> {
  for (const delayMs of delays) {
    const rows = await fetchRows();
    const hit = rows.find((r) => r?.answers && r.answers[match.field] === match.value);
    if (hit && typeof hit.id === 'string') return hit.id;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

const NOOP_OUTCOME: AppLogicHookOutcome = {
  ran: 0, rejected: false, warnings: [], values: {}, deniedPermissions: [], errors: [],
};

function hasEnabledScript(bundle: CustomAppLogicBundle | null | undefined): boolean {
  return !!bundle?.scripts?.some((sc) => sc && sc.enabled !== false);
}

/** Combine app-wide logic with the current form's logic into one bundle (form scripts run only here). */
function mergeBundles(
  app: CustomAppLogicBundle | null | undefined,
  form: CustomAppLogicBundle | null | undefined
): CustomAppLogicBundle | null {
  const scripts = [...(app?.scripts ?? []), ...(form?.scripts ?? [])];
  if (scripts.length === 0) return null;
  return {
    version: 1,
    runtime: 'quickjs',
    scripts,
    permissions: [...(app?.permissions ?? []), ...(form?.permissions ?? [])],
    strictPermissions: app?.strictPermissions || form?.strictPermissions,
  };
}

export interface UseCustomAppLogicOptions {
  formId?: string;
  /** Apply a patch of field values to the live form (usually setAnswers-backed). */
  applyValues: (patch: Record<string, unknown>) => void;
  /** The current form's own logic bundle (runs only while this form is open). */
  formCustomLogic?: CustomAppLogicBundle | null;
}

export interface CustomAppLogicApi {
  /** True when the app has at least one enabled logic script. */
  enabled: boolean;
  /** Run onScreenEnter for the current form (may chain connector→onConnectorEvent prefill). */
  runScreenEnter: () => Promise<AppLogicHookOutcome>;
  /** Run onBeforeSubmit; returns the outcome (rejected? warnings? merged values). */
  runBeforeSubmit: (answers: Record<string, unknown>) => Promise<AppLogicHookOutcome>;
  /** Run onAfterSubmit (advisory: toasts / navigation). */
  runAfterSubmit: (answers: Record<string, unknown>) => Promise<AppLogicHookOutcome>;
  /**
   * Run onConnectorEvent for an EXTERNALLY-delivered connector event (a FormLogic
   * Desktop SSE envelope, or a mock simulator push) — the SAME pipeline the host chains
   * after a connector.request effect, so scripts see one event shape either way.
   */
  runConnectorEvent: (event: Record<string, unknown>) => Promise<AppLogicHookOutcome>;
}

export function useCustomAppLogic({ formId, applyValues, formCustomLogic }: UseCustomAppLogicOptions): CustomAppLogicApi {
  // Subscribe only to bundle presence so we don't re-render on unrelated store changes.
  const appEnabled = useAppRuntimeStore((s) => hasEnabledScript(s.config?.app.customLogic));
  const enabled = appEnabled || hasEnabledScript(formCustomLogic);

  // Keep the latest form bundle without re-creating callbacks (read at hook-run time).
  const formBundleRef = useRef(formCustomLogic);
  useEffect(() => { formBundleRef.current = formCustomLogic; }, [formCustomLogic]);

  const handlers = useMemo<AppLogicEffectHandlers>(() => {
    const connector = getConnectorClient();
    return {
      setValues: (values) => applyValues(values),
      toast: (message, level) => {
        if (level === 'error') toast.error(message);
        else if (level === 'success') toast.success(message);
        else if (level === 'warning') toast.warning(message);
        else toast.info(message);
      },
      connectorRequest: (connectorId, command, payload) => connector.request(connectorId, command, payload),
      // flow.run effect (docs/FORMLOGIC_FLOWS.md §5): runs a FormLogic Flow through the
      // dispatcher (reserve-first run log, browser executor, output pipeline).
      flowRun: (flow, options) => runFlowBySlug(flow, options),
      submitResponse: async (formKey, answers) => {
        const state = useAppRuntimeStore.getState();
        return state.createResponse(resolveFormKey(formKey), answers);
      },
      // Update by explicit responseId or a {field, value} match over recent answers. The
      // lookup runs HERE in the trusted host (viewer session + permissions) — the sandbox
      // only ever described the intent. `upsert` creates the row when nothing matches
      // (e.g. an SMS thread seen for the first time).
      //
      // The match lookup RETRIES briefly: submits ride the offline-first queue, so a
      // follow-up event (call.answered ~1s after call.incoming) can arrive before the
      // original row is server-visible. Events outrunning writes is normal — absorb it.
      updateResponse: async (formKey, target, answers, options) => {
        const state = useAppRuntimeStore.getState();
        const formId = resolveFormKey(formKey);
        let responseId = target.responseId;
        if (!responseId && target.match) {
          // Push the match down to the server (answersEq) when the key is a plain
          // string machine field, so the target row is found REGARDLESS of age.
          // The old newest-100 client window missed a long-lived match key (e.g. an
          // sms-thread by phone that had >100 newer rows since), and upsert then
          // minted a DUPLICATE row. The client-side match + retry below still runs,
          // absorbing the write-lag case (a row not yet server-visible).
          const { field, value } = target.match;
          const canPushDown = typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(field);
          const fetchOpts = canPushDown
            ? { limit: 100, answersEq: { [field]: value } }
            : { limit: 100 };
          responseId =
            (await findResponseIdByMatch(
              async () =>
                (await state.fetchResponses(formId, fetchOpts)) as Array<{
                  id?: unknown;
                  answers?: Record<string, unknown>;
                }>,
              target.match
            )) ?? undefined;
        }
        if (!responseId) {
          if (options?.upsert) return state.createResponse(formId, answers);
          throw new Error('no matching response to update');
        }
        return state.updateResponse(formId, responseId, { answers });
      },
      storageGet: (key) => {
        try { const v = localStorage.getItem(logicStorageKey(key)); return v == null ? null : JSON.parse(v); } catch { return null; }
      },
      storageSet: (key, value) => {
        try { localStorage.setItem(logicStorageKey(key), JSON.stringify(value)); } catch { /* ignore */ }
      },
      storageRemove: (key) => {
        try { localStorage.removeItem(logicStorageKey(key)); } catch { /* ignore */ }
      },
    };
  }, [applyValues]);

  const buildMeta = useCallback((): CustomAppLogicInput['meta'] => {
    const state = useAppRuntimeStore.getState();
    return {
      appSlug: state.appSlug ?? undefined,
      appId: state.config?.app.id,
      formId,
      formKey: formId,
      userRole: state.roleName ?? undefined,
      nativeAvailable: getConnectorClient().isNativeAvailable(),
      offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
      now: new Date().toISOString(),
    };
  }, [formId]);

  const run = useCallback(
    async (
      hook: CustomAppLogicHookName,
      answers: Record<string, unknown>,
      event?: unknown
    ): Promise<AppLogicHookOutcome> => {
      const appBundle = useAppRuntimeStore.getState().config?.app.customLogic;
      const bundle = mergeBundles(appBundle, formBundleRef.current);
      if (!bundle) return NOOP_OUTCOME;
      return runHook({
        bundle,
        hook,
        input: { answers, values: answers, meta: buildMeta(), event, storage: readLogicStorageSnapshot() },
        handlers,
      });
    },
    [handlers, buildMeta]
  );

  return {
    enabled,
    runScreenEnter: useCallback(() => run('onScreenEnter', {}), [run]),
    runBeforeSubmit: useCallback((answers) => run('onBeforeSubmit', answers), [run]),
    runAfterSubmit: useCallback((answers) => run('onAfterSubmit', answers), [run]),
    runConnectorEvent: useCallback((event) => run('onConnectorEvent', {}, event), [run]),
  };
}

function logicStorageKey(key: string): string {
  const appId = useAppRuntimeStore.getState().config?.app.id ?? 'app';
  return `formlogic-applogic-${appId}-${key}`;
}

/**
 * Resolve an app-logic form key to a real form id. Pack-shipped scripts can't know the
 * post-import UUIDs, so the runtime display name is accepted as a stable key ('Calls',
 * 'Transcript Turns', …) alongside a real formId. Falls back to the raw key (server
 * authorization still applies).
 */
function resolveFormKey(formKey: string): string {
  const forms = useAppRuntimeStore.getState().config?.forms ?? [];
  // The stable pack alias wins (audit FL-007): labels are the operator's to
  // change, so displayName resolves only as a fallback.
  const hit =
    forms.find((f) => f.packFormId === formKey) ??
    forms.find((f) => f.formId === formKey) ??
    forms.find((f) => f.displayName === formKey);
  return hit?.formId ?? formKey;
}

const LOGIC_STORAGE_SNAPSHOT_CAP = 200;

/**
 * Snapshot this app's logic storage (keys written via storage.set effects) so scripts can
 * read their own guards (idempotency dedupe, counters) from `ctx.storage` — the sandbox
 * itself has no live IO. Bounded, never throws.
 */
function readLogicStorageSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const appId = useAppRuntimeStore.getState().config?.app.id ?? 'app';
    const prefix = `formlogic-applogic-${appId}-`;
    let taken = 0;
    for (let i = 0; i < localStorage.length && taken < LOGIC_STORAGE_SNAPSHOT_CAP; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const raw = localStorage.getItem(full);
      if (raw == null) continue;
      try {
        out[full.slice(prefix.length)] = JSON.parse(raw);
      } catch {
        continue; // non-JSON junk under our prefix — skip
      }
      taken += 1;
    }
  } catch {
    // Storage unavailable (privacy mode) — scripts just see an empty snapshot.
  }
  return out;
}
