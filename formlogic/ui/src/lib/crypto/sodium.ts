// Lazy libsodium-wrappers-sumo loader (docs/E2EE_PRIVATE_FORMS_PLAN.md §5, D3).
// The sumo build is required: crypto_pwhash (Argon2id) is not in the standard wrappers.
// Dynamic import keeps the WASM out of every bundle that doesn't touch private forms.
// Works on the http dev origin (no WebCrypto dependency); randomness comes from
// sodium.randombytes_buf ONLY — never generateId()/Math.random for key material.

export type Sodium = typeof import('libsodium-wrappers-sumo');

let sodiumPromise: Promise<Sodium> | null = null;

export function getSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      const mod = await import('libsodium-wrappers-sumo');
      const sodium = (mod as unknown as { default?: Sodium }).default ?? (mod as unknown as Sodium);
      await sodium.ready;
      return sodium;
    })();
  }
  return sodiumPromise;
}
