// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useAdminQuery } from './useAdminQuery';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
type Result = { data?: { name: string }; error?: string };
function deferred() { let resolve!: (result: Result) => void; const promise = new Promise<Result>(r => { resolve = r; }); return { promise, resolve }; }
function Probe({ fetcher }: { fetcher: () => Promise<Result> }) {
  const { data, loading, error, refresh } = useAdminQuery(fetcher);
  return <><span>{data?.name}</span>{loading && <p>Loading</p>}{error && <p role="alert">{error}</p>}<button onClick={refresh}>Refresh</button></>;
}
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('ignores an older search that resolves after the latest search', async () => {
  const old = deferred(); const latest = deferred();
  const fetchOld = () => old.promise; const fetchLatest = () => latest.promise;
  await act(async () => root.render(<Probe fetcher={fetchOld} />));
  await act(async () => root.render(<Probe fetcher={fetchLatest} />));
  await act(async () => latest.resolve({ data: { name: 'Latest user' } }));
  await act(async () => old.resolve({ data: { name: 'Old user' } }));
  expect(container.textContent).toContain('Latest user');
  expect(container.textContent).not.toContain('Old user');
});
it('hides previously loaded account data while a different account loads', async () => {
  const first = vi.fn().mockResolvedValue({ data: { name: 'Previous account' } });
  const next = deferred(); const fetchNext = () => next.promise;
  await act(async () => root.render(<Probe fetcher={first} />));
  await act(async () => root.render(<Probe fetcher={fetchNext} />));
  expect(container.textContent).not.toContain('Previous account');
  await act(async () => next.resolve({ error: 'Account unavailable' }));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Account unavailable');
});
it('keeps last loaded data with an explicit refresh error and recovers on retry', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ data: { name: 'Overview' } }).mockResolvedValueOnce({ error: 'Server unavailable' }).mockResolvedValueOnce({ data: { name: 'Fresh overview' } });
  await act(async () => root.render(<Probe fetcher={fetcher} />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Overview');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Server unavailable');
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Fresh overview');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('turns a rejected request into a retryable error', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { name: 'Recovered' } });
  await act(async () => root.render(<Probe fetcher={fetcher} />));
  expect(container.textContent).not.toContain('Loading');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Recovered');
});
