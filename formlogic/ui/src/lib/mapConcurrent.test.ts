import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './mapConcurrent';

describe('bounded dashboard reads', () => {
  it('limits concurrent requests and keeps results in form order', async () => {
    let active = 0, peak = 0;
    const result = await mapConcurrent([5, 4, 3, 2, 1], async (value) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 2;
    }, () => false, 2);
    expect(peak).toBe(2);
    expect(result).toEqual([10, 8, 6, 4, 2]);
  });

  it('starts no further requests after navigation cancels the view', async () => {
    let cancelled = false;
    const called: number[] = [];
    await mapConcurrent([1, 2, 3], async (value) => {
      called.push(value);
      cancelled = true;
      return value;
    }, () => cancelled, 1);
    expect(called).toEqual([1]);
  });
});
