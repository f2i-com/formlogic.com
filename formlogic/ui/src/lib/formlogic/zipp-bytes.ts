import source from '../../../vendor/zipp-wasm/SOURCE.json';
// The vocabulary lives with the rule that uses it (frameEngine), which reaches no DOM, message or
// fetch; this module is the page's actual holdings. Keeping them apart means a test that stubs
// what this page holds cannot also, silently, stub what the announcement is compared against.
import { OWN_DOCUMENT_ENGINE, type EngineIdentity, type FrameEngineBytes } from './frameEngine';

export type { EngineIdentity, FrameEngineBytes };

/** Immutable public engine identity, shared with the trusted hosted-app shell. */
export const ZIPP_RUNTIME_IDENTITY = Object.freeze({ version: source.version, sha256: source.sha256 });
const wasmUrl = new URL('../../../vendor/zipp-wasm/zipp_wasm_bg.wasm', import.meta.url);
const MAX_WASM_BYTES = 32 * 1024 * 1024;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  let digest: Uint8Array;
  if (globalThis.crypto?.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  } else {
    // Local phones may open an HTTP LAN address where SubtleCrypto is absent.
    // Reuse the existing bundled, lazy crypto library; never fetch remote code
    // or skip artifact verification to support that development environment.
    const { getSodium } = await import('../crypto/sodium');
    const sodium = await getSodium();
    digest = sodium.crypto_hash_sha256(new Uint8Array(bytes));
  }
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * The engines this page can boot, and what each one's shell must announce.
 *
 * Two today. `zipp-web-python` is the ZIPP JavaScript-and-Python VM, described by the identity of
 * the bytes this page ships and sends. `host-js` is the author's code run as the host document's
 * own JavaScript, described by {@link OWN_DOCUMENT_ENGINE}: it is served by its own runtime
 * document under its own policy, and no bytes ever cross. The table is the parent's half of the
 * handshake — an id it does not name can never be chosen, so it can never be asked for bytes.
 */
const FRAME_ENGINES: Readonly<Record<string, FrameEngineBytes>> = Object.freeze({
  'zipp-web-python': ZIPP_RUNTIME_IDENTITY,
  'host-js': OWN_DOCUMENT_ENGINE,
});

/** What an engine's shell must announce, or undefined when this page cannot boot it. */
export function engineIdentity(id: string): FrameEngineBytes | undefined {
  return Object.hasOwn(FRAME_ENGINES, id) ? FRAME_ENGINES[id] : undefined;
}

/** Whether booting this engine needs engine bytes from the page at all. */
export function engineNeedsBytes(id: string): boolean {
  return engineIdentity(id) !== OWN_DOCUMENT_ENGINE;
}

/**
 * One lazy, retryable download for the page. Consumers must clone these bytes
 * through postMessage without a transfer list: transferring would detach the
 * cache, while sharing a VM would also share its mutable memory and bridges.
 */
export function createWasmByteBroker(expectedSha256: string, load: () => Promise<Response>): () => Promise<ArrayBuffer> {
  let pending: Promise<ArrayBuffer> | undefined;
  return () => {
    if (!pending) {
      pending = (async () => {
        const response = await load();
        if (!response.ok) throw new Error(`The app engine could not be downloaded (${response.status}).`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 8 || bytes.byteLength > MAX_WASM_BYTES) throw new Error('The downloaded app engine is invalid.');
        const actual = await sha256(bytes);
        if (actual !== expectedSha256) throw new Error('The downloaded app engine does not match this version. Please reload after updating the site.');
        return bytes;
      })().catch(error => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export const getZippWasmBytes = createWasmByteBroker(ZIPP_RUNTIME_IDENTITY.sha256, () =>
  fetch(wasmUrl, { credentials: 'omit', signal: AbortSignal.timeout(90_000) })
);

/**
 * The engine bytes one id needs, from the page's single cache.
 *
 * Only ids {@link engineIdentity} knows can reach here, and callers ask {@link engineNeedsBytes}
 * first, so the rejection is a seam marker rather than a reachable path. `host-js` is refused by
 * the same rule as an unknown id and for the same reason: an engine that is its own document has
 * no bytes, and handing it ZIPP's would be giving it the wrong engine rather than none.
 */
export function getEngineBytes(id: string): Promise<ArrayBuffer> {
  if (id !== 'zipp-web-python') return Promise.reject(new Error('This app runtime does not have the engine this app needs.'));
  return getZippWasmBytes();
}
