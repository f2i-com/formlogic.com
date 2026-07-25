import { describe, expect, it } from 'vitest';
import { checkWire } from './wireChecks';
import type { NodeSpec } from './nodeCatalog';

// FLOW-205: the canvas's consumer of the §6.4 assignability lattice. The behaviour that
// matters is what it does with UNCERTAINTY: unknown types must stay connectable (an author
// is never blocked because the host lacks type information), and only a positively-proved
// mismatch refuses. Exact/widening/checkable/conversion/incompatible each get a verdict.

function spec(overrides: Partial<NodeSpec>): NodeSpec {
  return {
    type: 'x',
    label: 'X',
    category: 'core',
    description: '',
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'out', label: 'Out' }],
    ...overrides,
  } as NodeSpec;
}

/** A node with one control handle plus one declared data port. */
function dataNode(side: 'in' | 'out', schema: unknown, label = 'value'): NodeSpec {
  const handle = { id: label, label, data: true, ...(schema === undefined ? {} : { schema }) };
  return side === 'out'
    ? spec({ outputs: [{ id: 'out', label: 'Out' }, handle] })
    : spec({ inputs: [{ id: 'in', label: 'In' }, handle] });
}

function wire(source: NodeSpec, target: NodeSpec, sourceHandle: string | null, targetHandle: string | null) {
  const byId: Record<string, NodeSpec> = { s: source, t: target };
  return checkWire({ source: 's', target: 't', sourceHandle, targetHandle }, (id) => byId[id]);
}

describe('checkWire', () => {
  it('always allows control wires (they carry order, not values)', () => {
    const verdict = wire(spec({}), spec({}), null, null);
    expect(verdict.allowed).toBe(true);
    expect(verdict.assignability).toBeUndefined();
  });

  it('allows an exact data match silently', () => {
    const verdict = wire(
      dataNode('out', { type: 'string' }),
      dataNode('in', { type: 'string' }),
      'value',
      'value',
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.assignability?.level).toBe('exact');
    expect(verdict.message).toBeUndefined();
  });

  it('allows safe widening and says what it did', () => {
    const verdict = wire(
      dataNode('out', { type: 'integer' }),
      dataNode('in', { type: 'number' }),
      'value',
      'value',
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.assignability?.level).toBe('safe-widening');
    expect(verdict.message).toContain('safe widening');
  });

  it('refuses a proved mismatch and names both ends', () => {
    // Media kinds never interchange (plan §6.4): an image cannot feed an audio port.
    const verdict = wire(
      dataNode('out', { type: 'string', contentMediaType: 'image/png' }, 'picture'),
      dataNode('in', { type: 'string', contentMediaType: 'audio/wav' }, 'sound'),
      'picture',
      'sound',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.assignability?.level).toBe('incompatible');
    expect(verdict.message).toContain('picture');
    expect(verdict.message).toContain('sound');
  });

  it('refuses a conversion-required wire but points at the fix', () => {
    // string → boolean is a NAMED coercion in the lattice, never a silent one: the wire is
    // refused, and the message tells the author to convert rather than just saying "no".
    const verdict = wire(
      dataNode('out', { type: 'string' }),
      dataNode('in', { type: 'boolean' }),
      'value',
      'value',
    );
    expect(verdict.assignability?.level).toBe('conversion-required');
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toContain('convert');
  });

  it('stays permissive when a port declares no schema', () => {
    // Core nodes mostly declare nothing yet — an un-typed port must never block authoring.
    const verdict = wire(dataNode('out', undefined), dataNode('in', { type: 'string' }), 'value', 'value');
    expect(verdict.allowed).toBe(true);
    expect(verdict.assignability?.level).toBe('runtime-checkable');
  });

  it('allows any wire touching a node the host cannot describe', () => {
    // A graph from a newer version must stay editable rather than becoming unwirable.
    const byId: Record<string, NodeSpec | undefined> = { s: undefined, t: dataNode('in', { type: 'string' }) };
    const verdict = checkWire({ source: 's', target: 't', sourceHandle: 'value', targetHandle: 'value' }, (id) => byId[id]);
    expect(verdict.allowed).toBe(true);
  });

  it('refuses mixing a data port with a control handle', () => {
    const verdict = wire(dataNode('out', { type: 'string' }), spec({}), 'value', null);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toContain('data');
  });
});
