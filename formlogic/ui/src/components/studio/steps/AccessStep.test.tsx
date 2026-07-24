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
import type { App, AppRole } from '../../../types/app';

vi.mock('../../../lib/api', () => ({
  api: {
    getAppRolePermissions: vi.fn(async () => ({ data: { permissions: [{ formId: null, permission: 'manage_users' }] } })),
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
          onReloadAux={async () => {}}
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
