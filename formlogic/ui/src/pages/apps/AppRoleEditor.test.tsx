// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoleEditor } from './AppRoleEditor';

const mocks = vi.hoisted(() => ({
  getPermissions: vi.fn(),
  savePermissions: vi.fn(),
  store: {
    fetchRoles: vi.fn(), fetchAppForms: vi.fn(), createRole: vi.fn(),
    deleteRole: vi.fn(), updateRole: vi.fn(), getApp: vi.fn(),
  },
}));
vi.mock('../../stores/appStore', () => ({ useAppStore: () => mocks.store }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'owner' } }),
}));
vi.mock('../../lib/api', () => ({ api: { getAppRolePermissions: mocks.getPermissions, setAppRolePermissions: mocks.savePermissions } }));
vi.mock('../../components/admin/AdminActingContext', () => ({
  useResourcePaths: () => ({ appSub: (id: string, path: string) => `/apps/${id}/${path}` }),
}));
vi.mock('../../components/layout/Header', () => ({
  Header: ({ title, actions }: { title: string; actions: ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
}));
vi.mock('../../components/ui/PermissionMatrix', () => ({
  PermissionMatrix: ({ permissions }: { permissions: unknown[] }) => <output data-testid="permissions">{JSON.stringify(permissions)}</output>,
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
    mocks.store.getApp.mockReturnValue({ ownerId: 'owner' });
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
});
