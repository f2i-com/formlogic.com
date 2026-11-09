// @vitest-environment jsdom
// FormLogic's wallet over an app: the balance and what it was spent on, a top-up through PayPal's
// buttons (a fake SDK here), a capture that can be confirmed again, and a code to save the balance.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { WalletSheetData } from '../../lib/appPayments';
import { WalletSheet } from './WalletSheet';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root | undefined;
let buttonsOptions: Record<string, (...args: unknown[]) => unknown> | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  buttonsOptions = null;
  // PayPal's SDK, as far as the sheet uses it: Buttons(options).render(element).
  window.paypal = { Buttons: (options: Record<string, unknown>) => { buttonsOptions = options as typeof buttonsOptions; return { render: async () => {} }; } };
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  delete window.paypal;
  vi.restoreAllMocks();
});

const sheet = (over: Partial<WalletSheetData> = {}): WalletSheetData => ({
  available: true, reason: null, reasonText: null, balanceCents: 0, status: 'active', currency: 'USD', packages: [200, 500], items: { download: 5 },
  paypalClientId: 'client-1', ledger: [], email: { saved: false, possible: true }, ...over,
});
const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));

async function mount(onClose = vi.fn()) {
  root = createRoot(container);
  await act(async () => root!.render(<WalletSheet slug="logo-shop" appName="Logo shop" visitor onClose={onClose} />));
  return onClose;
}

it('tops up through PayPal: the chosen amount, captured, and the new balance read again', async () => {
  vi.spyOn(api, 'getAppWallet').mockResolvedValueOnce({ data: sheet() }).mockResolvedValueOnce({ data: sheet({ balanceCents: 500, ledger: [{ kind: 'topup', amountCents: 500, balanceAfter: 500, label: null, at: '2026-11-09 10:00:00' }] }) });
  const create = vi.spyOn(api, 'createAppWalletOrder').mockResolvedValue({ data: { orderId: 'ORDER1' } });
  const capture = vi.spyOn(api, 'captureAppWalletOrder').mockResolvedValue({ data: { status: 'completed', balanceCents: 500 } });
  await mount();
  expect(container.querySelector('[data-testid="wallet-balance"]')?.textContent).toBe('$0.00');
  const five = [...container.querySelectorAll<HTMLInputElement>('input[name="fl-wallet-package"]')][1];
  await act(async () => five.click());
  expect(buttonsOptions).not.toBeNull();
  let orderId: unknown;
  await act(async () => { orderId = await buttonsOptions!.createOrder(); });
  expect(orderId).toBe('ORDER1');
  expect(create).toHaveBeenCalledWith('logo-shop', 500, true);
  await act(async () => { await buttonsOptions!.onApprove({ orderID: 'ORDER1' }); });
  expect(capture).toHaveBeenCalledWith('logo-shop', 'ORDER1', true);
  expect(container.querySelector('[data-testid="wallet-balance"]')?.textContent).toBe('$5.00');
  expect(container.textContent).toContain('Top-up');
});

it('keeps an approved payment it could not confirm, to confirm again rather than pay twice', async () => {
  vi.spyOn(api, 'getAppWallet').mockResolvedValue({ data: sheet() });
  vi.spyOn(api, 'captureAppWalletOrder').mockResolvedValueOnce({ error: 'We could not confirm the payment yet.' }).mockResolvedValueOnce({ data: { status: 'completed', balanceCents: 200 } });
  await mount();
  await act(async () => { await buttonsOptions!.onApprove({ orderID: 'ORDER2' }); });
  expect(container.textContent).toContain('We could not confirm the payment yet.');
  await act(async () => button('Confirm the payment again')!.click());
  expect(api.captureAppWalletOrder).toHaveBeenLastCalledWith('logo-shop', 'ORDER2', true);
  expect(button('Confirm the payment again')).toBeUndefined();
});

it('says why payments are off, and shows no PayPal', async () => {
  vi.spyOn(api, 'getAppWallet').mockResolvedValue({ data: sheet({ available: false, reason: 'beta', reasonText: 'Payments are off during the beta.', paypalClientId: null, balanceCents: 120 }) });
  await mount();
  expect(container.textContent).toContain('Payments are off during the beta.');
  expect(container.querySelector('[data-testid="wallet-paypal"]')).toBeNull();
  expect(buttonsOptions).toBeNull();
});

it('saves the balance with an email code, and closes with the balance', async () => {
  vi.spyOn(api, 'getAppWallet').mockResolvedValue({ data: sheet({ balanceCents: 195 }) });
  const send = vi.spyOn(api, 'sendAppWalletCode').mockResolvedValue({ data: { sent: true } });
  const confirm = vi.spyOn(api, 'confirmAppWalletCode').mockResolvedValue({ data: { balanceCents: 195 } });
  const onClose = await mount();
  await act(async () => button('Save my balance with an email')!.click());
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const set = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
  await act(async () => set(email, 'me@example.com'));
  await act(async () => button('Send a code')!.click());
  expect(send).toHaveBeenCalledWith('logo-shop', 'save', 'me@example.com', true);
  const code = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
  await act(async () => set(code, '123456'));
  await act(async () => button('Confirm')!.click());
  expect(confirm).toHaveBeenCalledWith('logo-shop', 'save', 'me@example.com', '123456', true);
  expect(container.textContent).toContain('Saved.');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(onClose).toHaveBeenCalledWith(195);
});
