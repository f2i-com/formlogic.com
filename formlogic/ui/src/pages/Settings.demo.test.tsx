// @vitest-environment jsdom
// The demo's route table has no /trash (the sidebar hides it too), so a button to it led to the 404
// page, and the shared account has nothing of its own to restore.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../stores/authStore';
import { Settings } from './Settings';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: true, message: 'Not in this test' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
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

async function openYourData(isDemo: boolean) {
  useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test', isDemo } });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/settings#your-data']}><Settings /></MemoryRouter>);
  });
}

/** The links to the panels of the Your data section, which stand above them. */
const panelLinks = () => [...host.querySelectorAll('nav[aria-label="Your data on this page"] a')].map((a) => a.textContent);

describe('the recycle bin in Settings', () => {
  it('is offered to an account', async () => {
    await openYourData(false);
    expect(host.querySelector('#trash')?.textContent).toContain('Open recycle bin');
    expect(panelLinks()).toContain('Recycle bin');
  });

  it('is not offered in the demo, which has no such page', async () => {
    await openYourData(true);
    expect(host.textContent).not.toContain('Open recycle bin');
    expect(host.querySelector('#trash')).toBeNull();
    expect(panelLinks()).not.toContain('Recycle bin');
    // The section's other panels are all there.
    expect(panelLinks()).toEqual(['Export a copy', 'Backup & restore', 'Delete account']);
  });
});
