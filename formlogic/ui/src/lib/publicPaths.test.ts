import { describe, expect, it } from 'vitest';
import { isPublicPath } from './publicPaths';

// A session that ends while someone is on one of these leaves them there: the logged-out route
// table has the page, and sending them home would break a sign-in or a device check midway.
describe('isPublicPath', () => {
  it.each([
    '/',
    '/form/f1',
    '/app/cafe/form/f1',
    '/oauth/authorize',
    '/sign-in/domain',
    '/device-check',
    '/open/app/cafe',
    '/open/app/cafe/form/f1',
  ])('%s has a page when signed out', (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each(['/forms', '/settings', '/apps/a1/studio', '/admin'])('%s does not', (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });
});
