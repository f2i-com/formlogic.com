// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCreateStart } from './AppCreateStart';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import type { App } from '../../types/app';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
}));

vi.mock('../../client-runtime/flows/aiDefault', () => ({
  getAiReadiness: vi.fn(async () => ({ ready: true })),
}));

vi.mock('../../lib/api', () => ({
  api: {
    createApp: mocks.createApp,
    isAdminActing: () => false,
    isDemoMode: () => false,
  },
}));

vi.mock('../../components/vault/VaultSetupWizard', () => ({
  VaultSetupWizard: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="vault-setup" /> : null),
}));
vi.mock('../../components/vault/VaultUnlockDialog', () => ({
  VaultUnlockDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="vault-unlock" /> : null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const pathRef = { current: '/apps/new' };

function PathProbe() {
  const location = useLocation();
  React.useEffect(() => {
    pathRef.current = location.pathname;
  });
  return null;
}

const createdApp = {
  id: 'app-private',
  name: 'Client portal',
  slug: 'client-portal',
  ownerId: 'u1',
  canManage: true,
  status: 'draft',
  settings: { defaultFormPrivacy: 'private' },
  theme: {},
  navConfig: [],
  createdAt: '2026-07-24 00:00:00',
  updatedAt: '2026-07-24 00:00:00',
} as unknown as App;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createApp.mockResolvedValue({ data: { app: createdApp } });
  pathRef.current = '/apps/new';
  useAppStore.setState({ apps: [], error: null, isLoading: false, _loadingCount: 0 });
  useVaultStore.setState({ status: 'unlocked', vault: null });
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.com', name: 'Owner', isDemo: false } as unknown as AuthUser });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ apps: [], error: null });
  useAuthStore.setState({ user: null });
});

async function renderPage() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/apps/new']}>
        <PathProbe />
        <Routes>
          <Route path="*" element={<AppCreateStart />} />
        </Routes>
      </MemoryRouter>
    );
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AppCreateStart data protection', () => {
  it('persists the E2EE default and opens the new App Studio when the vault is unlocked', async () => {
    await renderPage();
    const name = container.querySelector<HTMLInputElement>('#new-app-name')!;
    const privateRadio = container.querySelector<HTMLInputElement>('input[value="private"]')!;

    await act(async () => {
      setInput(name, 'Client portal');
      privateRadio.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create and open'))!.click();
    });

    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Client portal',
      settings: { defaultFormPrivacy: 'private' },
    }));
    expect(pathRef.current).toBe('/apps/app-private/studio');
  });

  it('keeps the E2EE option disabled in the browser-local demo', async () => {
    useAuthStore.setState({ user: { id: 'demo', email: 'demo@example.com', name: 'Demo', isDemo: true } as unknown as AuthUser });
    await renderPage();
    expect(container.querySelector<HTMLInputElement>('input[value="private"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('Demo data is already kept on this device');
  });
});
