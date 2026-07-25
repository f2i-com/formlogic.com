// @vitest-environment jsdom
// MKT-601: the three behaviours that are easy to lose when the catalog is browsed from two
// places, and that the Packs popup had in fact already lost — one fetch, stale-response
// cancellation, and a failure that is a state with an action rather than an empty grid.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePackBrowse } from './usePackBrowse';
import { api } from '../lib/api';

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

/**
 * Render the hook and read its result from the DOM.
 *
 * Writing the result to an outer variable during render is what react-hooks/immutability exists
 * to stop, and the rule is right — so the probe renders what it sees and the assertions read it
 * back, which is also how the other jsdom suites here work.
 */
function mount(props: { search?: string; enabled?: boolean } = {}) {
  function Probe({ search, enabled }: { search?: string; enabled?: boolean }) {
    const browse = usePackBrowse({ search, enabled, debounceMs: 0 });
    return (
      <div>
        <span data-testid="ids">{browse.packs.map((p) => p.id).join(',')}</span>
        <span data-testid="pages">{String(browse.totalPages)}</span>
        <span data-testid="loading">{String(browse.loading)}</span>
        <span data-testid="error">{browse.error ?? ''}</span>
        <button type="button" onClick={browse.retry}>retry</button>
      </div>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe {...props} />));
  const read = (id: string) => host!.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
  return {
    ids: () => read('ids'),
    pages: () => read('pages'),
    loading: () => read('loading'),
    error: () => read('error'),
    retry: () => act(() => (host!.querySelector('button') as HTMLButtonElement).click()),
    rerender: (next: { search?: string; enabled?: boolean }) => act(() => root!.render(<Probe {...next} />)),
  };
}

/** Let queued promise callbacks run. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('usePackBrowse', () => {
  it('fetches once and exposes the packs', async () => {
    const spy = vi.spyOn(api, 'browsePacks').mockResolvedValue({
      data: { packs: [{ id: 'p1', name: 'Pack one' }], totalPages: 3 },
    } as Awaited<ReturnType<typeof api.browsePacks>>);

    const probe = mount();
    await flush();

    expect(probe.ids()).toBe('p1');
    expect(probe.pages()).toBe('3');
    expect(probe.error()).toBe('');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never renders a failed load as an empty catalog', async () => {
    // An empty catalog and a failed request look identical to a user, and only one of them is
    // worth waiting for — so a failure has to be a state with an action.
    vi.spyOn(api, 'browsePacks').mockRejectedValue(new Error('offline'));

    const probe = mount();
    await flush();

    expect(probe.error()).toContain('Could not load');
    expect(probe.loading()).toBe('false');
    expect(probe.ids()).toBe('');
  });

  it('surfaces an API error payload rather than swallowing it', async () => {
    vi.spyOn(api, 'browsePacks').mockResolvedValue({
      error: 'Catalog unavailable',
    } as Awaited<ReturnType<typeof api.browsePacks>>);

    const probe = mount();
    await flush();

    expect(probe.error()).toBe('Catalog unavailable');
  });

  it('retry re-runs the current query', async () => {
    const spy = vi
      .spyOn(api, 'browsePacks')
      .mockResolvedValueOnce({ error: 'Catalog unavailable' } as Awaited<ReturnType<typeof api.browsePacks>>)
      .mockResolvedValueOnce({
        data: { packs: [{ id: 'p1', name: 'Pack one' }], totalPages: 1 },
      } as Awaited<ReturnType<typeof api.browsePacks>>);

    const probe = mount();
    await flush();
    expect(probe.error()).toBe('Catalog unavailable');

    probe.retry();
    await flush();

    expect(probe.ids()).toBe('p1');
    expect(probe.error()).toBe('');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a slow earlier query cannot overwrite a newer one', async () => {
    // Without stale-response cancellation the list silently shows results for a search the user
    // has already moved on from.
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    vi.spyOn(api, 'browsePacks')
      .mockImplementationOnce(() => first as ReturnType<typeof api.browsePacks>)
      .mockResolvedValueOnce({
        data: { packs: [{ id: 'new', name: 'Newer result' }], totalPages: 1 },
      } as Awaited<ReturnType<typeof api.browsePacks>>);

    const probe = mount({ search: 'old' });
    probe.rerender({ search: 'new' });
    await flush();

    expect(probe.ids()).toBe('new');

    // The stale response lands late and must be ignored.
    await act(async () => {
      resolveFirst({ data: { packs: [{ id: 'stale', name: 'Stale result' }], totalPages: 1 } });
      await Promise.resolve();
    });
    expect(probe.ids()).toBe('new');
  });

  it('fetches nothing while disabled', async () => {
    const spy = vi.spyOn(api, 'browsePacks');
    const probe = mount({ enabled: false });
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(probe.loading()).toBe('false');
  });
});
