// App types for the Apps feature

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
  landingPage: 'dashboard' | 'first_form';
  showBranding: boolean;
  enablePwa: boolean;
  pwaShortName?: string;
  pwaThemeColor?: string;
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
  createdAt: string;
  updatedAt: string;
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
  fontFamily: 'Inter',
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
  manage_app: 'Manage App',
  manage_users: 'Manage Users',
  manage_roles: 'Manage Roles',
  view_analytics: 'View Analytics',
  submit_responses: 'Submit Responses',
  view_own_responses: 'View Own Responses',
  view_all_responses: 'View All Responses',
  edit_responses: 'Edit Responses',
  delete_responses: 'Delete Responses',
  export_responses: 'Export Responses',
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
