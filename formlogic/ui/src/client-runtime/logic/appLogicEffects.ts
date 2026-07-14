// Effect application layer for custom app-logic.
//
// A QuickJS hook returns a CustomAppLogicRunResult. This module (a) defensively
// normalizes whatever came out of the sandbox into that shape, and (b) defines
// the handler interface the trusted host implements to actually carry out the
// permitted effects (show a toast, set form values, ask a connector, etc.).
// The sandbox never touches any of these — it only describes intent.
import type {
  CustomAppLogicEffect,
  CustomAppLogicRunResult,
  CustomAppLogicUiPatch,
} from '../../types/customAppLogic';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * Concrete side-effect implementations, injected by the runtime that hosts the
 * logic (the app form view, the SDK, a preview harness…). Every method is
 * optional: a handler that isn't provided means "this effect is unsupported
 * here" and the effect is skipped (with a warning), never executed unsafely.
 */
export interface AppLogicEffectHandlers {
  setValues?(values: Record<string, unknown>): void;
  toast?(message: string, level?: ToastLevel): void;
  navigate?(screenId: string, params?: Record<string, unknown>): void;
  /** Ask a connector for data. Resolves with the connector's JSON payload. */
  connectorRequest?(connectorId: string, command: string, payload?: unknown): Promise<unknown>;
  submitResponse?(
    formKey: string,
    answers: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  /**
   * Update an existing response, located by explicit id OR a {field, value} match over
   * recent answers (the trusted host performs the lookup — the sandbox never reads live
   * data). `upsert` creates the row when no match exists.
   */
  updateResponse?(
    formKey: string,
    target: { responseId?: string; match?: { field: string; value: unknown } },
    answers: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<unknown>;
  listResponses?(formKey: string, query?: Record<string, unknown>): Promise<unknown>;
  /** Run a FormLogic Flow by slug (docs/FORMLOGIC_FLOWS.md §5). Resolves with the flow
   *  result for sync runs; async runs resolve as soon as the run is queued. */
  flowRun?(
    flow: string,
    options?: { mode?: 'sync' | 'async'; timeoutMs?: number; input?: Record<string, unknown> }
  ): Promise<unknown>;
  storageGet?(key: string): unknown;
  storageSet?(key: string, value: unknown): void;
  storageRemove?(key: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Coerce the raw sandbox output into a well-formed run result. Never throws. */
export function normalizeRunResult(raw: unknown): CustomAppLogicRunResult {
  const obj = asRecord(raw);
  if (!obj) {
    // A script that returns nothing (or a scalar) is treated as a successful no-op.
    return { ok: true, effects: [] };
  }

  const effects: CustomAppLogicEffect[] = Array.isArray(obj.effects)
    ? (obj.effects.filter((e) => asRecord(e) && typeof (e as { type?: unknown }).type === 'string') as CustomAppLogicEffect[])
    : [];

  let ui: CustomAppLogicUiPatch | undefined;
  const uiObj = asRecord(obj.ui);
  if (uiObj) {
    ui = {};
    const setValues = asRecord(uiObj.setValues);
    if (setValues) ui.setValues = setValues;
    const nav = asRecord(uiObj.navigate);
    if (nav && typeof nav.screenId === 'string') {
      ui.navigate = { screenId: nav.screenId, params: asRecord(nav.params) };
    }
    const toast = asRecord(uiObj.toast);
    if (toast && typeof toast.message === 'string') {
      ui.toast = { message: toast.message, level: toast.level as ToastLevel | undefined };
    }
  }

  return {
    ok: obj.ok !== false && obj.reject !== true && !obj.error,
    value: obj.value,
    effects,
    ui,
    reject: obj.reject === true,
    message: typeof obj.message === 'string' ? obj.message : undefined,
    warnings: asStringArray(obj.warnings),
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

/**
 * Fold a result's `ui` shorthand into the flat effect list so the host has ONE
 * permission-checked path. (Authors may write either `ui: { setValues }` or
 * `effects: [{ type: 'ui.setValues', ... }]`; both end up here.)
 */
export function resultEffects(result: CustomAppLogicRunResult): CustomAppLogicEffect[] {
  const effects: CustomAppLogicEffect[] = [...result.effects];
  const ui = result.ui;
  if (ui?.setValues) effects.push({ type: 'ui.setValues', values: ui.setValues });
  if (ui?.toast) effects.push({ type: 'ui.toast', message: ui.toast.message, level: ui.toast.level });
  if (ui?.navigate) {
    effects.push({ type: 'ui.navigate', screenId: ui.navigate.screenId, params: ui.navigate.params });
  }
  return effects;
}
