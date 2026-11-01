// @vitest-environment jsdom
// A version is taken before each save, so the top row is not the form as it stands: it is what a
// mistake is undone from, and after a restore it is what undoes the restore.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getFormVersions: vi.fn(), restoreFormVersion: vi.fn(), toastError: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getFormVersions: h.getFormVersions, restoreFormVersion: h.restoreFormVersion } }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: h.toastError, info: vi.fn(), warning: vi.fn() } }));

import { FormVersionHistory } from './FormVersionHistory';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const row = (version: number, changelog: string | null = null) =>
  ({ id: `v${version}`, version, changelog, createdAt: '2026-10-01 10:00:00' });
/** Versions `from` down to `to`, newest first. */
const rows = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => row(from - i));

let root: Root | null = null;
let host: HTMLElement | null = null;
let onRestored: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.getFormVersions.mockReset();
  h.restoreFormVersion.mockReset();
  h.toastError.mockReset();
  onRestored = vi.fn();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<FormVersionHistory isOpen onClose={() => {}} formId="f1" onRestored={onRestored as never} />);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const buttons = (name: string) => Array.from(document.body.querySelectorAll('button')).filter((b) => b.textContent?.trim() === name);
const text = () => document.body.textContent ?? '';

describe('the version list', () => {
  it('offers Restore on every row, the top one too, and does not call it the latest', async () => {
    h.getFormVersions.mockResolvedValue({ data: { versions: [row(3, 'Auto-snapshot before restoring to v1'), row(2), row(1)] } });
    await render();

    expect(buttons('Restore')).toHaveLength(3);
    expect(text()).not.toMatch(/latest/i);
  });

  it('restores the top row, which is what undoes a restore', async () => {
    h.getFormVersions.mockResolvedValue({ data: { versions: [row(3, 'Auto-snapshot before restoring to v1'), row(2)] } });
    h.restoreFormVersion.mockResolvedValue({ data: { form: {} } });
    await render();

    await act(async () => buttons('Restore')[0].click());
    const confirm = Array.from(document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)!;
    await act(async () => Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Restore')!.click());

    expect(h.restoreFormVersion).toHaveBeenCalledWith('f1', 3, true);
    expect(onRestored).toHaveBeenCalled();
  });
});

describe('versions older than the newest page', () => {
  it('reaches them a page at a time, past the newest 50', async () => {
    h.getFormVersions.mockImplementation(async (_id: string, page: { limit: number; offset: number }) => {
      const all = rows(120, 1);
      return { data: { versions: all.slice(page.offset, page.offset + page.limit) } };
    });
    await render();
    expect(text()).toContain('Version 71');
    expect(text()).not.toContain('Version 70');

    await act(async () => buttons('Show older versions')[0].click());
    expect(h.getFormVersions).toHaveBeenLastCalledWith('f1', { limit: 50, offset: 50 });
    expect(text()).toContain('Version 21');

    await act(async () => buttons('Show older versions')[0].click());
    expect(text()).toContain('Version 1');
    expect(buttons('Show older versions')).toHaveLength(0);
  });

  it('offers none when the list ends inside a page', async () => {
    h.getFormVersions.mockResolvedValue({ data: { versions: rows(3, 1) } });
    await render();
    expect(buttons('Show older versions')).toHaveLength(0);
  });

  it('does not repeat a row when a save moved the list on between pages', async () => {
    h.getFormVersions
      .mockResolvedValueOnce({ data: { versions: rows(60, 11) } })
      .mockResolvedValueOnce({ data: { versions: rows(11, 1) } });
    await render();
    await act(async () => buttons('Show older versions')[0].click());

    expect(buttons('Restore')).toHaveLength(60);
  });

  it('keeps what is shown when an older page fails', async () => {
    h.getFormVersions
      .mockResolvedValueOnce({ data: { versions: rows(60, 11) } })
      .mockResolvedValueOnce({ error: 'Server unavailable', status: 503 });
    await render();
    await act(async () => buttons('Show older versions')[0].click());

    expect(buttons('Restore')).toHaveLength(50);
    expect(h.toastError).toHaveBeenCalledWith('Failed to load history', 'Server unavailable');
  });
});

describe('a failed read', () => {
  it('says so, rather than that there is no history, and can be tried again', async () => {
    h.getFormVersions.mockResolvedValueOnce({ error: 'Server unavailable', status: 503 });
    await render();

    expect(text()).toContain('Could not load version history');
    expect(text()).toContain('Server unavailable');
    expect(text()).not.toContain('No version history yet');

    h.getFormVersions.mockResolvedValueOnce({ data: { versions: [row(1)] } });
    await act(async () => buttons('Try again')[0].click());
    expect(text()).toContain('Version 1');
  });

  it('says so for one that threw', async () => {
    h.getFormVersions.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(text()).toContain('Could not load version history');
  });
});
