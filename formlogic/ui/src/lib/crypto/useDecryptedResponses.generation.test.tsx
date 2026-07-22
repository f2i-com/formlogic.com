// @vitest-environment jsdom
// Plaintext boundary (review 2026-07-22, blocker 3): a vault generation change
// must close any open editor and wipe its decrypted draft state immediately.
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  api: {
    isAuthenticated: () => false,
    getVault: vi.fn(async () => ({ data: { vault: null } })),
    createVault: vi.fn(),
    changeVaultPassphrase: vi.fn(),
  },
  newIdempotencyKey: () => 'idem-test',
}));

// The hook under test imports formCrypto for the decrypt pipeline; the api/auth
// chain behind it is irrelevant here (and heavy), so stub the pipeline surface.
vi.mock('./formCrypto', () => ({
  ensureVaultLoaded: async () => undefined,
  getFormPrivacyState: async () => 'plain',
  openResponsesForForm: async () => new Map(),
  vaultGeneration: () => 0,
}));

import { useResetOnVaultGenerationChange } from './useDecryptedResponses';
import { useVaultStore } from '../../stores/vaultStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Stand-in for the responses edit modal: open, holding a decrypted draft. */
function DecryptedEditor() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<Record<string, unknown>>({ f1: 'canary-plaintext-draft' });
  useResetOnVaultGenerationChange(() => {
    setOpen(false);
    setDraft({});
  });
  return <div data-testid="editor">{open ? `open:${JSON.stringify(draft)}` : 'closed'}</div>;
}

describe('useResetOnVaultGenerationChange', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useVaultStore.setState({ generation: 0 });
  });

  function mount(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<DecryptedEditor />));
  }

  it('does not fire on the initial render', () => {
    useVaultStore.setState({ generation: 7 });
    mount();
    expect(container.textContent).toContain('open');
    expect(container.textContent).toContain('canary-plaintext-draft');
  });

  it('a generation bump closes the editor and wipes the decrypted draft', () => {
    useVaultStore.setState({ generation: 7 });
    mount();
    expect(container.textContent).toContain('canary-plaintext-draft');

    act(() => { useVaultStore.setState({ generation: 8 }); });

    expect(container.textContent).toContain('closed');
    expect(container.textContent).not.toContain('canary-plaintext-draft');
  });
});
