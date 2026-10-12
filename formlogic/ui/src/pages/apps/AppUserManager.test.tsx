// @vitest-environment jsdom
// Only the app's Owner may change the role of, suspend or remove a member whose role grants an
// app-level permission (manage app / users / roles, analytics, Aokie Companion): the server refuses
// anyone else. A non-owner manager sees those controls disabled, with the reason, instead of a
// failed save. The same holds for giving a member such a role. Which members those are is the
// server's call (each row's holdsAppLevelRole), and who the owner is comes from the apps list
// (canManage true, and ownerId present, only on the owner's row), or from the app itself when the
// list does not hold it (see useViewerOwnsApp).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRole, AppUser } from '../../types/app';

const mocks = vi.hoisted(() => ({
  viewer: 'owner-user',
  users: [] as AppUser[],
  roles: [] as AppRole[],
  app: undefined as Record<string, unknown> | undefined,
  acting: null as { ownerId: string } | null,
  getApp: vi.fn(),
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
  useAppStore: () => ({ fetchRoles: async () => mocks.roles, getApp: () => mocks.app }),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: mocks.viewer } }),
}));
vi.mock('../../components/admin/AdminActingContext', () => ({
  useResourcePaths: () => ({ appSub: (id: string, path: string) => `/apps/${id}/${path}` }),
  useAdminActing: () => mocks.acting,
}));
vi.mock('../../lib/api', () => ({ api: { getApp: mocks.getApp } }));
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
const member = (id: string, roleId: string, name: string, holdsAppLevelRole: boolean): AppUser => ({ id, appId: 'app1', userId: `u-${id}`, roleId, status: 'active', name, email: `${id}@example.test`, roleName: roles.find((r) => r.id === roleId)?.name, holdsAppLevelRole });
const ownerRow = { id: 'app1', ownerId: 'owner-user', canManage: true };
const managerRow = { id: 'app1', canManage: false };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  mocks.roles = roles;
  mocks.users = [member('m-admin', 'r-admin', 'Ada Admin', true), member('m-flows', 'r-flows', 'Flo Runner', false), member('m-plain', 'r-member', 'Pat Plain', false)];
  mocks.app = ownerRow;
  mocks.acting = null;
  // GET /apps/{id} for an app that is not the asker's to open is answered not found.
  mocks.getApp.mockReset().mockResolvedValue({ error: 'App not found or access denied', status: 404 });
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

/** `app` null: the app is not in the viewer's apps list. */
async function mount(viewer: string, listed: Record<string, unknown> | null = viewer === 'owner-user' ? ownerRow : managerRow) {
  const app = listed ?? undefined;
  mocks.viewer = viewer;
  mocks.app = app;
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

  it('follows the server’s flag for each member, not a reading of the role here', async () => {
    mocks.users = [member('m-admin', 'r-admin', 'Ada Admin', false), member('m-plain', 'r-member', 'Pat Plain', true)];
    await mount('manager-user');
    expect(controls('Ada Admin').edit.disabled).toBe(false);
    expect(controls('Pat Plain').edit.disabled).toBe(true);
    expect(controls('Pat Plain').remove.disabled).toBe(true);
  });

  it('does not take an app missing from the list as the viewer’s own: a draft is not listed to a member, and asking for it is answered not found', async () => {
    await mount('manager-user', null);
    expect(mocks.getApp).toHaveBeenCalledWith('app1');
    expect(controls('Ada Admin').edit.disabled).toBe(true);
    expect(controls('Ada Admin').remove.disabled).toBe(true);
  });

  it('is told the same when the app answers with the member’s copy, which has no ownerId', async () => {
    mocks.getApp.mockResolvedValue({ data: { app: { id: 'app1', name: 'Shared app' } } });
    await mount('manager-user', null);
    expect(controls('Ada Admin').edit.disabled).toBe(true);
    expect(controls('Ada Admin').text).toContain('Owner only');
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

describe('an invitation the server refuses', () => {
  // The store shows the server's reason (a toast with its sentence); the dialog must not add a
  // guess that contradicts it, such as blaming the email for a role only the owner may give.
  it('says it was not sent without guessing why', async () => {
    await mount('owner-user');
    const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Invite user"]')!.click());
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => setValue(dialog.querySelector('input[type="email"]')!, 'new@example.test'));
    await act(async () => setValue(dialog.querySelector('select')!, 'r-member'));
    const send = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Send invitation')!;
    await act(async () => send.click());
    expect(dialog.textContent).toContain('The invitation was not sent.');
    expect(dialog.textContent).not.toContain('check the email');
  });
});

describe('AppUserManager for the Owner', () => {
  it('can change or remove every member but the Owner', async () => {
    await mount('owner-user');
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(false);
    expect(admin.remove.disabled).toBe(false);
    expect(admin.text).not.toContain('Owner only');
    // The list already says whose app it is: nothing more is asked.
    expect(mocks.getApp).not.toHaveBeenCalled();
  });
});

// The apps list is loaded by the page shell, not by this page. An owner can be here before it has
// arrived (a direct link in a new browser) or after it failed to load, and neither is to be told
// "Owner only" about their own app.
describe('AppUserManager when the apps list does not hold the app', () => {
  it('asks for the app itself and gives its owner every control', async () => {
    mocks.getApp.mockResolvedValue({ data: { app: { id: 'app1', ownerId: 'owner-user' } } });
    await mount('owner-user', null);
    expect(mocks.getApp).toHaveBeenCalledWith('app1');
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(false);
    expect(admin.remove.disabled).toBe(false);
    expect(admin.text).not.toContain('Owner only');
  });

  it('does not say "Owner only" while that answer is on its way', async () => {
    let answer!: (value: unknown) => void;
    mocks.getApp.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await mount('owner-user', null);
    expect(controls('Ada Admin').text).not.toContain('Owner only');
    expect(controls('Ada Admin').edit.disabled).toBe(false);
    await act(async () => { answer({ data: { app: { id: 'app1', ownerId: 'owner-user' } } }); });
    expect(controls('Ada Admin').edit.disabled).toBe(false);
  });

  it('does not lock the owner out when the app could not be read either', async () => {
    mocks.getApp.mockResolvedValue({ error: 'Failed to fetch' });
    await mount('owner-user', null);
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(false);
    expect(admin.remove.disabled).toBe(false);
    expect(admin.text).not.toContain('Owner only');
  });

  it('takes the list’s word as soon as the list holds the app', async () => {
    mocks.getApp.mockResolvedValue({ error: 'Failed to fetch' });
    await mount('manager-user', null);
    expect(controls('Ada Admin').edit.disabled).toBe(false);
    await mount('manager-user', managerRow);
    expect(controls('Ada Admin').edit.disabled).toBe(true);
    expect(controls('Ada Admin').text).toContain('Owner only');
  });
});

// /admin/apps/{id}/users: the server runs each request as the app's owner (AdminActAsMiddleware),
// so the admin is given the owner's controls. The signed-in id is the admin's own, and the apps
// list is the admin's own unless another page fetched the owner's.
describe('AppUserManager for a platform admin acting for the owner', () => {
  it('gives the owner’s controls without the app in the list', async () => {
    mocks.acting = { ownerId: 'owner-user' };
    await mount('admin-user', null);
    const admin = controls('Ada Admin');
    expect(admin.edit.disabled).toBe(false);
    expect(admin.remove.disabled).toBe(false);
    expect(admin.text).not.toContain('Owner only');
  });

  it('offers a member any role but Owner', async () => {
    mocks.acting = { ownerId: 'owner-user' };
    await mount('admin-user', null);
    await act(async () => controls('Pat Plain').edit.click());
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'r-admin'))!;
    expect([...select.options].find((o) => o.value === 'r-admin')!.disabled).toBe(false);
  });
});
