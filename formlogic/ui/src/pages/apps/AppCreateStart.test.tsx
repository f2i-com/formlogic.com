// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCreateStart } from './AppCreateStart';
import { useUIStore } from '../../stores/uiStore';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore } from '../../stores/vaultStore';
import type { App } from '../../types/app';

type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  createStarter: vi.fn(),
  readiness: vi.fn(async () => ({ ready: true })),
}));

vi.mock('../../client-runtime/flows/aiDefault', () => ({
  getAiReadiness: mocks.readiness,
}));
vi.mock('../../lib/softnApps', async (original) => ({
  ...(await original<typeof import('../../lib/softnApps')>()), createSoftnApp: mocks.createStarter,
}));

vi.mock('../../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ plans: { siteAiEnabled: false } }) }));
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
  useUIStore.setState({ chatOpen: false, chatMinimized: false, chatLaunch: null });
  mocks.createApp.mockResolvedValue({ data: { app: createdApp } });
  mocks.createStarter.mockResolvedValue({ app: createdApp, project: { version: 1 } });
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

async function renderPage(entry = '/apps/new') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
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
    await renderPage('/apps/new?type=forms');
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
      settings: { defaultFormPrivacy: 'private', appKind: 'internal' },
    }));
    expect(pathRef.current).toBe('/apps/app-private/studio');
  });

  it('creates without waiting for AI and suppresses repeated submits', async () => {
    mocks.readiness.mockReturnValueOnce(new Promise(() => {}));
    let finish!: (value: { data: { app: App } }) => void;
    mocks.createApp.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await renderPage('/apps/new?type=forms');
    await act(async () => setInput(container.querySelector<HTMLInputElement>('#new-app-name')!, 'Operations'));
    const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Create and open'))!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(mocks.createApp).toHaveBeenCalledTimes(1);
    await act(async () => finish({ data: { app: createdApp } }));
    expect(pathRef.current).toBe('/apps/app-private/studio');
  });

  it('keeps the E2EE option disabled in the browser-local demo', async () => {
    useAuthStore.setState({ user: { id: 'demo', email: 'demo@example.com', name: 'Demo', isDemo: true } as unknown as AuthUser });
    await renderPage('/apps/new?type=forms');
    expect(container.querySelector<HTMLInputElement>('input[value="private"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('Demo data is already kept on this device');
  });
});

describe('Create app entry points', () => {
  it('opens with just chat when AI is ready and starts a fresh brief', async () => {
    await renderPage();
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="Describe your app"]')!;
    expect(prompt).toBeTruthy();
    expect(container.querySelector('[name="framework"]')).toBeNull();
    const react = [...container.querySelectorAll('button')].find(button => button.textContent === 'React app')!;
    await act(async () => react.click());
    expect(prompt.value).toContain('React app');
    expect(document.activeElement).toBe(prompt);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(useUIStore.getState().chatLaunch).toEqual({ text: prompt.value.trim(), newThread: true });
    expect(useUIStore.getState().chatOpen).toBe(true);
  });

  it('opens on all three frameworks when AI is disconnected', async () => {
    mocks.readiness.mockResolvedValueOnce({ ready: false });
    await renderPage();
    expect([...container.querySelectorAll<HTMLInputElement>('[name="framework"]')].map(radio => radio.value)).toEqual(['javascript', 'react', 'vue']);
    expect(container.querySelector('summary')?.textContent).toContain('Connect AI');
    expect(container.querySelector('#softn-app-name')).not.toBeNull();
  });

  it('creates the selected framework once and opens the chosen editor in preview', async () => {
    await renderPage('/apps/new?type=web');
    const vue = container.querySelector<HTMLInputElement>('input[name="framework"][value="vue"]')!;
    const builder = [...container.querySelectorAll('button')].find(b => b.textContent === 'Open in Builder')!;
    await act(async () => vue.click());
    await act(async () => { builder.click(); builder.click(); });
    expect(mocks.createStarter).toHaveBeenCalledTimes(1);
    expect(mocks.createStarter).toHaveBeenCalledWith({ name: 'My Vue app', start: { kind: 'starter', template: 'vue' } });
    expect(useUIStore.getState().softnOpen).toMatchObject({ appId: createdApp.id, editor: 'builder', template: 'vue', preview: true });
    expect(pathRef.current).toBe('/apps/app-private/web/edit');
  });

  it('keeps a starter being named if the pending connection check finds AI', async () => {
    let finish!: (readiness: {ready: boolean}) => void;
    mocks.readiness.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await renderPage();
    const name = container.querySelector<HTMLInputElement>('#softn-app-name')!;
    await act(async () => {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      setInput(name, 'Meal planner');
      finish({ ready: true });
    });
    expect(container.querySelector<HTMLInputElement>('#softn-app-name')?.value).toBe('Meal planner');
  });

  it('keeps a direct web starter or ZIP link usable with AI enabled', async () => {
    await renderPage('/apps/new?type=softn');
    expect(container.querySelector('[name="framework"]')).not.toBeNull();
    const upload = container.querySelector<HTMLAnchorElement>('a[href*="type=upload"]')!;
    await act(async () => upload.click());
    const picker = container.querySelector('[data-testid="softn-drop-zone"]')!;
    expect(picker.compareDocumentPosition(container.querySelector('#softn-app-name')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('Create from this file');
    expect(container.querySelector('[aria-label="Describe your app"]')).toBeNull();
  });

  it('retains the built-site import bookmark', async () => {
    await renderPage('/apps/new?type=site');
    expect(container.querySelector<HTMLInputElement>('#site-app-build')?.accept).toBe('.zip');
  });
});
