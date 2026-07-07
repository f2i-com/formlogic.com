// Trusted host for custom app-logic hooks.
//
// This is the boundary the whole design rests on (spec §31/§65):
//
//   QuickJS scripts describe safe effects; the trusted host applies those
//   effects after permission checks.
//
// The host runs the enabled scripts for a hook inside the QuickJS sandbox
// (runAppLogic), permission-checks every effect they return, applies the
// permitted ones through injected handlers, and folds the outcome into a single
// result the caller can act on (reject a submit, show warnings, apply prefill).
//
// It also realizes the connector effect model (spec §32): when a hook emits a
// `connector.request`, the host performs the request through the connector
// handler and then runs the `onConnectorEvent` hook with the result — that two
// step flow is how vehicle telemetry ends up prefilled into a pre-start form,
// without ever handing the sandbox live IO.
import { runAppLogic } from '../../lib/formlogic';
import { logger } from '../../lib/logger';
import type {
  CustomAppLogicBundle,
  CustomAppLogicEffect,
  CustomAppLogicHookName,
  CustomAppLogicInput,
  CustomAppLogicScript,
} from '../../types/customAppLogic';
import {
  collectGrants,
  effectRequiredPermission,
  isDefaultSafeEffect,
  isPermissionGranted,
} from './appLogicPermissions';
import {
  normalizeRunResult,
  resultEffects,
  type AppLogicEffectHandlers,
} from './appLogicEffects';

const DEFAULT_BUDGET_MS = 1000;
const MAX_CONNECTOR_CHAIN_DEPTH = 3; // guards against connector→event→connector loops

/** Aggregate outcome of running every script bound to a hook. */
export interface AppLogicHookOutcome {
  /** How many scripts actually ran. */
  ran: number;
  /** A script asked to block the action (onBeforeSubmit reject). */
  rejected: boolean;
  /** Reject reason or the first advisory message. */
  message?: string;
  /** Non-blocking warnings gathered from all scripts. */
  warnings: string[];
  /** Merged field values to apply to the form (from ui.setValues effects). */
  values: Record<string, unknown>;
  /** A navigation request, if any script asked for one. */
  navigate?: { screenId: string; params?: Record<string, unknown> };
  /** Permission strings for effects that were denied and skipped. */
  deniedPermissions: string[];
  /** Script/runtime errors — logged, never fatal (fail-safe). */
  errors: string[];
}

export interface RunHookParams {
  bundle: CustomAppLogicBundle;
  hook: CustomAppLogicHookName;
  input: Omit<CustomAppLogicInput, 'hook'>;
  handlers?: AppLogicEffectHandlers;
  budgetMs?: number;
}

function enabledScriptsForHook(
  bundle: CustomAppLogicBundle,
  hook: CustomAppLogicHookName
): CustomAppLogicScript[] {
  if (!bundle || !Array.isArray(bundle.scripts)) return [];
  return bundle.scripts.filter(
    (s) => s && s.hook === hook && s.enabled !== false && typeof s.source === 'string' && s.source.trim()
  );
}

function emptyOutcome(): AppLogicHookOutcome {
  return { ran: 0, rejected: false, warnings: [], values: {}, deniedPermissions: [], errors: [] };
}

/** Does a bundle have any enabled script for this hook? (cheap pre-check) */
export function hasHook(
  bundle: CustomAppLogicBundle | null | undefined,
  hook: CustomAppLogicHookName
): boolean {
  return !!bundle && enabledScriptsForHook(bundle, hook).length > 0;
}

/**
 * Run every enabled script for `hook`, in order, permission-checking + applying
 * their effects. Never throws — a broken script degrades to a recorded error and
 * the run continues (the backend stays authoritative regardless).
 */
export async function runHook(params: RunHookParams): Promise<AppLogicHookOutcome> {
  return runHookInternal(params, 0);
}

async function runHookInternal(
  { bundle, hook, input, handlers, budgetMs }: RunHookParams,
  depth: number
): Promise<AppLogicHookOutcome> {
  const outcome = emptyOutcome();
  const scripts = enabledScriptsForHook(bundle, hook);
  if (scripts.length === 0) return outcome;

  // Permission mode (spec §33). Strict (the default — absent or true) requires an explicit grant for
  // EVERY effect. Non-strict (strictPermissions === false) lets a documented default-safe set
  // (ui.setValues / ui.toast) through without a grant; connector.*, storage, response writes and
  // navigation still require one. This is the one place bundle.strictPermissions is consulted.
  const strict = bundle.strictPermissions !== false;

  for (const script of scripts) {
    // Build a fresh JSON ctx per script. `values` carries forward what earlier
    // scripts set, so a chain sees a consistent view.
    const ctx: CustomAppLogicInput = {
      hook,
      answers: input.answers ?? {},
      values: { ...(input.values ?? {}), ...outcome.values },
      params: input.params ?? {},
      meta: input.meta ?? {},
      event: input.event,
    };

    let raw: unknown;
    try {
      raw = await runAppLogic(
        script.source,
        ctx as unknown as Record<string, unknown>,
        script.budgetMs ?? budgetMs ?? DEFAULT_BUDGET_MS
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[app-logic] script ${script.id} (${hook}) failed:`, msg);
      outcome.errors.push(`${script.id}: ${msg}`);
      continue; // fail-safe: a thrown script does not block the user
    }

    outcome.ran += 1;
    const result = normalizeRunResult(raw);
    if (result.error) outcome.errors.push(`${script.id}: ${result.error}`);
    if (result.warnings?.length) outcome.warnings.push(...result.warnings);

    if (result.reject) {
      outcome.rejected = true;
      outcome.message = result.message || outcome.message || 'This action was blocked.';
      // A reject is terminal — stop running further scripts for this hook.
      return outcome;
    }
    if (!outcome.message && result.message) outcome.message = result.message;

    const grants = collectGrants(bundle, script);
    const connectorRequests: Extract<CustomAppLogicEffect, { type: 'connector.request' }>[] = [];
    const flowRuns: Extract<CustomAppLogicEffect, { type: 'flow.run' }>[] = [];

    for (const effect of resultEffects(result)) {
      const required = effectRequiredPermission(effect);
      const relaxed = !strict && isDefaultSafeEffect(effect);
      if (required && !relaxed && !isPermissionGranted(required, grants)) {
        outcome.deniedPermissions.push(required);
        logger.warn(`[app-logic] ${script.id}: effect '${effect.type}' denied (needs ${required})`);
        continue;
      }
      await applyEffect(effect, handlers, outcome, connectorRequests, flowRuns);
    }

    // FormLogic Flows §5: a sync flow.run feeds its result back through onConnectorEvent
    // (the same chained-hook shape as a connector.request result); async runs just queue.
    if (flowRuns.length && handlers?.flowRun) {
      for (const eff of flowRuns) {
        const opts = { mode: eff.mode, timeoutMs: eff.timeoutMs, input: eff.input };
        if (eff.mode !== 'sync') {
          void handlers.flowRun(eff.flow, opts).catch((err) => {
            logger.warn(`[app-logic] flow.run ${eff.flow} (async) failed:`, err);
          });
          continue;
        }
        let flowResult: unknown;
        try {
          flowResult = await handlers.flowRun(eff.flow, opts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outcome.errors.push(`flow.run ${eff.flow}: ${msg}`);
          continue;
        }
        if (depth < MAX_CONNECTOR_CHAIN_DEPTH) {
          const nested = await runHookInternal(
            {
              bundle,
              hook: 'onConnectorEvent',
              input: {
                ...input,
                values: { ...(input.values ?? {}), ...outcome.values },
                event: { flow: eff.flow, source: 'flow', result: flowResult },
              },
              handlers,
              budgetMs,
            },
            depth + 1
          );
          mergeOutcome(outcome, nested);
          if (nested.rejected) return outcome;
        }
      }
    }

    // Effect model §32: perform connector requests, then feed results into
    // onConnectorEvent — but only up to a small chain depth.
    if (connectorRequests.length && depth < MAX_CONNECTOR_CHAIN_DEPTH && handlers?.connectorRequest) {
      for (const req of connectorRequests) {
        let payload: unknown;
        try {
          payload = await handlers.connectorRequest(req.connectorId, req.command, req.payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outcome.errors.push(`connector ${req.connectorId}.${req.command}: ${msg}`);
          continue;
        }
        const nested = await runHookInternal(
          {
            bundle,
            hook: 'onConnectorEvent',
            input: {
              ...input,
              values: { ...(input.values ?? {}), ...outcome.values },
              event: {
                connectorId: req.connectorId,
                command: req.command,
                result: payload,
                // Convenience alias used by the MineCab examples (§52.2).
                vehicleStatus: payload,
              },
            },
            handlers,
            budgetMs,
          },
          depth + 1
        );
        mergeOutcome(outcome, nested);
        if (nested.rejected) return outcome;
      }
    }
  }

  return outcome;
}

async function applyEffect(
  effect: CustomAppLogicEffect,
  handlers: AppLogicEffectHandlers | undefined,
  outcome: AppLogicHookOutcome,
  connectorRequests: Extract<CustomAppLogicEffect, { type: 'connector.request' }>[],
  flowRuns: Extract<CustomAppLogicEffect, { type: 'flow.run' }>[]
): Promise<void> {
  switch (effect.type) {
    case 'ui.setValues':
      Object.assign(outcome.values, effect.values);
      handlers?.setValues?.(effect.values);
      break;
    case 'ui.toast':
      handlers?.toast?.(effect.message, effect.level);
      break;
    case 'ui.navigate':
      outcome.navigate = { screenId: effect.screenId, params: effect.params };
      handlers?.navigate?.(effect.screenId, effect.params);
      break;
    case 'ui.reject':
      outcome.rejected = true;
      outcome.message = effect.message || outcome.message;
      break;
    case 'connector.request':
      connectorRequests.push(effect);
      break;
    case 'flow.run':
      // Deferred like connector requests: performed after the effect loop so a sync
      // run can chain its result into onConnectorEvent (docs/FORMLOGIC_FLOWS.md §5).
      flowRuns.push(effect);
      break;
    case 'formlogic.submitResponse':
      if (handlers?.submitResponse) {
        try {
          await handlers.submitResponse(effect.formKey, effect.answers, effect.options);
        } catch (err) {
          outcome.errors.push(`submitResponse ${effect.formKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      break;
    case 'formlogic.updateResponse':
      if (handlers?.updateResponse) {
        try {
          await handlers.updateResponse(
            effect.formKey,
            { responseId: effect.responseId, match: effect.match },
            effect.answers,
            { upsert: effect.upsert }
          );
        } catch (err) {
          outcome.errors.push(`updateResponse ${effect.formKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      break;
    case 'formlogic.listResponses':
      // Read effect: result isn't threaded back in MVP; handler may cache/prefetch.
      handlers?.listResponses?.(effect.formKey, effect.query);
      break;
    case 'storage.get':
      handlers?.storageGet?.(effect.key);
      break;
    case 'storage.set':
      handlers?.storageSet?.(effect.key, effect.value);
      break;
    case 'storage.remove':
      handlers?.storageRemove?.(effect.key);
      break;
  }
}

function mergeOutcome(into: AppLogicHookOutcome, from: AppLogicHookOutcome): void {
  into.ran += from.ran;
  Object.assign(into.values, from.values);
  into.warnings.push(...from.warnings);
  into.deniedPermissions.push(...from.deniedPermissions);
  into.errors.push(...from.errors);
  if (from.navigate) into.navigate = from.navigate;
  if (from.rejected) {
    into.rejected = true;
    if (from.message) into.message = from.message;
  }
}
