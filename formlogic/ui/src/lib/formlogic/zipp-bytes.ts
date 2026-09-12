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

export function matchesZippRuntime(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const identity = value as { version?: unknown; sha256?: unknown };
  return identity.version === ZIPP_RUNTIME_IDENTITY.version && identity.sha256 === ZIPP_RUNTIME_IDENTITY.sha256;
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
