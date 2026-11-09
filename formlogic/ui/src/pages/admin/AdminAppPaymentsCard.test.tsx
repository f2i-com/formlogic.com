// @vitest-environment jsdom
// Admin → Platform → App payments: the switch, the top-ups offered (dollars in, cents saved), the
// latest top-ups with PayPal's ids, and a correction to one wallet.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppPaymentsAdminView } from '../../lib/appPayments';
import { AdminAppPaymentsCard } from './AdminAppPaymentsCard';

vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

const settings = { enabled: false, packages: [200, 500, 1000], maxChargeCents: 500, dailyLimitCents: 500 };
const adminView = (over: Partial<AppPaymentsAdminView> = {}): AppPaymentsAdminView => ({
  settings,
  topups: [{ id: 't1', appId: 'app-1', appName: 'Five Cent Designs', orderId: 'ORDER1', captureId: 'CAP1', amountCents: 500, status: 'completed', refundedCents: 0, walletId: 'w'.repeat(32), at: '2026-11-09 10:00:00.000' }],
  held: [],
  totals: { topupsCents: 500, spentCents: 25 },
  ...over,
});

it('saves the switch and the top-ups offered, and lists top-ups with PayPal\'s ids', async () => {
  vi.spyOn(api, 'adminGetAppPayments').mockResolvedValue({ data: adminView() });
  const put = vi.spyOn(api, 'adminPutAppPayments').mockResolvedValue({ data: adminView({ settings: { ...settings, enabled: true, packages: [200, 500] } }) });
  root = createRoot(container);
  await act(async () => root!.render(<AdminAppPaymentsCard />));
  expect(container.textContent).toContain('ORDER1 / CAP1');
  expect(container.textContent).toContain('Topped up in all: $5.00. Spent: 25¢.');
  const packages = container.querySelector<HTMLInputElement>('input[placeholder="2.00, 5.00, 10.00"]')!;
  expect(packages.value).toBe('2.00, 5.00, 10.00');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(packages, '2, $5.00');
    packages.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click());
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
  expect(put).toHaveBeenCalledWith({ ...settings, enabled: true, packages: [200, 500] });
});

it('corrects a wallet with a note', async () => {
  vi.spyOn(api, 'adminGetAppPayments').mockResolvedValue({ data: adminView({ held: [{ walletId: 'w'.repeat(32), appId: 'app-1', appName: 'Five Cent Designs', balanceCents: -5, status: 'blocked' }] }) });
  vi.spyOn(window, 'prompt').mockReturnValueOnce('0.05').mockReturnValueOnce('Refunded by mistake');
  const adjust = vi.spyOn(api, 'adminAdjustAppWallet').mockResolvedValue({ data: { walletId: 'w'.repeat(32), balanceCents: 0 } });
  root = createRoot(container);
  await act(async () => root!.render(<AdminAppPaymentsCard />));
  expect(container.textContent).toContain('Five Cent Designs: −5¢ (blocked)');
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Correct')!.click());
  expect(adjust).toHaveBeenCalledWith('w'.repeat(32), 5, 'Refunded by mistake');
});
