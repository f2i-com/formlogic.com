// SRV-406: service-action projections. Every invocable catalog action becomes a palette entry
// that inserts an ordinary, pre-addressed `service_action` node — one execution protocol, not
// two. The properties that matter: projections never enter a stored graph as their own type,
// non-invocable lanes are never offered, and withdrawing the catalog withdraws the entries.
import { afterEach, describe, expect, it } from 'vitest';
import { flowNodeRegistry } from './FlowNodeRegistry';
import { projectServiceAction, serviceNodeProvider, setServiceCatalogForProjections } from './serviceNodeProvider';
import type { DesktopServiceCatalog } from '../../../client-runtime/desktop/desktopClient';

const catalog = {
  schemaVersion: 3,
  definitions: [
    {
      id: 'openai-api',
      name: 'OpenAI API',
      capabilities: ['llm.chat'],
      actions: [
        { id: 'chat.complete', title: 'Chat completion', sideEffects: 'external-write' },
        // An event-stream lane: the host refuses to invoke these as flow nodes.
        { id: 'realtime.stream.connect', title: 'Realtime', streaming: { mode: 'events' } },
      ],
    },
    {
      id: 'mock.images',
      name: 'Mock Images',
      provider: 'mock',
      capabilities: ['image.generate'],
      actions: [{ id: 'generate-image', title: 'Generate image', description: 'Make a picture.' }],
    },
  ],
} as unknown as DesktopServiceCatalog;

afterEach(() => setServiceCatalogForProjections(null));

describe('serviceNodeProvider (SRV-406)', () => {
  it('offers one palette entry per INVOCABLE action and skips event-stream lanes', () => {
    setServiceCatalogForProjections(catalog);
    const types = serviceNodeProvider.list({} as never).map((s) => s.type);

    expect(types).toContain('service-projection:openai-api/chat.complete');
    expect(types).toContain('service-projection:mock.images/generate-image');
    // Offering a lane the host refuses to invoke would be an entry that can only fail.
    expect(types).not.toContain('service-projection:openai-api/realtime.stream.connect');
  });

  it('inserts an ordinary service_action node, pre-addressed', () => {
    const spec = projectServiceAction(
      catalog.definitions[1],
      catalog.definitions[1].actions[0],
    );
    // The palette identity is NOT what the graph stores.
    expect(spec.type).toBe('service-projection:mock.images/generate-image');
    expect(spec.insertAs).toBe('service_action');
    expect(spec.defaultData).toEqual({ definitionId: 'mock.images', actionId: 'generate-image' });
    expect(spec.executable).toBe(true);
    // Provenance travels to the author choosing between services.
    expect(spec.description).toContain('from mock');
  });

  it('never resolves a stored node type — saved graphs contain only real node types', () => {
    setServiceCatalogForProjections(catalog);
    expect(serviceNodeProvider.resolve('service-projection:mock.images/generate-image', {} as never)).toBeUndefined();
    // …and the registry treats an unknown projection identity as missing, not insertable.
    expect(flowNodeRegistry.resolveKnownNodeSpec('service-projection:mock.images/generate-image')).toBeUndefined();
    // The palette lookup DOES find it (that is the insertion path).
    expect(flowNodeRegistry.resolvePaletteSpec('service-projection:mock.images/generate-image')).toBeDefined();
  });

  it('withdraws every projection when the catalog goes away', () => {
    setServiceCatalogForProjections(catalog);
    expect(serviceNodeProvider.list({} as never).length).toBeGreaterThan(0);

    // Desktop unpaired: stale entries would advertise services that cannot be reached.
    setServiceCatalogForProjections(null);
    expect(serviceNodeProvider.list({} as never)).toEqual([]);
    expect(flowNodeRegistry.resolvePaletteSpec('service-projection:mock.images/generate-image')).toBeUndefined();
  });

  it('bumps the registry revision so a live palette picks the change up', () => {
    const before = flowNodeRegistry.registryRevision();
    setServiceCatalogForProjections(catalog);
    expect(flowNodeRegistry.registryRevision()).toBeGreaterThan(before);
  });
});
