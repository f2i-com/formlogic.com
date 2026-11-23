import { describe, expect, it } from 'vitest';
import {
  buildAppAddress,
  extractPlatformAppSubpath,
  isFormAppSubroute,
  readAppPlace,
} from './nativeRouteAddress';

describe('nativeRouteAddress', () => {
  describe('custom domain URLs', () => {
    it('reads clean subpages like /about.html and nested paths', () => {
      expect(readAppPlace({ pathname: '/', slug: 'mysite', onDomain: true })).toBeNull();
      expect(readAppPlace({ pathname: '/about.html', slug: 'mysite', onDomain: true })).toBe('/about.html');
      expect(readAppPlace({ pathname: '/docs/guide.html', search: '?tab=2', hash: '#team', slug: 'mysite', onDomain: true }))
        .toBe('/docs/guide.html?tab=2#team');
    });

    it('keeps reading legacy #/about.html hash links on root', () => {
      expect(readAppPlace({ pathname: '/', hash: '#/about.html', slug: 'mysite', onDomain: true }))
        .toBe('/about.html');
    });

    it('strips __flhost preview query param when reading app place', () => {
      expect(readAppPlace({ pathname: '/about.html', search: '?__flhost=mysite.example&page=2', slug: 'mysite', onDomain: true }))
        .toBe('/about.html?page=2');
    });

    it('writes clean paths to the address bar and preserves __flhost', () => {
      expect(buildAppAddress('/about.html', { pathname: '/', slug: 'mysite', onDomain: true }))
        .toBe('/about.html');
      expect(buildAppAddress('/docs/guide.html#team', { pathname: '/about.html', slug: 'mysite', onDomain: true }))
        .toBe('/docs/guide.html#team');
      expect(buildAppAddress('/', { pathname: '/about.html', slug: 'mysite', onDomain: true }))
        .toBe('/');
      expect(buildAppAddress('/about.html', { pathname: '/', search: '?__flhost=mysite.example', slug: 'mysite', onDomain: true }))
        .toBe('/about.html?__flhost=mysite.example');
    });

    it('falls back to hash if a domain app path collides with a reserved route', () => {
      expect(buildAppAddress('/privacy', { pathname: '/', slug: 'mysite', onDomain: true }))
        .toBe('/#/privacy');
      expect(buildAppAddress('/api/items', { pathname: '/', slug: 'mysite', onDomain: true }))
        .toBe('/#/api/items');
    });
  });

  describe('platform /app/:slug URLs', () => {
    it('reads and writes clean pages under /app/:slug', () => {
      expect(readAppPlace({ pathname: '/app/mysite', slug: 'mysite', onDomain: false })).toBeNull();
      expect(readAppPlace({ pathname: '/app/mysite/about.html', slug: 'mysite', onDomain: false }))
        .toBe('/about.html');
      expect(readAppPlace({ pathname: '/app/mysite/docs/guide.html', hash: '#intro', slug: 'mysite', onDomain: false }))
        .toBe('/docs/guide.html#intro');
      expect(buildAppAddress('/about.html', { pathname: '/app/mysite', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite/about.html');
      expect(buildAppAddress('/', { pathname: '/app/mysite/about.html', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite');
    });

    it('reads and writes clean pages under /app/:slug/native', () => {
      expect(readAppPlace({ pathname: '/app/mysite/native', slug: 'mysite', onDomain: false })).toBeNull();
      expect(readAppPlace({ pathname: '/app/mysite/native/about.html', slug: 'mysite', onDomain: false }))
        .toBe('/about.html');
      expect(buildAppAddress('/about.html', { pathname: '/app/mysite/native', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite/native/about.html');
      expect(buildAppAddress('/', { pathname: '/app/mysite/native/about.html', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite/native');
    });

    it('falls back to hash on /app/:slug if an app route collides with a Form App route', () => {
      expect(buildAppAddress('/records', { pathname: '/app/mysite', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite#/records');
      expect(buildAppAddress('/native', { pathname: '/app/mysite', slug: 'mysite', onDomain: false }))
        .toBe('/app/mysite#/native');
    });
  });

  describe('helpers', () => {
    it('distinguishes Form App subroutes from SoftN HTML pages', () => {
      expect(isFormAppSubroute('/records')).toBe(true);
      expect(isFormAppSubroute('/form/123')).toBe(true);
      expect(isFormAppSubroute('/reports')).toBe(true);
      expect(isFormAppSubroute('/native')).toBe(true);
      expect(isFormAppSubroute('/about.html')).toBe(false);
      expect(isFormAppSubroute('/docs/guide.html')).toBe(false);
      expect(isFormAppSubroute('/pricing')).toBe(false);
    });

    it('extracts platform app subpath accurately', () => {
      expect(extractPlatformAppSubpath('/app/demo', 'demo')).toBe('');
      expect(extractPlatformAppSubpath('/app/demo/', 'demo')).toBe('');
      expect(extractPlatformAppSubpath('/app/demo/about.html', 'demo')).toBe('/about.html');
      expect(extractPlatformAppSubpath('/apps/123/web', 'demo')).toBeNull();
    });

    it('rejects traversal, encoded separators, backslashes, and control chars in app places', () => {
      for (const bad of [
        '/../secret',
        '/docs/../secret.html',
        '/%2e%2e/secret',
        '/docs%2fsecret',
        '/docs%5csecret',
        '/docs\\secret',
        '/foo\x00bar',
        '/foo\nbar',
        '//evil.example/x',
      ]) {
        expect(readAppPlace({ pathname: '/', hash: `#${bad}`, slug: 'mysite', onDomain: true })).toBeNull();
        expect(readAppPlace({ pathname: `/app/mysite${bad}`, slug: 'mysite', onDomain: false })).toBeNull();
      }
      expect(buildAppAddress('/../secret', { pathname: '/', slug: 'mysite', onDomain: true })).toBeNull();
      expect(buildAppAddress('/%2e%2e/secret', { pathname: '/app/mysite', slug: 'mysite', onDomain: false })).toBeNull();
    });
  });
});
