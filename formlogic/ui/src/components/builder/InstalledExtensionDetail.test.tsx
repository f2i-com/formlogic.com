// @vitest-environment jsdom
// MKT-605 installed-extension management: the detail panel reads the §13.1 receipt endpoint
// and surfaces what the list row cannot — contributed node types with their compiler digests,
// BOTH dependency directions (dependents are what block an uninstall), and the connector
// grants the install was reviewed under. A failed load must stay honest + retriable, never
// render as an empty/healthy panel.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstalledExtensionDetail } from './InstalledExtensionDetail';
import { api, type PackageInstallationDetail } from '../../lib/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function detail(overrides: Partial<PackageInstallationDetail> = {}): PackageInstallationDetail {
  return {
    id: 'inst-1',
    packageId: 'com.acme.media-tools',
    publisherId: 'com.acme',
    kind: 'extension',
    version: '1.4.0',
    displayName: 'Acme Media Tools',
    state: 'ready',
    source: 'signed-json:plan',
    installedAt: '2026-07-24T00:00:00Z',
    receipt: { trust: 'official', approvedConnectorGrants: ['connector.acme.images'] },
    nodes: [{ type: 'com.acme.mediatools.generate-image', version: '1.2.0', digest: 'a'.repeat(64), enabled: true }],
    dependencies: [],
    dependents: [],
    ...overrides,
  };
}

async function render(installationId = 'inst-1'): Promise<string> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<InstalledExtensionDetail installationId={installationId} />);
  });
  return host.textContent ?? '';
}

describe('InstalledExtensionDetail', () => {
  it('shows contributed nodes, both dependency directions, and the reviewed grants', async () => {
    vi.spyOn(api, 'getPackageInstallation').mockResolvedValue({
      data: {
        installation: detail({
          dependencies: [{ packageId: 'com.acme.core', range: '^1.0.0', resolvedVersion: '1.3.0', required: true }],
          dependents: [{ packageId: 'com.acme.suite', displayName: 'Acme Suite', version: '2.0.0', range: '^1.2.0', required: true }],
        }),
      },
    } as Awaited<ReturnType<typeof api.getPackageInstallation>>);

    const text = await render();

    expect(text).toContain('com.acme.mediatools.generate-image');
    expect(text).toContain('v1.2.0');
    // The digest is what the compiler locks against — shown truncated, full value in the title.
    expect(text).toContain('aaaaaaaaaaaa…');
    expect(text).toContain('Requires');
    expect(text).toContain('^1.0.0 → v1.3.0');
    expect(text).toContain('Required by');
    expect(text).toContain('Acme Suite v2.0.0');
    // The operational consequence is stated, not left for the user to infer from a 409 —
    // and it NAMES the blocker (an earlier "this package still requires it" read as if it
    // meant the extension itself).
    expect(text).toContain('Uninstall is blocked while “Acme Suite” still requires this extension');
    expect(text).toContain('connector.acme.images');
  });

  it('states plainly when no connector grants were approved', async () => {
    vi.spyOn(api, 'getPackageInstallation').mockResolvedValue({
      data: { installation: detail({ receipt: { trust: 'community', approvedConnectorGrants: [] } }) },
    } as Awaited<ReturnType<typeof api.getPackageInstallation>>);

    const text = await render();

    expect(text).toContain('no connector grants approved');
    // With nothing depending on it, neither dependency section is invented.
    expect(text).not.toContain('Required by');
    expect(text).not.toContain('Uninstall is blocked');
  });

  it('surfaces a failed load with a retry instead of rendering an empty panel', async () => {
    const spy = vi.spyOn(api, 'getPackageInstallation')
      .mockResolvedValueOnce({ error: 'Installation not found' } as Awaited<ReturnType<typeof api.getPackageInstallation>>)
      .mockResolvedValueOnce({ data: { installation: detail() } } as Awaited<ReturnType<typeof api.getPackageInstallation>>);

    const text = await render();
    expect(text).toContain('Installation not found');
    expect(text).toContain('Retry');
    expect(text).not.toContain('Contributed flow nodes');

    const retry = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(host!.textContent).toContain('Contributed flow nodes');
  });
  it('says an installation is not active yet and why, rather than looking healthy', async () => {
    // PKG-107: a package that committed but has not activated withholds its nodes. Rendering it
    // identically to a working one would leave the user hunting for an extension that is simply
    // waiting on a device.
    vi.spyOn(api, 'getPackageInstallation').mockResolvedValue({
      data: {
        installation: detail({
          active: false,
          components: [
            { key: 'cloud-nodes', kind: 'cloud-nodes', target: 'cloud', required: true, state: 'active', deviceId: null, detail: null },
            { key: 'runtime', kind: 'device-distribution', target: 'device', required: true, state: 'pending', deviceId: 'desk-A', detail: null },
          ],
        }),
      },
    } as Awaited<ReturnType<typeof api.getPackageInstallation>>);

    const text = await render();

    expect(text).toContain('Not active yet');
    expect(text).toContain('waiting for device desk-A to report');
    expect(text).toContain('stay out of the editor');
    // The healthy component is not listed as a problem.
    expect(text).not.toContain('cloud-nodes —');
  });

  it('reports a failed component with the health detail', async () => {
    vi.spyOn(api, 'getPackageInstallation').mockResolvedValue({
      data: {
        installation: detail({
          active: false,
          components: [
            { key: 'cloud-nodes', kind: 'cloud-nodes', target: 'cloud', required: true, state: 'failed', deviceId: null, detail: 'a stored definition could not be decoded' },
          ],
        }),
      },
    } as Awaited<ReturnType<typeof api.getPackageInstallation>>);

    expect(await render()).toContain('a stored definition could not be decoded');
  });
});
