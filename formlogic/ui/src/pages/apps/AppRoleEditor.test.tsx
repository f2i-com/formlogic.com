// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoleEditor } from './AppRoleEditor';

const mocks = vi.hoisted(() => ({
  getPermissions: vi.fn(),
  savePermissions: vi.fn(),
  viewer: 'owner',
  acting: null as { ownerId: string } | null,
  getApp: vi.fn(),
  store: {
    fetchRoles: vi.fn(), fetchAppForms: vi.fn(), createRole: vi.fn(),
    deleteRole: vi.fn(), updateRole: vi.fn(), getApp: vi.fn(),
  },
}));
vi.mock('../../stores/appStore', () => ({ useAppStore: () => mocks.store }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: mocks.viewer } }),
}));
vi.mock('../../lib/api', () => ({ api: { getAppRolePermissions: mocks.getPermissions, setAppRolePermissions: mocks.savePermissions, getApp: mocks.getApp } }));
vi.mock('../../components/admin/AdminActingContext', () => ({
  useResourcePaths: () => ({ appSub: (id: string, path: string) => `/apps/${id}/${path}` }),
  useAdminActing: () => mocks.acting,
}));
vi.mock('../../components/layout/Header', () => ({
  Header: ({ title, actions }: { title: string; actions: ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
}));
// The matrix, reduced to what it shows and one edit: a form-level grant added.
vi.mock('../../components/ui/PermissionMatrix', () => ({
  PermissionMatrix: ({ permissions, onChange, appLevelDisabled }: { permissions: unknown[]; onChange: (next: unknown[]) => void; appLevelDisabled?: boolean }) => (
    <>
      <output data-testid="permissions">{JSON.stringify(permissions)}</output>
      <output data-testid="app-level">{appLevelDisabled ? 'owner only' : 'editable'}</output>
      <button type="button" onClick={() => onChange([...permissions, { formId: 'form-x', permission: 'view_all_responses' }])}>add form grant</button>
    </>
  ),
}));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type PermissionsReply = { data?: { permissions: Array<{ formId: string; permission: string }> }; error?: string };

describe('role permission loading', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.fetchRoles.mockResolvedValue([
      { id: 'alpha', appId: 'app', name: 'Alpha', isSystem: false },
      { id: 'beta', appId: 'app', name: 'Beta', isSystem: false },
    ]);
    mocks.store.fetchAppForms.mockResolvedValue([]);
    mocks.store.getApp.mockReturnValue({ ownerId: 'owner', canManage: true });
    mocks.viewer = 'owner';
    mocks.acting = null;
    // GET /apps/{id} for an app that is not the asker's to open is answered not found.
    mocks.getApp.mockResolvedValue({ error: 'App not found or access denied', status: 404 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function mount() {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/apps/app/roles']}>
        <Routes><Route path="/apps/:appId/roles" element={<AppRoleEditor />} /></Routes>
      </MemoryRouter>,
    ));
  }
  async function click(name: string) {
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === name);
    expect(button, `button ${name}`).toBeDefined();
    await act(async () => button!.click());
  }

  it('removes the prior role matrix immediately and keeps save disabled on an unread role', async () => {
    const alpha = deferred<PermissionsReply>();
    const beta = deferred<PermissionsReply>();
    mocks.getPermissions.mockImplementation((_app: string, role: string) => role === 'alpha' ? alpha.promise : beta.promise);
    await mount();
    await act(async () => alpha.resolve({ data: { permissions: [{ formId: 'form-a', permission: 'read' }] } }));
    expect(container.querySelector('[data-testid="permissions"]')?.textContent).toContain('form-a');
    await click('Beta');
    expect(container.querySelector('[data-testid="permissions"]')).toBeNull();
    expect(container.querySelector('[aria-label="Loading permissions"]')).not.toBeNull();
    await act(async () => beta.resolve({ error: 'The role could not be read' }));
    expect(container.textContent).toContain("Couldn't read this role's permissions");
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save permissions');
    expect(save?.disabled).toBe(true);
    expect(mocks.savePermissions).not.toHaveBeenCalled();
  });

  it('ignores a late permission response after another role is selected', async () => {
    const alpha = deferred<PermissionsReply>();
    const beta = deferred<PermissionsReply>();
    mocks.getPermissions.mockImplementation((_app: string, role: string) => role === 'alpha' ? alpha.promise : beta.promise);
    await mount();
    await click('Beta');
    await act(async () => beta.resolve({ data: { permissions: [{ formId: 'beta-form', permission: 'read' }] } }));
    await act(async () => alpha.resolve({ data: { permissions: [{ formId: 'alpha-form', permission: 'read' }] } }));
    expect(container.querySelector('[data-testid="permissions"]')?.textContent).toContain('beta-form');
    expect(container.querySelector('[data-testid="permissions"]')?.textContent).not.toContain('alpha-form');
  });

  // App-level grants are the owner's alone to give or take away. Who the owner is comes from the
  // apps list: canManage is true, and ownerId present, only on the owner's own row.
  describe('app-level grants and who owns the app', () => {
    const appLevel = () => container.querySelector('[data-testid="app-level"]')?.textContent;
    beforeEach(() => {
      mocks.getPermissions.mockResolvedValue({ data: { permissions: [{ formId: null, permission: 'manage_users' }] } });
    });

    it('are editable for the owner', async () => {
      await mount();
      expect(appLevel()).toBe('editable');
    });

    it('are the owner’s alone for a delegated manager, whose row has canManage false and no ownerId', async () => {
      mocks.viewer = 'manager';
      mocks.store.getApp.mockReturnValue({ canManage: false });
      await mount();
      expect(appLevel()).toBe('owner only');
    });

    it('are the owner’s alone when the app is not in the list (a draft or archived app is not listed to a member, and asking for it is answered not found)', async () => {
      mocks.viewer = 'manager';
      mocks.store.getApp.mockReturnValue(undefined);
      await mount();
      expect(mocks.getApp).toHaveBeenCalledWith('app');
      expect(appLevel()).toBe('owner only');
    });

    // The list is loaded by the page shell: an owner can be here before it arrives, or after it
    // failed to load, and is not to be shown their own app's grants as someone else's.
    it('are editable for the owner whose list does not hold the app, once the app itself says whose it is', async () => {
      mocks.store.getApp.mockReturnValue(undefined);
      mocks.getApp.mockResolvedValue({ data: { app: { id: 'app', ownerId: 'owner' } } });
      await mount();
      expect(appLevel()).toBe('editable');
    });

    it('are not locked when neither the list nor the app could be read', async () => {
      mocks.store.getApp.mockReturnValue(undefined);
      mocks.getApp.mockResolvedValue({ error: 'Failed to fetch' });
      await mount();
      expect(appLevel()).toBe('editable');
    });

    // /admin/apps/{id}/roles: the server runs the request as the owner, and the list is the admin's.
    it('are editable for a platform admin acting for the owner', async () => {
      mocks.viewer = 'admin';
      mocks.acting = { ownerId: 'owner' };
      mocks.store.getApp.mockReturnValue(undefined);
      await mount();
      expect(appLevel()).toBe('editable');
    });

    it('go back unchanged when a delegated manager saves the role', async () => {
      mocks.viewer = 'manager';
      mocks.store.getApp.mockReturnValue({ canManage: false });
      mocks.savePermissions.mockResolvedValue({ data: {} });
      await mount();
      await click('add form grant');
      await click('Save permissions');
      expect(mocks.savePermissions).toHaveBeenCalledTimes(1);
      const sent = mocks.savePermissions.mock.calls[0][2] as Array<{ formId: string | null; permission: string }>;
      expect(sent).toContainEqual({ formId: null, permission: 'manage_users' });
      expect(sent).toContainEqual({ formId: 'form-x', permission: 'view_all_responses' });
    });
  });
});
