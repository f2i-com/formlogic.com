import { describe, expect, it } from 'vitest';
import { facingSide, freeSpot, lineEnds, tidy } from './placement';

describe('what a line says', () => {
  it('says how many of each for two forms, with a crow’s foot at the end with many', () => {
    expect(lineEnds('relation', '1:N')).toEqual({ label: 'has many', start: 'sketch-one', end: 'sketch-many' });
    expect(lineEnds('relation', '1:1')).toEqual({ label: 'one each', start: 'sketch-one', end: 'sketch-one' });
    expect(lineEnds('relation', 'N:M')).toEqual({ label: 'many of each', start: 'sketch-many', end: 'sketch-many' });
  });

  it('points at what happens next, and says nothing on a plain link', () => {
    expect(lineEnds('triggers', undefined)).toEqual({ label: 'starts', end: 'sketch-arrow' });
    expect(lineEnds('sends-data', undefined)).toEqual({ label: 'adds records', end: 'sketch-arrow' });
    expect(lineEnds('uses', undefined)).toEqual({ label: 'uses', end: 'sketch-arrow' });
    expect(lineEnds('relation', undefined)).toEqual({});
  });
});

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('where a new card goes', () => {
  it('goes where it was wanted when nothing is there', () => {
    expect(freeSpot({ x: 100.4, y: 50.6 }, { w: 200, h: 80 }, [])).toEqual({ x: 100, y: 51 });
  });

  it('never covers another card: five added at the same spot each find room of their own', () => {
    const taken: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let n = 0; n < 5; n += 1) {
      const spot = freeSpot({ x: 300, y: 200 }, { w: 200, h: 80 }, taken);
      for (const other of taken) expect(overlaps({ ...spot, w: 200, h: 80 }, other)).toBe(false);
      taken.push({ ...spot, w: 200, h: 80 });
    }
    // Each stays near where it was wanted.
    for (const box of taken) expect(Math.hypot(box.x - 300, box.y - 200)).toBeLessThan(400);
  });

  it('goes below rather than beside on a narrow screen, where sideways is out of sight', () => {
    const first = { x: 100, y: 100, w: 160, h: 64 };
    const wide = freeSpot({ x: 100, y: 100 }, { w: 160, h: 64 }, [first]);
    const narrow = freeSpot({ x: 100, y: 100 }, { w: 160, h: 64 }, [first], { x: 3, y: 1 });
    expect(Math.abs(narrow.x - 100)).toBeLessThan(Math.abs(narrow.y - 100));
    expect(narrow.y).toBeGreaterThanOrEqual(first.y + first.h);
    expect(overlaps({ ...wide, w: 160, h: 64 }, first)).toBe(false);
  });
});

describe('where a line joins a card', () => {
  const card = { x: 400, y: 300, w: 200, h: 80 };
  it('joins the side that faces the other card', () => {
    expect(facingSide({ x: 0, y: 300, w: 200, h: 80 }, card)).toBe('l');
    expect(facingSide({ x: 800, y: 320, w: 200, h: 80 }, card)).toBe('r');
    expect(facingSide({ x: 420, y: 0, w: 200, h: 80 }, card)).toBe('t');
    expect(facingSide({ x: 380, y: 600, w: 200, h: 80 }, card)).toBe('b');
  });
});

describe('tidying up', () => {
  it('lays cards out left to right along their lines, where the group was, none over another', () => {
    const cards = [
      { id: 'orders', x: 500, y: 90, w: 200, h: 80 },
      { id: 'customers', x: 520, y: 100, w: 200, h: 80 },
      { id: 'lines', x: 510, y: 95, w: 200, h: 120 },
    ];
    const placed = tidy(cards, [{ from: 'customers', to: 'orders' }, { from: 'orders', to: 'lines' }]);
    const customers = placed.get('customers')!;
    const orders = placed.get('orders')!;
    const lines = placed.get('lines')!;
    expect(customers.x).toBeLessThan(orders.x);
    expect(orders.x).toBeLessThan(lines.x);
    expect(Math.min(customers.x, orders.x, lines.x)).toBe(500);
    expect(Math.min(customers.y, orders.y, lines.y)).toBe(90);
    const boxes = cards.map((card) => ({ ...placed.get(card.id)!, w: card.w, h: card.h }));
    for (const [n, a] of boxes.entries()) for (const b of boxes.slice(n + 1)) expect(overlaps(a, b)).toBe(false);
  });
});
