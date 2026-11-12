import { describe, expect, it } from 'vitest';
import { pagePlace } from './pagePlace';

describe('pagePlace', () => {
  it('holds a SoftN app\'s sections and open table to the one page', () => {
    const page = '/apps/app-1/softn';
    for (const address of [page, `${page}/data`, `${page}/data/bookings`, `${page}/data/bookings/structure`, `${page}/edit`, `${page}/settings`]) {
      expect(pagePlace(address)).toBe(page);
    }
  });

  it('keeps two apps apart', () => {
    expect(pagePlace('/apps/app-1/softn/data')).not.toBe(pagePlace('/apps/app-2/softn/data'));
  });

  it('leaves every other address as its own page', () => {
    for (const address of ['/', '/apps', '/apps/app-1', '/apps/app-1/settings', '/apps/app-1/studio/page-2', '/forms/f1/edit', '/apps/app-1/softnx/data']) {
      expect(pagePlace(address)).toBe(address);
    }
  });
});
