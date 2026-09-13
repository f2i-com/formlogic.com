// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), latest: vi.fn(), download: vi.fn(), apply: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: {
  adminUpgradeStatus: mocks.status, adminUpgradeLatest: mocks.latest,
  adminUpgradeDownload: mocks.download, adminUpgradeApply: mocks.apply,
} }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/timezone', () => ({ useAdminTimezone: () => 'UTC', formatDateTimeInZone: (date: string) => date }));
import { AdminUpgrade } from './AdminUpgrade';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const release = { releaseId: 101, assetId: 202, version: '2.0.0', digest: 'a'.repeat(64),
  sizeBytes: 1048576, publishedAt: '2026-09-12', url: 'https://github.com/f2i-com/formlogic.com/releases/tag/v2.0.0', isNewer: true };
const status = { currentVersion: '1.0.0', layout: { supported: true, mode: 'deployed' },
  staged: null, backups: [], history: [], maintenance: { enabled: false } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue({ data: status });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(<AdminUpgrade />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(el => el.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

it('checks and stages the reviewed release without automatically installing it', async () => {
  mocks.latest.mockResolvedValue({ data: { release } });
  const staged = { version: '2.0.0', currentVersion: '1.0.0', packageId: 'pkg-test', digest: release.digest,
    integrity: 'github-release', verifiedFiles: 100, isDowngrade: false };
  mocks.download.mockImplementation(async () => {
    mocks.status.mockResolvedValue({ data: { ...status, staged } });
    return { data: { staged } };
  });
  await mount();
  expect(mocks.latest).not.toHaveBeenCalled();
  await click('Check for updates');
  expect(container.textContent).toContain('FormLogic 2.0.0');
  await click('Download and verify');
  expect(mocks.download).toHaveBeenCalledWith(release);
  expect(container.textContent).toContain('Ready to install: v2.0.0');
  expect(container.textContent).toContain('GitHub verified');
  expect(container.textContent).toContain('100 files checked');
  expect(mocks.apply).not.toHaveBeenCalled();
});

it('explains missing releases and lets an unavailable GitHub request be retried', async () => {
  mocks.latest.mockResolvedValueOnce({ error: 'GitHub unavailable' }).mockResolvedValueOnce({ data: { release: null } });
  await mount();
  await click('Check for updates');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('GitHub unavailable');
  await click('Check for updates');
  expect(container.textContent).toContain('No installable stable release');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('shows an up-to-date state without offering an older release', async () => {
  mocks.latest.mockResolvedValue({ data: { release: { ...release, isNewer: false } } });
  await mount();
  await click('Check for updates');
  expect(container.textContent).toContain('Your installation is up to date');
  expect([...container.querySelectorAll('button')].some(el => el.textContent === 'Download and verify')).toBe(false);
});
