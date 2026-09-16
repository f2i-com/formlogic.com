// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ maintenance: vi.fn(), notices: vi.fn(), backups: vi.fn(), create: vi.fn(), revoke: vi.fn(), toggle: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { adminGetMaintenance: mocks.maintenance, adminListNotices: mocks.notices, adminListScheduledBackups: mocks.backups, adminCreateNotice: mocks.create, adminRevokeNotice: mocks.revoke, adminSetMaintenance: mocks.toggle } }));
vi.mock('./AdminPlansCard', () => ({ AdminPlansCard: () => <div>Plans</div> }));
vi.mock('./AdminAllowancesCard', () => ({ AdminAllowancesCard: () => <div>Allowances</div> }));
vi.mock('./AdminEnginePolicyCard', () => ({ AdminEnginePolicyCard: () => <div>App engine</div> }));
vi.mock('../../lib/timezone', () => ({ useAdminTimezone: () => 'UTC', formatDateTimeInZone: (date: string) => date }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: mocks.error, success: mocks.success } }));
import { AdminPlatform } from './AdminPlatform';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.maintenance.mockResolvedValue({ data: { maintenance: { enabled: false, message: 'Back soon' }, onlineUsers: 2 } });
  mocks.notices.mockResolvedValue({ data: { notices: [] } });
  mocks.backups.mockResolvedValue({ data: { runs: [], lastRun: null } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(<AdminPlatform />)); }
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
it('distinguishes loading backup history from a never-run schedule', async () => {
  let resolve!: (value: unknown) => void;
  mocks.backups.mockReturnValue(new Promise(r => { resolve = r; }));
  await mount(); expect(container.textContent).toContain('Loading backup history'); expect(container.textContent).not.toContain('Never run');
  await act(async () => resolve({ error: 'Unavailable' }));
  expect(container.textContent).toContain("read the backup history"); expect(container.textContent).not.toContain('Never run');
});
it('shows notice loading failures with retry instead of reporting an empty list', async () => {
  mocks.notices.mockResolvedValueOnce({ error: 'Notices unavailable' }).mockResolvedValueOnce({ data: { notices: [] } });
  await mount(); expect(container.querySelector('[role="alert"]')?.textContent).toBe('Notices unavailable');
  await click('Try again'); expect(container.textContent).toContain('No notices yet.');
});
it('keeps a failed retraction visible and reports the error', async () => {
  mocks.notices.mockResolvedValue({ data: { notices: [{ id: 'n1', message: 'Scheduled maintenance', level: 'info', audience: 'all', createdAt: '2026-09-13', active: true }] } });
  mocks.revoke.mockResolvedValue({ error: 'Please retry' });
  await mount(); await click('Retract');
  expect(mocks.error).toHaveBeenCalledWith('Could not retract notice', 'Please retry');
  expect(container.textContent).toContain('Scheduled maintenance');
});
it('waits for confirmation before enabling maintenance', async () => {
  await mount(); await click('Close site for maintenance');
  expect(mocks.toggle).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Close the site for maintenance?');
  await click('Cancel'); expect(mocks.toggle).not.toHaveBeenCalled();
});
it('disables notice submission and editing while sending', async () => {
  let resolve!: (value: unknown) => void;
  mocks.create.mockReturnValue(new Promise(r => { resolve = r; }));
  await mount();
  const input = container.querySelector<HTMLTextAreaElement>('#broadcast-message')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Test notice'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Send notice');
  expect(input.disabled).toBe(true);
  expect([...container.querySelectorAll('button')].find(el => el.textContent === 'Send notice')?.disabled).toBe(true);
  await act(async () => resolve({ error: 'Server unavailable' }));
  expect(input.value).toBe('Test notice'); expect(input.disabled).toBe(false);
});
