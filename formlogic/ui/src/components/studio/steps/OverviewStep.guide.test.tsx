// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, AppForm, AppRole } from '../../../types/app';
import type { FlowDefinition } from '../../../types/flows';

vi.mock('../../../lib/api', () => ({ api: { isDemoMode: () => false, isAdminActing: () => false, setAdminActing: () => {} } }));
vi.mock('../../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
const { OverviewStep } = await import('./OverviewStep');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const app = (over: Partial<App> = {}) => ({ id: 'a1', name: 'Repairs', slug: 'repairs', description: '', status: 'draft', settings: {}, ...over }) as unknown as App;
const forms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `af${i}`, appId: 'a1', formId: `f${i}`, displayName: `Form ${i}`, sortOrder: i, isVisible: true, settings: {} })) as unknown as AppForm[];
const roles = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Role ${i}` })) as unknown as AppRole[];
const flows = (enabled: boolean[]) => enabled.map((on, i) => ({ id: `fl${i}`, name: `Flow ${i}`, slug: `flow-${i}`, enabled: on })) as unknown as FlowDefinition[];

async function show(props: { app?: App; forms?: number; formsKnown?: boolean; roles?: number; flows?: boolean[]; members?: number; membersKnown?: boolean; tables?: number } = {}) {
  await act(async () => root.render(<MemoryRouter>
    <OverviewStep app={props.app ?? app()} appForms={forms(props.forms ?? 0)} nativeTableCount={props.tables} formsKnown={props.formsKnown} formsById={{}} roles={roles(props.roles ?? 0)} flows={flows(props.flows ?? [])}
      blueprint={null} memberCount={props.members ?? 1} memberCountKnown={props.membersKnown ?? true} onReloadApp={async () => {}} />
  </MemoryRouter>));
}
const links = () => [...host.querySelectorAll<HTMLAnchorElement>('section[aria-labelledby="studio-app-contents"] li a')];

describe('the Overview’s app contents', () => {
  it('links an empty app directly to naming its first form and shows its working sections', async () => {
    await show();
    expect(links().map(link => link.getAttribute('href'))).toEqual([
      '/apps/a1/studio/data?new=form', '/apps/a1/studio/screens', '/apps/a1/studio/automations',
      '/apps/a1/studio/access', '/apps/a1/studio/publish',
    ]);
    expect(links()[0].textContent).toContain('Add your first form');
  });

  it('shows the actual contents and release version of a published app', async () => {
    await show({ app: app({ status: 'published', publishedVersion: 4 } as Partial<App>), forms: 2, roles: 3, flows: [true, false], members: 6 });
    expect(links().map(link => link.textContent)).toEqual([
      'Forms2 forms', 'Screens3 screens', 'Automations2 automations · 1 running',
      'Members6 members · 3 roles', 'PublishingLive · version 4',
    ]);
    expect(links()[0].getAttribute('href')).toBe('/apps/a1/studio/data');
  });

  it('opens existing project tables with the forms, and reports unknown counts', async () => {
    await show({ forms: 0, tables: 3, members: 0, membersKnown: false });
    expect(links()[0].textContent).toContain('0 forms · 3 database tables');
    expect(links()[0].getAttribute('href')).toBe('/apps/a1/studio/data');
    expect(links()[3].textContent).toContain('Members not loaded');
    await show({ formsKnown: false });
    expect(links()[0].textContent).toContain('Forms not loaded');
    expect(links()[0].getAttribute('href')).toBe('/apps/a1/studio/data');
  });
});
