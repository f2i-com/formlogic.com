// @vitest-environment jsdom
// A page the person goes to opens at its top. The workspace scrolls the window, which stayed where
// it was from one page to the next: the "+" on a phone's bar opened Create app as far down as the
// page it was pressed on.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageTopOnNavigation } from './usePageTopOnNavigation';
import { MobileNav } from '../components/layout/MobileNav';
import { useAuthStore } from '../stores/authStore';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let go: NavigateFunction;
const scrollTo = vi.fn();
const TOP = { top: 0, left: 0, behavior: 'instant' };

function Shell() {
  usePageTopOnNavigation();
  const navigate = useNavigate();
  useEffect(() => { go = navigate; }, [navigate]);
  return <MobileNav />;
}

beforeEach(async () => {
  scrollTo.mockClear();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.com', name: 'Owner' } as unknown as AuthUser });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/apps']}>
        <Routes><Route path="*" element={<Shell />} /></Routes>
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAuthStore.setState({ user: null });
});

const to = async (where: To | number, options?: NavigateOptions) => {
  await act(async () => { void (typeof where === 'number' ? go(where) : go(where, options)); });
};

describe('a page the person goes to opens at its top', () => {
  it('from the "+" on a phone\'s bar, and from it again on Create app itself', async () => {
    expect(scrollTo).not.toHaveBeenCalled();
    const plus = container.querySelector<HTMLButtonElement>('button[aria-label="Create app"]')!;
    await act(async () => { plus.click(); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(TOP);
    await act(async () => { plus.click(); });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('from any link to another page: an app opened from far down the apps page, the bar\'s other places', async () => {
    await to('/apps/a1/web/data');
    await act(async () => { container.querySelector<HTMLAnchorElement>('a[href="/forms"]')!.click(); });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('leaves a new query, a named place, Back and Forward and a redirect where they are', async () => {
    await to('/apps?q=plumbing');
    await to('/apps?q=plumbers');
    await to('/settings#linked-desktops');
    await to(-1);
    await to(1);
    await to('/somewhere-else', { replace: true });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves a move within the SoftN app page, which opens its sections from their tops itself, and not a move to another app', async () => {
    await to('/apps/a1/web/data');
    scrollTo.mockClear();
    await to('/apps/a1/web/history/7');
    await to('/apps/a1/web');
    expect(scrollTo).not.toHaveBeenCalled();
    await to('/apps/a2/web');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    await to('/apps/a2/settings');
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
