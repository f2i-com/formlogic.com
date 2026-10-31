// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import { PackImportModal } from './PackImportModal';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function planNumbered(n: number, grants: string[]) {
  return {
    data: {
      planId: `plan-${n}`, planDigest: `digest-${n}`, expiresInSeconds: 600, trust: 'community', action: 'install',
      capabilities: { forms: 0, apps: 0, hasScreens: false, hasCustomLogic: false, logicScripts: 0, connectors: [], permissions: grants, connectorGrants: grants },
      resolution: { ok: true, resolved: [], missingOptional: [], problems: [] },
    },
  };
}

async function uploadExtension(grants: string[] = []) {
  vi.spyOn(api, 'getInstalledPacks').mockResolvedValue({ data: { installations: [] } } as never);
  let proposals = 0;
  const propose = vi.spyOn(api, 'proposePackageInstallPlan').mockImplementation(async () => {
    proposals += 1;
    return planNumbered(proposals, grants) as never;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter><PackImportModal isOpen onClose={() => {}} initialTab="upload" /></MemoryRouter>);
  });
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([JSON.stringify({ formatVersion: 2, package: { id: 'acme.ext', version: '1.0.0' } })], 'ext.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(propose).toHaveBeenCalled()); // FileReader takes its own time
  });
  await act(settle);
  return { propose };
}

const importButton = () =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('Import to My Forms')) as HTMLButtonElement;

describe('PackImportModal v2 confirm', () => {
  it('starts a fresh review after a failed confirm, so Import uses a new plan', async () => {
    const { propose } = await uploadExtension();
    expect(propose).toHaveBeenCalledTimes(1);
    const confirm = vi.spyOn(api, 'confirmPackageInstallPlan')
      .mockResolvedValueOnce({ error: 'dependency missing' } as never)
      .mockResolvedValueOnce({ data: { installationId: 'i1', forms: [], apps: [] } } as never);
    vi.spyOn(api, 'cancelPackageInstallPlan').mockResolvedValue({ data: { success: true } } as never);

    await act(async () => importButton().click());
    await act(settle);

    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ message: 'dependency missing' })]);
    expect(propose).toHaveBeenCalledTimes(2);

    await act(async () => importButton().click());
    await act(settle);

    expect(confirm).toHaveBeenLastCalledWith('plan-2', { planDigest: 'digest-2', approvedConnectorGrants: [] });
  });

  it('does the same when the confirm never got an answer, releasing the old plan first', async () => {
    const { propose } = await uploadExtension();
    vi.spyOn(api, 'confirmPackageInstallPlan').mockRejectedValue(new Error('offline'));
    const cancel = vi.spyOn(api, 'cancelPackageInstallPlan').mockResolvedValue({ data: { success: true } } as never);

    await act(async () => importButton().click());
    await act(settle);

    expect(cancel).toHaveBeenCalledWith('plan-1');
    expect(propose).toHaveBeenCalledTimes(2);
  });

  it('keeps a grant unticked across the fresh review', async () => {
    const grants = ['connector.crm.read', 'connector.crm.write'];
    await uploadExtension(grants);
    const confirm = vi.spyOn(api, 'confirmPackageInstallPlan')
      .mockResolvedValueOnce({ error: 'dependency missing' } as never)
      .mockResolvedValueOnce({ data: { installationId: 'i1', forms: [], apps: [] } } as never);
    vi.spyOn(api, 'cancelPackageInstallPlan').mockResolvedValue({ data: { success: true } } as never);

    await act(async () => document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
    await act(async () => importButton().click());
    await act(settle);
    await act(async () => importButton().click());
    await act(settle);

    expect(confirm).toHaveBeenLastCalledWith('plan-2', { planDigest: 'digest-2', approvedConnectorGrants: [grants[0]] });
  });
});
