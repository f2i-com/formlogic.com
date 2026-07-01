// App types for the Apps feature
import type { CustomScreen } from './form';

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
  ownerId: string;
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
  createdAt: string;
  updatedAt: string;
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

export interface AppReportSpec {
  formId: string;
  viz: ReportViz;
  /** Cross-form joins along linked_record relationships. Joined fields are referenced as "<formId>::<fieldId>". */
  joins?: Array<{ via: string; formId: string; type: 'inner' | 'left' }>;
  /** Field refs may be a base field id, "<formId>::<fieldId>" (joined), or pseudo-fields "__submitted_at"/"__status". */
  filters?: Array<{ field: string; op: string; value?: string }>;
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
}

export interface AppReportResult {
  viz: string;
  columns?: Array<{ id: string; label: string }>;
  rows?: Array<Record<string, unknown>>;
  series?: Array<{ label: string; value: number }>;
  value?: number;
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
  icon?: string;
  description?: string | null;
  fields: unknown[];
  settings: Record<string, unknown>;
  customScreen?: CustomScreen | null;
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
];

export const FORM_LEVEL_PERMISSIONS: PermissionAction[] = [
  'submit_responses',
  'view_own_responses',
  'view_all_responses',
  'edit_responses',
  'delete_responses',
  'export_responses',
];
