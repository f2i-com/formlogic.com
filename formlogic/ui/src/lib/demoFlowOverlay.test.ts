// The demo Flows overlay merge — a shared-demo visitor's creates/edits/deletes live in
// IndexedDB, never on the server; reads merge the seeded flows with that overlay. This covers
// the pure merge (mergeFlowOverlay); the IndexedDB read/write wrappers around it are thin.
import { describe, it, expect } from 'vitest';
import { mergeFlowOverlay } from './demoLocal';
import type { FlowDefinition } from '../types/flows';

const flow = (id: string, over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  id,
  ownerUserId: 'demo',
  appId: null,
  name: id,
  slug: id,
  description: null,
  engine: 'f2i',
  flowJson: { nodes: [], edges: [] },
  inputSchema: null,
  outputSchema: null,
  nodeCapabilities: null,
  version: 1,
  enabled: true,
  createdAt: '2026-07-07T00:00:00.000Z',
  updatedAt: '2026-07-07T00:00:00.000Z',
  ...over,
});

const empty = { created: [] as FlowDefinition[], edits: {}, deleted: [] as string[] };

describe('mergeFlowOverlay', () => {
  it('returns the seeded flows unchanged when the overlay is empty', () => {
    const server = [flow('a'), flow('b')];
    expect(mergeFlowOverlay(null, server, empty)).toEqual(server);
  });

  it('applies field edits to a seeded flow (name/enabled/graph)', () => {
    const server = [flow('a', { name: 'Original', enabled: true })];
    const out = mergeFlowOverlay(null, server, {
      ...empty,
      edits: { a: { name: 'Edited', enabled: false } },
    });
    expect(out[0]).toMatchObject({ id: 'a', name: 'Edited', enabled: false });
  });

  it('hides a tombstoned seeded flow', () => {
    const server = [flow('a'), flow('b')];
    const out = mergeFlowOverlay(null, server, { ...empty, deleted: ['a'] });
    expect(out.map((f) => f.id)).toEqual(['b']);
  });

  it('prepends locally-created flows for the matching scope only', () => {
    const server = [flow('seed', { appId: null })];
    const created = [
      flow('demolocal_ws', { appId: null, name: 'My workspace flow' }),
      flow('demolocal_app', { appId: 'app1', name: 'App-scoped flow' }),
    ];
    const ws = mergeFlowOverlay(null, server, { ...empty, created });
    expect(ws.map((f) => f.id)).toEqual(['demolocal_ws', 'seed']); // local first, seeded after
    const app = mergeFlowOverlay('app1', [], { ...empty, created });
    expect(app.map((f) => f.id)).toEqual(['demolocal_app']);
  });

  it('a deleted local flow does not reappear', () => {
    const created = [flow('demolocal_x', { appId: null })];
    const out = mergeFlowOverlay(null, [], { ...empty, created, deleted: ['demolocal_x'] });
    expect(out).toEqual([]);
  });

  it('does not duplicate a local flow when a demo-aware API result is overlaid again', () => {
    const local = flow('demolocal_app', { appId: 'app1', name: 'Browser flow' });
    const out = mergeFlowOverlay('app1', [local], {
      ...empty,
      created: [local],
    });
    expect(out.map((item) => item.id)).toEqual(['demolocal_app']);
  });

  it('edit + delete of the same seeded id: delete wins', () => {
    const server = [flow('a')];
    const out = mergeFlowOverlay(null, server, { ...empty, edits: { a: { name: 'X' } }, deleted: ['a'] });
    expect(out).toEqual([]);
  });
});
