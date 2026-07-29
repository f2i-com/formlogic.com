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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function renderStep(stepRoles: AppRole[]) {
  return act(async () => {
    root.render(
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
