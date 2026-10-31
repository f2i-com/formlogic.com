// @vitest-environment jsdom
// Accepting an invitation takes the person to their apps a moment later, so they can read the
// confirmation. Someone who has left the page by then stays where they went.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ navigate: vi.fn(), accept: vi.fn(async () => {}) }));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));
vi.mock('../stores/appUserStore', () => ({
  useAppUserStore: (pick: (state: { acceptInvitation: typeof h.accept }) => unknown) => pick({ acceptInvitation: h.accept }),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (pick: (state: { user: unknown; isLoading: boolean }) => unknown) => pick({ user: { id: 'u1', email: 'a@example.test' }, isLoading: false }),
  unsentSubmissionsOnSignOut: async () => 0,
  deviceFormsOnSignOut: () => 0,
}));

import { AcceptInvite } from './AcceptInvite';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(async () => {
  vi.useFakeTimers();
  h.navigate.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter initialEntries={['/accept-invite?token=t1']}><AcceptInvite /></MemoryRouter>); });
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

describe('after an invitation is accepted', () => {
  it('goes on to the apps', async () => {
    expect(host.textContent).toContain('Invitation accepted');
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(h.navigate).toHaveBeenCalledWith('/apps');
    act(() => root.unmount());
  });

  it('stays out of the way of someone who has left the page', async () => {
    act(() => root.unmount());
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
