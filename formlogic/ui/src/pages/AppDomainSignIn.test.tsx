// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createCode = vi.fn();
const launch = vi.fn();
vi.mock('../lib/api', () => ({ api: { createAppDomainCode: (origin: string) => createCode(origin) } }));
vi.mock('../lib/domainLaunchApi', () => ({ fetchLaunchConfig: (host: string) => launch(host) }));

import { useAuthStore } from '../stores/authStore';
import { AppDomainSignIn } from './AppDomainSignIn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = 'https://shop.acme.com';
const PAGE = `/sign-in/domain?origin=${encodeURIComponent(ORIGIN)}&state=the-state&page=signup`;
const member = { id: 'member-1', email: 'member@example.com', name: 'Member' };
const assign = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement;

async function open(entry = PAGE) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/sign-in/domain" element={<AppDomainSignIn />} />
          <Route path="/login" element={<p>The login page</p>} />
          <Route path="/signup" element={<p>The signup page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const button = (name: string) => Array.from(container.querySelectorAll('button')).find(found => found.textContent?.includes(name));

beforeEach(() => {
  vi.useFakeTimers();
  createCode.mockReset().mockResolvedValue({ data: { code: 'the-code' } });
  launch.mockReset().mockResolvedValue({ app: { name: 'Shop', slug: 'shop' } });
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
  useAuthStore.setState({ user: member as never });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe('continuing to an app on its own domain', () => {
  it('sends someone with no session to the page they asked for, and back here after', async () => {
    useAuthStore.setState({ user: null });
    await open();
    expect(container.textContent).toContain('The signup page');
    expect(launch).not.toHaveBeenCalled();
  });

  it('says which site is asking, and holds Continue back long enough to read it', async () => {
    await open();
    expect(container.textContent).toContain('Continue to Shop');
    expect(container.textContent).toContain('shop.acme.com');
    expect(container.textContent).toContain('member@example.com');
    expect(button('Continue')?.disabled).toBe(true);
    await act(async () => { button('Continue')?.click(); });
    expect(createCode).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(button('Continue')?.disabled).toBe(false);
  });

  it('goes back to the domain with the code and the state in the fragment', async () => {
    await open();
    await act(async () => { vi.advanceTimersByTime(1000); });
    await act(async () => { button('Continue')?.click(); });
    expect(createCode).toHaveBeenCalledWith(ORIGIN);
    expect(assign).toHaveBeenCalledWith(`${ORIGIN}/sign-in/complete#code=the-code&state=the-state`);
  });

  it('stays here and says so when the server refuses', async () => {
    createCode.mockResolvedValue({ error: 'That domain is not connected to an app' });
    await open();
    await act(async () => { vi.advanceTimersByTime(1000); });
    await act(async () => { button('Continue')?.click(); });
    expect(assign).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not connected');
  });

  it.each([
    ['a host nothing is connected to', PAGE],
    ['a script address', `/sign-in/domain?origin=${encodeURIComponent('javascript:alert(1)')}&state=s`],
    ['no origin at all', '/sign-in/domain'],
  ])('offers no way on from %s', async (_name, entry) => {
    launch.mockResolvedValue(null);
    await open(entry);
    expect(button('Continue')).toBeUndefined();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain("This site isn't connected");
  });
});
