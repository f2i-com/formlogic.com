// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useFormStore } from '../../stores/formStore';
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

describe('PackImportModal uninstall', () => {
  const REFUSED = { error: 'Nothing was uninstalled: a copy of "Clients" could not be saved to the recycle bin.', code: 'bin_unavailable' };
  const button = (name: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

  async function openInstalled({ keepList = false } = {}) {
    useFormStore.setState({ storageMode: 'api' });
    if (!keepList) {
      vi.spyOn(api, 'getInstalledPacks').mockResolvedValue({
        data: { installations: [{ id: 'inst-1', packName: 'Clients Pack', formCount: 1, appCount: 0, existingFormCount: 1, existingAppCount: 0, installedAt: '2026-11-01' }] },
      } as never);
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<MemoryRouter><PackImportModal isOpen onClose={() => {}} initialTab="installed" /></MemoryRouter>);
    });
    await act(settle);
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Uninstall Clients Pack"]')!.click());
  }

  it('says why the bin refused, and lets the person go on without a copy', async () => {
    const uninstall = vi.spyOn(api, 'uninstallPack')
      .mockResolvedValueOnce(REFUSED as never)
      .mockResolvedValueOnce({ data: { success: true, message: 'Uninstalled' } } as never);
    await openInstalled();

    await act(async () => button('Delete')!.click());
    await act(settle);

    expect(uninstall).toHaveBeenCalledWith('inst-1', { withoutCopy: false });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('gone for good');
    expect(useToastStore.getState().toasts).toEqual([]);

    await act(async () => button('Delete anyway')!.click());
    await act(settle);

    expect(uninstall).toHaveBeenLastCalledWith('inst-1', { withoutCopy: true });
    expect(button('Delete anyway')).toBeUndefined();
  });

  it('forgets the refusal on Cancel: the next try keeps a copy', async () => {
    const uninstall = vi.spyOn(api, 'uninstallPack').mockResolvedValue(REFUSED as never);
    await openInstalled();
    await act(async () => button('Delete')!.click());
    await act(settle);

    await act(async () => button('Cancel')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Uninstall Clients Pack"]')!.click());
    await act(async () => button('Delete')!.click());
    await act(settle);

    expect(uninstall).toHaveBeenLastCalledWith('inst-1', { withoutCopy: false });
  });

  it('shows any other failure as before', async () => {
    vi.spyOn(api, 'uninstallPack').mockResolvedValue({ error: 'Failed to uninstall pack' } as never);
    await openInstalled();

    await act(async () => button('Delete')!.click());
    await act(settle);

    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ message: 'Failed to uninstall pack' })]);
    expect(button('Delete anyway')).toBeUndefined();
  });

  it('keeps a refusal with its own pack, and holds the others back while one is going', async () => {
    let answer!: (refused: unknown) => void;
    const uninstall = vi.spyOn(api, 'uninstallPack').mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as never; }));
    vi.spyOn(api, 'getInstalledPacks').mockResolvedValue({
      data: { installations: ['Clients Pack', 'Stock Pack'].map((packName, n) => ({ id: `inst-${n + 1}`, packName, formCount: 1, appCount: 0, existingFormCount: 1, existingAppCount: 0, installedAt: '2026-11-01' })) },
    } as never);
    await openInstalled({ keepList: true });
    const stock = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Uninstall Stock Pack"]')!;

    await act(async () => button('Delete')!.click());
    expect(stock().disabled).toBe(true);

    await act(async () => answer(REFUSED));
    await act(settle);
    expect(stock().disabled).toBe(false);
    await act(async () => stock().click());

    expect(button('Delete anyway')).toBeUndefined();
    uninstall.mockResolvedValue({ data: { success: true, message: 'Uninstalled' } } as never);
    await act(async () => button('Delete')!.click());
    await act(settle);
    expect(uninstall).toHaveBeenLastCalledWith('inst-2', { withoutCopy: false });
  });
});

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
