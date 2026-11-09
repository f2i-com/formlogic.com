// @vitest-environment jsdom
// The site's AI served from the administrator's OAIY: a chosen computer that no longer stands is said so.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type SiteAiDesktopState } from '../../lib/api';
import { AdminSiteAiDesktop } from './AdminSiteAiDesktop';

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

const state = (over: Partial<SiteAiDesktopState> = {}): SiteAiDesktopState => ({ current: null, gone: null, candidates: [], engineProvider: 'oaiy-engine', ...over });

it('says when the chosen computer was unlinked or given a new key, and lets it be forgotten', async () => {
  vi.spyOn(api, 'adminGetSiteAiDesktop')
    .mockResolvedValueOnce({ data: state({ gone: { deviceName: 'Studio PC', fingerprint: 'AAAA BBBB' } }) })
    .mockResolvedValue({ data: state() });
  const forget = vi.spyOn(api, 'adminDeleteSiteAiDesktop').mockResolvedValue({ data: state() });
  root = createRoot(container);
  await act(async () => root!.render(<AdminSiteAiDesktop />));
  const said = container.querySelector('[role="status"]');
  expect(said?.textContent).toContain('Studio PC');
  expect(said?.textContent).toContain('was unlinked, has a new key');
  await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Forget it'))!.click());
  expect(forget).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('says nothing of the kind while the computer stands', async () => {
  vi.spyOn(api, 'adminGetSiteAiDesktop').mockResolvedValue({ data: state({ current: { connectionId: 'dc-1', deviceName: 'Studio PC', fingerprint: 'AAAA BBBB', chosenAt: null, yours: true } }) });
  root = createRoot(container);
  await act(async () => root!.render(<AdminSiteAiDesktop />));
  expect(container.textContent).toContain('Serving from Studio PC');
  expect(container.querySelector('[role="status"]')).toBeNull();
});
