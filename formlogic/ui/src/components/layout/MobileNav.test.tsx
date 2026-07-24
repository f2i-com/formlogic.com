// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileNav } from './MobileNav';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import type { AppListItem } from '../../types/app';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const fixtures = vi.hoisted(() => ({ apps: [] as unknown[] }));

vi.mock('../../lib/api', () => ({
  api: {
    getApps: vi.fn(async () => ({ data: { apps: fixtures.apps, count: fixtures.apps.length } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const pathRef = { current: '/' };

function PathProbe() {
  const location = useLocation();
  React.useEffect(() => {
    pathRef.current = location.pathname;
  });
  return null;
}

const makeApp = (overrides: Partial<AppListItem>): AppListItem =>
  ({
    id: 'app-1',
    name: 'Plumbing Operations',
    slug: 'plumbing',
    ownerId: 'u1',
    status: 'published',
    settings: {},
    theme: {},
    navConfig: [],
    createdAt: '2026-07-24 00:00:00',
    updatedAt: '2026-07-24 00:00:00',
    canManage: true,
    ...overrides,
  }) as AppListItem;

beforeEach(() => {
  fixtures.apps = [];
  pathRef.current = '/';
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.com', name: 'Owner' } as unknown as AuthUser });
  useAppStore.setState({ apps: [], activeAppId: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ apps: [], activeAppId: null });
  useAuthStore.setState({ user: null });
});

async function renderNav() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <PathProbe />
        <Routes>
          <Route path="*" element={<MobileNav />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

describe('MobileNav apps drawer', () => {
  it('opens a searchable apps sidebar and routes an owner to the Studio', async () => {
    fixtures.apps = [
      makeApp({ id: 'plumbing', name: 'Plumbing Operations' }),
      makeApp({ id: 'portal', name: 'Customer Portal', slug: 'customer-portal' }),
    ];
    await renderNav();

    const appsButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open your apps"]')!;
    await act(async () => { appsButton.click(); });
    expect(appsButton.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"][aria-label="Your apps"]')).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search your apps"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'plumb');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Plumbing Operations');
    expect(container.textContent).not.toContain('Customer Portal');

    const plumbing = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Plumbing Operations'))!;
    await act(async () => { plumbing.click(); });
    expect(pathRef.current).toBe('/apps/plumbing/studio');
    expect(container.querySelector('[role="dialog"][aria-label="Your apps"]')).toBeNull();
  });

  it('offers a direct route to the complete apps page', async () => {
    await renderNav();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open your apps"]')!.click();
    });
    const viewAll = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('View all apps'))!;
    await act(async () => { viewAll.click(); });
    expect(pathRef.current).toBe('/apps');
  });
});
