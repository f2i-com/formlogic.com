// Shared type definitions for the marketplace packs (every <pack-id>/pack.ts imports from here).
// ── Type definitions ────────────────────────────────────────────────────────

import type { PackFlowBinding, PackFlowDefinition } from '../../types/flows';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

export interface PackFormField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  properties: Record<string, unknown>;
  conditionalLogic?: { expression: string; action: string };
  validation?: Array<{
    id: string;
    type: string;
    value?: string | number;
    message: string;
    expression?: string;
  }>;
}

export interface PackForm {
  packFormId: string;
  title: string;
  description: string;
  icon?: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  logicScript?: string;
  /** Per-form section screen (renders on the form's view in-app and on its public link).
   *  allowNewResponses keeps the real form reachable via the runtime's "New record" button.
   *  kind 'sdk' renders a trusted first-party React screen from the sdkScreenRegistry;
   *  kind 'code' (or bare html/css/js) is a PACK-OWNED sandboxed screen — the self-contained
   *  route (plan §8): the source ships inside the pack and runs in the opaque-origin iframe. */
  customScreen?: {
    enabled?: boolean;
    allowNewResponses?: boolean;
    kind?: 'dashboard' | 'sdk' | 'code';
    dashboard?: PackDashboardScreen;
    sdkScreen?: { screenId: string; title?: string; params?: Record<string, unknown> };
    /** kind 'code': the sandboxed section screen's source (title is display-only). Either a
     *  precompiled html/css/js triple, or a TSX/TS `files` project the runtime bundles
     *  (entry index.tsx; preact/react built-ins available). */
    title?: string;
    html?: string;
    css?: string;
    js?: string;
    files?: Array<{ path: string; content: string }>;
    entry?: string;
    /** Optional per-RECORD widget on the record detail view (see RecordScreen in types/form). */
    recordScreen?: {
      kind: 'sdk' | 'code';
      title?: string;
      screenId?: string;
      params?: Record<string, unknown>;
      consumesRelated?: string[];
      html?: string;
      css?: string;
      js?: string;
      files?: Array<{ path: string; content: string }>;
      entry?: string;
      height?: number;
    };
  };
  fields: PackFormField[];
}

export interface PackAppRole {
  name: string;
  description: string;
  /** packFormId null = an app-level permission string (declarative capability intent). */
  permissions: Array<{ packFormId: string | null; permission: string }>;
}

export interface PackAppForm {
  packFormId: string;
  displayName: string;
  sortOrder: number;
  isVisible: boolean;
}

/**
 * A report spec inside a pack. Form references are portable pack keys, NOT real ids:
 *  - `formId` / `joins[].formId` use `@pack:<packFormId>`
 *  - joined field refs use `@pack:<packFormId>::<fieldId>`; base-form field refs are the bare `<fieldId>`;
 *    `__submitted_at` / `__status` are pseudo-fields.
 * These are resolved to real form ids at install/import time (PackService::resolvePackReports).
 */
export interface PackReportSpec {
  formId: string;
  viz: 'table' | 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'kpi';
  joins?: Array<{ via: string; formId: string; type?: 'inner' | 'left' }>;
  filters?: Array<{ field: string; op: string; value?: string | number }>;
  groupBy?: { field: string; bucket?: 'none' | 'day' | 'month' | 'year' };
  measure?: { fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'; field?: string };
  columns?: string[];
  seriesSort?: 'value' | 'label';
  sort?: 'asc' | 'desc' | { by: string; dir: 'asc' | 'desc' };
  having?: { op: string; value: number };
  limit?: number;
}

/** Grid placement for a dashboard widget on the 12-column grid. */
export interface PackWidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single widget on a pack dashboard. Form references inside spec/list use portable
 *  `@pack:<packFormId>` keys (and `@pack:<packFormId>::<fieldId>` for joined fields),
 *  resolved to real ids at install/import time. */
export interface PackDashboardWidget {
  id: string;
  title?: string;
  layout: PackWidgetLayout;
  kind: 'report' | 'list' | 'text' | 'actions' | 'activity';
  spec?: PackReportSpec;
  list?: { formId: string; titleField?: string; subtitleField?: string; metaField?: string; limit?: number };
  text?: { body: string };
}

/** A declarative widget dashboard stored on customScreen.dashboard (host-rendered recharts). */
export interface PackDashboardScreen {
  version: 1;
  cols?: number;
  /** Auto-refresh cadence in seconds (30 | 60 | 300); absent = no auto-refresh. */
  refreshInterval?: number;
  widgets: PackDashboardWidget[];
}

/** A block in a pack PDF document: free text, or a chart that references a sibling PackReportItem by reportId. */
export type PackReportBlock =
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'report'; reportId: string; caption?: string };

/** A pack report item — a chart (`kind:'chart'`, has `spec`) or a PDF document (`kind:'document'`, has `blocks`). */
export interface PackReportItem {
  /** Pack-local stable id, referenced by document blocks. */
  reportId: string;
  kind: 'chart' | 'document';
  name: string;
  description?: string;
  spec?: PackReportSpec;
  blocks?: PackReportBlock[];
}

/** A service a pack DECLARES as included with its app (wave 1: 'companion-relay').
 *  Import composes settings.services['<id>'] = { enabled, title, description } on the
 *  installed app; the owner can toggle each entry in App Settings and the backend
 *  gates the service's endpoints on it (absent entry = enabled, backward compatible). */
export interface PackAppService {
  id: string;
  title: string;
  description: string;
  defaultEnabled?: boolean;
}

export interface PackApp {
  packAppId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  forms: PackAppForm[];
  /** Optional host-rendered widget dashboard shown instead of the form list. */
  customScreen?: { enabled?: boolean; kind?: 'dashboard'; dashboard?: PackDashboardScreen };
  roles: PackAppRole[];
  /** Optional pre-configured chart reports + PDF documents shown in the app's Reports section. */
  reports?: PackReportItem[];
  /** Optional sandboxed QuickJS app-logic bundle (spec §31; imported to apps.custom_logic). */
  customLogic?: CustomAppLogicBundle;
  /** Services included with this app (owner-toggleable after install; max 8). */
  services?: PackAppService[];
}

export interface PackData {
  formatVersion: number;
  packMeta: {
    id?: string;
    name: string;
    description: string;
    version: string;
    author: string;
    tags: string[];
  };
  forms: PackForm[];
  apps: PackApp[];
  /** FormLogic Flows shipped with the pack (docs/FORMLOGIC_FLOWS.md §6). */
  flows?: PackFlowDefinition[];
  /** Event bindings for the pack's flows ('@pack:<formId>' refs remapped on import). */
  flowBindings?: PackFlowBinding[];
}
