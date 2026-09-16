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

/**
 * The web variant's engine, when the installed Softn release ships one (formlogic/ui/vendor/
 * zipp-wasm-web, the release's zipp-web/ tree; see scripts/fetch-softn-release.mjs). The glob is
 * what makes a variant-less install build at all: Vite emits NOTHING for a pattern that matches
 * no file, and a hashed asset — zipp_wasm_bg-<hash>.wasm, the same base name as the primary, so
 * the precache exclusion and the runtime cache rule in vite.config.ts cover both — when the file
 * is there (verified on Vite 8.3.0). A static `new URL(...)` would fail the build when absent.
 */
const webWasmUrls = import.meta.glob('../../../vendor/zipp-wasm-web/zipp_wasm_bg.wasm', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const webWasmUrl: string | undefined = Object.values(webWasmUrls)[0];

/** The shape of the installed engine's SOURCE.json this module reads: the primary record and its variants. */
export type ZippSourceRecord = { version: string; sha256: string; variants?: { web?: { sha256?: unknown } } };

/**
 * What this page can announce for `zipp-web`: the installed record's `variants.web` digest under
 * the release's version (which is what Softn's shell announces for it), and only when the build
 * actually holds those bytes. A record naming a variant whose bytes are not in the build, or
 * bytes without a record, is no identity at all — a frame that asked for it would be asking a
 * shell to match something this page cannot supply, so it falls back instead.
 */
export function webVariantIdentity(record: ZippSourceRecord, url: string | undefined): EngineIdentity | undefined {
  const sha256 = record.variants?.web?.sha256;
  if (!url || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return Object.freeze({ version: record.version, sha256 });
}

/** The web variant this build holds, or undefined when the installed release ships none. */
export const ZIPP_WEB_IDENTITY: EngineIdentity | undefined = webVariantIdentity(source as ZippSourceRecord, webWasmUrl);

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
 * `zipp-web-python` is the ZIPP JavaScript-and-Python VM, described by the identity of the bytes
 * this page ships and sends. `zipp-web` is the same release's JavaScript-only build, described by
 * {@link ZIPP_WEB_IDENTITY} — present only when the installed release ships the variant, so an
 * install without it never names the id, and a frame asked for it falls back. `host-js` is the
 * author's code run as the host document's own JavaScript, described by {@link OWN_DOCUMENT_ENGINE}:
 * it is served by its own runtime document under its own policy, and no bytes ever cross. The
 * table is the parent's half of the handshake — an id it does not name can never be chosen, so
 * it can never be asked for bytes.
 */
const FRAME_ENGINES: Readonly<Record<string, FrameEngineBytes>> = Object.freeze({
  'zipp-web-python': ZIPP_RUNTIME_IDENTITY,
  'host-js': OWN_DOCUMENT_ENGINE,
  ...(ZIPP_WEB_IDENTITY ? { 'zipp-web': ZIPP_WEB_IDENTITY } : {}),
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
 * The web variant's own broker — a second cache, since the two engines are two byte strings —
 * or undefined when this build holds no variant. It exists exactly when {@link ZIPP_WEB_IDENTITY}
 * does, and its digest check is that identity's.
 */
export const getZippWebWasmBytes: (() => Promise<ArrayBuffer>) | undefined = ZIPP_WEB_IDENTITY && webWasmUrl
  ? createWasmByteBroker(ZIPP_WEB_IDENTITY.sha256, () => fetch(webWasmUrl, { credentials: 'omit', signal: AbortSignal.timeout(90_000) }))
  : undefined;

/**
 * The engine bytes one id needs, from the page's cache for that engine.
 *
 * Only ids {@link engineIdentity} knows can reach here, and callers ask {@link engineNeedsBytes}
 * first, so the rejection is a seam marker rather than a reachable path. `host-js` is refused by
 * the same rule as an unknown id and for the same reason: an engine that is its own document has
 * no bytes, and handing it ZIPP's would be giving it the wrong engine rather than none. `zipp-web`
 * is served only from its own broker — never the primary's bytes under the variant's name, which
 * the shell would refuse as an engine that "also runs python".
 */
export function getEngineBytes(id: string): Promise<ArrayBuffer> {
  if (id === 'zipp-web-python') return getZippWasmBytes();
  if (id === 'zipp-web' && getZippWebWasmBytes) return getZippWebWasmBytes();
  return Promise.reject(new Error('This app runtime does not have the engine this app needs.'));
}
