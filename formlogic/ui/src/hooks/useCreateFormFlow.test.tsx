// @vitest-environment jsdom
// Private-form creation fail-closed (review 2026-07-22, blocker 2): when the
// user explicitly chose a PRIVATE form and encryption setup fails, the created
// form must be REMOVED — never left behind as a plaintext form the user
// believes is encrypted.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createFormMock, deleteFormMock, addFieldsMock, setActiveFormMock, navigateMock,
  enableMock, markPrivateMock, toastError, toastSuccess,
} = vi.hoisted(() => ({
  createFormMock: vi.fn(),
  deleteFormMock: vi.fn(),
  addFieldsMock: vi.fn(),
  setActiveFormMock: vi.fn(),
  navigateMock: vi.fn(),
  enableMock: vi.fn(),
  markPrivateMock: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('../stores/formStore', () => {
  const state = {
    createForm: createFormMock,
    deleteForm: deleteFormMock,
    addFields: addFieldsMock,
    setActiveForm: setActiveFormMock,
    getForm: () => undefined,
  };
  return {
    useFormStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state, setState: () => undefined },
    ),
  };
});

vi.mock('../stores/vaultStore', () => ({
  useVaultStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'unlocked' }),
}));

vi.mock('../stores/toastStore', () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn(), info: vi.fn() },
}));

// The picker is reduced to a button that selects "blank + private".
vi.mock('../components/builder', () => ({
  TemplateSelector: ({ onSelectTemplate }: { onSelectTemplate: (t: null, makePrivate: boolean) => void }) => (
    <button data-testid="pick-private" onClick={() => onSelectTemplate(null, true)} />
  ),
}));

vi.mock('../lib/crypto/formCrypto', () => ({
  enableFormEncryption: (...args: unknown[]) => enableMock(...args),
  markFormPrivate: (...args: unknown[]) => markPrivateMock(...args),
}));

import { useCreateFormFlow } from './useCreateFormFlow';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const { newFormPicker } = useCreateFormFlow();
  return <>{newFormPicker}</>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useCreateFormFlow private fail-closed', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    createFormMock.mockResolvedValue({ id: 'f-new', title: 'Untitled Form', fields: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('enable failure REMOVES the created form — no silent plaintext fallback', async () => {
    enableMock.mockRejectedValue(Object.assign(new Error('encryption setup already running'), { code: 'encryption_enabling' }));
    container.querySelector<HTMLButtonElement>('[data-testid="pick-private"]')!.click();
    await flush();

    expect(deleteFormMock).toHaveBeenCalledWith('f-new');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'Could not make it private',
      expect.stringContaining('removed rather than left unencrypted'),
    );
  });

  it('successful enable keeps the form and navigates to the builder', async () => {
    enableMock.mockResolvedValue(undefined);
    container.querySelector<HTMLButtonElement>('[data-testid="pick-private"]')!.click();
    await flush();

    expect(deleteFormMock).not.toHaveBeenCalled();
    expect(markPrivateMock).toHaveBeenCalledWith('f-new');
    expect(setActiveFormMock).toHaveBeenCalledWith('f-new');
    expect(navigateMock).toHaveBeenCalledWith('/builder/f-new');
  });
});
