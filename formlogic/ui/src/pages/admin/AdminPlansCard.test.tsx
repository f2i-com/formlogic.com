// @vitest-environment jsdom
// Admin → Platform → Plans: its Site AI switch and the AI for apps checklist show the same state.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, DEFAULT_PLATFORM_PLANS } from '../../lib/api';
import { announceSiteAiChanged, onSiteAiChanged } from '../../lib/siteAiEvents';
import { AdminPlansCard } from './AdminPlansCard';

vi.mock('./AdminSiteAiDesktop', () => ({ AdminSiteAiDesktop: () => null }));

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

const siteAi = () => [...container.querySelectorAll('label')].find((node) => node.textContent?.includes('Offer operator-funded Site AI'))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
/** The text box that holds this value now. */
const holding = (value: string) => [...container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].find((node) => node.value === value);
const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label))!;

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<AdminPlansCard />));
  await act(async () => {});
}

it('shows Site AI as the AI for apps checklist switched it, and keeps what is being edited here', async () => {
  const read = vi.spyOn(api, 'adminGetPlans').mockResolvedValue({ data: { plans: DEFAULT_PLATFORM_PLANS } });
  await mount();
  expect(siteAi().checked).toBe(false);
  const name = holding(DEFAULT_PLATFORM_PLANS.freeName)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Starter');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The checklist's "Turn on Site AI" saved it and announced it.
  read.mockResolvedValue({ data: { plans: { ...DEFAULT_PLATFORM_PLANS, siteAiEnabled: true } } });
  await act(async () => announceSiteAiChanged());
  expect(siteAi().checked).toBe(true);
  expect(holding('Starter')).toBeDefined();
  // Only the name is still unsaved: saving it keeps Site AI on.
  const put = vi.spyOn(api, 'adminPutPlans').mockResolvedValue({ data: { plans: { ...DEFAULT_PLATFORM_PLANS, freeName: 'Starter', siteAiEnabled: true } } });
  const heard = vi.fn();
  const stop = onSiteAiChanged(heard);
  await act(async () => button('Save plan settings').click());
  expect(put).toHaveBeenCalledWith({ ...DEFAULT_PLATFORM_PLANS, freeName: 'Starter', siteAiEnabled: true });
  // And the checklist hears of what this card saves.
  expect(heard).toHaveBeenCalledTimes(1);
  stop();
});
