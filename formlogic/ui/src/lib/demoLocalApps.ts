// IndexedDB-backed App Studio projects for the shared Demo account.
//
// Seeded demo apps remain server-owned and read-only. Apps whose ids start with
// `demolocal_` live entirely in this browser: this store owns their app record,
// attached forms, roles, permissions, triggers and publish history. The existing
// demo form / flow overlays keep owning the heavier form and automation content.

import {
  APP_LEVEL_PERMISSIONS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_APP_THEME,
  FORM_LEVEL_PERMISSIONS,
} from '../types/app';
import type {
  App,
  AppForm,
  AppFormUsageApp,
  AppPermission,
  AppRole,
  AppUser,
  AppVersion,
  FormAppContext,
  PermissionAction,
} from '../types/app';
import type { FlowBinding, FlowBindingMode } from '../types/flows';
import { demoApplyFlowOverlay, isDemoLocalId } from './demoLocal';

const DB_NAME = 'formlogic-demo-apps';
const STORE = 'apps';
const DB_VERSION = 1;

export interface DemoAppStored {
  app: App;
  forms: AppForm[];
  roles: AppRole[];
  rolePermissions: Record<string, AppPermission[]>;
  versions: AppVersion[];
  bindings: FlowBinding[];
  users: AppUser[];
}

function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'x' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readKey(id: string): Promise<DemoAppStored | null> {
  try {
    const db = await openDb();
    return await new Promise<DemoAppStored | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as DemoAppStored | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeKey(stored: DemoAppStored): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(stored, stored.app.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function normalize(stored: DemoAppStored): DemoAppStored {
  const forms = stored.forms ?? [];
  return {
    ...stored,
    app: {
      ...stored.app,
      canManage: true,
      formCount: forms.length,
      navConfig: stored.app.navConfig ?? [],
      settings: { ...DEFAULT_APP_SETTINGS, ...(stored.app.settings ?? {}) },
      theme: { ...DEFAULT_APP_THEME, ...(stored.app.theme ?? {}) },
    },
    forms,
    roles: stored.roles ?? [],
    rolePermissions: stored.rolePermissions ?? {},
    versions: stored.versions ?? [],
    bindings: stored.bindings ?? [],
    users: stored.users ?? [],
  };
}

function slugify(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'my-app';
}

function localRole(appId: string, name: string, sortOrder: number, description: string): AppRole {
  return {
    id: 'demolocal_' + uuid(),
    appId,
    name,
    description,
    isSystem: true,
    sortOrder,
  };
}

function makePermissions(
  role: AppRole,
  formIds: string[],
  permissions: readonly PermissionAction[],
): AppPermission[] {
  const appLevel = permissions
    .filter((permission) => APP_LEVEL_PERMISSIONS.includes(permission))
    .map((permission) => ({
      id: 'demolocal_' + uuid(),
      roleId: role.id,
      formId: null,
      permission,
    }));
  const formLevel = formIds.flatMap((formId) =>
    permissions
      .filter((permission) => FORM_LEVEL_PERMISSIONS.includes(permission))
      .map((permission) => ({
        id: 'demolocal_' + uuid(),
        roleId: role.id,
        formId,
        permission,
      }))
  );
  return [...appLevel, ...formLevel];
}

export async function clearDemoApps(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort demo cleanup */
  }
}

export async function listDemoApps(): Promise<DemoAppStored[]> {
  try {
    const db = await openDb();
    const rows = await new Promise<DemoAppStored[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result as DemoAppStored[] : []);
      req.onerror = () => reject(req.error);
    });
    return rows
      .map(normalize)
      .sort((a, b) => (a.app.updatedAt < b.app.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export async function getDemoApp(id: string): Promise<DemoAppStored | null> {
  const stored = await readKey(id);
  return stored ? normalize(stored) : null;
}

export async function getDemoAppBySlug(slug: string): Promise<DemoAppStored | null> {
  return (await listDemoApps()).find((stored) => stored.app.slug === slug) ?? null;
}

export async function createDemoApp(
  data: Partial<App> & { formIds?: string[] },
): Promise<DemoAppStored> {
  const now = new Date().toISOString();
  const id = 'demolocal_' + uuid();
  const existingSlugs = new Set((await listDemoApps()).map((stored) => stored.app.slug));
  const baseSlug = slugify(data.slug || data.name);
  let slug = baseSlug;
  let suffix = 2;
  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const formIds = Array.from(new Set((data.formIds ?? []).filter((formId) => typeof formId === 'string')));
  const forms: AppForm[] = formIds.map((formId, index) => ({
    id: 'demolocal_' + uuid(),
    appId: id,
    formId,
    displayName: 'Untitled',
    sortOrder: index,
    isVisible: true,
    settings: {},
  }));
  const owner = localRole(id, 'Owner', 0, 'Full access to the app and every data type.');
  const admin = localRole(id, 'Admin', 1, 'Manages the app, people and records.');
  const member = localRole(id, 'Member', 2, 'Creates records and works with their own submissions.');
  const viewer = localRole(id, 'Viewer', 3, 'Read-only access to app data.');
  const roles = [owner, admin, member, viewer];
  const rolePermissions: Record<string, AppPermission[]> = {
    [owner.id]: makePermissions(owner, formIds, [...APP_LEVEL_PERMISSIONS, ...FORM_LEVEL_PERMISSIONS]),
    [admin.id]: makePermissions(admin, formIds, [
      'manage_app', 'manage_users', 'view_analytics', 'execute_flows',
      'submit_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses',
    ]),
    [member.id]: makePermissions(member, formIds, ['submit_responses', 'view_own_responses', 'edit_responses']),
    [viewer.id]: makePermissions(viewer, formIds, ['view_all_responses']),
  };
  const app: App = {
    id,
    name: String(data.name ?? '').trim() || 'Untitled app',
    slug,
    ownerId: 'demo',
    canManage: true,
    description: data.description,
    logoUrl: data.logoUrl,
    status: 'draft',
    settings: { ...DEFAULT_APP_SETTINGS, ...(data.settings ?? {}) },
    theme: { ...DEFAULT_APP_THEME, ...(data.theme ?? {}) },
    navConfig: forms.map((form) => ({
      kind: 'form',
      formId: form.formId,
      displayName: form.displayName,
      sortOrder: form.sortOrder,
      isVisible: true,
    })),
    customScreen: data.customScreen,
    reports: data.reports,
    customLogic: data.customLogic,
    formCount: forms.length,
    publishedVersion: 0,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const stored: DemoAppStored = {
    app,
    forms,
    roles,
    rolePermissions,
    versions: [],
    bindings: [],
    users: [],
  };
  await writeKey(stored);
  return stored;
}

export async function updateDemoApp(id: string, patch: Partial<App>): Promise<DemoAppStored | null> {
  const stored = await getDemoApp(id);
  if (!stored) return null;
  const app: App = {
    ...stored.app,
    ...patch,
    id: stored.app.id,
    ownerId: stored.app.ownerId,
    canManage: true,
    settings: patch.settings ? { ...stored.app.settings, ...patch.settings } : stored.app.settings,
    theme: patch.theme ? { ...stored.app.theme, ...patch.theme } : stored.app.theme,
    navConfig: patch.navConfig ?? stored.app.navConfig,
    formCount: stored.forms.length,
    updatedAt: new Date().toISOString(),
  };
  const next = { ...stored, app };
  await writeKey(next);
  return next;
}

export async function deleteDemoApp(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort */
  }
}

export async function listDemoAppsFormUsage(): Promise<AppFormUsageApp[]> {
  return (await listDemoApps()).map(({ app, forms }) => ({
    appId: app.id,
    appName: app.name,
    slug: app.slug,
    canManage: true,
    forms: forms.map((form) => ({
      formId: form.formId,
      displayName: form.displayName,
      sortOrder: form.sortOrder,
      isVisible: form.isVisible,
    })),
  }));
}

export async function listDemoFormAppContexts(formId: string): Promise<FormAppContext[]> {
  return (await listDemoApps())
    .filter((stored) => stored.forms.some((form) => form.formId === formId))
    .map(({ app, forms }) => ({
      appId: app.id,
      appName: app.name,
      slug: app.slug,
      status: app.status,
      formDisplayName: forms.find((form) => form.formId === formId)?.displayName ?? 'Untitled',
      isPublished: app.status === 'published',
    }));
}

export async function addDemoAppForm(appId: string, formId: string, displayName?: string): Promise<AppForm[] | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  if (stored.forms.some((form) => form.formId === formId)) return stored.forms;
  const name = displayName?.trim() || 'Untitled';
  const attachment: AppForm = {
    id: 'demolocal_' + uuid(),
    appId,
    formId,
    displayName: name,
    sortOrder: stored.forms.length,
    isVisible: true,
    settings: {},
  };
  const forms = [...stored.forms, attachment];
  const rolePermissions = { ...stored.rolePermissions };
  for (const role of stored.roles) {
    const defaults: PermissionAction[] = role.name === 'Owner'
      ? [...FORM_LEVEL_PERMISSIONS]
      : role.name === 'Admin'
        ? ['submit_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses']
        : role.name === 'Member'
          ? ['submit_responses', 'view_own_responses', 'edit_responses']
          : role.name === 'Viewer'
            ? ['view_all_responses']
            : [];
    rolePermissions[role.id] = [
      ...(rolePermissions[role.id] ?? []),
      ...makePermissions(role, [formId], defaults),
    ];
  }
  const app = {
    ...stored.app,
    formCount: forms.length,
    navConfig: [
      ...stored.app.navConfig.filter((item) => item.formId !== formId),
      { kind: 'form' as const, formId, displayName: name, sortOrder: forms.length - 1, isVisible: true },
    ],
    updatedAt: new Date().toISOString(),
  };
  await writeKey({ ...stored, app, forms, rolePermissions });
  return forms;
}

export async function updateDemoAppForm(
  appId: string,
  formId: string,
  patch: Partial<AppForm>,
): Promise<AppForm[] | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const index = stored.forms.findIndex((form) => form.formId === formId);
  if (index === -1) return null;
  const forms = [...stored.forms];
  forms[index] = {
    ...forms[index],
    ...patch,
    id: forms[index].id,
    appId,
    formId,
    settings: patch.settings ? { ...forms[index].settings, ...patch.settings } : forms[index].settings,
  };
  const current = forms[index];
  const navConfig = stored.app.navConfig.map((item) =>
    item.formId === formId
      ? {
          ...item,
          displayName: current.displayName,
          sortOrder: current.sortOrder,
          isVisible: current.isVisible,
        }
      : item
  );
  await writeKey({
    ...stored,
    app: { ...stored.app, navConfig, updatedAt: new Date().toISOString() },
    forms,
  });
  return forms;
}

export async function removeDemoAppForm(appId: string, formId: string): Promise<boolean> {
  const stored = await getDemoApp(appId);
  if (!stored) return false;
  const forms = stored.forms
    .filter((form) => form.formId !== formId)
    .map((form, index) => ({ ...form, sortOrder: index }));
  const rolePermissions = Object.fromEntries(
    Object.entries(stored.rolePermissions).map(([roleId, permissions]) => [
      roleId,
      permissions.filter((permission) => permission.formId !== formId),
    ])
  );
  await writeKey({
    ...stored,
    app: {
      ...stored.app,
      formCount: forms.length,
      navConfig: stored.app.navConfig
        .filter((item) => item.formId !== formId)
        .map((item, index) => ({ ...item, sortOrder: index })),
      updatedAt: new Date().toISOString(),
    },
    forms,
    rolePermissions,
  });
  return true;
}

export async function reorderDemoAppForms(appId: string, formIds: string[]): Promise<AppForm[] | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const order = new Map(formIds.map((formId, index) => [formId, index]));
  const forms = [...stored.forms]
    .sort((a, b) => (order.get(a.formId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.formId) ?? Number.MAX_SAFE_INTEGER))
    .map((form, index) => ({ ...form, sortOrder: index }));
  const navOrder = new Map(forms.map((form) => [form.formId, form.sortOrder]));
  const navConfig = [...stored.app.navConfig]
    .sort((a, b) => (navOrder.get(a.formId ?? '') ?? Number.MAX_SAFE_INTEGER) - (navOrder.get(b.formId ?? '') ?? Number.MAX_SAFE_INTEGER))
    .map((item, index) => ({ ...item, sortOrder: index }));
  await writeKey({
    ...stored,
    app: { ...stored.app, navConfig, updatedAt: new Date().toISOString() },
    forms,
  });
  return forms;
}

export async function listDemoAppRoles(appId: string): Promise<AppRole[]> {
  return (await getDemoApp(appId))?.roles ?? [];
}

export async function createDemoAppRole(appId: string, name: string, description?: string): Promise<AppRole | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const role: AppRole = {
    id: 'demolocal_' + uuid(),
    appId,
    name: name.trim(),
    description,
    isSystem: false,
    sortOrder: stored.roles.length,
  };
  await writeKey({
    ...stored,
    roles: [...stored.roles, role],
    rolePermissions: { ...stored.rolePermissions, [role.id]: [] },
  });
  return role;
}

export async function updateDemoAppRole(appId: string, roleId: string, patch: Partial<AppRole>): Promise<AppRole[] | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const roles = stored.roles.map((role) =>
    role.id === roleId
      ? { ...role, ...patch, id: role.id, appId, isSystem: role.isSystem }
      : role
  );
  await writeKey({ ...stored, roles });
  return roles;
}

export async function deleteDemoAppRole(appId: string, roleId: string): Promise<boolean> {
  const stored = await getDemoApp(appId);
  if (!stored) return false;
  const role = stored.roles.find((candidate) => candidate.id === roleId);
  if (!role || role.isSystem) return false;
  const rolePermissions = { ...stored.rolePermissions };
  delete rolePermissions[roleId];
  await writeKey({
    ...stored,
    roles: stored.roles.filter((candidate) => candidate.id !== roleId),
    rolePermissions,
  });
  return true;
}

export async function getDemoAppRolePermissions(appId: string, roleId: string): Promise<AppPermission[]> {
  return (await getDemoApp(appId))?.rolePermissions[roleId] ?? [];
}

export async function setDemoAppRolePermissions(
  appId: string,
  roleId: string,
  permissions: Array<{ formId?: string | null; permission?: unknown }>,
): Promise<AppPermission[] | null> {
  const stored = await getDemoApp(appId);
  if (!stored || !stored.roles.some((role) => role.id === roleId)) return null;
  const allowed = new Set<string>([...APP_LEVEL_PERMISSIONS, ...FORM_LEVEL_PERMISSIONS]);
  const rows: AppPermission[] = permissions
    .filter((permission) => typeof permission.permission === 'string' && allowed.has(permission.permission))
    .map((permission) => ({
      id: 'demolocal_' + uuid(),
      roleId,
      formId: typeof permission.formId === 'string' ? permission.formId : null,
      permission: permission.permission as PermissionAction,
    }));
  await writeKey({
    ...stored,
    rolePermissions: { ...stored.rolePermissions, [roleId]: rows },
  });
  return rows;
}

export async function publishDemoApp(appId: string, label?: string): Promise<{ app: App; version: AppVersion } | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const now = new Date().toISOString();
  const versionNumber = (stored.app.publishedVersion ?? 0) + 1;
  const app: App = {
    ...stored.app,
    status: 'published',
    publishedVersion: versionNumber,
    publishedAt: now,
    updatedAt: now,
  };
  const version: AppVersion = {
    id: 'demolocal_' + uuid(),
    version: versionNumber,
    label: label?.trim() || null,
    publishedBy: 'Demo visitor',
    createdAt: now,
  };
  await writeKey({ ...stored, app, versions: [version, ...stored.versions] });
  return { app, version };
}

export async function listDemoAppVersions(appId: string): Promise<AppVersion[]> {
  return (await getDemoApp(appId))?.versions ?? [];
}

function bindingMode(value: unknown): FlowBindingMode | undefined {
  return value === 'sync' || value === 'async' || value === 'background' || value === 'manual'
    ? value
    : undefined;
}

function objectOrNull(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayOrNull<T>(value: unknown): T[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) ? value as T[] : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function bindingPatch(appId: string, payload: Record<string, unknown>): Partial<FlowBinding> {
  const patch: Partial<FlowBinding> = { appId };
  if (typeof payload.formId === 'string' || payload.formId === null) patch.formId = payload.formId;
  if (typeof payload.connectorId === 'string' || payload.connectorId === null) patch.connectorId = payload.connectorId;
  if (typeof payload.flowDefinitionId === 'string') patch.flowDefinitionId = payload.flowDefinitionId;
  if (typeof payload.flow === 'string') patch.flow = payload.flow;
  if (typeof payload.event === 'string') patch.event = payload.event;
  const mode = bindingMode(payload.mode);
  if (mode) patch.mode = mode;
  const condition = objectOrNull(payload.condition);
  if (condition !== undefined) patch.condition = condition as FlowBinding['condition'];
  const inputMap = objectOrNull(payload.inputMap);
  if (inputMap !== undefined) patch.inputMap = inputMap;
  const outputActions = arrayOrNull<NonNullable<FlowBinding['outputActions']>[number]>(payload.outputActions);
  if (outputActions !== undefined) patch.outputActions = outputActions as FlowBinding['outputActions'];
  const timeoutMs = finiteNumber(payload.timeoutMs);
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
  const retryPolicy = objectOrNull(payload.retryPolicy);
  if (retryPolicy !== undefined) patch.retryPolicy = retryPolicy as FlowBinding['retryPolicy'];
  const fallbackPolicy = objectOrNull(payload.fallbackPolicy);
  if (fallbackPolicy !== undefined) patch.fallbackPolicy = fallbackPolicy as FlowBinding['fallbackPolicy'];
  if (typeof payload.enabled === 'boolean') patch.enabled = payload.enabled;
  const sortOrder = finiteNumber(payload.sortOrder);
  if (sortOrder !== undefined) patch.sortOrder = sortOrder;
  return patch;
}

export async function listDemoAppBindings(appId: string): Promise<FlowBinding[]> {
  return (await getDemoApp(appId))?.bindings ?? [];
}

export async function listDemoBindingsForFlow(flowId: string): Promise<FlowBinding[]> {
  return (await listDemoApps())
    .flatMap((stored) => stored.bindings)
    .filter((binding) => binding.flowDefinitionId === flowId);
}

export async function createDemoAppBinding(appId: string, payload: Record<string, unknown>): Promise<FlowBinding | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const now = new Date().toISOString();
  const patch = bindingPatch(appId, payload);
  const flow = patch.flow ?? '';
  const flows = await demoApplyFlowOverlay(appId, []);
  const flowDefinitionId = patch.flowDefinitionId
    ?? flows.find((candidate) => candidate.slug === flow)?.id
    ?? '';
  const binding: FlowBinding = {
    id: 'demolocal_' + uuid(),
    appId,
    formId: patch.formId ?? null,
    connectorId: patch.connectorId ?? null,
    flowDefinitionId,
    flow,
    event: patch.event ?? 'form.submitted',
    mode: patch.mode ?? 'async',
    condition: patch.condition ?? null,
    inputMap: patch.inputMap ?? null,
    outputActions: patch.outputActions ?? null,
    timeoutMs: patch.timeoutMs ?? 30000,
    retryPolicy: patch.retryPolicy ?? null,
    fallbackPolicy: patch.fallbackPolicy ?? null,
    enabled: patch.enabled ?? true,
    sortOrder: patch.sortOrder ?? stored.bindings.length,
    createdAt: now,
    updatedAt: now,
  };
  await writeKey({ ...stored, bindings: [...stored.bindings, binding] });
  return binding;
}

export async function updateDemoAppBinding(
  appId: string,
  bindingId: string,
  payload: Record<string, unknown>,
): Promise<FlowBinding | null> {
  const stored = await getDemoApp(appId);
  if (!stored) return null;
  const index = stored.bindings.findIndex((binding) => binding.id === bindingId);
  if (index === -1) return null;
  const bindings = [...stored.bindings];
  bindings[index] = {
    ...bindings[index],
    ...bindingPatch(appId, payload),
    id: bindingId,
    appId,
    updatedAt: new Date().toISOString(),
  };
  await writeKey({ ...stored, bindings });
  return bindings[index];
}

export async function deleteDemoAppBinding(appId: string, bindingId: string): Promise<boolean> {
  const stored = await getDemoApp(appId);
  if (!stored) return false;
  await writeKey({
    ...stored,
    bindings: stored.bindings.filter((binding) => binding.id !== bindingId),
  });
  return true;
}

export function isDemoLocalAppId(id: unknown): id is string {
  return isDemoLocalId(id);
}
