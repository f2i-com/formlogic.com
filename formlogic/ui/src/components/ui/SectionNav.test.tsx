// @vitest-environment jsdom
// The row of section links every page with sections shares (the SoftN app page, Settings, the
// admin area, the App Studio).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, Globe } from 'lucide-react';
import { SectionNav, type SectionNavItem } from './SectionNav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const items: SectionNavItem[] = [
  { value: 'overview', label: 'Overview', to: '/app' },
  { value: 'data', label: 'Data', to: '/app/data', icon: Database, mark: 7 },
  { value: 'domains', label: 'Domains', to: { hash: '#domains' }, icon: Globe, replace: true },
];
function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname + location.hash}</p>; }
const show = (current: string, end?: React.ReactNode) => act(async () => root.render(
  <MemoryRouter initialEntries={['/app']}><SectionNav label="App sections" items={items} current={current} end={end} /><Where /></MemoryRouter>,
));
const link = (name: string) => Array.from(container.querySelectorAll('nav a')).find((a) => a.textContent?.startsWith(name)) as HTMLAnchorElement;

describe('a page’s sections', () => {
  it('is a named navigation of links, the open one marked as the current page', async () => {
    await show('data');
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('App sections');
    expect(Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(link('Data').getAttribute('href')).toBe('/app/data');
    // No tab roles: a section is an address, opened like any link.
    expect(container.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
  });

  it('shows a section’s count beside its name, and keeps icons out of the name read aloud', async () => {
    await show('overview');
    expect(link('Data').textContent).toBe('Data7');
    expect(link('Data').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(link('Overview').querySelector('svg')).toBeNull();
  });

  it('goes to a section’s address when its link is pressed, a path or a hash', async () => {
    await show('overview');
    await act(async () => { link('Data').click(); });
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/app/data');
    await act(async () => { link('Domains').click(); });
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/app/data#domains');
  });

  it('puts what the page gives it at the end of the row, outside the navigation', async () => {
    await show('overview', <span data-testid="state">Live, version 3</span>);
    const state = container.querySelector('[data-testid="state"]')!;
    expect(state.textContent).toBe('Live, version 3');
    expect(state.closest('nav')).toBeNull();
  });
});
