// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    getOAuthAuthorizeInfo: vi.fn(async () => ({
      data: {
        clientId: 'oaiy-desktop',
        clientName: 'OAIY Desktop',
        isDesktopLink: true,
        device: 'FRONT-DESK',
        redirectHost: '127.0.0.1',
        scopes: ['flows:read'],
        scopeLabels: {},
      },
    })),
    approveOAuth: vi.fn(),
    isAdminActing: () => false,
  },
  newIdempotencyKey: () => 'key',
}));

import { OAuthAuthorize } from './OAuthAuthorize';
import { SignedInRedirect } from '../components/auth/SignedInRedirect';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What a desktop opens to link itself: the consent page, with its OAuth request.
const CONSENT = '/oauth/authorize?response_type=code&client_id=oaiy-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&code_challenge=abc&code_challenge_method=S256&state=xyz&device=FRONT-DESK';
const SIGN_IN = `/login?redirect=${encodeURIComponent(CONSENT)}`;
const owner = { id: 'u-1', email: 'owner@example.com', name: 'Owner' };

/** The two route tables App swaps between when a visitor signs in, cut down to this flow. */
function Tables() {
  const user = useAuthStore((s) => s.user);
  return user ? (
    <Routes>
      <Route path="/" element={<p>Dashboard</p>} />
      <Route path="/login" element={<SignedInRedirect />} />
      <Route path="/oauth/authorize" element={<OAuthAuthorize />} />
    </Routes>
  ) : (
    <Routes>
      <Route path="/login" element={<p>Sign in</p>} />
      <Route path="/oauth/authorize" element={<OAuthAuthorize />} />
    </Routes>
  );
}

let root: Root;
let container: HTMLDivElement;
const here = () => window.location.pathname + window.location.search;

async function open(path: string) {
  window.history.replaceState(null, '', path);
  // StrictMode as main.tsx has it: in development React runs every effect twice, which is
  // where the consent page lost its way (production runs them once).
  await act(async () => {
    root.render(<StrictMode><BrowserRouter><Tables /></BrowserRouter></StrictMode>);
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: null, isInitialized: true, isLoading: false });
  useAppStore.setState({ apps: [], fetchApps: async () => {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

it('sends a signed-out visitor to sign in with this consent request to come back to, once', async () => {
  await open(CONSENT);
  expect(here()).toBe(SIGN_IN);
  expect(container.textContent).toContain('Sign in');
});

it('comes back to the consent page after signing in', async () => {
  await open(CONSENT);
  await act(async () => { useAuthStore.setState({ user: owner }); });
  expect(here()).toBe(CONSENT);
  expect(container.textContent).toContain('Link FormLogic Desktop');
  expect(container.textContent).toContain('FRONT-DESK');
});

it('does not follow a return address that is itself the sign-in page', async () => {
  // What the page used to build: /login?redirect=/login?redirect=/oauth/authorize…
  useAuthStore.setState({ user: owner });
  await open(`/login?redirect=${encodeURIComponent(SIGN_IN)}`);
  expect(here()).toBe('/');
  expect(container.textContent).toContain('Dashboard');
});
