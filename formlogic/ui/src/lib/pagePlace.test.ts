import { describe, expect, it } from 'vitest';
import { pagePlace } from './pagePlace';

describe('pagePlace', () => {
  it('holds a SoftN app\'s sections and open table to the one page', () => {
    const page = '/apps/app-1/web';
    for (const address of [page, `${page}/data`, `${page}/data/bookings`, `${page}/data/bookings/structure`, `${page}/edit`, `${page}/settings`]) {
      expect(pagePlace(address)).toBe(page);
    }
  });

  it('holds an app\'s Studio steps and management sections to one place without remounting the shell', () => {
    const place = '/apps/app-1/manage';
    for (const address of [
      '/apps/app-1/studio',
      '/apps/app-1/studio/data',
      '/apps/app-1/studio/flows',
      '/apps/app-1/studio/publish',
      '/apps/app-1/settings',
      '/apps/app-1/records',
      '/apps/app-1/forms',
      '/apps/app-1/users',
      '/apps/app-1/roles',
      '/apps/app-1/relations',
      '/apps/app-1/deploy',
    ]) {
      expect(pagePlace(address)).toBe(place);
    }
    expect(pagePlace('/apps/app-1/settings')).not.toBe(pagePlace('/apps/app-2/settings'));
  });

  it('holds a live Form App\'s internal menu routes to one place so navigation loads section data via AJAX', () => {
    const place = '/app/agrilog-123';
    for (const address of [
      place,
      `${place}/`,
      `${place}/form/form-1`,
      `${place}/form/form-1/responses`,
      `${place}/form/form-1/responses/42`,
      `${place}/records`,
      `${place}/reports`,
      `${place}/profile`,
      `${place}/aokie`,
    ]) {
      expect(pagePlace(address)).toBe(place);
    }
    expect(pagePlace('/app/agrilog-123/records')).not.toBe(pagePlace('/app/repairbench-456/records'));
    // Standalone /native and /project routes stay separate pages
    expect(pagePlace('/app/agrilog-123/native')).toBe('/app/agrilog-123/native');
    expect(pagePlace('/app/agrilog-123/project')).toBe('/app/agrilog-123/project');
  });

  it('keeps two apps apart', () => {
    expect(pagePlace('/apps/app-1/web/data')).not.toBe(pagePlace('/apps/app-2/web/data'));
  });

  it('leaves every other address as its own page', () => {
    for (const address of ['/', '/apps', '/apps/new', '/apps/app-1', '/forms/f1/edit', '/apps/app-1/softnx/data']) {
      expect(pagePlace(address)).toBe(address);
    }
  });
});
