// What the screen compiler holds of esm.sh while it bundles a custom screen's npm imports.
//
// - A module is read as a stream and dropped at the size cap. The cap used to be checked after
//   the whole body had been buffered, so an answer of any size (or one that never ended) was held
//   in memory first.
// - Fetched modules are cached for later builds, and the cache is bounded by count and by bytes,
//   letting go of the least recently used. It used to keep every module ever fetched for as long
//   as the page stayed open.
//
// Node environment and the native esbuild, as in screenCompile.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as esbuildNative from 'esbuild';
import {
  __esmCacheStatsForTests,
  __setEsbuildForTests,
  __setEsmCacheLimitsForTests,
  __setEsmFetchForTests,
  bundleScreenFiles,
  type EsbuildLike,
  type EsmFetch,
} from './screenCompile';

vi.setConfig({ testTimeout: 30000 });

beforeAll(() => __setEsbuildForTests(esbuildNative as unknown as EsbuildLike));
afterAll(() => { __setEsbuildForTests(null); __setEsmFetchForTests(null); });
afterEach(() => { __setEsmCacheLimitsForTests(null); __setEsmFetchForTests(null); });

const MB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A body that never ends, counting what was read from it and whether it was cancelled. */
function endlessBody() {
  const seen = { bytes: 0, cancelled: false };
  const chunk = new TextEncoder().encode('/' + '*'.repeat(CHUNK - 1));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

/** An esm.sh fake answering each url with `source(url)`, counting fetches per url. */
function countingEsm(source: (url: string) => string) {
  const fetched: string[] = [];
  const fetch: EsmFetch = (url) => {
    fetched.push(url);
    return Promise.resolve({ ok: true, status: 200, url, text: () => Promise.resolve(source(url)) });
  };
  return { fetch, fetched };
}

const importing = (name: string) => bundleScreenFiles([{ path: 'index.ts', content: `import x from '${name}'; console.log(x);` }]);

describe('reading a module from esm.sh', () => {
  it('stops at the size cap instead of buffering the whole answer first', async () => {
    const { body, seen } = endlessBody();
    let textCalls = 0;
    __setEsmFetchForTests(() => Promise.resolve({
      ok: true,
      status: 200,
      url: 'https://esm.sh/huge-lib@1.0.0',
      body,
      text: () => { textCalls += 1; return new Promise<string>(() => {}); },
    }));
    const r = await importing('huge-lib@1.0.0');
    expect(r.js).toBe('');
    expect(r.error).toContain('4MB');
    expect(r.error).not.toContain('needs internet');
    expect(textCalls).toBe(0);
    expect(seen.bytes).toBeLessThanOrEqual(4 * MB + 2 * CHUNK);
    expect(seen.cancelled).toBe(true);
  }, 10000);

  it('still bundles a module that streams in under the cap', async () => {
    const source = new TextEncoder().encode(`export default 'streamed';`);
    __setEsmFetchForTests(() => Promise.resolve({
      ok: true,
      status: 200,
      url: 'https://esm.sh/small-lib@1.0.0',
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(source.slice(0, 10)); c.enqueue(source.slice(10)); c.close(); } }),
      text: () => Promise.reject(new Error('the body is read as a stream')),
    }));
    const r = await importing('small-lib@1.0.0');
    expect(r.error).toBeUndefined();
    expect(r.js).toContain('streamed');
  });
});

describe('the module cache', () => {
  it('lets go of the least recently used module once it holds the most modules it may', async () => {
    __setEsmCacheLimitsForTests({ modules: 2, bytes: 1024 * MB });
    const esm = countingEsm((url) => `export default ${JSON.stringify(url)};`);
    __setEsmFetchForTests(esm.fetch);
    for (const name of ['a-lib@1.0.0', 'b-lib@1.0.0', 'a-lib@1.0.0', 'c-lib@1.0.0', 'a-lib@1.0.0', 'b-lib@1.0.0']) {
      expect((await importing(name)).error).toBeUndefined();
    }
    // a was used again before c came in, so b was the one let go; a is still cached.
    expect(esm.fetched).toEqual(['https://esm.sh/a-lib@1.0.0', 'https://esm.sh/b-lib@1.0.0', 'https://esm.sh/c-lib@1.0.0', 'https://esm.sh/b-lib@1.0.0']);
    expect(__esmCacheStatsForTests().modules).toBeLessThanOrEqual(2);
  });

  it('lets go of modules once their bytes pass its byte limit', async () => {
    __setEsmCacheLimitsForTests({ modules: 100, bytes: 100 });
    const esm = countingEsm(() => `export default '${'x'.repeat(40)}';`);
    __setEsmFetchForTests(esm.fetch);
    await importing('a-lib@1.0.0');
    await importing('b-lib@1.0.0');
    expect(__esmCacheStatsForTests().bytes).toBeLessThanOrEqual(100);
    await importing('c-lib@1.0.0');
    expect(__esmCacheStatsForTests().bytes).toBeLessThanOrEqual(100);
    await importing('a-lib@1.0.0');
    expect(esm.fetched.filter((u) => u.endsWith('a-lib@1.0.0'))).toHaveLength(2);
  });

  it('is bounded by default', () => {
    __setEsmCacheLimitsForTests(null);
    const { limits } = __esmCacheStatsForTests();
    expect(limits.modules).toBeGreaterThan(0);
    expect(limits.bytes).toBeLessThanOrEqual(64 * MB);
  });
});
