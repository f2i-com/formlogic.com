import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWasmByteBroker, matchesZippRuntime, ZIPP_RUNTIME_IDENTITY } from './zipp-bytes';

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const response = () => new Response(bytes);
afterEach(() => vi.unstubAllGlobals());

describe('page engine byte broker', () => {
  it('is lazy and shares one download across concurrent and later consumers', async () => {
    let finish!: (value: Response) => void;
    const load = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const get = createWasmByteBroker(sha256, load);
    expect(load).not.toHaveBeenCalled();
    const worker = get();
    const frame = get();
    expect(frame).toBe(worker);
    finish(response());
    const saved = await worker;
    expect(await frame).toBe(saved);
    expect(await get()).toBe(saved);
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(saved)).toEqual(bytes);
  });

  it('retries after a failed download instead of poisoning later app loads', async () => {
    const load = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status: 503 })).mockImplementation(response);
    const get = createWasmByteBroker(sha256, load);
    await expect(get()).rejects.toThrow('503');
    expect(new Uint8Array(await get())).toEqual(bytes);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched bytes and can recover with the correct artifact', async () => {
    const load = vi.fn().mockResolvedValueOnce(new Response('<html>stale SPA fallback</html>')).mockImplementation(response);
    const get = createWasmByteBroker(sha256, load);
    await expect(get()).rejects.toThrow('does not match');
    expect(new Uint8Array(await get())).toEqual(bytes);
  });

  it('requires both the version and hash from the hosted shell', () => {
    expect(matchesZippRuntime(ZIPP_RUNTIME_IDENTITY)).toBe(true);
    expect(matchesZippRuntime({ version: ZIPP_RUNTIME_IDENTITY.version, sha256: 'old' })).toBe(false);
    expect(matchesZippRuntime({ ...ZIPP_RUNTIME_IDENTITY, version: '0.0.1' })).toBe(false);
    expect(matchesZippRuntime(undefined)).toBe(false);
  });

  it('verifies bytes on an HTTP LAN context without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const load = vi.fn().mockImplementation(response);
    const get = createWasmByteBroker(sha256, load);
    const [worker, frame] = await Promise.all([get(), get()]);
    expect(new Uint8Array(worker)).toEqual(bytes);
    expect(frame).toBe(worker);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps integrity verification and retries on the HTTP LAN fallback', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const changed = new Uint8Array(bytes);
    changed[7] = 1;
    const load = vi.fn().mockResolvedValueOnce(new Response(changed)).mockImplementation(response);
    const get = createWasmByteBroker(sha256, load);
    await expect(get()).rejects.toThrow('does not match');
    expect(new Uint8Array(await get())).toEqual(bytes);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
