// @vitest-environment jsdom
// "Payments": what the app sells at the owner's prices (never above what it declares), turned on, and sold.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AppPaymentsView } from '../../lib/appPayments';
import { AppPaymentsPanel } from './AppPaymentsPanel';

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

const view = (over: Partial<AppPaymentsView> = {}): AppPaymentsView => ({
  declared: { purpose: 'Pay 5 cents to download a logo.', items: [{ id: 'download', label: 'Download a logo', priceCents: 5 }], routes: ['/api/download'] },
  settings: { enabled: false, prices: { download: 5 } },
  available: false, reason: 'app_off', reasonText: 'This app does not take payments yet.', maxChargeCents: 500,
  sales: { today: { cents: 15, charges: 3 }, total: { cents: 120, charges: 24 }, latest: [] },
  ...over,
});

it('shows what the app sells and what it sold, and saves a lower price with payments on', async () => {
  vi.spyOn(api, 'getAppPayments').mockResolvedValue({ data: view() });
  const put = vi.spyOn(api, 'putAppPayments').mockResolvedValue({ data: view({ settings: { enabled: true, prices: { download: 4 } }, available: true, reason: null, reasonText: null }) });
  root = createRoot(container);
  await act(async () => root!.render(<AppPaymentsPanel appId="app-1" />));
  expect(container.textContent).toContain('Pay 5 cents to download a logo.');
  expect(container.textContent).toContain('This app does not take payments yet.');
  expect(container.textContent).toContain('Today: 15¢ from 3 sales. In all: $1.20.');
  const price = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(price.max).toBe('5');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '9');
    price.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(price.value).toBe('5', 'never above what the app declares');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '4');
    price.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click());
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { enabled: true, prices: { download: 4 } });
  expect(container.textContent).toContain('Taking payments');
});

it('marks an item an update added, and saving confirms every price shown', async () => {
  const items = [{ id: 'download', label: 'Download a logo', priceCents: 5 }, { id: 'poster', label: 'A poster', priceCents: 300 }];
  vi.spyOn(api, 'getAppPayments').mockResolvedValue({ data: view({ declared: { purpose: 'Logos.', items, routes: ['/api/download'] }, settings: { enabled: true, prices: { download: 5 }, unconfirmed: { poster: 300 } }, maxChargeCents: 200 }) });
  const put = vi.spyOn(api, 'putAppPayments').mockResolvedValue({ data: view({ declared: { purpose: 'Logos.', items, routes: ['/api/download'] }, settings: { enabled: true, prices: { download: 5, poster: 200 }, unconfirmed: {} } }) });
  root = createRoot(container);
  await act(async () => root!.render(<AppPaymentsPanel appId="app-1" />));
  expect(container.textContent).toContain('not sold until you save its price');
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
  expect(put).toHaveBeenCalledWith('app-1', { enabled: true, prices: { download: 5, poster: 200 } });
  expect(container.textContent).not.toContain('not sold until you save its price');
});

it('says why it cannot be turned on for a member\'s app', async () => {
  vi.spyOn(api, 'getAppPayments').mockResolvedValue({ data: view() });
  vi.spyOn(api, 'putAppPayments').mockResolvedValue({ error: 'This app cannot take payments on this site. Payments go to this site\'s own PayPal, so only its administrators\' apps take them.', status: 400 });
  root = createRoot(container);
  await act(async () => root!.render(<AppPaymentsPanel appId="app-1" />));
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('only its administrators\' apps');
});
