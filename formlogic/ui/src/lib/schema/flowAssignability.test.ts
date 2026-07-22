// Typed-port compatibility matrix (extensible-flows plan §6.4, test plan §19.2).
// This is the TypeScript leg of the plan's shared cross-language matrix; the Rust/PHP
// legs consume the same cases when the compiler lands. Conservative-by-construction is
// the load-bearing property: nothing unknown may ever grade better than
// runtime-checkable, and no silent coercion may ever grade better than
// conversion-required.
import { describe, expect, it } from 'vitest';
import {
  assignability,
  normalizePortType,
  schemaAssignability,
  wireAllowed,
} from './flowAssignability';

describe('normalizePortType (§6.5 subset → §6.4 lattice)', () => {
  it('maps primitives, media strings, enums, unions, and unknowns conservatively', () => {
    expect(normalizePortType({ type: 'string' }).types).toEqual(['string']);
    expect(normalizePortType({ type: 'integer' }).types).toEqual(['integer']);
    expect(normalizePortType({ type: ['string', 'null'] }).types).toEqual(['string', 'null']);
    expect(normalizePortType({ type: 'string', contentMediaType: 'image/png' }).types).toEqual(['image']);
    expect(normalizePortType({ type: 'string', contentMediaType: 'application/pdf' }).types).toEqual(['file']);
    expect(normalizePortType({ enum: ['fast', 'slow'] })).toEqual({ types: ['enum'], enumValues: ['fast', 'slow'] });
    expect(normalizePortType({ const: 42 })).toEqual({ types: ['enum'], enumValues: [42] });
    // Unknown/absent schemas normalize to 'any' — never to something provable.
    expect(normalizePortType(undefined).types).toEqual(['any']);
    expect(normalizePortType({ description: 'no type' }).types).toEqual(['any']);
    expect(normalizePortType({ type: 'quaternion' }).types).toEqual(['any']);
    // Object requireds and array items are carried for the deeper checks.
    expect(normalizePortType({ type: 'object', required: ['a', 'b'] }).requiredProperties).toEqual(['a', 'b']);
    expect(normalizePortType({ type: 'array', items: { type: 'integer' } }).items?.types).toEqual(['integer']);
  });
});

describe('assignability (§6.4 levels / §19.2 matrix)', () => {
  const level = (s: unknown, t: unknown) => schemaAssignability(s, t).level;

  it('primitive equality is exact; nullable-union sugar stays exact', () => {
    expect(level({ type: 'string' }, { type: 'string' })).toBe('exact');
    expect(level({ type: ['string', 'null'] }, { type: ['string', 'null'] })).toBe('exact');
    expect(level({ type: 'null' }, { type: ['string', 'null'] })).toBe('exact');
  });

  it('integer widens safely to number; the reverse is runtime-checkable narrowing', () => {
    expect(level({ type: 'integer' }, { type: 'number' })).toBe('safe-widening');
    expect(level({ type: 'number' }, { type: 'integer' })).toBe('runtime-checkable');
  });

  it("'any' on either side is amber, never green", () => {
    expect(level(undefined, { type: 'object' })).toBe('runtime-checkable');
    expect(level({ type: 'object' }, undefined)).toBe('runtime-checkable');
  });

  it('explicit conversions are demanded, never silent (§6.4 named cases)', () => {
    expect(level({ type: 'string' }, { type: 'string', contentMediaType: 'image/png' })).toBe('conversion-required');
    expect(level({ type: 'object' }, { type: 'string' })).toBe('conversion-required');
    expect(level({ type: 'number' }, { type: 'string' })).toBe('conversion-required');
    expect(level({ type: 'string' }, { type: 'integer' })).toBe('conversion-required');
  });

  it('nonsense wires are refused outright', () => {
    expect(level({ type: 'array' }, { type: 'boolean' })).toBe('incompatible');
    expect(level({ type: 'boolean' }, { type: 'array' })).toBe('incompatible');
    expect(level({ type: 'string', contentMediaType: 'image/png' }, { type: 'boolean' })).toBe('incompatible');
  });

  it('union sources take the WORST case; union targets give each source its best home', () => {
    // Every string member demands conversion into ['integer','null'] → conversion.
    expect(level({ type: 'string' }, { type: ['integer', 'null'] })).toBe('conversion-required');
    // ['integer','null'] into ['number','null']: integer widens, null is exact → widening.
    expect(level({ type: ['integer', 'null'] }, { type: ['number', 'null'] })).toBe('safe-widening');
  });

  it('enum narrowing is decided statically when both sides carry values', () => {
    expect(level({ enum: ['a'] }, { enum: ['a', 'b'] })).toBe('exact');
    expect(level({ enum: ['a', 'z'] }, { enum: ['a', 'b'] })).toBe('incompatible');
    // enum vs a plain base type stays runtime-checkable (no value analysis against schemas yet).
    expect(level({ enum: ['a'] }, { type: 'string' })).toBe('runtime-checkable');
  });

  it('media family: kinds widen to artifact/file, artifact narrows at runtime, kinds never interchange (§19.2)', () => {
    const image = { type: 'string', contentMediaType: 'image/png' };
    const audio = { type: 'string', contentMediaType: 'audio/wav' };
    const file = { type: 'string', contentMediaType: 'application/octet-stream' };
    expect(level(image, file)).toBe('safe-widening');
    expect(level(file, image)).toBe('runtime-checkable');
    expect(level(image, audio)).toBe('incompatible');
  });

  it('object targets with required properties never grade green without property proofs', () => {
    expect(level({ type: 'object' }, { type: 'object', required: ['messages'] })).toBe('runtime-checkable');
    expect(level({ type: 'object' }, { type: 'object' })).toBe('exact');
  });

  it('array wires compose through their item types', () => {
    const ints = { type: 'array', items: { type: 'integer' } };
    const nums = { type: 'array', items: { type: 'number' } };
    const strs = { type: 'array', items: { type: 'string' } };
    expect(level(ints, nums)).toBe('safe-widening');
    expect(level(ints, ints)).toBe('exact');
    expect(level(nums, strs)).toBe('conversion-required');
  });

  it('wireAllowed maps the levels to the §6.4 editor behavior', () => {
    expect(wireAllowed(schemaAssignability({ type: 'string' }, { type: 'string' }))).toBe(true);
    expect(wireAllowed(schemaAssignability({ type: 'integer' }, { type: 'number' }))).toBe(true);
    expect(wireAllowed(schemaAssignability(undefined, { type: 'object' }))).toBe(true); // amber, allowed
    expect(wireAllowed(schemaAssignability({ type: 'object' }, { type: 'string' }))).toBe(false); // offer converter
    expect(wireAllowed(schemaAssignability({ type: 'array' }, { type: 'boolean' }))).toBe(false); // refused
  });

  it('levels carry editor notes except exact', () => {
    expect(assignability(normalizePortType({ type: 'string' }), normalizePortType({ type: 'string' })).note).toBeUndefined();
    expect(schemaAssignability({ type: 'integer' }, { type: 'number' }).note).toMatch(/widening/);
    expect(schemaAssignability(undefined, { type: 'string' }).note).toMatch(/run time/);
  });
});
