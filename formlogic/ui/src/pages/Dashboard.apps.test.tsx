// @vitest-environment jsdom
// Home for someone who hosts apps. An owner of live apps with no forms used to be met, on every
// visit, by the newcomer's welcome ("Let's build your first form"), a "Get started" banner and
// two empty boxes about forms, with their apps listed as "0 forms · Published".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import { useFormStore } from '../stores/formStore';
import type { AppListItem, AppSummary } from '../types/app';

const h = vi.hoisted(() => ({ apps: [] as unknown[], summaries: {} as Record<string, unknown>, appsAnswer: null as null | Promise<unknown> }));

vi.mock('../lib/api', () => {
  const known: Record<string, unknown> = {
    getApps: vi.fn(() => h.appsAnswer ?? Promise.resolve({ data: { apps: h.apps, count: h.apps.length } })),
    getAppsSummary: vi.fn(async () => ({ data: { apps: h.summaries } })),
    getInstalledPacks: vi.fn(async () => ({ data: { installations: [] } })),
    getAIStatus: vi.fn(async () => ({ data: { available: false } })),
    isAdminActing: () => false,
    isDemoMode: () => false,
    isAuthenticated: () => true,
  };
  // Whatever else the page's panels ask for is answered with nothing: this file is about the apps.
  return { api: new Proxy(known, { get: (target, name: string) => (name in target ? target[name] : async () => ({ data: {} })) }) };
});

import { Dashboard } from './Dashboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type AuthUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

const app = (id: string, more: Partial<AppListItem> = {}): AppListItem => ({
  id, name: `App ${id}`, slug: `app-${id}`, ownerId: 'u1', status: 'published', publishedVersion: 1, settings: { softnApp: true }, theme: {}, navConfig: [],
  createdAt: '2026-11-01 00:00:00', updatedAt: '2026-11-10 00:00:00', canManage: true, formCount: 0, ...more,
}) as AppListItem;
const summary = (tables: number, bytes: number): AppSummary => ({ installed: true, backend: true, tables, bytes, access: 'members', members: 0 }) as unknown as AppSummary;

let root: Root;
let container: HTMLDivElement;
const show = async () => {
  await act(async () => { root.render(<MemoryRouter><Dashboard /></MemoryRouter>); });
  // The apps and their summary arrive after the first draw.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const welcome = () => Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => dialog.textContent?.includes('Welcome to FormLogic'));
const heading = (name: string) => Array.from(container.querySelectorAll('h2')).find((h2) => h2.textContent?.trim() === name);

beforeEach(() => {
  localStorage.clear();
  h.apps = []; h.summaries = {}; h.appsAnswer = null;
  useAuthStore.setState({ user: { id: 'u1', email: 'owner@example.com', name: 'Owner', createdAt: '2025-01-01 00:00:00' } as unknown as AuthUser });
  useAppStore.setState({ apps: [], activeAppId: null, error: null, isLoading: false, _loadingCount: 0 });
  useFormStore.setState({ forms: [], isLoading: false, isInitialized: true, error: null, storageMode: 'api' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ apps: [], activeAppId: null, error: null });
  useAuthStore.setState({ user: null });
});

describe('Home for an owner who hosts apps and has no forms', () => {
  beforeEach(() => {
    h.apps = [app('1'), app('2', { status: 'draft', publishedVersion: undefined })];
    h.summaries = { '1': summary(8, 1_500_000), '2': summary(3, 500_000) };
  });

  it('says how the apps stand, in the page’s one sentence', async () => {
    await show();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('1 of 2 apps are live, holding 11 tables (1.9 MB).');
  });

  it('lists the apps as the Apps page does, with what each holds, and no way to remove one from here', async () => {
    await show();
    expect(heading('Your apps')).toBeDefined();
    const rows = Array.from(container.querySelectorAll('table tbody tr')).map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('App 1');
    expect(rows[0]).toContain('Live v1');
    expect(rows[0]).toContain('8 tables');
    expect(rows.join(' ')).not.toContain('0 forms');
    expect(container.querySelector('a[aria-label="Data of App 1"]')?.getAttribute('href')).toBe('/apps/1/softn/data');
    expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();
  });

  it('does not welcome them as a newcomer, and keeps forms to one line', async () => {
    await show();
    expect(welcome()).toBeUndefined();
    expect(heading('Start here')).toBeUndefined();
    expect(heading('My forms')).toBeUndefined();
    expect(container.textContent).toContain('No forms yet.');
    expect(container.textContent).not.toContain('Get started with FormLogic');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Create form')).toBe(true);
  });
});

describe('Home for a new account', () => {
  it('welcomes it, and offers a form, an app and a template side by side', async () => {
    await show();
    expect(welcome()).toBeDefined();
    expect(heading('Start here')).toBeDefined();
    expect(heading('Your apps')).toBeUndefined();
    expect(heading('My forms')).toBeUndefined();
    const starts = Array.from(heading('Start here')!.parentElement!.querySelectorAll('button')).map((button) => button.textContent ?? '');
    expect(starts.map((text) => ['Create your first form', 'Create an app', 'Start from a template'].find((title) => text.startsWith(title)))).toEqual(['Create your first form', 'Create an app', 'Start from a template']);
  });

  it('waits to hear about the apps before calling the account new', async () => {
    let answer!: (value: unknown) => void;
    h.appsAnswer = new Promise((resolve) => { answer = resolve; });
    await show();
    expect(welcome()).toBeUndefined();
    expect(heading('Start here')).toBeUndefined();

    h.apps = [app('1')];
    await act(async () => { answer({ data: { apps: h.apps, count: 1 } }); await Promise.resolve(); await Promise.resolve(); });
    expect(welcome()).toBeUndefined();
    expect(heading('Your apps')).toBeDefined();
  });

  it('does not take a failed read of the apps for an account without any', async () => {
    h.appsAnswer = Promise.resolve({ error: 'The server could not be reached.' });
    await show();
    expect(welcome()).toBeUndefined();
    expect(heading('Start here')).toBeUndefined();
  });
});
