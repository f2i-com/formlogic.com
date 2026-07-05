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
import type { AppLogicEffectHandlers } from './appLogicEffects';
import { runHook, type AppLogicHookOutcome } from './appLogicHost';
import type { CustomAppLogicBundle, CustomAppLogicHookName, CustomAppLogicInput } from '../../types/customAppLogic';

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
      submitResponse: async (formKey, answers) => {
        // formId IS the key in this runtime; resolve defensively through config.
        const state = useAppRuntimeStore.getState();
        const target = state.config?.forms.find((f) => f.formId === formKey)?.formId ?? formKey;
        return state.createResponse(target, answers);
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
    async (hook: CustomAppLogicHookName, answers: Record<string, unknown>): Promise<AppLogicHookOutcome> => {
      const appBundle = useAppRuntimeStore.getState().config?.app.customLogic;
      const bundle = mergeBundles(appBundle, formBundleRef.current);
      if (!bundle) return NOOP_OUTCOME;
      return runHook({
        bundle,
        hook,
        input: { answers, values: answers, meta: buildMeta() },
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
  };
}

function logicStorageKey(key: string): string {
  const appId = useAppRuntimeStore.getState().config?.app.id ?? 'app';
  return `formlogic-applogic-${appId}-${key}`;
}
