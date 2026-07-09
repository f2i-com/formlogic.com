// The demo form-flow binding overlay merge. Shared-demo visitors can create/edit/delete
// standalone form bindings locally in IndexedDB; this covers the pure server+overlay merge.
import { describe, expect, it } from 'vitest';
import { mergeFormBindingOverlay } from './demoLocal';
import type { FlowBinding } from '../types/flows';

const binding = (id: string, over: Partial<FlowBinding> = {}): FlowBinding => ({
  id,
  appId: null,
  formId: 'form1',
  connectorId: null,
  flowDefinitionId: 'flow1',
  flow: 'flow-one',
  event: 'form.submitted',
  mode: 'async',
  condition: null,
  inputMap: null,
  outputActions: null,
  timeoutMs: 30000,
  retryPolicy: null,
  fallbackPolicy: null,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-07-07T00:00:00.000Z',
  updatedAt: '2026-07-07T00:00:00.000Z',
  ...over,
});

const empty = { created: [] as FlowBinding[], edits: {}, deleted: [] as string[] };

describe('mergeFormBindingOverlay', () => {
  it('returns the seeded bindings unchanged when the overlay is empty', () => {
    const server = [binding('a'), binding('b')];
    expect(mergeFormBindingOverlay('form1', server, empty)).toEqual(server);
  });

  it('applies field edits to a seeded binding', () => {
    const server = [binding('a', { enabled: true, mode: 'async' })];
    const out = mergeFormBindingOverlay('form1', server, {
      ...empty,
      edits: { a: { enabled: false, mode: 'sync', timeoutMs: 1000 } },
    });
    expect(out[0]).toMatchObject({ id: 'a', enabled: false, mode: 'sync', timeoutMs: 1000 });
  });

  it('hides a tombstoned seeded binding', () => {
    const server = [binding('a'), binding('b')];
    const out = mergeFormBindingOverlay('form1', server, { ...empty, deleted: ['a'] });
    expect(out.map((row) => row.id)).toEqual(['b']);
  });

  it('prepends locally-created bindings for the matching form only', () => {
    const server = [binding('seed')];
    const created = [
      binding('demolocal_form1', { formId: 'form1', flow: 'local-one' }),
      binding('demolocal_form2', { formId: 'form2', flow: 'local-two' }),
    ];
    const out = mergeFormBindingOverlay('form1', server, { ...empty, created });
    expect(out.map((row) => row.id)).toEqual(['demolocal_form1', 'seed']);
  });

  it('a deleted local binding does not reappear', () => {
    const created = [binding('demolocal_x')];
    const out = mergeFormBindingOverlay('form1', [], { ...empty, created, deleted: ['demolocal_x'] });
    expect(out).toEqual([]);
  });

  it('edit + delete of the same seeded id: delete wins', () => {
    const server = [binding('a')];
    const out = mergeFormBindingOverlay('form1', server, { ...empty, edits: { a: { enabled: false } }, deleted: ['a'] });
    expect(out).toEqual([]);
  });
});
