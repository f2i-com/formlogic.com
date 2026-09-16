// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), setCodeTrust: vi.fn(), backups: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../lib/api', () => ({
  api: {
    adminGetUser: mocks.getUser,
    adminSetCodeTrust: mocks.setCodeTrust,
    adminListScheduledBackups: mocks.backups,
    adminSetAdmin: vi.fn(),
    adminResetMfa: vi.fn(),
    adminGetBackupManifest: vi.fn(),
    adminRestoreScheduledBackup: vi.fn(),
  },
}));
vi.mock('../../lib/timezone', () => ({ useAdminTimezone: () => 'UTC', formatDateInZone: (d: string) => d, formatDateTimeInZone: (d: string) => d }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (select: (s: { user: { id: string } }) => unknown) => select({ user: { id: 'admin-1' } }) }));
vi.mock('./AdminAccountTools', () => ({ AdminAccountTools: () => <div /> }));
import { AdminUserDetail } from './AdminUserDetail';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u-1', email: 'owner@test.local', name: 'Owner', plan: 'personal', isAdmin: false, isDemo: false,
  online: false, mfaEnabled: true, codeTrustVerified: false, apps: [], forms: [], flows: [], ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.backups.mockResolvedValue({ data: { runs: [], lastRun: null } });
  mocks.getUser.mockResolvedValue({ data: { user: user() } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/admin/users/u-1']}>
      <Routes><Route path="/admin/users/:userId" element={<AdminUserDetail />} /></Routes>
    </MemoryRouter>
  ));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(el => el.textContent === label);
const click = async (label: string) => { const el = button(label); expect(el, label).toBeTruthy(); await act(async () => el!.click()); };
const password = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;
const type = async (value: string) => {
  const input = password();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('will not offer verification to an account without two-factor auth', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: user({ mfaEnabled: false }) } });
  await mount();
  expect(button('Verify for host JavaScript')?.disabled).toBe(true);
  expect(button('Verify for host JavaScript')?.getAttribute('title')).toContain('two-factor authentication');
});

it('never offers it for the shared demo account', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: user({ isDemo: true }) } });
  await mount();
  expect(button('Verify for host JavaScript')).toBeUndefined();
});

it('asks for the acting admin\'s own password before verifying', async () => {
  await mount();
  await click('Verify for host JavaScript');
  expect(mocks.setCodeTrust).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Verify this account for host JavaScript?');
  expect(button('Verify account')?.disabled).toBe(true);

  mocks.setCodeTrust.mockResolvedValue({ data: { success: true, codeTrust: { verified: true, verifiedAt: '2026-09-16 10:00:00', verifiedBy: 'admin-1', affectedApps: [], self: false } } });
  await type('admin-pass');
  await click('Verify account');
  expect(mocks.setCodeTrust).toHaveBeenCalledWith('u-1', true, 'admin-pass');
  expect(mocks.success).toHaveBeenCalledWith('Verified for host JavaScript', expect.stringContaining('can now choose host JavaScript'));
});

it('warns that revoking sends the account\'s apps back to the default, and says how many moved', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: user({ codeTrustVerified: true, codeTrustVerifiedAt: '2026-09-16 10:00:00', codeTrustVerifiedBy: 'admin-1' }) } });
  await mount();
  expect(container.textContent).toContain('verified for host JavaScript');
  expect(container.textContent).toContain('since 2026-09-16 10:00:00');
  expect(container.textContent).toContain('by you');
  await click('Revoke code trust');
  expect(document.body.textContent).toContain('go back to the site default engine');

  mocks.setCodeTrust.mockResolvedValue({ data: { success: true, codeTrust: { verified: false, verifiedAt: null, verifiedBy: null, affectedApps: ['a-1', 'a-2'], self: false } } });
  await type('admin-pass');
  await click('Revoke verification');
  expect(mocks.setCodeTrust).toHaveBeenCalledWith('u-1', false, 'admin-pass');
  expect(mocks.success).toHaveBeenCalledWith('Verification revoked', '2 apps went back to the site default engine.');
});

it('says a self-verification is recorded as one', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: user({ id: 'admin-1' }) } });
  await mount();
  await click('Verify for host JavaScript');
  expect(document.body.textContent).toContain('verifying your OWN account');
});

it('keeps the dialog open and reports a refused step-up', async () => {
  mocks.setCodeTrust.mockResolvedValue({ error: 'Enter your own password to confirm this change' });
  await mount();
  await click('Verify for host JavaScript');
  await type('wrong');
  await click('Verify account');
  expect(mocks.error).toHaveBeenCalledWith('Could not verify this account', 'Enter your own password to confirm this change');
  expect(document.body.textContent).toContain('Verify this account for host JavaScript?');
  expect(mocks.success).not.toHaveBeenCalled();
});

it('shows each app\'s requested and effective engine', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: user({
    apps: [{
      id: 'a-1', name: 'Notes', formCount: 0, flowCount: 0, bindingCount: 0, memberCount: 0,
      engine: { id: 'zipp-web-python', requested: 'host-js', stored: 'host-js', reason: 'not-installed', revision: 'abc' },
    }],
  }) } });
  await mount();
  expect(container.textContent).toContain('engine ZIPP (JavaScript and Python)');
  expect(container.textContent).toContain('owner asked for None (host JavaScript, verified accounts) (not-installed)');
});
