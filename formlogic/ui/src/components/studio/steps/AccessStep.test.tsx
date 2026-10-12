// @vitest-environment jsdom
// Access step regression: while the studio's role list is still loading the
// step renders with roles=[] and no fetched permissions — that intermediate
// state used to crash (permsState?.roleId === selected?.id read as "loaded"
// when BOTH sides were undefined, then permsState!.dirty threw on null).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessStep } from './AccessStep';
import { api } from '../../../lib/api';
import { useAuthStore } from '../../../stores/authStore';
import type { App, AppRole } from '../../../types/app';

vi.mock('../../../lib/api', () => ({
  api: {
    getAppRolePermissions: vi.fn(async () => ({ data: { permissions: [{ formId: null, permission: 'manage_users' }] } })),
    setAppRolePermissions: vi.fn(async () => ({ data: {} })),
    getAppUsers: vi.fn(async () => ({ data: { users: [], count: 0 } })),
    getAppInvitations: vi.fn(async () => ({ data: { invitations: [] } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const app = {
  id: 'a1',
  name: 'Test app',
  slug: 'test-app',
  status: 'draft',
  settings: {},
} as unknown as App;

const roles: AppRole[] = [
  { id: 'r1', appId: 'a1', name: 'Owner', isSystem: true, sortOrder: 0 } as AppRole,
  { id: 'r2', appId: 'a1', name: 'Member', isSystem: true, sortOrder: 2 } as AppRole,
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getAppRolePermissions).mockReset().mockResolvedValue({ data: { permissions: [{ formId: null, permission: 'manage_users' }] } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function renderStep(stepRoles: AppRole[], strict = false) {
  return act(async () => {
    const element = (
      <MemoryRouter>
        <AccessStep
          app={app}
          roles={stepRoles}
          appForms={[]}
          formsById={{}}
          onReloadRoles={async () => {}}
          onReloadApp={async () => {}}
        />
      </MemoryRouter>
    );
    root.render(strict ? <React.StrictMode>{element}</React.StrictMode> : element);
  });
}

describe('AccessStep', () => {
  it('renders the loading state (roles=[]) without crashing, then the loaded roles', async () => {
    await renderStep([]);
    expect(container.textContent).toContain('App roles');

    await renderStep(roles);
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('Member');
  });

  it('shows the Owner summary once a role is selected', async () => {
    await renderStep(roles);
    expect(container.textContent).toContain('Everything in this app');
  });

  it('a failed permissions read never renders as "this role has no permissions"', async () => {
    // Rendering an unread set as empty and letting the user Save over it silently
    // revoked every grant the role really held.
    vi.mocked(api.getAppRolePermissions).mockResolvedValue({ error: 'Server error (500)' } as never);

    await renderStep(roles);
    // Select the non-Owner role, whose matrix would otherwise be editable.
    const memberRow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Member'))!;
    await act(async () => { memberRow.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("Couldn't read this role's permissions");
    expect(container.textContent).not.toContain('Nothing yet');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Save permissions')).toBe(false);
  });

  it('keeps unsaved matrix edits per role when the user clicks another role', async () => {
    vi.mocked(api.getAppRolePermissions).mockResolvedValue({ data: { permissions: [] } } as never);

    await renderStep(roles);
    const clickByText = async (text: string) => {
      const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;
      await act(async () => { el.click(); });
      await act(async () => { await Promise.resolve(); });
    };
    await clickByText('Member');

    // Tick any permission box to make the Member draft dirty.
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box).toBeTruthy();
    await act(async () => { box.click(); });
    expect(container.textContent).toContain('Unsaved changes');

    // Switching to Owner and back must not throw the draft away.
    await clickByText('Owner');
    await clickByText('Member');
    expect(container.textContent).toContain('Unsaved changes');
  });

  it('renders the People tab without looping (regression: unstable ?? [] selectors)', async () => {
    await renderStep(roles);
    const peopleTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('People & invites')
    )!;
    expect(peopleTab).toBeTruthy();
    await act(async () => { peopleTab.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('People with access');
  });
});


it('finishes loading Owner permissions after StrictMode replays the effect', async () => {
  await renderStep(roles, true);
  expect(container.querySelector('[aria-label="Loading permissions"]')).toBeNull();
  expect(container.textContent).toContain('Everything in this app');
  expect(container.textContent).toContain('The Owner role always has every permission');
});

it('retries a cancelled load when returning to a role before its request finishes', async () => {
  let resolveFirst!: (result: Awaited<ReturnType<typeof api.getAppRolePermissions>>) => void;
  vi.mocked(api.getAppRolePermissions).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
  await renderStep(roles);
  expect(container.querySelector('[aria-label="Loading permissions"]')).not.toBeNull();
  const clickRole = async (name: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(name))!;
    await act(async () => button.click());
  };
  await clickRole('Member');
  await clickRole('Owner');
  expect(api.getAppRolePermissions).toHaveBeenCalledTimes(3);
  expect(container.querySelector('[aria-label="Loading permissions"]')).toBeNull();
  await act(async () => resolveFirst({ error: 'Outdated request failed' }));
  expect(container.textContent).toContain('Everything in this app');
  expect(container.textContent).not.toContain('Outdated request failed');
});

// Only the app's Owner may change the role of, suspend or remove a member whose role grants an
// app-level permission, or give a member such a role: the server refuses anyone else. A manager who
// is not the Owner sees those controls disabled, with the reason, rather than a failed save.
describe('AccessStep people, for a manager who is not the Owner', () => {
  const perm = (roleId: string, permission: string) => ({ id: `${roleId}-${permission}`, roleId, formId: null, permission });
  const guardedRoles = [
    { id: 'r1', appId: 'a1', name: 'Owner', isSystem: true, sortOrder: 0, permissions: [] },
    { id: 'r-admin', appId: 'a1', name: 'Admin', isSystem: true, sortOrder: 1, permissions: [perm('r-admin', 'manage_users')] },
    { id: 'r2', appId: 'a1', name: 'Member', isSystem: true, sortOrder: 2, permissions: [] },
  ] as unknown as AppRole[];
  const member = (id: string, roleId: string, name: string) => ({ id, appId: 'a1', userId: `u-${id}`, roleId, status: 'active', name, email: `${id}@example.test` });

  async function openPeople(viewer: string) {
    useAuthStore.setState({ user: { id: viewer } as never });
    vi.mocked(api.getAppUsers).mockResolvedValue({ data: { users: [member('m-owner', 'r1', 'Olive Owner'), member('m-admin', 'r-admin', 'Ada Admin'), member('m-plain', 'r2', 'Pat Plain')], count: 3 } } as never);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AccessStep app={{ ...app, ownerId: 'u-m-owner' } as App} roles={guardedRoles} appForms={[]} formsById={{}} onReloadRoles={async () => {}} onReloadApp={async () => {}} />
        </MemoryRouter>,
      );
    });
    const tab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('People & invites'))!;
    await act(async () => { tab.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const roleSelect = (name: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="Role for ${name}"]`);
  const removeButton = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="Remove ${name}"]`);

  afterEach(() => useAuthStore.setState({ user: null }));

  it('disables the role and Remove of a member whose role grants an app-level permission, and says why', async () => {
    await openPeople('u-manager');
    expect(roleSelect('Ada Admin')?.disabled).toBe(true);
    expect(removeButton('Ada Admin')?.disabled).toBe(true);
    expect(removeButton('Ada Admin')?.getAttribute('title')).toMatch(/only the app owner/i);
    expect(container.textContent).toContain('Owner only');
  });

  it('leaves a member with an ordinary role manageable, without offering an app-level role', async () => {
    await openPeople('u-manager');
    const select = roleSelect('Pat Plain')!;
    expect(select.disabled).toBe(false);
    expect(removeButton('Pat Plain')?.disabled).toBe(false);
    expect([...select.options].find((o) => o.value === 'r-admin')?.disabled).toBe(true);
  });

  it('never offers to change or remove the Owner', async () => {
    await openPeople('u-manager');
    expect(roleSelect('Olive Owner')).toBeNull();
    expect(removeButton('Olive Owner')).toBeNull();
  });

  it('shows app-level permissions of a role as the Owner’s to change, as the role editor does', async () => {
    vi.mocked(api.getAppRolePermissions).mockResolvedValue({ data: { permissions: [] } } as never);
    for (const [viewer, locked] of [['u-manager', true], ['u-m-owner', false]] as const) {
      useAuthStore.setState({ user: { id: viewer } as never });
      await act(async () => {
        root.render(
          <MemoryRouter>
            <AccessStep app={{ ...app, ownerId: 'u-m-owner' } as App} roles={guardedRoles} appForms={[]} formsById={{}} onReloadRoles={async () => {}} onReloadApp={async () => {}} />
          </MemoryRouter>,
        );
      });
      const member = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Member'))!;
      await act(async () => { member.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Manage users"]')?.disabled).toBe(locked);
    }
  });

  it('lets the Owner manage the admin member', async () => {
    await openPeople('u-m-owner');
    expect(roleSelect('Ada Admin')?.disabled).toBe(false);
    expect(removeButton('Ada Admin')?.disabled).toBe(false);
    expect([...roleSelect('Pat Plain')!.options].find((o) => o.value === 'r-admin')?.disabled).toBe(false);
  });
});
