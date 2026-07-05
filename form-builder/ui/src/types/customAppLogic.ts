// Types for sandboxed QuickJS logic hooks used by custom FormLogic apps.
//
// These types intentionally describe a capability/effect based runtime instead of
// direct browser/native/backend access. React renders the UI; QuickJS scripts
// return safe effects that the trusted host applies after permission checks.

export type CustomAppLogicRuntime = 'quickjs';

export type CustomAppLogicHookName =
  | 'onAppStart'
  | 'onScreenEnter'
  | 'onScreenLeave'
  | 'onButtonClick'
  | 'onBeforeSubmit'
  | 'onAfterSubmit'
  | 'onConnectorEvent'
  | 'onSyncConflict'
  | 'mapConnectorDataToForm'
  | 'calculateDashboardState';

export type CustomAppLogicPermission =
  | '*'
  | 'formlogic.forms.read'
  | 'formlogic.responses.write'
  | 'formlogic.responses.read'
  | 'formlogic.responses.manage'
  | 'storage.local'
  | 'ui.toast'
  | 'ui.navigate'
  | 'ui.setValues'
  | 'ui.reject'
  | `connector.${string}.${string}`
  | `${string}.*`;

export interface CustomAppLogicScript {
  id: string;
  hook: CustomAppLogicHookName;
  runtime: CustomAppLogicRuntime;
  source: string;
  description?: string;
  enabled?: boolean;
  permissions?: CustomAppLogicPermission[];
  budgetMs?: number;
}

export interface CustomAppLogicBundle {
  version: 1;
  runtime: CustomAppLogicRuntime;
  scripts: CustomAppLogicScript[];
  /** Optional app-wide grants; script-level permissions are added on top. */
  permissions?: CustomAppLogicPermission[];
  /** When true, every emitted effect must map to an explicit permission. */
  strictPermissions?: boolean;
}

export interface CustomAppLogicInput {
  hook: CustomAppLogicHookName;
  answers?: Record<string, unknown>;
  values?: Record<string, unknown>;
  params?: Record<string, unknown>;
  meta?: {
    appSlug?: string;
    appId?: string;
    formId?: string;
    formKey?: string;
    screenId?: string;
    userRole?: string;
    nativeAvailable?: boolean;
    offline?: boolean;
    now?: string;
  };
  event?: unknown;
}

export type CustomAppLogicEffect =
  | {
      type: 'formlogic.submitResponse';
      formKey: string;
      answers: Record<string, unknown>;
      options?: Record<string, unknown>;
    }
  | {
      type: 'formlogic.listResponses';
      formKey: string;
      query?: Record<string, unknown>;
    }
  | {
      type: 'connector.request';
      connectorId: string;
      command: string;
      payload?: unknown;
    }
  | { type: 'storage.get'; key: string }
  | { type: 'storage.set'; key: string; value: unknown }
  | { type: 'storage.remove'; key: string }
  | { type: 'ui.toast'; message: string; level?: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'ui.navigate'; screenId: string; params?: Record<string, unknown> }
  | { type: 'ui.setValues'; values: Record<string, unknown> }
  | { type: 'ui.reject'; message: string };

export interface CustomAppLogicUiPatch {
  setValues?: Record<string, unknown>;
  navigate?: { screenId: string; params?: Record<string, unknown> };
  toast?: { message: string; level?: 'info' | 'success' | 'warning' | 'error' };
}

export interface CustomAppLogicRunResult {
  ok: boolean;
  value?: unknown;
  effects: CustomAppLogicEffect[];
  ui?: CustomAppLogicUiPatch;
  reject?: boolean;
  message?: string;
  warnings?: string[];
  error?: string;
}
