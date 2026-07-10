// App types for the Apps feature
import type { CustomScreen } from './form';
import type { CustomAppLogicBundle } from './customAppLogic';

export interface AppTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  borderRadius: 'none' | 'small' | 'medium' | 'large';
  logoUrl?: string;
  sidebarColor?: string;
  headerColor?: string;
}

/** OPTIONAL portal-type metadata stored at settings.appKind. Server-validated on save
 *  (createApp/updateApp/companion drop invalid values); absent = untyped (treat as custom in UI). */
export type AppKind = 'admin' | 'client' | 'staff' | 'public' | 'internal' | 'custom';

/** Human labels for each app kind (shared by the wizard, app cards and dashboard templates). */
export const KIND_LABELS: Record<AppKind, string> = {
  admin: 'Admin console',
  client: 'Client portal',
  staff: 'Staff app',
  public: 'Public intake',
  internal: 'Internal tool',
  custom: 'Custom',
};

export interface AppSettings {
  allowSelfRegistration: boolean;
  requireApproval: boolean;
  defaultRoleId?: string;
  /** Lucide icon name (curated ICON_MAP) shown on the app's identity tile when there's no logo. */
  icon?: string;
  // 'dashboard' (default) or a specific formId the member lands on.
  landingPage: 'dashboard' | string;
  showBranding: boolean;
  enablePwa: boolean;
  pwaShortName?: string;
  pwaThemeColor?: string;
  /** Render the app runtime full-screen without the sidebar/menu (self-contained custom-home apps). */
  hideNav?: boolean;
  /** Optional portal type ('admin console' / 'client portal' / …) — see AppKind. */
  appKind?: AppKind;
}

export interface AppNavItem {
  formId: string;
  displayName: string;
  sortOrder: number;
  isVisible: boolean;
  icon?: string;
}

export interface App {
  id: string;
  name: string;
  slug: string;
  /** Stripped from the runtime config for non-owners — prefer `canManage` (below) over its presence. */
  ownerId: string;
  /** Explicit "can manage this app" capability from the runtime config (owner-only). Use the store's
   *  isOwner() selector rather than reading this or `ownerId` directly. */
  canManage?: boolean;
  description?: string;
  logoUrl?: string;
  status: 'draft' | 'published' | 'archived';
  settings: AppSettings;
  theme: AppTheme;
  navConfig: AppNavItem[];
  /** Optional sandboxed custom HOME screen ({ html, css, js }) shown instead of the form list. */
  customScreen?: CustomScreen;
  /** Optional saved reports + composed PDF documents shown in the app's Reports section. */
  reports?: AppReportItem[];
  /** Optional sandboxed QuickJS app-logic (onBeforeSubmit / onConnectorEvent / …). Owner-authored;
   *  runs client-side to describe safe effects — the backend stays authoritative on submit. */
  customLogic?: CustomAppLogicBundle;
  /** REAL attached-form count from the apps list endpoint (app_forms). Use this for list displays —
   *  navConfig.length is NOT a forms count (empty on pack-provisioned apps). */
  formCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** An app as returned by the apps LIST endpoint (GET /api/apps): the base App plus list-only
 *  capability flags. `canManage` / `canCreateCompanion` are server-authoritative (owner-only for
 *  now) — prefer them over inferring ownership from `ownerId`'s presence. */
export type AppListItem = App & {
  formCount?: number;
  canManage?: boolean;
  canCreateCompanion?: boolean;
};

/** One app (owned by the caller) that contains a given form — from
 *  GET /api/forms/{formId}/app-contexts. Powers context-aware Preview routing:
 *  a form in exactly one PUBLISHED app previews inside that app's runtime. */
export interface FormAppContext {
  appId: string;
  appName: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  formDisplayName: string;
  isPublished: boolean;
}

/** One of the caller's apps with its attached forms — from GET /api/apps/form-usage,
 *  the ONE-round-trip replacement for the old getApps + per-app getAppForms fan-out. */
export interface AppFormUsageApp {
  appId: string;
  appName: string;
  slug: string;
  canManage: boolean;
  forms: Array<{ formId: string; displayName: string; sortOrder: number; isVisible: boolean }>;
}

/** A saved report on an app. `builder` = no-code spec; `screen` reserved for future AI report screens. */
export interface AppReport {
  id: string;
  name: string;
  description?: string;
  type?: 'builder' | 'screen';
  spec: AppReportSpec;
}

/** A block inside a PDF document: free text, or a chart that references a saved report. */
export type ReportDocBlock =
  | { id: string; kind: 'text'; title?: string; body: string }
  | { id: string; kind: 'report'; reportId: string; caption?: string };

/** A composed multi-chart PDF document (title + description + ordered blocks). */
export interface AppReportDocument {
  id: string;
  name: string;
  description?: string;
  type: 'document';
  blocks: ReportDocBlock[];
}

/** Items stored in `app.reports`: individual chart reports and composed PDF documents. */
export type AppReportItem = AppReport | AppReportDocument;

export function isReportDocument(item: AppReportItem): item is AppReportDocument {
  return (item as AppReportDocument).type === 'document';
}

export type ReportViz = 'table' | 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'kpi';

/** Named accent for a chart, resolved to light/dark-appropriate hues at render time ('primary' = app colour). */
export type ReportAccent = 'primary' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal';

/** Number formatting applied to KPI values, axis ticks, tooltips and data labels. */
export type ReportNumberFormat = 'plain' | 'compact' | 'currency' | 'percent';

/** Client-side re-order of the returned series (absent = server order: chronological for date buckets, else value desc). */
export type ReportSeriesOrder = 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';

export interface AppReportSpec {
  formId: string;
  viz: ReportViz;
  /** Cross-form joins along linked_record relationships. Joined fields are referenced as "<formId>::<fieldId>". */
  joins?: Array<{ via: string; formId: string; type: 'inner' | 'left' }>;
  /** Field refs may be a base field id, "<formId>::<fieldId>" (joined), or pseudo-fields "__submitted_at"/"__status". */
  filters?: Array<{ field: string; op: string; value?: string }>;
  /** How the filters combine: 'any' ORs them together (base status/scope + dateRange stay AND'd);
   *  absent/'all' = every filter must match (legacy behaviour). */
  filterMode?: 'all' | 'any';
  groupBy?: { field: string; bucket?: 'none' | 'day' | 'month' | 'year' };
  measure?: { fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'; field?: string };
  columns?: string[];
  /** How to order chart series (value = largest first, label = alphabetical/chronological). */
  seriesSort?: 'value' | 'label';
  /** Series value direction ('asc'|'desc'); for tables, the sort column + direction. */
  sort?: 'asc' | 'desc' | { by: string; dir: 'asc' | 'desc' };
  /** Filter grouped results by the aggregate value. */
  having?: { op: string; value: string | number };
  limit?: number;
  /** Quick server-side time window; absent/'all' = no constraint (legacy behaviour). `field` defaults to
   *  '__submitted_at'; a ref that isn't a date-typed field falls back to submitted-at. */
  dateRange?: { preset: 'all' | '7d' | '30d' | '90d' | 'thisMonth' | 'ytd'; field?: string };
  /** Second group dimension — bar/line/area with a groupBy ONLY (ignored elsewhere). The top `limit`
   *  (2–8, default 5) series by total value are kept; the remainder buckets into a literal 'Other'.
   *  Result rows stay flat ({ label, value, series }) — the renderer pivots by `series`. */
  seriesBy?: { field: string; limit?: number };
  // ── Presentation (all optional; absent = the default look, so old specs render unchanged) ──
  /** Chart accent colour; unset/'primary' uses the app colour. */
  color?: ReportAccent;
  /** Value formatting; unset = plain locale numbers. */
  format?: ReportNumberFormat;
  /** Fixed decimal places 0–2 (unset = 0 for integers, up to 2 otherwise). */
  decimals?: number;
  /** Short strings (≤8 chars) wrapped around every formatted value, e.g. "€" / "kg". */
  prefix?: string;
  suffix?: string;
  /** Value labels on marks. Bars default ON (legacy look); line/area default OFF. */
  showDataLabels?: boolean;
  /** Draws a labeled dashed reference line on bar/line/area; a progress-vs-target bar under a KPI. */
  target?: number;
  /** Bar charts only: false = vertical columns (unset/true = the default horizontal bars). */
  horizontal?: boolean;
  /** Client-side series re-sort (covers orders the server can't produce, e.g. label Z→A). */
  seriesOrder?: ReportSeriesOrder;
  /** KPI with a date-bucketed groupBy: big number = total, with a mini trend rendered underneath. */
  sparkline?: boolean;
}

export interface AppReportResult {
  viz: string;
  columns?: Array<{ id: string; label: string }>;
  rows?: Array<Record<string, unknown>>;
  /** Flat chart rows; `series` is set only when the spec used seriesBy (renderer pivots by it). */
  series?: Array<{ label: string; value: number; series?: string }>;
  value?: number;
}

// ── Configurable dashboards (host-rendered widget grids) ──────────────────────
// A dashboard is a declarative grid of widgets rendered natively with recharts
// (NOT sandboxed user code). It is stored on customScreen.dashboard when
// customScreen.kind === 'dashboard', on both apps (home/Dashboard) and forms
// (section screens). Chart/number/table widgets reuse the Reports engine verbatim
// (AppReportSpec → runReport → ReportResultView).

/** Grid placement for a widget: 12-column grid; h is in row units (~120px each). */
export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DashboardWidgetKind = 'report' | 'list' | 'grid' | 'text' | 'actions' | 'activity';

/** A single tile on a configurable dashboard. */
export interface DashboardWidget {
  id: string;
  title?: string;
  layout: WidgetLayout;
  kind: DashboardWidgetKind;
  /** kind 'report' — the no-code query + chart type (any AppReportSpec viz). */
  spec?: AppReportSpec;
  /** kind 'list' — a compact recent-records list from one form. `metaField` renders a trailing
   *  meta value per row; `linkToRecords` makes rows navigate to the record (default off). */
  list?: { formId: string; titleField?: string; subtitleField?: string; metaField?: string; limit?: number; linkToRecords?: boolean };
  /** kind 'grid' — a paginated records grid from one form. `columnFieldIds` picks the
   *  columns (default: the form's first few simple fields); rows open their record. */
  grid?: { formId: string; columnFieldIds?: string[]; pageSize?: number };
  /** kind 'text' — a static note / section heading. */
  text?: { body: string };
  // kind 'actions' | 'activity' — app-scope built-ins derived from the app (no extra config).
}

/** A declarative dashboard stored on customScreen.dashboard (host-rendered, no sandbox). */
export interface DashboardScreen {
  version: 1;
  /** Grid column count (default 12). */
  cols?: number;
  widgets: DashboardWidget[];
  /** Date-range picker visibility: shown when !== false AND at least one report widget is time-aware
   *  (date-bucketed groupBy or a dateRange). The picker merges its preset into each report widget's
   *  spec.dateRange before running it. */
  showRangePicker?: boolean;
  /** Auto-refresh cadence in seconds — 30 | 60 | 300 only; absent = off. */
  refreshInterval?: number;
}

export interface AppForm {
  id: string;
  appId: string;
  formId: string;
  displayName: string;
  sortOrder: number;
  isVisible: boolean;
  settings: Record<string, unknown>;
}

export interface AppRole {
  id: string;
  appId: string;
  name: string;
  description?: string;
  isSystem: boolean;
  sortOrder: number;
  permissions?: AppPermission[];
}

export type PermissionAction =
  | 'manage_app'
  | 'manage_users'
  | 'manage_roles'
  | 'view_analytics'
  | 'execute_flows'
  | 'submit_responses'
  | 'view_own_responses'
  | 'view_all_responses'
  | 'edit_responses'
  | 'delete_responses'
  | 'export_responses';

export interface AppPermission {
  id: string;
  roleId: string;
  formId: string | null;
  permission: PermissionAction;
}

export interface AppUser {
  id: string;
  appId: string;
  userId: string;
  roleId: string;
  status: 'pending' | 'active' | 'suspended';
  invitedBy?: string;
  invitedAt?: string;
  joinedAt?: string;
  // Joined fields from users table
  email?: string;
  name?: string;
  roleName?: string;
}

export interface AppUserGroup {
  id: string;
  appId: string;
  name: string;
  description?: string;
  memberCount?: number;
}

export interface AppInvitation {
  id: string;
  appId: string;
  email: string;
  roleId: string;
  roleName?: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName?: string;
  expiresAt: string;
  createdAt: string;
  token?: string; // Only returned at creation time
}

// Runtime types (for end-user app)
export interface AppRuntimeForm {
  formId: string;
  displayName: string;
  /** Stable machine alias stamped at pack import (audit FL-007) — app-logic
   *  formKey resolution prefers it over rename-able labels. */
  packFormId?: string | null;
  icon?: string;
  description?: string | null;
  fields: unknown[];
  settings: Record<string, unknown>;
  customScreen?: CustomScreen | null;
  /** Form-scoped app-logic delivered with the runtime config; runs only for this form. */
  customLogic?: CustomAppLogicBundle | null;
}

export interface AppRuntimeConfig {
  app: App;
  forms: AppRuntimeForm[];
  userPermissions: Record<string, PermissionAction[]>;
}

export interface AppUserPermissions {
  appLevel: PermissionAction[];
  formLevel: Record<string, PermissionAction[]>;
}

// Defaults
export const DEFAULT_APP_THEME: AppTheme = {
  primaryColor: '#6366f1',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  // DM Sans is loaded app-wide (index.html); 'Inter' was never loaded and fell
  // back to system-ui, so published apps rendered in the wrong font.
  fontFamily: 'DM Sans',
  borderRadius: 'medium',
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  allowSelfRegistration: false,
  requireApproval: false,
  landingPage: 'dashboard',
  showBranding: true,
  enablePwa: true,
};

export const APP_PERMISSION_LABELS: Record<PermissionAction, string> = {
  manage_app: 'Manage app',
  manage_users: 'Manage users',
  manage_roles: 'Manage roles',
  view_analytics: 'View analytics',
  execute_flows: 'Run flows',
  submit_responses: 'Submit responses',
  view_own_responses: 'View own responses',
  view_all_responses: 'View all responses',
  edit_responses: 'Edit responses',
  delete_responses: 'Delete responses',
  export_responses: 'Export responses',
};

export const APP_LEVEL_PERMISSIONS: PermissionAction[] = [
  'manage_app',
  'manage_users',
  'manage_roles',
  'view_analytics',
  // FL-AUTH-001: gates the runtime flow surface (definitions, run claiming, shared flow-KV).
  // App-wide only (form_id NULL) — the backend does not treat it as an admin-style permission.
  'execute_flows',
];

export const FORM_LEVEL_PERMISSIONS: PermissionAction[] = [
  'submit_responses',
  'view_own_responses',
  'view_all_responses',
  'edit_responses',
  'delete_responses',
  'export_responses',
];
