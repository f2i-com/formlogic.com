// Where things go on a diagram's canvas: a new card in the nearest free spot (never over another),
// the side of a card that faces another (where a line joins it), a tidy arrangement of the whole
// sketch by its lines (Dagre, as the database designer lays out its tables), and what a line says.
import dagre from 'dagre';

/**
 * What a line says and how it ends, by what it means (§11.5). Two forms' records: a crow's foot
 * at the end with many, a bar at the end with one (the form at the line's end gets the question
 * that names the other, so one of these has many of those). What happens next (a flow started,
 * records added, a role using something): an arrow. A plain link between notes and shapes: a line.
 */
export function lineEnds(edgeType: string | undefined, cardinality: string | undefined): { label?: string; start?: string; end?: string } {
  if (edgeType === 'relation' && cardinality) {
    if (cardinality === '1:1') return { label: 'one each', start: 'sketch-one', end: 'sketch-one' };
    if (cardinality === 'N:M') return { label: 'many of each', start: 'sketch-many', end: 'sketch-many' };
    return { label: 'has many', start: 'sketch-one', end: 'sketch-many' };
  }
  if (edgeType === 'triggers') return { label: 'starts', end: 'sketch-arrow' };
  if (edgeType === 'sends-data') return { label: 'adds records', end: 'sketch-arrow' };
  if (edgeType === 'uses') return { label: 'uses', end: 'sketch-arrow' };
  if (edgeType && edgeType !== 'relation') return { label: edgeType.replace(/-/g, ' '), end: 'sketch-arrow' };
  return {};
}

export interface Spot { x: number; y: number }
export interface Box extends Spot { w: number; h: number }
export type Side = 't' | 'r' | 'b' | 'l';

/** The room kept round a card, so two never touch. */
const GAP = 32;
/** How far apart the spots tried are, and how many rings of them out from where it was wanted. */
const STEP = 40;
const RINGS = 40;

// The spots tried, nearest first, for each way of weighing a step sideways against one down.
const tries = new Map<string, Array<[number, number]>>();
function triesFor(lean: { x: number; y: number }): Array<[number, number]> {
  const key = `${lean.x},${lean.y}`;
  let found = tries.get(key);
  if (!found) {
    const all: Array<[number, number, number]> = [];
    // Of two spots as near, below comes before above and right before left: the way one reads.
    for (let dx = -RINGS; dx <= RINGS; dx += 1) for (let dy = -RINGS; dy <= RINGS; dy += 1) if (dx || dy) all.push([dx, dy, (dx * lean.x) ** 2 + (dy * lean.y) ** 2 + (dy < 0 ? 0.5 : 0) + (dx < 0 ? 0.25 : 0)]);
    found = all.sort((a, b) => a[2] - b[2]).map(([dx, dy]) => [dx, dy]);
    tries.set(key, found);
  }
  return found;
}

/**
 * The top-left corner nearest `want` where a card of `size` covers none of `taken` (with room
 * round each): `want` itself when it is free. `lean` weighs a step each way: a narrow screen
 * makes sideways dear ({ x: 3, y: 1 }), so the next card goes below, where it can be seen.
 */
export function freeSpot(want: Spot, size: { w: number; h: number }, taken: Box[], lean: { x: number; y: number } = { x: 1, y: 1 }): Spot {
  const clear = (x: number, y: number) => taken.every((box) =>
    x + size.w + GAP <= box.x || x >= box.x + box.w + GAP || y + size.h + GAP <= box.y || y >= box.y + box.h + GAP);
  if (clear(want.x, want.y)) return { x: Math.round(want.x), y: Math.round(want.y) };
  for (const [dx, dy] of triesFor(lean)) {
    const x = want.x + dx * STEP;
    const y = want.y + dy * STEP;
    if (clear(x, y)) return { x: Math.round(x), y: Math.round(y) };
  }
  return { x: Math.round(want.x), y: Math.round(want.y) };
}

/** The side of `to` that faces `from`: where a line between them joins `to`. */
export function facingSide(from: Box, to: Box): Side {
  const dx = from.x + from.w / 2 - (to.x + to.w / 2);
  const dy = from.y + from.h / 2 - (to.y + to.h / 2);
  // Wide cards: a card beside another is joined at its side, one above or below at its edge.
  if (Math.abs(dx) / Math.max(1, (from.w + to.w) / 2) >= Math.abs(dy) / Math.max(1, (from.h + to.h) / 2)) return dx > 0 ? 'r' : 'l';
  return dy > 0 ? 'b' : 't';
}

/**
 * The cards laid out left to right along their lines, each line's start before its end, the
 * group's top-left corner where it was: each card's new top-left corner, by its id.
 */
export function tidy(cards: Array<Box & { id: string }>, lines: Array<{ from: string; to: string }>): Map<string, Spot> {
  const placed = new Map<string, Spot>();
  if (!cards.length) return placed;
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 110, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const card of cards) graph.setNode(card.id, { width: card.w, height: card.h });
  for (const line of lines) if (line.from !== line.to && graph.hasNode(line.from) && graph.hasNode(line.to)) graph.setEdge(line.from, line.to);
  dagre.layout(graph);
  const laid = cards.map((card) => { const node = graph.node(card.id); return { id: card.id, x: node.x - card.w / 2, y: node.y - card.h / 2 }; });
  const left = Math.min(...cards.map((card) => card.x));
  const top = Math.min(...cards.map((card) => card.y));
  const fromLeft = Math.min(...laid.map((spot) => spot.x));
  const fromTop = Math.min(...laid.map((spot) => spot.y));
  for (const spot of laid) placed.set(spot.id, { x: Math.round(spot.x - fromLeft + left), y: Math.round(spot.y - fromTop + top) });
  return placed;
}
