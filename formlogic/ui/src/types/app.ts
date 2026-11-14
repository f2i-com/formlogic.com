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
export type AppFormPrivacyDefault = 'plain' | 'private';

/** Human labels for each app kind (shared by the wizard, app cards and dashboard templates). */
export const KIND_LABELS: Record<AppKind, string> = {
  admin: 'Admin console',
  client: 'Client portal',
  staff: 'Staff app',
  public: 'Public intake',
  internal: 'Internal tool',
  custom: 'Custom',
};

/**
 * settings.signInPage: how the site's sign-in and sign-up pages greet people coming to use the app (the server keeps
 * only these, as plain words and design tokens: AppService::signInPage).
 */
export interface SignInPageSettings {
  /** A line of up to 80 characters beside or over the form; the site's own heading stays. */
  title?: string;
  /** Up to 280 characters of plain text. */
  message?: string;
  /** A panel beside the form, or one card in the middle. */
  layout?: 'split' | 'centered';
  /** The panel's colour (#rrggbb); the accent when not set. */
  panelColor?: string;
  /** false: the site's font rather than the app's. */
  appFont?: boolean;
}

export interface AppSettings {
  /** How the sign-in and sign-up pages greet people coming to use the app. */
  signInPage?: SignInPageSettings;
  /** Use the published portable project for the app's home dashboard. */
  hostedDashboard?: boolean;
  aokieWorkspace?: boolean;
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
  /**
   * A hosted SoftN app: its interface, backend and data are its SoftN project, not forms. Its
   * owner manages it in the SoftN app workspace (/apps/:id/softn). Server-validated boolean.
   */
  softnApp?: boolean;
  /** false turns torch off for this app's hosted projects; absent = allowed (the site may still refuse it). */
  torch?: boolean;
  /**
   * Privacy used for data types created from this app's Studio. `private` is a
   * fail-closed preference: the Studio enables E2EE before attaching a new form.
   * Existing forms attached to an app are never changed.
   */
  defaultFormPrivacy?: AppFormPrivacyDefault;
  /** IANA timezone record times are displayed in for members without their own
   *  account timezone. Defaulted from the creator's account on app creation;
   *  also drives report date bucketing. Empty/absent → UTC. */
  timezone?: string;
  /** Pack-declared "included services" (e.g. the Aokie Companion relay), keyed by
   *  service id. Composed at pack import; owner-toggleable under App Settings →
   *  Included services. The backend gates each service's endpoints on `enabled`;
   *  an ABSENT map/entry means enabled (backward compatible). */
  services?: Record<string, { enabled: boolean; title?: string; description?: string }>;
  /** The passes the app's members need, each from the plugin named (AccessGateService). A member
   *  without a live one is kept out until they get it on the main site; the owner never is.
   *  Absent: none. */
  requires?: AppRequirement[];
  /** A hosted SoftN app may open the files a person picks and save files they ask for: 'ask' asks
   *  each person first, 'allow' asks nobody (the owner knows the app). Absent: it may not. */
  softnFiles?: 'ask' | 'allow';
  /** How a hosted SoftN app looks before it opens and where it is shared (AppLookService). */
  softnLook?: SoftnLook;
}

/**
 * A hosted SoftN app's look, as its owner chose: its icon and share image (each one of its own
 * media files), a description, and its loading screen's colours. What is absent is the app's own
 * (its manifest's icon and description) or FormLogic's.
 */
export interface SoftnLook {
  icon?: string;
  shareImage?: string;
  description?: string;
  background?: string;
  spinner?: string;
}

/** How strongly a method establishes a pass's value, weakest first. */
export type PassStrength = 'declared' | 'estimated' | 'verified';

/** What an app asks of its members: a pass of `kind` from `plugin`, for at least `min`, at least this strong. */
export interface AppRequirement {
  plugin: string;
  kind: string;
  min: number;
  strength: PassStrength;
}

/** A requirement as a page shows it, in its plugin's words, with whether the signed-in member meets it and where to. */
export interface PassRequirement extends AppRequirement {
  pluginName: string;
  label: string;
  unit: string;
  /** Who an app that asks it is for, with the app's value in: "people aged 18 and over". */
  asks: string;
  /** What the button that takes the member to the plugin says. */
  action: string;
  /** The plugin that issues it is installed and on. */
  available: boolean;
  satisfied: boolean;
  /** Where on the main site the member gets it: the plugin's page, for this app. */
  verifyPath: string;
}

/** An app's requirements as the signed-in member stands with them. */
export interface RequirementsStatus {
  satisfied: boolean;
  requirements: PassRequirement[];
}

/** A pass a plugin may issue, as its manifest declares it, with the words the site shows for it. */
export interface PluginPass {
  kind: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** The value an owner starts from. */
  default: number;
  strengths: PassStrength[];
  issueRoute: string;
  asks: string;
  action: string;
  /** The owner's switch for it, and the field for the app's value. */
  require: string;
  minLabel: string;
  strengthLabels: Partial<Record<PassStrength, string>>;
}

/** A kind of pass an owner can require: one an enabled plugin on this site may issue. */
export interface PassKind extends PluginPass {
  plugin: string;
  pluginName: string;
  /** The strengths this site can issue now (stronger than a declaration needs what the plugin uses set up). */
  offered?: PassStrength[];
}

/** A setting a plugin declares, which the administrator sets and its code is handed. */
export interface PluginSetting {
  key: string;
  label: string;
  help: string;
  type: 'integer' | 'choice' | 'boolean';
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  default: number | string | boolean;
}

/** The sign-in codes a plugin sends: for apps that name `provider`, in its words. */
export interface PluginSignInCodes {
  provider: string;
  label: string;
}

/** A setting a plugin asks each app's owner for, as the administrator reads it. */
export interface PluginAppSettingWords {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'integer' | 'choice' | 'boolean';
}

/** What a plugin may do beyond its passes: the hosts the site reaches for it, the codes it sends, what it asks owners. */
export interface PluginGrantedWords {
  /** The hosts the site makes HTTPS requests to for it (`network`). */
  network?: string[];
  signInCodes?: PluginSignInCodes | null;
  appSettings?: PluginAppSettingWords[];
}

/** What a plugin asks, as the administrator reads it before granting it. */
export interface PluginReview extends PluginGrantedWords {
  version: string;
  passes: PluginPass[];
  uses: string[];
  settings: PluginSetting[];
  /** Its sandbox's own permissions, in words. */
  sandbox: string[];
  /** For an update: the hosts it would reach that it does not now. */
  networkAdded?: string[];
}

/** One camera check, as the site's page follows it (CameraCheckService). */
export interface CameraCheckState {
  id: string;
  mode: 'member' | 'trial' | 'probe';
  status: 'started' | 'assessing' | 'done';
  outcome: string | null;
  message: string | null;
  attemptsLeft: number | null;
  expiresAt: string;
  /** What to ask at each step, in the plugin's words, with an arrow, while it is started. */
  steps?: Array<{ say: string; hint: 'center' | 'left' | 'right' | 'up' | 'down' | null }>;
  /** The model's answer and the plugin's decision, for the administrator's own trial or test only. */
  answer?: Record<string, unknown>;
}

/** One of the member's own passes. Never a date of birth, a picture or an estimate. */
export interface AccessReceipt {
  id: string;
  plugin: string;
  pluginName: string;
  kind: string;
  label: string;
  value: number;
  strength: PassStrength;
  method: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  live: boolean;
}

/** An installed plugin, as Admin → Plugins shows it, with what it was granted beyond its passes. */
export interface InstalledPlugin extends PluginGrantedWords {
  id: string;
  manifestId: string;
  scope: string;
  source: 'builtin' | 'upload';
  appId: string;
  name: string;
  version: string;
  enabled: boolean;
  grants: PluginPass[];
  /** What it may use besides issuing passes: `camera`. */
  uses: string[];
  settingsSchema: PluginSetting[];
  settings: Record<string, number | string | boolean>;
  installedAt: string;
  /** This FormLogic ships it in another version: what updating would bring, and grant it. */
  update?: PluginReview | null;
}

/** A plugin that ships with FormLogic and is not installed yet. */
export interface AvailablePlugin extends PluginReview {
  id: string;
  name: string;
  description: string;
}

/** An uploaded plugin, read before it is installed. */
export interface UploadedPlugin extends PluginReview {
  id: string;
  name: string;
  description: string;
  /** It updates the installed plugin of this id. */
  updates: { version: string } | null;
}

export interface AppNavItem {
  /** 'form' (default, legacy entries) references an app form; 'link' is an
   *  owner-authored custom menu link rendered in the app's nav. */
  kind?: 'form' | 'link';
  /** kind 'form' only. Optional so link entries can omit it. */
  formId?: string;
  displayName: string;
  sortOrder: number;
  isVisible: boolean;
  icon?: string;
  /** kind 'link': https URL (opens a new tab) or an in-app target accepted by
   *  safeAppNavTarget ('records', 'reports', 'form/<id>'…). Render-side scheme
   *  guard — javascript:/data: never navigate. */
  url?: string;
  /** kind 'link': stable id for editor keys (generated client-side). */
  id?: string;
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
  /**
   * A SoftN app's own icon, as the server names it wherever it lists the app: which kind it is and
   * the version its address carries (lib/appLook.ts, `appIconUrl`). It is the icon the app's tab and
   * home screen show: the one its owner chose, else the one its manifest names. Absent for any
   * other app and where it has none. Read-only: the server ignores it on a save.
   */
  lookIcon?: { kind: 'raster' | 'svg'; version: string } | null;
  status: 'draft' | 'published' | 'archived';
  settings: AppSettings;
  theme: AppTheme;
  navConfig: AppNavItem[];
  /** Optional sandboxed custom HOME screen ({ html, css, js }) shown instead of the form list. */
  customScreen?: CustomScreen;
  /** Optional saved reports + composed PDF documents shown in the app's Reports section. */
  reports?: AppReportItem[];
  /** Optional sandboxed app-logic (onBeforeSubmit / onConnectorEvent / …). Owner-authored;
   *  runs client-side to describe safe effects — the backend stays authoritative on submit. */
  customLogic?: CustomAppLogicBundle;
  /** REAL attached-form count from the apps list endpoint (app_forms). Use this for list displays —
   *  navConfig.length is NOT a forms count (empty on pack-provisioned apps). */
  formCount?: number;
  /** App Studio version state: bumped on every publish; 0 = never published. */
  publishedVersion?: number;
  /** When the app was last published — anchors "unpublished changes since" comparisons. */
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One publish event from GET /api/apps/{id}/versions (newest first). */
export interface AppVersion {
  id: string;
  version: number;
  label: string | null;
  publishedBy: string | null;
  createdAt: string | null;
}

/** An app as returned by the apps LIST endpoint (GET /api/apps): the base App plus list-only
 *  capability flags. `canManage` / `canCreateCompanion` are server-authoritative (owner-only for
 *  now) — prefer them over inferring ownership from `ownerId`'s presence. */
export type AppListItem = App & {
  formCount?: number;
  canManage?: boolean;
  canCreateCompanion?: boolean;
};

/**
 * What the apps list shows beside one of the caller's own apps (GET /api/apps/summary). Each value
 * is null where the server has nothing to say: an app with no project, or no database of its own.
 */
export interface AppSummary {
  /** A SoftN app: its settings say so, or it has a project installed. */
  softn: boolean;
  installed: boolean;
  /** The installed project's version: the number the app's own page shows. */
  version: number | null;
  /** Who can use it, as the project stores it ('members', 'application'). */
  access: string | null;
  /** The project has a server side, so its data is kept here and not in each person's browser. */
  backend: boolean;
  tables: number | null;
  bytes: number | null;
  /** The first custom domain that is connected, without the scheme. */
  domain: string | null;
  /** People with access besides the owner. */
  members: number | null;
}

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
  /** Builder-authored theming CSS, sanitized server-side (AppReportService::sanitizeDashboardCss)
   *  and scoped client-side to this dashboard's container. Rules target the documented
   *  fl-dash-* class hooks and --dash-* variables. */
  customCss?: string;
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
  | 'aokie_companion_state'
  | 'aokie_companion_monitor'
  | 'aokie_companion_consult'
  | 'aokie_companion_takeover'
  | 'aokie_companion_resume'
  | 'aokie_companion_end'
  | 'aokie_companion_assistance'
  | 'aokie_companion_audit'
  | 'manage_aokie_companion'
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
  /** Server-computed (AppUserService::roleGrantsAppLevel): the member's role grants an app-level
   *  permission, so only the app's Owner may change their role or status or remove them. */
  holdsAppLevelRole?: boolean;
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
  /** Data-only form (app_forms.settings.hidden): no menu entry, direct
   *  navigation blocked — but the form stays in this config so custom-screen
   *  SDK reads/writes (queryRecords/related/updateRecord) keep resolving it. */
  hidden?: boolean;
  /** Unlisted (app_forms.settings.menuHidden): no menu entry, but the form
   *  remains openable by URL and from screens. */
  menuHidden?: boolean;
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
  aokie_companion_state: 'Aokie Companion: view live call state',
  aokie_companion_monitor: 'Aokie Companion: monitor call audio',
  aokie_companion_consult: 'Aokie Companion: private voice consultation',
  aokie_companion_takeover: 'Aokie Companion: take over live calls',
  aokie_companion_resume: 'Aokie Companion: return calls to Aokie',
  aokie_companion_end: 'Aokie Companion: end the caller call',
  aokie_companion_assistance: 'Aokie Companion: typed assistance',
  aokie_companion_audit: 'Aokie Companion: view audit history',
  manage_aokie_companion: 'Manage Aokie Companion access',
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
  'aokie_companion_state',
  'aokie_companion_monitor',
  'aokie_companion_consult',
  'aokie_companion_takeover',
  'aokie_companion_resume',
  'aokie_companion_end',
  'aokie_companion_assistance',
  'aokie_companion_audit',
  'manage_aokie_companion',
];

/**
 * The app-level permissions only the app's Owner may hand out, and whose holders only the Owner
 * may re-role, suspend or remove: the server's AppPermissions::APP_LEVEL, which is every app-level
 * permission above except execute_flows (running flows is not an admin-style grant).
 */
export const OWNER_GUARDED_PERMISSIONS: PermissionAction[] = APP_LEVEL_PERMISSIONS.filter((p) => p !== 'execute_flows');

/**
 * Whether the signed-in user owns this app, from what the server sends: `canManage` is true, and
 * `ownerId` present, only on the owner's own copy of the app. An app that is not loaded is not
 * taken as owned: a draft or archived app is not listed to a member at all, so assuming ownership
 * there would offer a delegated manager the owner's controls and a refusal.
 */
export function viewerOwnsApp(app: Pick<App, 'ownerId' | 'canManage'> | undefined, userId: string | undefined): boolean {
  if (!app) return false;
  if (app.canManage === true) return true;
  return !!app.ownerId && !!userId && app.ownerId === userId;
}

/** Why a manager who is not the Owner cannot act on such a member or hand out such a role. */
export const OWNER_ONLY_MEMBER_REASON = 'Only the app owner can change the role of, suspend or remove a member whose role has app-level permissions.';

/** Does this role grant a permission only the Owner may manage (see OWNER_GUARDED_PERMISSIONS)? */
export function roleGrantsOwnerGuarded(role: Pick<AppRole, 'permissions'> | undefined): boolean {
  return !!role?.permissions?.some((p) => OWNER_GUARDED_PERMISSIONS.includes(p.permission));
}

export const FORM_LEVEL_PERMISSIONS: PermissionAction[] = [
  'submit_responses',
  'view_own_responses',
  'view_all_responses',
  'edit_responses',
  'delete_responses',
  'export_responses',
];

/** The SoftN directory this site publishes hosted SoftN apps to (null: publishing off), as the admin card shows it. */
export interface SoftnDirectorySettings {
  url: string | null;
  /** DATA_ENCRYPTION_KEY is set, so apps' edit keys are kept encrypted (publishing needs it). */
  keysEncrypted: boolean;
}

/** An app of this account's in the SoftN directory. Never its edit key. */
export interface SoftnPublication {
  slug: string;
  name: string;
  directory: string;
  page: string;
  play: string;
  version: number;
  appId: string | null;
  updatedAt: string;
}

/** A hosted SoftN app packed for the SoftN directory, as its owner's approval page shows it. */
export interface SoftnDraft {
  draftId: string;
  appId: string;
  status: 'draft' | 'awaiting_approval' | 'publishing' | 'published' | 'failed' | 'uncertain' | 'expired';
  destination: string;
  /** The app a new version updates: its slug there, and the name it is listed under (null if this site lost it). */
  target: { slug: string; name?: string | null } | null;
  sha256: string;
  bytes: number;
  /** `categoryName`: the name the directory lists `category` under, shown, not sent. */
  listing: { name?: string; description?: string; category?: string; categoryName?: string; tags?: string[]; author?: string; notes?: string };
  permissions: Record<string, unknown>;
  warnings: string[];
  previewUrl: string;
  approvalUrl: string;
  expiresAt: string;
  error: string | null;
  publication: SoftnPublication | null;
  /** The app no longer holds what this draft froze: it cannot be published, and a new draft is needed. */
  appChanged?: boolean;
  /** The names in the bundle: all of it goes public. */
  files?: string[];
}
