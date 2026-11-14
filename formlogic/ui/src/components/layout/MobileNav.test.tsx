// @vitest-environment jsdom
// The bar at the foot of a phone's screen. Apps is the apps page itself, as on a wider screen: it
// opened a side menu of the apps on a phone, a second list of the same apps with the page one tap
// further in.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MobileNav } from './MobileNav';
import { useAuthStore } from '../../stores/authStore';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

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

beforeEach(() => {
  pathRef.current = '/';
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.com', name: 'Owner' } as unknown as AuthUser });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAuthStore.setState({ user: null });
});

async function renderNav(at = '/') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <PathProbe />
        <Routes>
          <Route path="*" element={<MobileNav />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

const item = (label: string) => Array.from(container.querySelectorAll<HTMLElement>('nav a, nav button')).find((el) => el.textContent === label || el.getAttribute('aria-label') === label);

describe('the bar at the foot of a phone’s screen', () => {
  it('takes Apps to the apps page itself, with no side menu', async () => {
    await renderNav('/forms');
    const apps = item('Apps') as HTMLAnchorElement;
    expect(apps.tagName).toBe('A');
    expect(apps.getAttribute('href')).toBe('/apps');
    await act(async () => { apps.click(); });
    expect(pathRef.current).toBe('/apps');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(apps.getAttribute('aria-current')).toBe('page');
  });

  it('lights Apps on an app’s own page too, and Home only at its own address', async () => {
    await renderNav('/apps/plumbing/softn/data');
    expect(item('Apps')!.className).toContain('bg-primary-50');
    expect(item('Home')!.className).not.toContain('bg-primary-50');
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderNav('/');
    expect(item('Home')!.className).toContain('bg-primary-50');
    expect(item('Apps')!.className).not.toContain('bg-primary-50');
  });

  it('goes to Create app from its button, and names itself as the sidebar it stands in for', async () => {
    await renderNav('/');
    await act(async () => { (item('Create app') as HTMLButtonElement).click(); });
    expect(pathRef.current).toBe('/apps/new');
    expect(container.querySelector('nav')!.getAttribute('aria-label')).toBe('Workspace');
    expect(Array.from(container.querySelectorAll('nav a')).map((a) => a.textContent)).toEqual(['Home', 'Forms', 'Apps', 'Automations']);
  });
});
