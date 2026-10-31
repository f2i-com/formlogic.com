// @vitest-environment jsdom
/**
 * A value in an API path stays one segment. Ids reach these calls from code that isn't ours: a
 * flow, a custom screen, app logic, a form id or slug someone stored. Every call carries the
 * viewer's session, and the browser collapses `..` before the server sees the path, so nothing on
 * the server can catch it. URLs are read here as a browser reads them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const hostile = [
  '../../../forms/victim',
  '..\\..\\..\\forms\\victim',
  '%2e%2e/%2e%2e/forms/victim',
  '.%2e/.%2e/forms/victim',
  'x/../../other-app',
  'x\\..\\other-app',
  'vic\ttim',
  'vic\ntim',
  'stops-here?',
  'stops-here#',
  'stops-here?x=1',
];

// Each with the id in a different place: where one is, the whole path has to stay put.
const calls: [string, (id: string) => Promise<unknown>][] = [
  ['getAppRuntime', id => api.getAppRuntime(id)],
  ['getAppForm', id => api.getAppForm('shop', id)],
  ['getAppResponses', id => api.getAppResponses('shop', id)],
  ['getAppResponses slug', id => api.getAppResponses(id, 'form')],
  ['getAppResponseById', id => api.getAppResponseById('shop', 'form', id)],
  ['createAppResponse', id => api.createAppResponse('shop', id, {})],
  ['updateAppResponse', id => api.updateAppResponse('shop', 'form', id, {})],
  ['updateAppResponse form', id => api.updateAppResponse('shop', id, 'row', {})],
  ['deleteAppResponse', id => api.deleteAppResponse('shop', 'form', id)],
  ['deleteAppResponse form', id => api.deleteAppResponse('shop', id, 'row')],
  ['getResponse', id => api.getResponse('form', id)],
  ['updateResponse', id => api.updateResponse('form', id, {})],
  ['deleteResponse', id => api.deleteResponse('form', id)],
  ['deleteResponse form', id => api.deleteResponse(id, 'row')],
];

const urls: string[] = [];
const reached = () => new URL(urls[urls.length - 1], 'https://formlogic.example');

beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('an id in an API path', () => {
  it.each(calls)('%s stays one segment, whatever it holds', async (_name, call) => {
    await call('safe-id');
    const safe = reached();
    for (const id of hostile) {
      await call(id);
      const url = reached();
      const hit = url.pathname.split('/');
      const expected = safe.pathname.split('/');
      expect(hit.length, id).toBe(expected.length);
      // Everything but the id itself is exactly where it was.
      expect(hit.filter((part, index) => part !== expected[index]).length, id).toBe(1);
      expect(url.search, id).toBe(safe.search);
      expect(url.hash, id).toBe('');
    }
  });

  it.each(calls)('%s refuses a bare dot segment, which no encoding hides', async (_name, call) => {
    for (const id of ['.', '..']) {
      await expect(call(id), id).rejects.toThrow('Invalid id in an API path');
    }
    expect(urls).toEqual([]);
  });

  it('leaves an ordinary id as it was', async () => {
    await api.getAppResponseById('shop', '3f2b8c1e-7a44-4d21-9f0e-1c2d3e4f5a6b', 'demolocal_row-1');
    expect(reached().pathname).toBe('/api/app/shop/forms/3f2b8c1e-7a44-4d21-9f0e-1c2d3e4f5a6b/responses/demolocal_row-1');
  });

  it('keeps a query string a call means to send', async () => {
    await api.getAppResponses('shop', 'form', { limit: 5 });
    expect(reached().pathname).toBe('/api/app/shop/forms/form/responses');
    expect(reached().searchParams.get('limit')).toBe('5');
  });
});

describe('api.ts', () => {
  it('sends no value into a path without making it a segment', () => {
    const source = readFileSync(resolve(__dirname, 'api.ts'), 'utf8');
    // The parts of a path that aren't ids: a base, and query strings built by URLSearchParams.
    const fine = /^(seg\(|encodeURIComponent\(|this\.baseUrl$|query$|qs$|queuedRunsQuery\(|endpoint$)/;
    const unwrapped: string[] = [];
    source.split(/\r?\n/).forEach((line, index) => {
      for (const literal of line.matchAll(/`((?:\$\{this\.baseUrl\})?\/[^`]*)`/g)) {
        const head = literal[1].split('?')[0];
        for (const value of head.matchAll(/\$\{([^{}]+)\}/g)) {
          if (!fine.test(value[1])) unwrapped.push(`api.ts:${index + 1} \${${value[1]}}`);
        }
      }
    });
    expect(unwrapped).toEqual([]);
  });
});
