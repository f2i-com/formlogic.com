// Vendor signing for marketplace packs (plan APP-501 first slice).
//
// Per-component digest trust: every form/app customScreen in a pack gets a
// sha256 digest over its EXECUTABLE surfaces, the digest manifest is signed
// with the vendor's Ed25519 key, and the block travels INSIDE the pack as
// `pack.signing`. The PHP importer (PackService::packSigningVerdicts) then
// stamps `custom_screen_trust = 'verified'` on a direct JSON import of an
// UNMODIFIED vendor pack — instead of 'untrusted' + a manual re-stamp — and
// marks a tampered component's provenance 'vendor_modified'.
//
// ⚠️ DIGEST RECIPE — deliberately NOT canonical-JSON (cross-language JSON
// canonicalization is where signing schemes rot): the digest input is a
// length-delimited concatenation of the screen's executable STRING fields in
// a fixed order. PHP mirrors this byte-for-byte in
// PackService::customScreenDigest — keep the two in lock-step; the fixture
// conformance test (backend PackVendorSigningTest) recomputes every emitted
// pack's digests in PHP and fails CI on any drift.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PACK_SIGNING_FORMAT = 'formlogic-pack-vendor/1';

/** The executable string fields of a screen scope, in DIGEST ORDER. */
const CODE_FIELDS = ['kind', 'entry', 'html', 'css', 'js', 'ts'];

/**
 * Netstring framing: `<utf8-byte-length>:<value>,`. INJECTIVE — the byte
 * length prefix means a value containing the delimiter (or a NUL) can never
 * be confused with a field boundary, so two different token lists always
 * produce different bytes. PHP's `strlen()` is a UTF-8 byte count (json_decode
 * yields byte strings) and matches `Buffer.byteLength(…,'utf8')` exactly.
 */
function frame(s) {
  const str = String(s);
  return Buffer.byteLength(str, 'utf8') + ':' + str + ',';
}

function digestTokens(tokens, scope, prefix) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return;
  for (const k of CODE_FIELDS) {
    if (typeof scope[k] === 'string') tokens.push(prefix + k, scope[k]);
  }
  // Only a LIST of {path,content} string entries contributes — matches the
  // PHP `array_is_list` + string guards, so a map/object `files` (or a
  // non-string path/content) is treated identically (excluded) on both sides.
  if (Array.isArray(scope.files)) {
    for (const f of scope.files) {
      if (f && typeof f === 'object' && typeof f.path === 'string' && typeof f.content === 'string') {
        tokens.push(prefix + 'file', f.path, f.content);
      }
    }
  }
}

/** sha256 hex over the screen's executable surfaces (top-level + recordScreen). */
export function customScreenDigest(screen) {
  const tokens = [];
  digestTokens(tokens, screen, '');
  digestTokens(tokens, screen && typeof screen === 'object' ? screen.recordScreen : null, 'record.');
  return createHash('sha256').update(tokens.map(frame).join(''), 'utf8').digest('hex');
}

/** Byte-order comparison — matches PHP `sort($keys, SORT_STRING)`. JS's
 *  default sort is UTF-16 code-unit order, which diverges on supplementary
 *  planes; author-controlled component keys must sort identically. */
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The signed bytes: format + pack identity + the sorted component digest list,
 *  all netstring-framed so the message is injective too. */
export function signingMessage(packId, packVersion, components) {
  const tokens = [PACK_SIGNING_FORMAT, String(packId), String(packVersion)];
  for (const key of Object.keys(components).sort(byteCompare)) {
    tokens.push(key, components[key]);
  }
  return Buffer.from(tokens.map(frame).join(''), 'utf8');
}

/** Collect the pack's screen components keyed by their STABLE pack-local ids. */
export function collectPackComponents(pack) {
  const components = {};
  for (const form of pack.forms ?? []) {
    if (form?.customScreen) components['form:' + form.packFormId] = customScreenDigest(form.customScreen);
  }
  for (const app of pack.apps ?? []) {
    if (app?.customScreen) components['app:' + app.packAppId] = customScreenDigest(app.customScreen);
  }
  return components;
}

/** Load the vendor key file, or null when this machine has none (emit then
 *  produces unsigned packs — imports of those stay untrusted, honestly). */
export function loadVendorKey(file = join(homedir(), '.formlogic-signing', 'formlogic-packs-2026a.json')) {
  if (!existsSync(file)) return null;
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (rec.alg !== 'ed25519' || !rec.privateKeyPem || !rec.publicKeyB64) return null;
  return {
    keyId: String(rec.keyId || 'fl-packs'),
    publicKeyB64: String(rec.publicKeyB64),
    privateKey: createPrivateKey(rec.privateKeyPem),
  };
}

/** Build the `pack.signing` block, or null when the pack has no screens or no key. */
export function buildPackSigning(pack, vendorKey) {
  if (!vendorKey) return null;
  const components = collectPackComponents(pack);
  if (Object.keys(components).length === 0) return null;
  const meta = pack.packMeta ?? {};
  const message = signingMessage(meta.id ?? '', meta.version ?? '', components);
  const signature = sign(null, message, vendorKey.privateKey).toString('base64');
  return {
    format: PACK_SIGNING_FORMAT,
    alg: 'ed25519',
    keyId: vendorKey.keyId,
    publisherKeyB64: vendorKey.publicKeyB64,
    components,
    signature,
  };
}
