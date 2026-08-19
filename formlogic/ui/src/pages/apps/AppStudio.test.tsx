// @vitest-environment jsdom
// App Studio smoke: the six-step shell loads real app data (mocked api),
// derives step completion from actual state, and step navigation via the
// rail + footer routes between steps.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStudio } from './AppStudio';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';

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
    getResponses: vi.fn(async () => ({ data: { responses: [], count: 0 } })),
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
const pathRef = { current: '' };

function PathProbe() {
  const location = useLocation();
  React.useEffect(() => {
    pathRef.current = `${location.pathname}${location.search}`;
  });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  pathRef.current = '';
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
        <PathProbe />
        <Routes>
          <Route path="/apps/:appId/studio" element={<AppStudio />} />
          <Route path="/apps/:appId/studio/:step" element={<AppStudio />} />
          <Route path="/apps/:appId/settings" element={<div />} />
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
    expect(container.textContent).toContain('1 change to publish');
  });

  it('renders the Publish step with preflight and version history', async () => {
    await renderStudio('/apps/a1/studio/publish');
    expect(container.textContent).toContain('Review & publish');
    expect(container.textContent).toContain('1 data type configured');
    expect(container.textContent).toContain('Release log');
    expect(container.textContent).toContain('First release');
    expect(container.textContent).toContain('Publish version 3');
    expect(container.textContent).toContain('Changes in version 3');
    expect(container.textContent).toContain('Updated the Repair request form');
  });

  it('makes draft preview state explicit and compares it with the live release', async () => {
    await renderStudio('/apps/a1/studio/screens');

    expect(container.textContent).toContain('Saved edits are already live for members');
    expect(container.textContent).toContain('Open draft');
    expect(container.querySelector('button[aria-label="Tablet preview"]')).toBeTruthy();
    expect(container.querySelector('select[aria-label="Preview data"]')).toBeTruthy();

    const compare = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Compare with live')!;
    expect(compare).toBeTruthy();
    await act(async () => { compare.click(); });
    expect(document.body.textContent).toContain('Compare draft with live');
    expect(document.body.textContent).toContain('Live v2');
    expect(document.body.textContent).toContain('Repair request');
  });

  it('opens the command palette with Ctrl/Cmd+K and exposes app resources', async () => {
    await renderStudio('/apps/a1/studio/data');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });

    expect(document.body.textContent).toContain('Search App Studio');
    expect(document.body.textContent).toContain('Open app');
    expect(document.body.textContent).toContain('Repair request');
    expect(document.body.textContent).toContain('Notify dispatch');
    const search = document.body.querySelector('input[aria-label="Search App Studio commands"]')!;
    expect(search).toBeTruthy();
    // Combobox wiring: arrowing the list has to announce the active option, since
    // focus never leaves the search field.
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-activedescendant')).toBeTruthy();
  });

  it('keeps an app published outside the versioned flow publishable', async () => {
    vi.mocked(api.getApp).mockResolvedValueOnce({
      data: {
        app: {
          ...h.app,
          publishedVersion: undefined,
          publishedAt: null,
        },
      },
    } as never);
    vi.mocked(api.listAppVersions).mockResolvedValueOnce({ data: { versions: [] } } as never);

    await renderStudio('/apps/a1/studio/publish');

    expect(container.textContent).not.toContain('Not published yet');
    expect(container.textContent).toContain('Current release');
    expect(container.textContent).toContain('No recorded releases yet');
    // Live but with no publishedAt (published from a raw status flip, or before
    // versioning existed): publishing has to stay possible, otherwise the only way
    // to release an edit is to take the live app offline first.
    expect(container.textContent).toContain('Publish version 1');
    const publish = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Publish changes')!;
    expect(publish).toBeTruthy();
    expect(publish.disabled).toBe(false);
  });

  it('moves forward with an in-flow link at the end of the section, not a fixed bar', async () => {
    await renderStudio('/apps/a1/studio/plan');
    // No wizard framing: no step counter, no Previous/Continue bar over the content.
    expect(container.textContent).not.toContain('Step 1 of 6');
    expect(container.textContent).not.toContain('Continue to Data');
    expect(container.textContent).not.toContain('Saved automatically');
    expect(container.textContent).toContain('Next: Data & forms');
  });

  it('the section nav states what each section holds and navigates between them', async () => {
    await renderStudio('/apps/a1/studio/data');
    const nav = container.querySelector('[aria-label="App Studio sections"]')!;
    expect(nav).toBeTruthy();
    // Counts, not completion ticks: 1 data type, 2 screens (form + home), 1 automation.
    const dataTab = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Data'))!;
    // The badge number carries an sr-only expansion, so its meaning is not
    // trapped in a hover title on a touch screen.
    expect(dataTab.textContent).toBe('Data11 data type');
    expect(dataTab.querySelector('.sr-only')!.textContent).toBe('1 data type');
    expect(dataTab.getAttribute('aria-label')).toBe('Data & forms');
    expect(dataTab.getAttribute('aria-current')).toBe('page');
    const publishBtn = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent?.includes('Publish'))!;
    await act(async () => { publishBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Review & publish');
  });

  it('reports a failed app load as a retryable error, not a deleted app', async () => {
    vi.mocked(api.getApp).mockResolvedValueOnce({ error: 'Server error (500)' } as never);

    await renderStudio('/apps/a1/studio/data');

    expect(container.textContent).toContain("Couldn't load this app");
    expect(container.textContent).toContain('Server error (500)');
    expect(container.textContent).not.toContain('It may have been deleted');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Try again'))).toBe(true);
  });

  it('reports a real 404 as a missing app', async () => {
    vi.mocked(api.getApp).mockResolvedValueOnce({ error: 'App not found', status: 404 } as never);

    await renderStudio('/apps/a1/studio/data');

    expect(container.textContent).toContain('App not found');
    expect(container.textContent).toContain('It may have been deleted');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Try again'))).toBe(false);
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

  // The top-bar control opens real settings, not the directory of tiles: a button
  // labelled "Manage app" that landed on a nine-tile menu never opened a setting.
  it('opens App settings from the Studio top bar', async () => {
    await renderStudio('/apps/a1/studio/data');
    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="App settings"]')!;
    expect(settings).toBeTruthy();
    await act(async () => { settings.click(); });
    expect(pathRef.current).toBe('/apps/a1/settings');
  });
});
