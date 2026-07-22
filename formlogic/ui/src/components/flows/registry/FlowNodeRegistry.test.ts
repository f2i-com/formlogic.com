// FlowNodeRegistry (extensible-flows plan §10.5 Phase 1): core-provider resolution parity
// with the static catalog, the §4.5 missing-definition placeholder for unknown types, and
// provider registration/shadowing rules.
import { describe, expect, it } from 'vitest';
import { EXECUTABLE_NODE_TYPES } from '../../../client-runtime/flows/nodes';
import { getNodeSpec, NODE_SPECS } from '../editor/nodeCatalog';
import { flowNodeRegistry, missingNodeSpec } from './FlowNodeRegistry';

describe('FlowNodeRegistry', () => {
  it('resolves every core catalog type to the exact catalog spec', () => {
    for (const spec of NODE_SPECS) {
      expect(flowNodeRegistry.resolveNodeSpec(spec.type)).toBe(spec);
      expect(flowNodeRegistry.resolveKnownNodeSpec(spec.type)).toBe(getNodeSpec(spec.type));
    }
  });

  it('covers every executable runtime type (registry ↔ executor lock-step)', () => {
    for (const type of EXECUTABLE_NODE_TYPES) {
      const spec = flowNodeRegistry.resolveKnownNodeSpec(type);
      expect(spec, `executor type '${type}' must resolve through the registry`).toBeDefined();
      expect(spec?.missing).toBeUndefined();
    }
  });

  it('unknown types resolve to a read-only missing placeholder, never undefined', () => {
    const spec = flowNodeRegistry.resolveNodeSpec('pack.acme.tools.frobnicate');
    expect(spec.missing).toBe(true);
    expect(spec.executable).toBe(false);
    expect(spec.label).toBe('pack.acme.tools.frobnicate');
    expect(spec.category).toBe('missing');
    expect(spec.inputs).toHaveLength(1);
    expect(spec.outputs).toHaveLength(1);
    expect(spec.description).toMatch(/not installed/i);
    // Existence-checking callers see undefined instead.
    expect(flowNodeRegistry.resolveKnownNodeSpec('pack.acme.tools.frobnicate')).toBeUndefined();
  });

  it('missing placeholders never join the palette list', () => {
    const listed = flowNodeRegistry.listNodeSpecs();
    expect(listed).toEqual(NODE_SPECS);
    expect(listed.some((s) => s.missing)).toBe(false);
  });

  it('missingNodeSpec is pure and per-type', () => {
    expect(missingNodeSpec('a').type).toBe('a');
    expect(missingNodeSpec('a')).not.toBe(missingNodeSpec('a'));
  });
});
