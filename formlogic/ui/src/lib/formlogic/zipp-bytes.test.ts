import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import source from '../../../vendor/zipp-wasm/SOURCE.json';
import { createWasmByteBroker, engineIdentity, engineNeedsBytes, getEngineBytes, getZippWebWasmBytes, webVariantIdentity, ZIPP_RUNTIME_IDENTITY, ZIPP_WEB_IDENTITY, type ZippSourceRecord } from './zipp-bytes';
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
    // zipp-web is named exactly when the installed release ships the variant (the test below).
    expect(engineIdentity('zipp-web')).toEqual(ZIPP_WEB_IDENTITY);
    expect(engineIdentity('constructor')).toBeUndefined();
  });

  it('asks for bytes only for the engine that needs them', () => {
    expect(engineNeedsBytes('zipp-web-python')).toBe(true);
    expect(engineNeedsBytes('host-js')).toBe(false);
    // An engine this page cannot boot is never chosen, so it is never asked about; if it were,
    // "needs bytes" is the answer that leads to a refusal rather than to a silent boot.
    expect(engineNeedsBytes('zipp-next')).toBe(true);
  });

  it('serves bytes for the ZIPP engines alone, host JavaScript included in the refusal', async () => {
    // Defence in depth behind engineNeedsBytes: handing host-js ZIPP's bytes would be giving it
    // the wrong engine rather than none, so it is refused by the same rule as an unknown id.
    await expect(getEngineBytes('host-js')).rejects.toThrow('does not have the engine');
    await expect(getEngineBytes('zipp-next')).rejects.toThrow('does not have the engine');
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

describe('the web variant this page holds', () => {
  const record = { version: '0.0.18', sha256: 'a'.repeat(64), variants: { web: { sha256: 'b'.repeat(64) } } };

  it('names the variant only when the record describes it AND the build holds its bytes', () => {
    // The identity is the variant's digest under the RELEASE's version, which is what Softn's
    // shell announces for zipp-web ({...primary, sha256: web.sha256}), so sameIdentity can pass.
    expect(webVariantIdentity(record, '/assets/zipp_wasm_bg-web.wasm')).toEqual({ version: '0.0.18', sha256: 'b'.repeat(64) });
    // Bytes in the build but no record: no identity to announce them under.
    expect(webVariantIdentity({ version: '0.0.18', sha256: 'a'.repeat(64) }, '/assets/zipp_wasm_bg-web.wasm')).toBeUndefined();
    // A record but no bytes (a variant-less build): nothing to send, so nothing to name.
    expect(webVariantIdentity(record, undefined)).toBeUndefined();
    // A malformed digest is no identity either.
    expect(webVariantIdentity({ ...record, variants: { web: { sha256: 'not hex' } } }, '/x.wasm')).toBeUndefined();
    expect(webVariantIdentity({ ...record, variants: { web: {} } }, '/x.wasm')).toBeUndefined();
  });

  it('matches the installed release: zipp-web is bootable exactly when the installed Softn release ships the variant', async (context) => {
    const web = (source as ZippSourceRecord).variants?.web;
    if (!web) {
      // Never a silent skip: the absence is asserted, printed (the verbose reporter shows it), and
      // counted as a skip in the summary (the default reporter hides console output of passing tests).
      expect(ZIPP_WEB_IDENTITY).toBeUndefined();
      expect(engineIdentity('zipp-web')).toBeUndefined();
      expect(getZippWebWasmBytes).toBeUndefined();
      await expect(getEngineBytes('zipp-web')).rejects.toThrow('does not have the engine');
      console.log('skipped: installed Softn release has no zipp-web');
      context.skip('skipped: installed Softn release has no zipp-web');
      return;
    }
    expect(ZIPP_WEB_IDENTITY).toEqual({ version: source.version, sha256: web.sha256 });
    expect(engineIdentity('zipp-web')).toEqual(ZIPP_WEB_IDENTITY);
    expect(engineNeedsBytes('zipp-web')).toBe(true);
    // Two engines, two digests: the variant is never the primary's bytes named twice.
    expect(web.sha256).not.toBe(ZIPP_RUNTIME_IDENTITY.sha256);
    // The second broker is wired to the id and enforces the VARIANT's digest: bytes that are not
    // it are refused, and the refusal does not poison the next attempt.
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response('<html>stale SPA fallback</html>')).mockImplementation(() => new Response(bytes));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(getEngineBytes('zipp-web')).rejects.toThrow('does not match');
    await expect(getEngineBytes('zipp-web')).rejects.toThrow('does not match');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/zipp_wasm_bg/);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });
});
