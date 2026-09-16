import source from '../../../vendor/zipp-wasm/SOURCE.json';

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

/** What a hosted-runtime shell must announce for an engine to be the one this page holds. */
export type EngineIdentity = { version: string; sha256: string };

/**
 * The engines this page can boot, and the identity each one's shell must announce.
 *
 * Only the ZIPP JavaScript-and-Python engine today: it is the only one the installed hosted
 * runtime serves and the only one these bytes are. The table is the parent's half of the
 * handshake — an id it does not name can never be chosen, so it can never be asked for bytes.
 */
const FRAME_ENGINES: Readonly<Record<string, EngineIdentity>> = Object.freeze({
  'zipp-web-python': ZIPP_RUNTIME_IDENTITY,
});

/** The identity an engine's shell must announce, or undefined when this page cannot boot it. */
export function engineIdentity(id: string): EngineIdentity | undefined {
  return Object.hasOwn(FRAME_ENGINES, id) ? FRAME_ENGINES[id] : undefined;
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
 * Only ids {@link engineIdentity} knows can reach here, so the throw is a seam marker rather than
 * a reachable path: an engine that needs no bytes (host JavaScript) will answer differently here,
 * not be given ZIPP's.
 */
export function getEngineBytes(id: string): Promise<ArrayBuffer> {
  if (id !== 'zipp-web-python') return Promise.reject(new Error('This app runtime does not have the engine this app needs.'));
  return getZippWasmBytes();
}
