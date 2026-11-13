// @vitest-environment jsdom
// The row of section links every page with sections shares (the SoftN app page, Settings, the
// admin area, the App Studio).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// A phone shows three of six sections and half a word. The row says there is more, at the end
// it runs off, and an arrow there moves it along.
describe('a row longer than the screen', () => {
  let measure: () => void = () => {};
  const watched: Element[] = [];
  beforeEach(() => {
    watched.length = 0;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback; } observe(node: Element) { watched.push(node); } disconnect() {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  /** The row as a screen would lay it out: `width` showing of `whole`, scrolled to `at`. */
  const laidOut = async (width: number, whole: number, at: number) => {
    const nav = container.querySelector('nav')!;
    Object.defineProperty(nav, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: whole });
    nav.scrollLeft = at;
    Object.defineProperty(nav, 'scrollLeft', { configurable: true, writable: true, value: at });
    await act(async () => { measure(); });
    return nav;
  };
  const arrows = () => Array.from(container.querySelectorAll('[data-more]')).map((node) => node.getAttribute('data-more'));

  it('says nothing when every section is in view', async () => {
    await show('overview');
    const nav = await laidOut(700, 700, 0);
    expect(arrows()).toEqual([]);
    expect(nav.style.maskImage).toBe('');
  });

  it('fades the end it runs off and puts an arrow there, at either end or both', async () => {
    await show('overview');
    let nav = await laidOut(358, 700, 0);
    expect(arrows()).toEqual(['after']);
    expect(nav.style.maskImage).toContain('rgb(0, 0, 0) 0px, rgb(0, 0, 0) calc(100% - 1.75rem)');
    nav = await laidOut(358, 700, 160);
    expect(arrows()).toEqual(['before', 'after']);
    expect(nav.style.maskImage).toContain('rgb(0, 0, 0) 1.75rem, rgb(0, 0, 0) calc(100% - 1.75rem)');
    nav = await laidOut(358, 700, 342);
    expect(arrows()).toEqual(['before']);
    expect(nav.style.maskImage).toContain('rgb(0, 0, 0) 1.75rem, rgb(0, 0, 0) 100%');
  });

  it('moves the row along when an arrow is pressed, and measures again as it scrolls', async () => {
    await show('overview');
    const nav = await laidOut(358, 700, 0);
    const scrollBy = vi.fn();
    (nav as unknown as { scrollBy: typeof scrollBy }).scrollBy = scrollBy;
    await act(async () => (container.querySelector('[data-more="after"]') as HTMLButtonElement).click());
    expect(scrollBy).toHaveBeenCalledWith({ left: 358 * 0.7, behavior: 'smooth' });
    // The row arrives at its end: the arrow there goes, and one appears at the start.
    Object.defineProperty(nav, 'scrollLeft', { configurable: true, writable: true, value: 342 });
    await act(async () => { nav.dispatchEvent(new Event('scroll')); });
    expect(arrows()).toEqual(['before']);
  });

  it('keeps the arrows out of the keyboard’s way and a screen reader’s: the links are the navigation', async () => {
    await show('overview');
    await laidOut(358, 700, 160);
    for (const arrow of container.querySelectorAll('[data-more]')) {
      expect(arrow.getAttribute('tabindex')).toBe('-1');
      expect(arrow.getAttribute('aria-hidden')).toBe('true');
      expect(arrow.closest('nav')).toBeNull();
    }
    // The row is watched for its own width and for what is in it.
    expect(watched).toContain(container.querySelector('nav'));
    expect(watched.filter((node) => node.tagName === 'A')).toHaveLength(items.length);
  });
});
