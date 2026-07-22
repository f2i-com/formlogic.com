// flcanon/1 serializer unit tests (docs/FORMLOGIC_DATA_NODES.md §1).
// Cross-language byte-equality is covered by vectors.test.ts; this file pins the
// serializer's own reject rules and the preimage/object requirement.

import { describe, expect, it } from 'vitest';
import {
  CanonicalError,
  DOMAIN_OPERATION,
  canonicalize,
  signingPreimage,
} from './canonical';
import { utf8String } from '../crypto/encoding';

describe('flcanon/1 serializer', () => {
  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // U+1F600 (surrogate pair d83d/de00) sorts before U+FFFD under UTF-16 order.
    expect(canonicalize({ '�': 2, '\u{1F600}': 1 })).toBe('{"\u{1F600}":1,"�":2}');
  });

  it('serializes scalars and containers', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-42)).toBe('-42');
    expect(canonicalize('日本語')).toBe('"日本語"');
  });

  it('escapes strings per JCS', () => {
    expect(canonicalize('\b\f\n\r\t')).toBe('"\\b\\f\\n\\r\\t"');
    expect(canonicalize('"\\')).toBe('"\\"\\\\"');
    expect(canonicalize('\u0000\u001f')).toBe('"\\u0000\\u001f"');
  });

  it('rejects non-integers, -0, unsafe integers, undefined, and lone surrogates', () => {
    expect(() => canonicalize(1.5)).toThrow(CanonicalError);
    expect(() => canonicalize(-0)).toThrow(CanonicalError);
    expect(() => canonicalize(9007199254740992)).toThrow(CanonicalError);
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalError);
    expect(() => canonicalize('\uD800')).toThrow(CanonicalError);
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalError);
  });

  it('rejects excessive nesting', () => {
    let value: unknown = 1;
    for (let i = 0; i < 70; i++) value = [value];
    expect(() => canonicalize(value)).toThrow(CanonicalError);
  });

  it('builds domain-separated preimages over objects only', () => {
    const preimage = signingPreimage(DOMAIN_OPERATION, { a: 1 });
    expect(utf8String(preimage)).toBe('flop:1\n{"a":1}');
    expect(() => signingPreimage(DOMAIN_OPERATION, [1])).toThrow(CanonicalError);
    expect(() => signingPreimage(DOMAIN_OPERATION, 'x')).toThrow(CanonicalError);
  });
});
