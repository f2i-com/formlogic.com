import { describe, expect, it } from 'vitest';
import { MAX_DIFF_ROWS, diffText, textLines } from './textDiff';

const numbered = (count: number, change: (n: number) => string = n => `line ${n}`) => Array.from({ length: count }, (_, i) => change(i + 1)).join('\n');
/** One side of a stretch as "12 text" lines, the differing ones marked with *. */
const side = (rows: { line: number; text: string; changed: boolean }[]) => rows.map(row => `${row.changed ? '*' : ' '}${row.line} ${row.text}`);

describe('textLines', () => {
  it('reads lines whichever ending they have, and a final line break ends the last line', () => {
    expect(textLines('a\nb\n')).toEqual(['a', 'b']);
    expect(textLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
    expect(textLines('')).toEqual([]);
    expect(textLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffText', () => {
  it('finds nothing between texts whose lines are the same', () => {
    expect(diffText('a\nb\n', 'a\r\nb')).toEqual({ hunks: [], removed: 0, added: 0, exact: true, cut: false });
  });

  it('shows a changed line with the lines around it, each side numbered as its own text is', () => {
    const before = numbered(20);
    const after = numbered(20, n => (n === 10 ? 'line ten' : `line ${n}`));
    const diff = diffText(before, after);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(side(diff.hunks[0].before)).toEqual([' 7 line 7', ' 8 line 8', ' 9 line 9', '*10 line 10', ' 11 line 11', ' 12 line 12', ' 13 line 13']);
    expect(side(diff.hunks[0].after)).toEqual([' 7 line 7', ' 8 line 8', ' 9 line 9', '*10 line ten', ' 11 line 11', ' 12 line 12', ' 13 line 13']);
  });

  it('keeps each side\'s own numbers when lines are added and removed', () => {
    const diff = diffText('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nnew 1\nnew 2\nc\nd\ne\nf\nh');
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(2);
    // The two changes are close enough to be one stretch.
    expect(diff.hunks).toHaveLength(1);
    expect(side(diff.hunks[0].before)).toEqual([' 1 a', ' 2 b', ' 3 c', ' 4 d', ' 5 e', ' 6 f', '*7 g', ' 8 h']);
    expect(side(diff.hunks[0].after)).toEqual([' 1 a', ' 2 b', '*3 new 1', '*4 new 2', ' 5 c', ' 6 d', ' 7 e', ' 8 f', ' 9 h']);
  });

  it('shows differences far apart as stretches of their own', () => {
    const diff = diffText(numbered(60), numbered(60, n => (n === 5 || n === 50 ? `changed ${n}` : `line ${n}`)));
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].before[0].line).toBe(2);
    expect(diff.hunks[1].after.find(row => row.changed)).toEqual({ line: 50, text: 'changed 50', changed: true });
  });

  it('shows a file that grew from nothing, or to nothing, as one side alone', () => {
    const grown = diffText('', 'a\nb');
    expect(grown.hunks).toEqual([{ before: [], after: [{ line: 1, text: 'a', changed: true }, { line: 2, text: 'b', changed: true }] }]);
    const emptied = diffText('a\nb', '');
    expect([emptied.removed, emptied.added, emptied.hunks[0].after]).toEqual([2, 0, []]);
  });

  it('shows texts too long to compare line by line as wholly changed between what they share, and says so', () => {
    // 2,500 differing lines against 2,500: more than the comparison's table takes.
    const before = ['start', ...Array.from({ length: 2500 }, (_, i) => `old ${i}`), 'end'].join('\n');
    const after = ['start', ...Array.from({ length: 2500 }, (_, i) => `new ${i}`), 'end'].join('\n');
    const diff = diffText(before, after);
    expect(diff.exact).toBe(false);
    expect([diff.removed, diff.added]).toEqual([2500, 2500]);
    expect(diff.hunks[0].before[0]).toEqual({ line: 1, text: 'start', changed: false });
    // And no more rows than a page can show are handed over.
    expect(diff.cut).toBe(true);
    expect(diff.hunks.reduce((rows, hunk) => rows + hunk.before.length + hunk.after.length, 0)).toBeLessThanOrEqual(MAX_DIFF_ROWS + 1);
  });

  it('compares long texts that differ in a few places exactly', () => {
    const before = numbered(20000);
    const after = numbered(20000, n => (n === 15000 ? 'changed' : `line ${n}`));
    const diff = diffText(before, after);
    expect(diff.exact).toBe(true);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].after.find(row => row.changed)!.line).toBe(15000);
  });
});
