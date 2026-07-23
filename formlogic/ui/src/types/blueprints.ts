// Blueprints (extensible-flows plan §11/§14): the persistent high-level Diagram.
// Elements hold BOTH nodes and relationship edges (elementType 'edge'); all diagram
// mutation rides the §14.3 operation-batch commit gateway — there are no direct writes.

export type BlueprintElementType =
  | 'app'
  | 'form'
  | 'screen'
  | 'event'
  | 'flow'
  | 'intelligence'
  | 'service'
  | 'actor'
  | 'decision'
  | 'group'
  | 'note'
  /** §11A.1b drawing layer: freehand strokes, images, outlined shapes, text labels. */
  | 'ink'
  | 'image'
  | 'shape'
  | 'text'
  | 'edge';

export type BlueprintEdgeType =
  | 'contains'
  | 'triggers'
  | 'sends-data'
  | 'success'
  | 'failure'
  | 'invokes'
  | 'uses'
  | 'relation'
  | 'exposes';

export interface BlueprintElement {
  id: string;
  elementType: BlueprintElementType;
  /** Link to a real resource ({kind, id, version?}) — null while concept-only (§11.5). */
  resourceRef: Record<string, unknown> | null;
  /** Edge elements carry {edgeType, sourceId, targetId, state} here. */
  properties: Record<string, unknown>;
  /** Canvas-only state ({x, y, ...}); null when never placed. */
  layout: Record<string, unknown> | null;
}

export interface Blueprint {
  id: string;
  appId: string | null;
  name: string;
  status: string;
  semanticRevision: number;
  layoutRevision: number;
  viewport: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  /** Present on GET /api/blueprints/{id} only. */
  elements?: BlueprintElement[];
}

/** One §14.3 ID-addressed operation (never raw JSON Patch). */
export interface BlueprintOperation {
  operationId: string;
  type:
    | 'blueprint.element.create'
    | 'blueprint.element.update'
    | 'blueprint.element.delete'
    | 'blueprint.layout.set'
    | 'blueprint.viewport.set';
  targetId?: string;
  elementType?: BlueprintElementType;
  resourceRef?: Record<string, unknown> | null;
  properties?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  viewport?: Record<string, unknown>;
}

export interface BlueprintCommitResult {
  changeSetId: string;
  semanticRevision: number;
  layoutRevision: number;
}
