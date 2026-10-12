// @vitest-environment jsdom
// Only the app's Owner may change the role of, suspend or remove a member whose role grants an
// app-level permission (manage app / users / roles, analytics, Aokie Companion): the server refuses
// anyone else. A non-owner manager sees those controls disabled, with the reason, instead of a
// failed save. The same holds for giving a member such a role.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRole, AppUser } from '../../types/app';

const mocks = vi.hoisted(() => ({
  viewer: 'owner-user',
  users: [] as AppUser[],
  roles: [] as AppRole[],
}));
vi.mock('../../stores/appUserStore', () => ({
  useAppUserStore: () => ({
    users: { app1: mocks.users }, invitations: { app1: [] }, groups: { app1: [] },
    fetchUsers: vi.fn(async () => {}), fetchInvitations: vi.fn(async () => {}), fetchGroups: vi.fn(async () => {}),
    inviteUser: vi.fn(), revokeInvitation: vi.fn(), removeUser: vi.fn(), updateUser: vi.fn(),
    createGroup: vi.fn(), deleteGroup: vi.fn(), addGroupMember: vi.fn(), removeGroupMember: vi.fn(),
  }),
}));
vi.mock('../../stores/appStore', () => ({
  useAppStore: () => ({ fetchRoles: async () => mocks.roles, getApp: () => ({ id: 'app1', ownerId: 'owner-user' }) }),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: mocks.viewer } }),
}));
vi.mock('../../components/admin/AdminActingContext', () => ({
  useResourcePaths: () => ({ appSub: (id: string, path: string) => `/apps/${id}/${path}` }),
}));
vi.mock('../../components/layout/Header', () => ({
  Header: ({ title, actions }: { title: string; actions: ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
}));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AppUserManager } from './AppUserManager';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const perm = (roleId: string, permission: string) => ({ id: `${roleId}-${permission}`, roleId, formId: null, permission });
const roles: AppRole[] = [
  { id: 'r-owner', appId: 'app1', name: 'Owner', isSystem: true, sortOrder: 0, permissions: [] },
  { id: 'r-admin', appId: 'app1', name: 'Admin', isSystem: true, sortOrder: 1, permissions: [perm('r-admin', 'manage_users')] as AppRole['permissions'] },
  { id: 'r-flows', appId: 'app1', name: 'Runner', isSystem: false, sortOrder: 2, permissions: [perm('r-flows', 'execute_flows')] as AppRole['permissions'] },
  { id: 'r-member', appId: 'app1', name: 'Member', isSystem: true, sortOrder: 3, permissions: [] },
];
const member = (id: string, roleId: string, name: string): AppUser => ({ id, appId: 'app1', userId: `u-${id}`, roleId, status: 'active', name, email: `${id}@example.test`, roleName: roles.find((r) => r.id === roleId)?.name });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  mocks.roles = roles;
  mocks.users = [member('m-admin', 'r-admin', 'Ada Admin'), member('m-flows', 'r-flows', 'Flo Runner'), member('m-plain', 'r-member', 'Pat Plain')];
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // The table measures its width to choose between rows and cards.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(viewer: string) {
  mocks.viewer = viewer;
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/apps/app1/users']}>
      <Routes><Route path="/apps/:appId/users" element={<AppUserManager />} /></Routes>
    </MemoryRouter>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The action buttons in the row (or card) that shows this member's name. */
function controls(name: string) {
  // The smallest element holding both the name and an Edit button is that member's own row.
  const row = [...container.querySelectorAll('tr, li, div')]
    .filter((node) => node.textContent?.includes(name) && node.querySelector('button[aria-label^="Edit member"]'))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0] as HTMLElement | undefined;
  expect(row, `row for ${name}`).toBeDefined();
  return {
    edit: row!.querySelector<HTMLButtonElement>('button[aria-label^="Edit member"]')!,
    remove: row!.querySelector<HTMLButtonElement>('button[aria-label^="Remove user"]')!,
    text: row!.textContent ?? '',
  };
}

describe('AppUserManager for a manager who is not the Owner', () => {
  it('disables changing or removing a member whose role grants an app-level permission, and says why', async () => {
    await mount('manager-user');
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(true);
    expect(admin.remove.disabled).toBe(true);
    expect(admin.text).toContain('Owner only');
    expect(admin.edit.getAttribute('title')).toMatch(/only the app owner/i);
  });

  it('leaves other members editable, including one whose role only runs flows', async () => {
    await mount('manager-user');
    for (const name of ['Pat Plain', 'Flo Runner']) {
      const row = controls(name);
      expect(row.edit.disabled).toBe(false);
      expect(row.remove.disabled).toBe(false);
    }
  });

  it('does not offer an app-level role to give a member', async () => {
    await mount('manager-user');
    await act(async () => controls('Pat Plain').edit.click());
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'r-admin'))!;
    const admin = [...select.options].find((o) => o.value === 'r-admin')!;
    expect(admin.disabled).toBe(true);
    expect(admin.textContent).toMatch(/owner only/i);
    expect([...select.options].find((o) => o.value === 'r-flows')!.disabled).toBe(false);
  });
});

describe('AppUserManager for the Owner', () => {
  it('can change or remove every member but the Owner', async () => {
    await mount('owner-user');
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(false);
    expect(admin.remove.disabled).toBe(false);
    expect(admin.text).not.toContain('Owner only');
  });
});
