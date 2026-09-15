// Trusted host for custom app-logic hooks.
//
// This is the boundary the whole design rests on (spec §31/§65):
//
//   Sandboxed scripts describe safe effects; the trusted host applies those
//   effects after permission checks.
//
// The host runs the enabled scripts for a hook inside the ZIPP sandbox
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
  /**
   * Run only the scripts in these languages (absent: every script). The desktop bridge passes
   * the languages a fresh Desktop does NOT take for this event (useDesktopConnectorEvents). It
   * scopes this run only: a hook chained from it (connector.request / sync flow.run →
   * onConnectorEvent) handles an event no Desktop ever sees, so every script runs there.
   */
  languages?: readonly string[];
}

/**
 * A script's language: absent, null or '' is JavaScript (every bundle saved before Python), as
 * the server reads it (CustomLogicSanitizer::scriptLanguage) and zipp-host runs it.
 */
function scriptLanguage(script: CustomAppLogicScript): string {
  const language: unknown = script.language;
  return language === undefined || language === null || language === '' ? 'javascript' : String(language);
}

function enabledScriptsForHook(
  bundle: CustomAppLogicBundle,
  hook: CustomAppLogicHookName,
  languages?: readonly string[]
): CustomAppLogicScript[] {
  if (!bundle || !Array.isArray(bundle.scripts)) return [];
  return bundle.scripts.filter(
    (s) => s && s.hook === hook && s.enabled !== false && typeof s.source === 'string' && s.source.trim()
      && (!languages || languages.includes(scriptLanguage(s)))
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
  { bundle, hook, input, handlers, budgetMs, languages }: RunHookParams,
  depth: number
): Promise<AppLogicHookOutcome> {
  const outcome = emptyOutcome();
  const scripts = enabledScriptsForHook(bundle, hook, languages);
  if (scripts.length === 0) return outcome;

  // Permission mode (spec §33). Strict (the default — absent or true) requires an explicit grant for
  // EVERY effect. Non-strict (strictPermissions === false) lets a documented default-safe set
  // (ui.setValues / ui.toast) through without a grant; connector.*, storage, response writes and
  // navigation still require one. This is the one place bundle.strictPermissions is consulted.
  const strict = bundle.strictPermissions !== false;

  for (const script of scripts) {
    // Build a fresh JSON ctx per script. `values` carries forward what earlier
    // scripts set, so a chain sees a consistent view. `storage` is the host's
    // read-only snapshot of this app's logic storage (scripts dedupe on it).
    const ctx: CustomAppLogicInput = {
      hook,
      answers: input.answers ?? {},
      values: { ...(input.values ?? {}), ...outcome.values },
      params: input.params ?? {},
      storage: storageSnapshotCopy(input.storage),
      meta: input.meta ?? {},
      event: input.event,
    };

    let raw: unknown;
    try {
      // The script's own language; one this host does not run fails the script (zipp-host),
      // never runs it as JavaScript.
      raw = await runAppLogic(
        script.source,
        ctx as unknown as Record<string, unknown>,
        script.budgetMs ?? budgetMs ?? DEFAULT_BUDGET_MS,
        script.language
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

    // Effects apply in the script's order, and that order is the contract: scripts write the
    // record FIRST and the seen-marker AFTER (audit C-04/FL-001), so a write that did not
    // happen is not marked handled. Once a record write in this script fails (denied,
    // malformed or rejected), its later storage.set effects are held back and the next
    // delivery of the event tries again — the same rule as the desktop host.
    let recordWriteFailed = false;
    for (const effect of resultEffects(result)) {
      const required = effectRequiredPermission(effect);
      const relaxed = !strict && isDefaultSafeEffect(effect);
      if (required && !relaxed && !isPermissionGranted(required, grants)) {
        outcome.deniedPermissions.push(required);
        logger.warn(`[app-logic] ${script.id}: effect '${effect.type}' denied (needs ${required})`);
        if (isRecordWrite(effect)) recordWriteFailed = true;
        continue;
      }
      if (effect.type === 'storage.set' && recordWriteFailed) {
        const msg = `held back storage.set '${String(effect.key)}' because a record write earlier in this script failed; the event will be handled again`;
        logger.warn(`[app-logic] ${script.id}: ${msg}`);
        outcome.errors.push(`${script.id}: ${msg}`);
        continue;
      }
      if (await applyEffect(effect, handlers, outcome, connectorRequests, flowRuns)) recordWriteFailed = true;
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

/**
 * A JSON copy of the host's storage snapshot, so a script's ctx never shares
 * references with the host's copy. Anything that is not a plain object, or does
 * not survive JSON, reads as empty.
 */
function storageSnapshotCopy(storage: unknown): Record<string, unknown> {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return {};
  try {
    const copy: unknown = JSON.parse(JSON.stringify(storage));
    return copy && typeof copy === 'object' && !Array.isArray(copy) ? (copy as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A non-empty string form key (the sandbox output is loosely cast, so guard at runtime). */
function isFormKey(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** A plain answers object (not null, not an array). Matches the desktop host's guard. */
function isAnswersObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A record write (submitResponse / updateResponse): the effects a seen-marker vouches for. */
function isRecordWrite(effect: CustomAppLogicEffect): boolean {
  return effect.type === 'formlogic.submitResponse' || effect.type === 'formlogic.updateResponse';
}

/**
 * Apply one permitted effect. Resolves true when it was a record write that failed (a
 * malformed effect or a handler that threw); false otherwise, including a write this host
 * has no handler for (unsupported here, e.g. the editor's Test run).
 */
async function applyEffect(
  effect: CustomAppLogicEffect,
  handlers: AppLogicEffectHandlers | undefined,
  outcome: AppLogicHookOutcome,
  connectorRequests: Extract<CustomAppLogicEffect, { type: 'connector.request' }>[],
  flowRuns: Extract<CustomAppLogicEffect, { type: 'flow.run' }>[]
): Promise<boolean> {
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
        if (!isFormKey(effect.formKey) || !isAnswersObject(effect.answers)) {
          outcome.errors.push('submitResponse: a string formKey and object answers are required');
          return true;
        }
        try {
          await handlers.submitResponse(effect.formKey, effect.answers, effect.options);
        } catch (err) {
          outcome.errors.push(`submitResponse ${effect.formKey}: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        }
      }
      break;
    case 'formlogic.updateResponse':
      if (handlers?.updateResponse) {
        if (!isFormKey(effect.formKey) || !isAnswersObject(effect.answers)) {
          outcome.errors.push('updateResponse: a string formKey and object answers are required');
          return true;
        }
        try {
          await handlers.updateResponse(
            effect.formKey,
            { responseId: effect.responseId, match: effect.match },
            effect.answers,
            { upsert: effect.upsert }
          );
        } catch (err) {
          outcome.errors.push(`updateResponse ${effect.formKey}: ${err instanceof Error ? err.message : String(err)}`);
          return true;
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
      // A marker with no value would not survive JSON and read as absent in the next
      // ctx.storage snapshot, so an unstated value means "set" (true), as on the desktop.
      handlers?.storageSet?.(effect.key, effect.value === undefined ? true : effect.value);
      break;
    case 'storage.remove':
      handlers?.storageRemove?.(effect.key);
      break;
  }
  return false;
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
