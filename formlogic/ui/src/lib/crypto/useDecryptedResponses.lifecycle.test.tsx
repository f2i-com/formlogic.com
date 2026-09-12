// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDecryptedResponses, type DecryptableRow, type DecryptedResponsesResult } from './useDecryptedResponses';
import type { OpenRowsResult } from './formCrypto';

const mocks = vi.hoisted(() => ({
  vault: { status: 'unlocked', generation: 1 },
  open: vi.fn<(...args: unknown[]) => Promise<OpenRowsResult>>(),
  privacy: vi.fn<(...args: unknown[]) => Promise<'private' | 'plain' | 'unknown'>>(),
}));
vi.mock('../../stores/vaultStore', () => ({ useVaultStore: (select: (state: typeof mocks.vault) => unknown) => select(mocks.vault) }));
vi.mock('./formCrypto', () => ({
  ensureVaultLoaded: async () => undefined,
  getFormPrivacyState: mocks.privacy,
  openResponsesForForm: mocks.open,
  vaultGeneration: () => mocks.vault.generation,
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let seen: DecryptedResponsesResult<DecryptableRow>[];
const encrypted = [{ id: 'row', answers: { __flenc: 1, ct: 'synthetic' } }];
const opened = (name: string): OpenRowsResult => new Map([['row', { answers: { name }, rev: 1 }]]);
function Responses({ form = 'first', rows = encrypted }: { form?: string; rows?: DecryptableRow[] }) {
  const result = useDecryptedResponses(form, rows);
  seen.push(result);
  return <output>{JSON.stringify(result)}</output>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.vault = { status: 'unlocked', generation: 1 };
  mocks.privacy.mockResolvedValue('private');
  mocks.open.mockResolvedValue(opened('synthetic-secret'));
  container = document.createElement('div');
  root = createRoot(container);
  seen = [];
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

it('hides plaintext on the first locked render even before a generation bump', async () => {
  await act(async () => root.render(<Responses />));
  expect(container.textContent).toContain('synthetic-secret');
  seen = [];
  mocks.vault.status = 'locked';
  await act(async () => root.render(<Responses />));
  expect(seen.every((result) => result.locked && !JSON.stringify(result).includes('synthetic-secret'))).toBe(true);
});

it('never reuses decrypted answers for changed ciphertext with the same row id', async () => {
  await act(async () => root.render(<Responses />));
  let finish!: (value: OpenRowsResult) => void;
  mocks.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  seen = [];
  const next = [{ id: 'row', answers: { __flenc: 1, ct: 'revised' } }];
  await act(async () => root.render(<Responses rows={next} />));
  expect(seen.every((result) => !JSON.stringify(result).includes('synthetic-secret'))).toBe(true);
  await act(async () => { finish(opened('revised-answer')); });
  expect(container.textContent).toContain('revised-answer');
});

it('ignores decryption that finishes after locking and switching forms', async () => {
  let finish!: (value: OpenRowsResult) => void;
  mocks.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Responses />));
  mocks.vault = { status: 'locked', generation: 2 };
  await act(async () => root.render(<Responses form="second" />));
  await act(async () => { finish(opened('late-secret')); });
  expect(container.textContent).not.toContain('late-secret');
  expect(seen.at(-1)?.locked).toBe(true);
});

it('redacts failed batches and marks every private record as an error instead of enabling edits', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.open.mockRejectedValue(new Error('Worker unavailable'));
  const rows = [...encrypted, { id: 'malformed', answers: { name: 'must-not-display' } }];
  await act(async () => root.render(<Responses rows={rows} />));
  const result = seen.at(-1)!;
  expect(result.decrypting).toBe(false);
  expect(result.errors).toEqual({ row: 'decrypt_failed', malformed: 'plaintext_in_private_form' });
  expect(result.rows.every((row) => row._decryptError && Object.keys(row.answers).length === 0)).toBe(true);
  expect(container.textContent).not.toContain('must-not-display');
});

it('treats a missing worker result as a record error', async () => {
  mocks.open.mockResolvedValue(new Map());
  await act(async () => root.render(<Responses />));
  expect(seen.at(-1)?.errors).toEqual({ row: 'decrypt_failed' });
  expect(seen.at(-1)?.rows[0].answers).toEqual({});
});
