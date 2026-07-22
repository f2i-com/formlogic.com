// Pure-TS byte/string codecs for the E2EE module (docs/E2EE_PRIVATE_FORMS_PLAN.md §5).
// Standard base64 WITH padding (matches the tunnel's convention); RFC 4648 Base32
// uppercase without padding (recovery kit display); lowercase hex.
// No dependency on libsodium so codecs work before the WASM is ready.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8String(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET[i]] = i;
  return m;
})();

/** Strict standard-base64 decode (padding required, no whitespace, no url-safe chars). */
export function fromB64(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new Error('base64: bad length');
  let padding = 0;
  if (s.endsWith('==')) padding = 2;
  else if (s.endsWith('=')) padding = 1;
  const body = padding > 0 ? s.slice(0, s.length - padding) : s;
  if (body.includes('=')) throw new Error('base64: misplaced padding');
  const outLen = (s.length / 4) * 3 - padding;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < body.length; i += 4) {
    const c0 = B64_LOOKUP[body[i]];
    const c1 = B64_LOOKUP[body[i + 1]];
    const c2 = i + 2 < body.length ? B64_LOOKUP[body[i + 2]] : 0;
    const c3 = i + 3 < body.length ? B64_LOOKUP[body[i + 3]] : 0;
    if (c0 === undefined || c1 === undefined
      || (i + 2 < body.length && c2 === undefined)
      || (i + 3 < body.length && c3 === undefined)) {
      throw new Error('base64: bad character');
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (triple >> 16) & 0xff;
    if (o < outLen) out[o++] = (triple >> 8) & 0xff;
    if (o < outLen) out[o++] = triple & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/.test(s)) throw new Error('hex: invalid');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** RFC 4648 Base32, uppercase, no padding. 32 bytes -> 52 chars. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

const B32_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B32_ALPHABET.length; i++) m[B32_ALPHABET[i]] = i;
  return m;
})();

export function base32Decode(s: string): Uint8Array {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32_LOOKUP[ch];
    if (v === undefined) throw new Error('base32: bad character');
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
