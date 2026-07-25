// @vitest-environment jsdom
// MKT-604: progress for installs that run on a device. The properties worth protecting are
// about honesty over time — a finished job keeps its result on screen instead of vanishing,
// a failure says why, and polling stops once nothing is moving so an idle page goes quiet.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallJobProgress } from './InstallJobProgress';
import { api, type PackageInstallJob } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function job(overrides: Partial<PackageInstallJob> = {}): PackageInstallJob {
  return {
    id: 'job-1', kind: 'distribution-install', state: 'running', progress: 40, step: 'Staging',
    planId: null, installationId: null, distributionId: 'com.acme.image-service', deviceId: 'device-1',
    errorCode: null, error: null,
    createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z', expiresAt: '2026-07-25T01:00:00Z',
    ...overrides,
  };
}

async function render(jobs: PackageInstallJob[]): Promise<string> {
  vi.spyOn(api, 'listPackageJobs').mockResolvedValue({ data: { jobs } } as Awaited<ReturnType<typeof api.listPackageJobs>>);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<InstallJobProgress />);
  });
  return host.textContent ?? '';
}

describe('InstallJobProgress (MKT-604)', () => {
  it('renders nothing when there are no device installs', async () => {
    const text = await render([]);
    // An empty progress panel is noise on a page that has never installed anything.
    expect(text).toBe('');
    expect(host!.querySelector('section')).toBeNull();
  });

  it('shows the current step and an accessible progress bar while running', async () => {
    const text = await render([job({ progress: 40, step: 'Verifying signature' })]);
    expect(text).toContain('com.acme.image-service');
    expect(text).toContain('Verifying signature');

    const bar = host!.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('aria-valuenow')).toBe('40');
  });

  it('keeps a finished job on screen with its outcome', async () => {
    // The result is the part worth reading; a panel that vanishes on success takes it away.
    const succeeded = await render([job({ state: 'succeeded', progress: 100, step: null })]);
    expect(succeeded).toContain('Installed');
    expect(host!.querySelector('[role="progressbar"]')).toBeNull();
    expect(host!.textContent).not.toContain('Cancel');
  });

  it('says why a failure happened, not just that it did', async () => {
    const text = await render([job({ state: 'failed', error: 'the fetched artifact does not match its signed digest', errorCode: 'artifact_digest_mismatch' })]);
    expect(text).toContain('does not match its signed digest');
    expect(text).toContain('artifact_digest_mismatch');
  });

  it('offers cancel only while work is still in flight', async () => {
    await render([job({ state: 'running' })]);
    expect(host!.textContent).toContain('Cancel');

    if (root) act(() => root?.unmount());
    await render([job({ state: 'cancelled' })]);
    expect(host!.textContent).toContain('Cancelled');
    expect(host!.textContent).not.toContain('Cancel ');
  });

  it('stops polling once every job is terminal', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'listPackageJobs').mockResolvedValue(
      { data: { jobs: [job({ state: 'succeeded' })] } } as Awaited<ReturnType<typeof api.listPackageJobs>>,
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<InstallJobProgress />);
    });
    const afterFirst = spy.mock.calls.length;

    // An idle page must not keep asking the server about work that has finished.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(spy.mock.calls.length).toBe(afterFirst);
  });
});
