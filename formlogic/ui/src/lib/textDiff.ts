// Two versions of a text file, compared line by line, for showing them side by side (an app's
// History section, components/apps/SoftnHistory). Plain and small on purpose: the lines the two
// share at their start and end are set aside, and what is between is compared by its longest run
// of common lines. No dependency.

export interface DiffRow {
  /** The line's number in its own text, from 1. */
  line: number;
  text: string;
  /** The other text has no such line here. */
  changed: boolean;
}

/** One stretch where the texts differ, with a few lines around it: the same stretch of each. */
export interface DiffHunk {
  before: DiffRow[];
  after: DiffRow[];
}

export interface TextDiff {
  hunks: DiffHunk[];
  /** Lines only the first text has, and lines only the second has. */
  removed: number;
  added: number;
  /** False when the two were too long to compare line by line: their middle is shown as all changed. */
  exact: boolean;
  /** True when there were more differing stretches than are shown. */
  cut: boolean;
}

/** The most cells the comparison's table may have: about 2,000 changed lines against 2,000. */
const MAX_CELLS = 4_000_000;
/** The most rows (both sides together) one comparison shows. */
export const MAX_DIFF_ROWS = 3000;
/** Unchanged lines shown before and after each difference. */
const CONTEXT = 3;

/** A text's lines, whichever line ending it uses; a final line break ends the last line, it does not start another. */
export function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Each line of both texts as 0 (in both), 1 (only in the first) or 2 (only in the second), in reading order. */
function compare(a: string[], b: string[]): { ops: Uint8Array; exact: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const n = a.length - start - end;
  const m = b.length - start - end;
  const ops = new Uint8Array(start + n + m + end);
  let at = start;
  if (n * m > MAX_CELLS) {
    ops.fill(1, at, at + n); ops.fill(2, at + n, at + n + m);
    return { ops, exact: false };
  }
  // Lines as numbers, so the table below compares numbers.
  const ids = new Map<string, number>();
  const id = (line: string) => { let known = ids.get(line); if (known === undefined) { known = ids.size; ids.set(line, known); } return known; };
  const left = Int32Array.from({ length: n }, (_, i) => id(a[start + i]));
  const right = Int32Array.from({ length: m }, (_, j) => id(b[start + j]));
  // table[i][j]: the longest run of common lines from line i of the first and line j of the second.
  // It is at most the shorter side, which is under 65,536 while the table is within MAX_CELLS.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) { ops[at++] = 0; i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops[at++] = 1; i++; }
    else { ops[at++] = 2; j++; }
  }
  while (i < n) { ops[at++] = 1; i++; }
  while (j < m) { ops[at++] = 2; j++; }
  // A line in both takes one entry, not two: the common end follows what was written.
  return { ops: ops.subarray(0, at + end), exact: true };
}

/** What differs between two texts, as stretches to show side by side. No stretch when their lines are the same. */
export function diffText(before: string, after: string): TextDiff {
  const a = textLines(before);
  const b = textLines(after);
  const { ops, exact } = compare(a, b);
  // Which entries are shown: each changed line and the lines around it.
  const shown = new Uint8Array(ops.length);
  let removed = 0, added = 0;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k] === 0) continue;
    if (ops[k] === 1) removed++; else added++;
    for (let near = Math.max(0, k - CONTEXT); near <= Math.min(ops.length - 1, k + CONTEXT); near++) shown[near] = 1;
  }
  const hunks: DiffHunk[] = [];
  let rows = 0, cut = false;
  let i = 0, j = 0;
  let hunk: DiffHunk | null = null;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (shown[k]) {
      if (rows >= MAX_DIFF_ROWS) { cut = true; break; }
      if (!hunk) {
        hunk = { before: [], after: [] };
        hunks.push(hunk);
      }
      if (op !== 2) { hunk.before.push({ line: i + 1, text: a[i], changed: op === 1 }); rows++; }
      if (op !== 1) { hunk.after.push({ line: j + 1, text: b[j], changed: op === 2 }); rows++; }
    } else {
      hunk = null;
    }
    if (op !== 2) i++;
    if (op !== 1) j++;
  }
  return { hunks, removed, added, exact, cut };
}
