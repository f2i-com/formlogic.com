// @vitest-environment jsdom
// Signing out removes the submissions this account still has queued on the device (they hold its
// answers, and would otherwise be sent with whoever signs in next). Someone with submissions not
// yet sent is told so, and how many, before that happens, and can stay signed in instead.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ unsent: 0, forms: 0, logout: vi.fn(async () => {}) }));
vi.mock('../../stores/authStore', async (original) => {
  const actual = await original<typeof import('../../stores/authStore')>();
  actual.useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test', name: 'Ann' }, logout: auth.logout });
  return { ...actual, unsentSubmissionsOnSignOut: async () => auth.unsent, deviceFormsOnSignOut: () => auth.forms };
});

import { UserMenu } from './UserMenu';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  auth.unsent = 0;
  auth.forms = 0;
  auth.logout.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
async function click(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" button in: ${document.body.textContent}`);
  await act(async () => { b.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function openMenu() {
  await act(async () => { root.render(<MemoryRouter><UserMenu onOpenAuth={() => {}} /></MemoryRouter>); });
  const toggle = document.querySelector('button[aria-label="User menu"]') as HTMLButtonElement;
  await act(async () => { toggle.click(); });
}

describe('Sign Out with submissions still on the device', () => {
  it('signs out at once when nothing is waiting', async () => {
    await openMenu();
    await click('Sign Out');
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('says how many would be lost, and signs out only when the person confirms', async () => {
    auth.unsent = 2;
    await openMenu();
    await click('Sign Out');
    expect(auth.logout).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('2 submissions have not been sent');
    expect(document.body.textContent).toContain('answers will be lost');
    await click('Stay signed in');
    expect(auth.logout).not.toHaveBeenCalled();
    await openMenu();
    await click('Sign Out');
    await click('Sign out anyway');
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  // Signing out erases the forms a person keeps on this device, as it does what they have queued.
  it('names the forms kept on this device, and signs out only when the person confirms', async () => {
    auth.forms = 3;
    await openMenu();
    await click('Sign Out');
    expect(auth.logout).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('3 forms are kept on this device');
    expect(document.body.textContent).not.toContain('submissions have not been sent');
    await click('Sign out anyway');
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('names both when both would be lost', async () => {
    auth.unsent = 1;
    auth.forms = 1;
    await openMenu();
    await click('Sign Out');
    expect(document.body.textContent).toContain('1 submission has not been sent');
    expect(document.body.textContent).toContain('1 form is kept on this device');
  });
});
