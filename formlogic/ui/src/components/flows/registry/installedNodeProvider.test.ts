import { Puzzle, Sparkles } from 'lucide-react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowNodeDefinitionV1 } from '../../../application-package/packageV2';
import { useInstalledNodeStore } from '../../../stores/installedNodeStore';
import { flowNodeRegistry } from './FlowNodeRegistry';
import { adaptInstalledDefinition } from './installedNodeProvider';

// ADR-010 / FLOW-201 + FLOW-204: installed contributed definitions adapt into internal
// NodeSpecs (host icon allowlist; both v1 handler kinds are executable — core-preset via
// the server-compiled IR, service-action once its SRV-405 slot is bound) and resolve
// through the registry; removing them falls back to the missing-definition placeholder
// while graph data survives. Importing installedNodeProvider registered the provider on
// the module-singleton registry (vitest isolates modules per test file).

const DEF: FlowNodeDefinitionV1 = {
  schemaVersion: 1,
  type: 'com.acme.media.generate-image',
  version: '1.2.0',
  display: { label: 'Generate image', description: 'Generate an image', iconId: 'image-sparkles' },
  ports: [
    { id: 'prompt', direction: 'input', kind: 'data', required: true, schema: { type: 'string', minLength: 1 } },
    { id: 'image', direction: 'output', kind: 'data' },
  ],
  configurationSchema: {
    type: 'object',
    properties: {
      width: { type: 'integer', minimum: 64, description: 'Output width in pixels', default: 1024 },
      style: { type: 'string', enum: ['photo', 'sketch'] },
      metadata: { type: 'object' },
    },
    required: ['width'],
  },
  uiHints: { width: { control: 'number', group: 'Output' } },
  handler: { kind: 'service-action', bindingSlot: 'imageGenerator', requiredAction: 'generate-image' },
  sideEffects: 'external-write',
};

function seedStore(definitions: Array<{ type: string; definition: unknown; enabled?: boolean }>): void {
  useInstalledNodeStore.setState((s) => ({
    definitions: definitions.map((d, i) => ({
      type: d.type,
      version: '1.2.0',
      digest: `digest-${d.type}-${i}`,
      enabled: d.enabled ?? true,
      installationId: 'inst-1',
      packageId: 'com.acme.media-tools',
      packageName: 'Acme Media Tools',
      definition: d.definition,
    })),
    version: s.version + 1,
    loaded: true,
  }));
}

beforeEach(() => {
  useInstalledNodeStore.setState({ definitions: [], version: 0, loaded: false, loading: false });
});

describe('adaptInstalledDefinition (FLOW-201)', () => {
  it('adapts display, ports, and configuration into an internal NodeSpec', () => {
    const spec = adaptInstalledDefinition(DEF, 'Acme Media Tools');
    expect(spec.type).toBe('com.acme.media.generate-image');
    expect(spec.label).toBe('Generate image');
    expect(spec.category).toBe('installed');
    expect(spec.icon).toBe(Sparkles);
    // Default control handles plus the declared data ports.
    expect(spec.inputs.map((h) => h.id)).toEqual(['in', 'prompt']);
    expect(spec.outputs.map((h) => h.id)).toEqual(['out', 'image']);
    // Config schema → property fields: uiHint wins, enum → select, object → json code.
    const byKey = Object.fromEntries(spec.properties.map((p) => [p.key, p]));
    expect(byKey.width.type).toBe('number');
    expect(byKey.width.required).toBe(true);
    expect(byKey.width.help).toBe('Output width in pixels');
    expect(byKey.width.default).toBe(1024);
    expect(byKey.style.type).toBe('select');
    expect(byKey.style.options).toEqual([{ value: 'photo', label: 'photo' }, { value: 'sketch', label: 'sketch' }]);
    expect(byKey.metadata.type).toBe('code');
    expect(byKey.metadata.language).toBe('json');
    // Provenance is surfaced. SRV-405: a service-action contribution IS insertable now —
    // it lowers to the canonical service_action once its slot is bound, and the doc says
    // exactly what the author must do rather than calling the node unrunnable.
    expect(spec.doc).toContain('Acme Media Tools');
    expect(spec.executable).toBe(true);
    expect(spec.doc).toContain('service slot is bound');
  });

  it('RUN-301: core-preset contributions are executable (runs ride the server-compiled IR)', () => {
    const preset = adaptInstalledDefinition({
      schemaVersion: 1,
      type: 'com.acme.presets.notify',
      version: '1.0.0',
      display: { label: 'Notify' },
      handler: { kind: 'core-preset', coreType: 'template', defaults: { template: 'hi' } },
      sideEffects: 'none',
    });
    expect(preset.executable).toBe(true);
    expect(preset.doc).toContain('lowered to a built-in node');
  });

  it('never serializes React: unknown icon ids fall back to the host default', () => {
    const spec = adaptInstalledDefinition({ ...DEF, display: { label: 'X', iconId: 'totally-unknown' as string } });
    expect(spec.icon).toBe(Puzzle);
  });
});

describe('installed-package provider through the registry (FLOW-204)', () => {
  it('resolves and lists installed definitions; core stays first', () => {
    seedStore([{ type: DEF.type, definition: DEF }]);
    const spec = flowNodeRegistry.resolveNodeSpec(DEF.type);
    expect(spec.missing).toBeUndefined();
    expect(spec.label).toBe('Generate image');
    const listed = flowNodeRegistry.listNodeSpecs();
    expect(listed.some((s) => s.type === DEF.type)).toBe(true);
    // Core types still resolve from the core provider (registered first).
    expect(flowNodeRegistry.resolveNodeSpec('condition').category).not.toBe('installed');
  });

  it('a removed definition falls back to the missing placeholder (graph data survives)', () => {
    seedStore([{ type: DEF.type, definition: DEF }]);
    expect(flowNodeRegistry.resolveNodeSpec(DEF.type).missing).toBeUndefined();
    seedStore([]);
    const spec = flowNodeRegistry.resolveNodeSpec(DEF.type);
    expect(spec.missing).toBe(true);
    expect(flowNodeRegistry.listNodeSpecs().some((s) => s.type === DEF.type)).toBe(false);
  });

  it('disabled definitions neither resolve nor list', () => {
    seedStore([{ type: DEF.type, definition: DEF, enabled: false }]);
    expect(flowNodeRegistry.resolveNodeSpec(DEF.type).missing).toBe(true);
    expect(flowNodeRegistry.listNodeSpecs().some((s) => s.type === DEF.type)).toBe(false);
  });

  it('repeat resolutions return a stable spec identity (memoized by digest)', () => {
    seedStore([{ type: DEF.type, definition: DEF }]);
    const a = flowNodeRegistry.resolveNodeSpec(DEF.type);
    const b = flowNodeRegistry.resolveNodeSpec(DEF.type);
    expect(a).toBe(b);
  });
});
