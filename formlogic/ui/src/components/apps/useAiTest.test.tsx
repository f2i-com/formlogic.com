// @vitest-environment jsdom
/**
 * A computer's models asked of it (useModelList): the listing is let go when nobody wants its answer any more: another
 * key, the page leaving the component, and the page closing or reloading, which ends no effect by itself.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useModelList } from './useAiTest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let signals: AbortSignal[] = [];
const never = (signal: AbortSignal) => { signals.push(signal); return new Promise<never>(() => {}); };

function Listing({ listKey }: { listKey: string | null }) {
  const { listing } = useModelList(listKey, never);
  return <p>{listing ? 'listing' : 'idle'}</p>;
}

beforeEach(() => {
  signals = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('a listing of a computer\'s models', () => {
  it('is let go when the page closes, which ends no effect by itself', async () => {
    await act(async () => root.render(<Listing listKey="pc:engine" />));
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(signals[0].aborted).toBe(true);
  });

  it('is let go when another is asked for, and when the component goes', async () => {
    await act(async () => root.render(<Listing listKey="pc:engine" />));
    await act(async () => root.render(<Listing listKey="pc:other" />));
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    await act(async () => root.render(<Listing listKey={null} />));
    expect(signals[1].aborted).toBe(true);
    // A page closing later lets nothing go twice, and asks nothing.
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(signals).toHaveLength(2);
  });
});
