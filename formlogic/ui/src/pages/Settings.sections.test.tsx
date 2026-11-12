// @vitest-environment jsdom
// Settings keeps its section in the address's #hash. Other pages, setup wizards and e2e specs hold
// those addresses (/settings#ai, #security, #local-runtime, #backup, #linked-desktops, #your-data),
// so each must go on opening the section it always did, and a hash that names a panel further down
// a section must bring that panel into view.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../stores/authStore';
import { Settings } from './Settings';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let scrollTo: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: true, message: 'Not in this test' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  scrollTo = vi.fn();
  scrollIntoView = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null });
  vi.unstubAllGlobals();
});

async function open(address: string, isDemo = false) {
  useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test', isDemo } });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[address]}><Settings /></MemoryRouter>);
  });
}

const sectionLinks = () => [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a')];
/** The section whose link is marked as the open one. */
const current = () => sectionLinks().filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent);
/** The sections on show: every one stays mounted, and all but the open one are hidden. */
const shown = () => [...host.querySelectorAll<HTMLElement>('[data-settings-section]')].filter((section) => !section.hidden).map((section) => section.getAttribute('aria-label'));
/** The ids of the elements brought into view, in order. */
const broughtIntoView = () => scrollIntoView.mock.contexts.map((element) => (element as HTMLElement).id);

describe('the sections of Settings', () => {
  it('are five links, each at the address its tab had', async () => {
    await open('/settings');
    expect(sectionLinks().map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Account', '/settings#profile'], ['Workspace', '/settings#appearance'], ['AI & devices', '/settings#ai'],
      ['Security', '/settings#security'], ['Your data', '/settings#your-data'],
    ]);
    expect(host.querySelector('[role="tablist"], [role="tab"], [role="tabpanel"]')).toBeNull();
  });

  it('open on Account, from the top, when the address names none', async () => {
    await open('/settings');
    expect(current()).toEqual(['Account']);
    expect(shown()).toEqual(['Account']);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    ['profile', 'Account'], ['appearance', 'Workspace'], ['ai', 'AI & devices'], ['security', 'Security'], ['your-data', 'Your data'],
  ])('#%s is the address of %s: it opens from the top, with the row of sections in sight', async (hash, section) => {
    await open(`/settings#${hash}`);
    expect(current()).toEqual([section]);
    expect(shown()).toEqual([section]);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    // The panel still carries the id, for what looks it up; it asks for the page's top when a browser goes to it.
    expect(host.querySelector(`#${hash}`)?.className).toContain('scroll-mt-[100vh]');
  });

  it.each([
    ['notifications', 'Account'], ['form-defaults', 'Workspace'],
    ['local-runtime', 'AI & devices'], ['linked-desktops', 'AI & devices'], ['mcp', 'AI & devices'],
    ['two-factor', 'Security'], ['support-access', 'Security'], ['passes', 'Security'], ['vault', 'Security'], ['audit', 'Security'], ['api-keys', 'Security'],
    ['backup', 'Your data'], ['trash', 'Your data'], ['danger', 'Your data'],
  ])('#%s opens %s and brings its panel into view', async (hash, section) => {
    await open(`/settings#${hash}`);
    expect(current()).toEqual([section]);
    expect(shown()).toEqual([section]);
    expect(broughtIntoView()).toEqual([hash]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    // It is inside the section that opened, and stops below the sticky header.
    const panel = host.querySelector<HTMLElement>(`#${hash}`)!;
    expect(panel.closest('[data-settings-section]')?.getAttribute('aria-label')).toBe(section);
    // It stops below the sticky header (and the bar over it, when there is one), not under it.
    expect(panel.className).toMatch(/(^|\s)scroll-mt-/);
  });

  it('names a section by its own id too', async () => {
    await open('/settings#connections');
    expect(current()).toEqual(['AI & devices']);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('open on Account for a hash that is no address of the page', async () => {
    await open('/settings#nothing-here');
    expect(current()).toEqual(['Account']);
    expect(shown()).toEqual(['Account']);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('link to the panels of a long section, and not of a short one', async () => {
    await open('/settings#security');
    const links = (name: string) => [...host.querySelectorAll(`nav[aria-label="${name}"] a`)].map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links('Security on this page')).toEqual([
      ['Password', '/settings#security'], ['Two-factor authentication', '/settings#two-factor'], ['Support access', '/settings#support-access'],
      ['Passes', '/settings#passes'], ['Encryption vault', '/settings#vault'], ['Audit trail', '/settings#audit'], ['API keys', '/settings#api-keys'],
    ]);
    expect(links('AI & devices on this page')).toEqual([
      ['AI assistant', '/settings#ai'], ['Local runtime', '/settings#local-runtime'], ['Linked desktops', '/settings#linked-desktops'], ['External AI access', '/settings#mcp'],
    ]);
    expect(links('Your data on this page')).toEqual([
      ['Export a copy', '/settings#your-data'], ['Backup & restore', '/settings#backup'], ['Recycle bin', '/settings#trash'], ['Delete account', '/settings#danger'],
    ]);
    expect(host.querySelector('nav[aria-label="Account on this page"]')).toBeNull();
    expect(host.querySelector('nav[aria-label="Workspace on this page"]')).toBeNull();
  });

  it('moves to the section whose link is pressed, keeping what was typed in the one left', async () => {
    await open('/settings');
    const name = host.querySelector<HTMLInputElement>('#profile input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'A draft');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { sectionLinks().find((link) => link.textContent === 'Your data')!.click(); });
    expect(current()).toEqual(['Your data']);
    expect(shown()).toEqual(['Your data']);
    await act(async () => { sectionLinks().find((link) => link.textContent === 'Account')!.click(); });
    expect(shown()).toEqual(['Account']);
    expect(host.querySelector<HTMLInputElement>('#profile input')!.value).toBe('A draft');
  });

  it('returns to a panel when its link is pressed again', async () => {
    await open('/settings#backup');
    expect(broughtIntoView()).toEqual(['backup']);
    const link = [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Your data on this page"] a')].find((found) => found.textContent === 'Backup & restore')!;
    await act(async () => { link.click(); });
    expect(broughtIntoView()).toEqual(['backup', 'backup']);
  });
});

describe('the shared demo in Settings', () => {
  it('has none of the panels an account of its own has, nor links to them', async () => {
    await open('/settings#security', true);
    for (const id of ['two-factor', 'support-access', 'passes', 'vault', 'trash']) expect(host.querySelector(`#${id}`), id).toBeNull();
    expect([...host.querySelectorAll('nav[aria-label="Security on this page"] a')].map((link) => link.textContent)).toEqual(['Password', 'Audit trail', 'API keys']);
    expect([...host.querySelectorAll('nav[aria-label="Your data on this page"] a')].map((link) => link.textContent)).toEqual(['Export a copy', 'Backup & restore', 'Delete account']);
  });

  it('opens Your data from its top for the recycle bin it has not got', async () => {
    await open('/settings#trash', true);
    expect(current()).toEqual(['Your data']);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
