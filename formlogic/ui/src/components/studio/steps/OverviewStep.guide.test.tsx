// @vitest-environment jsdom
// The Overview's guide: the five sections after it, in the order an app is built, each said in a
// sentence with what this app has of it and the way in. It stands where a row of bare counts
// stood, which told an owner what there was and never what any of it was for or what to do next.
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
const opened: string[] = [];
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); opened.length = 0; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const app = (over: Partial<App> = {}) => ({ id: 'a1', name: 'Repairs', slug: 'repairs', description: '', status: 'draft', settings: {}, ...over }) as unknown as App;
const forms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `af${i}`, appId: 'a1', formId: `f${i}`, displayName: `Form ${i}`, sortOrder: i, isVisible: true, settings: {} })) as unknown as AppForm[];
const roles = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Role ${i}` })) as unknown as AppRole[];
const flows = (enabled: boolean[]) => enabled.map((on, i) => ({ id: `fl${i}`, name: `Flow ${i}`, slug: `flow-${i}`, enabled: on })) as unknown as FlowDefinition[];

async function show(props: { app?: App; forms?: number; roles?: number; flows?: boolean[]; members?: number; membersKnown?: boolean; tables?: number } = {}) {
  await act(async () => root.render(<MemoryRouter>
    <OverviewStep app={props.app ?? app()} appForms={forms(props.forms ?? 0)} nativeTableCount={props.tables} formsById={{}} roles={roles(props.roles ?? 0)} flows={flows(props.flows ?? [])}
      blueprint={null} memberCount={props.members ?? 1} memberCountKnown={props.membersKnown ?? true} onStepChange={step => opened.push(step)} onReloadApp={async () => {}} />
  </MemoryRouter>));
}
const steps = () => [...host.querySelectorAll('section[aria-labelledby="studio-build-steps"] ol > li')];
/** A step as it reads: its title, what the app has of it, and what its button says. */
const read = (step: Element) => ({
  title: step.querySelector('p')!.textContent!.replace(/^Step \d: /, ''),
  state: step.querySelectorAll('div')[2].querySelector('p')!.textContent,
  button: step.querySelector('button')!.textContent,
  done: step.querySelector('svg.lucide-check') !== null,
});

describe('the Overview’s guide', () => {
  it('is the five sections in the order an app is built, each with the way in', async () => {
    await show();
    expect(host.querySelector('#studio-build-steps')!.textContent).toBe('Build your app in five steps');
    expect(steps().map(step => read(step).title)).toEqual(['Add your forms', 'Check the screens', 'Automate the routineOptional', 'Invite people', 'Publish']);
    for (const [index, section] of ['data', 'screens', 'automations', 'access', 'publish'].entries()) {
      await act(async () => steps()[index].querySelector('button')!.click());
      expect(opened.at(-1)).toBe(section);
    }
    // Each button says which section it opens, for someone who hears it without the row around it.
    expect(steps().slice(1).map(step => step.querySelector('button')!.getAttribute('aria-label')))
      .toEqual(['Open Screens', 'Open Automations', 'Open Users & roles', 'Open Review & publish']);
  });

  it('says what to do first in a new app: nothing is ticked, and the first step offers a form', async () => {
    await show();
    expect(steps().map(step => read(step).done)).toEqual([false, false, false, false, false]);
    expect(read(steps()[0])).toMatchObject({ state: 'None yet', button: 'Add a form' });
    expect(read(steps()[1]).state).toBe('1 screen');
    expect(read(steps()[2]).state).toBe('None yet');
    expect(read(steps()[3]).state).toBe('Only you so far · 0 roles');
    expect(read(steps()[4]).state).toBe('Draft: only you can see it');
    // Numbers stand where ticks will: the order the steps are usually taken in.
    expect(steps().map(step => step.querySelector('[aria-hidden="true"]')!.textContent)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('ticks what is done and says how much there is, in the app’s own numbers', async () => {
    await show({ app: app({ status: 'published', publishedVersion: 4 } as Partial<App>), forms: 2, roles: 3, flows: [true, false], members: 6 });
    expect(steps().map(step => read(step).done)).toEqual([true, true, true, true, true]);
    expect(steps().map(step => read(step).state)).toEqual([
      'Done. 2 forms', 'Done. 3 screens', 'Done. 2 automations · 1 running', 'Done. 6 members · 3 roles', 'Done. Live, version 4',
    ]);
    expect(read(steps()[0]).button).toBe('Open');
    expect(steps()[0].querySelector('button')!.getAttribute('aria-label')).toBe('Open Data & forms');
  });

  it('says one of each in the singular, and counts a project’s tables with the forms', async () => {
    await show({ forms: 1, roles: 1, flows: [true] });
    expect(steps().map(step => read(step).state)).toEqual(['Done. 1 form', 'Done. 2 screens', 'Done. 1 automation · 1 running', 'Only you so far · 1 role', 'Draft: only you can see it']);
    await show({ forms: 0, tables: 3 });
    expect(read(steps()[0])).toMatchObject({ state: 'Done. 3 database tables · 0 forms', button: 'Open', done: true });
  });

  it('does not say "only you" of members it could not count', async () => {
    await show({ forms: 1, roles: 2, members: 0, membersKnown: false });
    expect(read(steps()[3])).toMatchObject({ state: 'Members not loaded · 2 roles', done: false });
  });

  it('never says "data type" for a form', async () => {
    await show({ forms: 2, roles: 2 });
    expect(host.textContent).not.toMatch(/data types?/i);
  });
});
