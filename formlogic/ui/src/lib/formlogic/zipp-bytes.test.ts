import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWasmByteBroker, engineIdentity, engineNeedsBytes, getEngineBytes, ZIPP_RUNTIME_IDENTITY } from './zipp-bytes';
import { OWN_DOCUMENT_ENGINE } from './frameEngine';

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

  it('names what this page holds for each engine it can boot, and nothing else', () => {
    // The parent's half of the handshake: an id that is not in this table can never be chosen,
    // so the frame can never ask a shell for an engine these bytes are not. Host JavaScript is in
    // the table described by OWN_DOCUMENT_ENGINE rather than an identity — it is the runtime
    // document's own engine, so there are no bytes to name.
    expect(engineIdentity('zipp-web-python')).toEqual({ version: ZIPP_RUNTIME_IDENTITY.version, sha256: ZIPP_RUNTIME_IDENTITY.sha256 });
    expect(engineIdentity('host-js')).toBe(OWN_DOCUMENT_ENGINE);
    expect(engineIdentity('zipp-web')).toBeUndefined();
    expect(engineIdentity('constructor')).toBeUndefined();
  });

  it('asks for bytes only for the engine that needs them', () => {
    expect(engineNeedsBytes('zipp-web-python')).toBe(true);
    expect(engineNeedsBytes('host-js')).toBe(false);
    // An engine this page cannot boot is never chosen, so it is never asked about; if it were,
    // "needs bytes" is the answer that leads to a refusal rather than to a silent boot.
    expect(engineNeedsBytes('zipp-web')).toBe(true);
  });

  it('serves bytes for the ZIPP engine alone, host JavaScript included in the refusal', async () => {
    // Defence in depth behind engineNeedsBytes: handing host-js ZIPP's bytes would be giving it
    // the wrong engine rather than none, so it is refused by the same rule as an unknown id.
    await expect(getEngineBytes('host-js')).rejects.toThrow('does not have the engine');
    await expect(getEngineBytes('zipp-web')).rejects.toThrow('does not have the engine');
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
