// @vitest-environment jsdom
// App Studio smoke: the six-step shell loads real app data (mocked api),
// derives step completion from actual state, and step navigation via the
// rail + footer routes between steps.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStudio } from './AppStudio';
import { useAuthStore } from '../../stores/authStore';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

const h = vi.hoisted(() => {
  const app = {
    id: 'a1',
    name: 'Plumbing Operations',
    slug: 'plumbing-ops',
    ownerId: 'u1',
    status: 'published',
    settings: { landingPage: 'dashboard' },
    theme: { primaryColor: '#6366f1' },
    navConfig: [],
    publishedVersion: 2,
    publishedAt: '2026-07-20 10:00:00',
    createdAt: '2026-07-01 00:00:00',
    updatedAt: '2026-07-20 10:00:00',
  };
  const form = {
    id: 'f1',
    title: 'Repair request',
    fields: [
      { id: 'customer', type: 'short_text', label: 'Customer', required: true, properties: {}, order: 0 },
      { id: 'problem', type: 'long_text', label: 'Problem', required: false, properties: {}, order: 1 },
    ],
    settings: {},
    theme: {},
    createdAt: '2026-07-01 00:00:00',
    updatedAt: '2026-07-22 10:00:00',
    status: 'published',
    responseCount: 12,
  };
  return { app, form };
});

vi.mock('../../lib/api', () => ({
  api: {
    getApp: vi.fn(async () => ({ data: { app: h.app } })),
    getAppForms: vi.fn(async () => ({
      data: { forms: [{ id: 'af1', appId: 'a1', formId: 'f1', displayName: 'Repair request', sortOrder: 0, isVisible: true, settings: {} }] },
    })),
    getForm: vi.fn(async () => ({ data: { form: h.form } })),
    listFlows: vi.fn(async () => ({
      data: { flows: [{ id: 'fl1', ownerUserId: 'u1', appId: 'a1', name: 'Notify dispatch', slug: 'notify', description: null, engine: 'v1', flowJson: { nodes: [{ id: 'trigger', type: 'input' }, { id: 'out', type: 'output' }], edges: [] }, inputSchema: null, outputSchema: null, nodeCapabilities: [], version: 1, enabled: true, createdAt: '2026-07-01 00:00:00', updatedAt: '2026-07-19 10:00:00' }] },
    })),
    listFlowBindings: vi.fn(async () => ({ data: { bindings: [] } })),
    getAppRoles: vi.fn(async () => ({
      data: { roles: [
        { id: 'r1', appId: 'a1', name: 'Owner', isSystem: true, sortOrder: 0 },
        { id: 'r2', appId: 'a1', name: 'Member', isSystem: true, sortOrder: 2 },
      ] },
    })),
    listBlueprints: vi.fn(async () => ({ data: { blueprints: [] } })),
    listAppVersions: vi.fn(async () => ({
      data: { versions: [
        { id: 'v2', version: 2, label: null, publishedBy: 'u1', createdAt: '2026-07-20 10:00:00' },
        { id: 'v1', version: 1, label: 'First release', publishedBy: 'u1', createdAt: '2026-07-18 10:00:00' },
      ] },
    })),
    getAppDomains: vi.fn(async () => ({ data: { domains: [] } })),
    getAppUsers: vi.fn(async () => ({ data: { users: [{ id: 'au1', status: 'active' }], count: 1 } })),
    getAppInvitations: vi.fn(async () => ({ data: { invitations: [] } })),
    getAppsFormUsage: vi.fn(async () => ({ data: { apps: [] } })),
    getAppRolePermissions: vi.fn(async () => ({ data: { permissions: [] } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
  },
}));

// AI readiness (FL-23) resolves out-of-band — pin it "ready" so the AI
// affordances render deterministically.
vi.mock('../../client-runtime/flows/aiDefault', () => ({
  getAiReadiness: vi.fn(async () => ({ ready: true })),
}));

// Chrome pieces with their own data dependencies — not under test here.
vi.mock('../../components/auth/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('../../components/auth/AuthModal', () => ({ AuthModal: () => null }));
vi.mock('../../components/vault/VaultChip', () => ({ VaultChip: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'u1', email: 'o@example.com', name: 'Owner' } as unknown as AuthUser });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAuthStore.setState({ user: null });
});

async function renderStudio(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apps/:appId/studio" element={<AppStudio />} />
          <Route path="/apps/:appId/studio/:step" element={<AppStudio />} />
        </Routes>
      </MemoryRouter>
    );
  });
  // Let the parallel data fetches resolve.
  await act(async () => { await Promise.resolve(); });
}

describe('AppStudio', () => {
  it('renders the Data step with the app identity and real form data', async () => {
    await renderStudio('/apps/a1/studio/data');
    expect(container.textContent).toContain('Plumbing Operations');
    expect(container.textContent).toContain('Data & forms');
    expect(container.textContent).toContain('Repair request');
    expect(container.textContent).toContain('2 fields');
    expect(container.textContent).toContain('12 records');
    // Live/version state from the top bar.
    expect(container.textContent).toContain('Live v2');
  });

  it('shows unpublished changes derived from resource timestamps', async () => {
    // form updatedAt (07-22) and flow updatedAt (07-19 → NOT counted) vs publish (07-20)
    await renderStudio('/apps/a1/studio/data');
    expect(container.textContent).toContain('1 unpublished change');
  });

  it('renders the Publish step with preflight and version history', async () => {
    await renderStudio('/apps/a1/studio/publish');
    expect(container.textContent).toContain('Review & publish');
    expect(container.textContent).toContain('1 data type configured');
    expect(container.textContent).toContain('Version history');
    expect(container.textContent).toContain('First release');
    expect(container.textContent).toContain('Publish version 3');
  });

  it('the rail marks configured steps and navigates between them', async () => {
    await renderStudio('/apps/a1/studio/data');
    const rail = container.querySelector('[aria-label="App Studio steps"]')!;
    expect(rail).toBeTruthy();
    const publishBtn = Array.from(rail.querySelectorAll('button')).find((b) => b.textContent?.includes('Publish'))!;
    await act(async () => { publishBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Review & publish');
  });

  it('an invalid step falls back to Data', async () => {
    await renderStudio('/apps/a1/studio/bogus');
    expect(container.textContent).toContain('Data & forms');
  });

  it('renders the Access step with the app roles', async () => {
    await renderStudio('/apps/a1/studio/access');
    expect(container.textContent).toContain('Users & roles');
    expect(container.textContent).toContain('App roles');
    expect(container.textContent).toContain('Owner');
  });
});
