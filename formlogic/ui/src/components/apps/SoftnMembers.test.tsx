// @vitest-environment jsdom
// The Members section of a SoftN app's own page: who the list is for, the people and how they
// join, and a read of the app's roles that failed said as a failure, never as an empty list.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeProject } from '../../lib/nativeHosting';
import type { App } from '../../types/app';

const mocks = vi.hoisted(() => ({ getAppRoles: vi.fn(), people: null as null | Record<string, unknown>, signup: null as null | Record<string, unknown> }));
vi.mock('../../lib/api', () => ({ api: { getAppRoles: mocks.getAppRoles } }));
vi.mock('../studio/steps/AccessStep', () => ({
  PeopleView: (props: Record<string, unknown>) => { mocks.people = props; return <p data-testid="people">people</p>; },
  SignupView: (props: Record<string, unknown>) => { mocks.signup = props; return <p data-testid="signup">sign-up</p>; },
}));

const { SoftnMembers } = await import('./SoftnMembers');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | undefined;

const app = { id: 'app-1', name: 'Recipes', slug: 'recipes', status: 'published', ownerId: 'u1', settings: { softnApp: true }, theme: {}, navConfig: [] } as unknown as App;
const project = (access: 'members' | 'application'): NativeProject => ({ version: 1, home: true, access, files: { 'manifest.json': '{"id":"a"}' }, assets: {} });
const ROLES = [{ id: 'r1', name: 'Owner', isSystem: true }, { id: 'r2', name: 'Member', isSystem: true }];
const reload = vi.fn(async () => {});

beforeEach(() => {
  mocks.getAppRoles.mockReset().mockResolvedValue({ data: { roles: ROLES } });
  mocks.people = mocks.signup = null;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); });

async function mount(access: 'members' | 'application' = 'members') {
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><SoftnMembers app={app} project={project(access)} onReloadApp={reload} /></MemoryRouter>));
  await act(async () => {});
}
const hrefs = () => [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));

it('lists the people of an app only invited people can use, and how they join, with its roles', async () => {
  await mount('members');
  expect(mocks.getAppRoles).toHaveBeenCalledWith('app-1');
  expect(container.textContent).toContain('Only the people here can use this app.');
  expect(container.querySelector('[data-testid="people"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="signup"]')).not.toBeNull();
  expect(mocks.people).toMatchObject({ app, roles: ROLES, returnLabel: 'Members' });
  // The sign-up panel speaks of the list as this page shows it, not by App Studio's tab.
  expect(mocks.signup).toMatchObject({ app, roles: ROLES, onReloadApp: reload, peopleName: 'the list above' });
  // Who can use it is changed in the app's own settings; roles are still App Studio's.
  expect(hrefs()).toEqual(['/apps/app-1/softn/settings#settings-access', '/apps/app-1/studio/access']);
});

it('says so of an app anyone with the link can use', async () => {
  await mount('application');
  expect(container.textContent).toContain('Anyone with the link can use this app.');
  expect(container.textContent).not.toContain('Only the people here');
  expect(container.querySelector('[data-testid="people"]')).not.toBeNull();
});

it('says a read that failed is a failure, shows no empty list, and reads again when asked', async () => {
  mocks.getAppRoles.mockResolvedValueOnce({ error: 'Server error' });
  await mount();
  expect(container.textContent).toContain('The app’s members could not be loaded');
  expect(container.querySelector('[data-testid="people"]')).toBeNull();
  const again = [...container.querySelectorAll('button')].find(b => /try again/i.test(b.textContent ?? ''))!;
  await act(async () => again.click());
  await act(async () => {});
  expect(mocks.getAppRoles).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-testid="people"]')).not.toBeNull();
  expect(container.textContent).not.toContain('could not be loaded');
});
