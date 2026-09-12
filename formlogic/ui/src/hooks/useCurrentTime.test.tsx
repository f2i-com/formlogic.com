// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentTime } from './useCurrentTime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Clock({ interval }: { interval: number }) {
  return <output>{useCurrentTime(interval)}</output>;
}

describe('useCurrentTime', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it('updates the committed clock on its cadence and releases its timer on unmount', async () => {
    await act(async () => root.render(<Clock interval={15_000} />));
    expect(container.textContent).toBe('1000000');
    await act(async () => { vi.advanceTimersByTime(14_999); });
    expect(container.textContent).toBe('1000000');
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(container.textContent).toBe('1015000');
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces the old interval when the requested cadence changes', async () => {
    await act(async () => root.render(<Clock interval={60_000} />));
    await act(async () => root.render(<Clock interval={15_000} />));
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(container.textContent).toBe('1015000');
  });
});
