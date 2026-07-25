// FlowNodeRegistry (extensible-flows plan §10.5 Phase 1): core-provider resolution parity
// with the static catalog, the §4.5 missing-definition placeholder for unknown types, and
// provider registration/shadowing rules.
import { afterEach, describe, expect, it } from 'vitest';
import { HelpCircle } from 'lucide-react';
import { EXECUTABLE_NODE_TYPES } from '../../../client-runtime/flows/nodes';
import { getNodeSpec, NODE_SPECS, type NodeSpec } from '../editor/nodeCatalog';
import { flowNodeRegistry, missingNodeSpec } from './FlowNodeRegistry';
import type { FlowNodeProvider } from './types';

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

  // FLOW-202: a registry whose sources come and go needs removal, a change signal, and an
  // account of what it shadowed — otherwise a provider's node silently never appears.
  describe('provider lifecycle (FLOW-202)', () => {
    const spec = (type: string): NodeSpec => ({
      type, label: type, category: 'installed', description: type,
      icon: HelpCircle, accent: 'violet', executable: false,
      inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Out' }], properties: [],
    });
    const provider = (id: string, types: string[]): FlowNodeProvider => ({
      id,
      resolve: (type) => (types.includes(type) ? spec(type) : undefined),
      list: () => types.map(spec),
    });

    afterEach(() => {
      for (const id of flowNodeRegistry.listProviders()) {
        if (id !== 'core') flowNodeRegistry.unregister(id);
      }
    });

    it('registers, resolves, then unregisters — stored types fall back to the placeholder', () => {
      flowNodeRegistry.register(provider('temp', ['acme.temp.node']));
      expect(flowNodeRegistry.resolveKnownNodeSpec('acme.temp.node')).toBeDefined();
      expect(flowNodeRegistry.listProviders()).toContain('temp');

      expect(flowNodeRegistry.unregister('temp')).toBe(true);
      // The type does not vanish from a stored graph — it becomes the read-only placeholder.
      expect(flowNodeRegistry.resolveKnownNodeSpec('acme.temp.node')).toBeUndefined();
      expect(flowNodeRegistry.resolveNodeSpec('acme.temp.node').missing).toBe(true);
      expect(flowNodeRegistry.unregister('temp')).toBe(false);
    });

    it('refuses to unregister core — every unknown type would lose its fallback', () => {
      expect(() => flowNodeRegistry.unregister('core')).toThrow(/core provider/);
    });

    it('bumps a revision on every change so consumers can memoize on it', () => {
      const start = flowNodeRegistry.registryRevision();
      flowNodeRegistry.register(provider('temp', ['acme.temp.node']));
      const afterRegister = flowNodeRegistry.registryRevision();
      expect(afterRegister).toBeGreaterThan(start);

      // refresh() signals "same providers, new underlying data" (a pack installed).
      expect(flowNodeRegistry.refresh()).toBeGreaterThan(afterRegister);
      const afterRefresh = flowNodeRegistry.registryRevision();
      flowNodeRegistry.unregister('temp');
      expect(flowNodeRegistry.registryRevision()).toBeGreaterThan(afterRefresh);
    });

    it('records what a collision shadowed instead of dropping it silently', () => {
      // A later provider claiming a CORE type must lose — and be accounted for.
      flowNodeRegistry.register(provider('impostor', ['template']));
      const listed = flowNodeRegistry.listNodeSpecs();

      expect(listed.filter((s) => s.type === 'template')).toHaveLength(1);
      expect(listed.find((s) => s.type === 'template')?.category).not.toBe('installed');
      expect(flowNodeRegistry.lastCollisions()).toEqual([
        { type: 'template', ownedBy: 'core', shadowedProvider: 'impostor' },
      ]);
    });
  });
});
