// The demo diagrams mini gateway (lib/demoLocal.ts applyDemoBlueprintOperations) is the
// pure core behind api.ts's demolocal_ blueprint overlay — these tests pin that it
// mirrors the server's §14.3 batch semantics: semantic batches conflict-check against
// baseSemanticRevision and bump semanticRevision; layout-only batches never conflict.
import { describe, expect, it } from 'vitest';
import { applyDemoBlueprintOperations, type DemoBlueprintStored } from './demoLocal';

function fresh(): DemoBlueprintStored {
  return {
    row: {
      id: 'demolocal_bp1',
      appId: null,
      name: 'Sketch',
      status: 'draft',
      semanticRevision: 0,
      layoutRevision: 0,
      viewport: null,
      createdAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
    },
    elements: [],
  };
}

describe('applyDemoBlueprintOperations', () => {
  it('creates, updates, lays out, and deletes elements with the right revision bumps', () => {
    let stored = fresh();

    const created = applyDemoBlueprintOperations(stored, {
      baseSemanticRevision: 0,
      operations: [
        { operationId: 'op1', type: 'blueprint.element.create', targetId: 'el-a', elementType: 'form', properties: { title: 'Orders' }, layout: { x: 10, y: 20 } },
        { operationId: 'op2', type: 'blueprint.element.create', targetId: 'el-b', elementType: 'note', properties: { text: 'hi' } },
      ],
    });
    if (!created.ok) throw new Error('create batch refused');
    expect(created.result.semanticRevision).toBe(1);
    expect(created.result.layoutRevision).toBe(1);
    expect(created.stored.elements).toHaveLength(2);
    expect(created.stored.elements[0]).toMatchObject({ id: 'el-a', elementType: 'form', resourceRef: null, layout: { x: 10, y: 20 } });
    stored = created.stored;

    // Layout-only batch: no baseSemanticRevision needed, semanticRevision untouched.
    const dragged = applyDemoBlueprintOperations(stored, {
      operations: [{ operationId: 'op3', type: 'blueprint.layout.set', targetId: 'el-a', layout: { x: 99, y: 1 } }],
    });
    if (!dragged.ok) throw new Error('layout batch refused');
    expect(dragged.result.semanticRevision).toBe(1);
    expect(dragged.result.layoutRevision).toBe(2);
    expect(dragged.stored.elements.find((el) => el.id === 'el-a')!.layout).toEqual({ x: 99, y: 1 });
    stored = dragged.stored;

    // Update replaces the provided facets; delete removes.
    const edited = applyDemoBlueprintOperations(stored, {
      baseSemanticRevision: 1,
      operations: [
        { operationId: 'op4', type: 'blueprint.element.update', targetId: 'el-a', properties: { title: 'Orders v2' } },
        { operationId: 'op5', type: 'blueprint.element.delete', targetId: 'el-b' },
      ],
    });
    if (!edited.ok) throw new Error('edit batch refused');
    expect(edited.result.semanticRevision).toBe(2);
    expect(edited.stored.elements).toHaveLength(1);
    expect(edited.stored.elements[0].properties).toEqual({ title: 'Orders v2' });
    // The untouched facets survive an update (layout was not part of op4).
    expect(edited.stored.elements[0].layout).toEqual({ x: 99, y: 1 });
  });

  it('refuses a stale semantic batch with the revision_conflict contract', () => {
    const stored = fresh();
    const out = applyDemoBlueprintOperations(stored, {
      baseSemanticRevision: 5,
      operations: [{ operationId: 'op1', type: 'blueprint.element.create', targetId: 'el-a', elementType: 'form' }],
    });
    expect(out).toEqual({ ok: false, code: 'revision_conflict', currentSemanticRevision: 0 });
  });

  it('refuses malformed operations without mutating anything', () => {
    const stored = fresh();
    const noType = applyDemoBlueprintOperations(stored, {
      baseSemanticRevision: 0,
      operations: [{ operationId: 'op1', type: 'blueprint.element.create', targetId: 'el-a' }],
    });
    expect(noType.ok).toBe(false);
    const unknownTarget = applyDemoBlueprintOperations(stored, {
      baseSemanticRevision: 0,
      operations: [{ operationId: 'op1', type: 'blueprint.element.update', targetId: 'ghost', properties: {} }],
    });
    expect(unknownTarget.ok).toBe(false);
    expect(stored.elements).toHaveLength(0);
    expect(stored.row.semanticRevision).toBe(0);
  });

  it('sets the viewport as a layout-tier change', () => {
    const out = applyDemoBlueprintOperations(fresh(), {
      operations: [{ operationId: 'op1', type: 'blueprint.viewport.set', viewport: { x: 1, y: 2, zoom: 0.5 } }],
    });
    if (!out.ok) throw new Error('viewport batch refused');
    expect(out.stored.row.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(out.result.semanticRevision).toBe(0);
    expect(out.result.layoutRevision).toBe(1);
  });
});
