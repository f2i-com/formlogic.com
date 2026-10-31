/**
 * A `pattern` rule is a regular expression the form's author wrote, and it runs on the visitor's
 * main thread: the checks that use it answer at once, on Next and on Submit, so the Worker engine
 * and its time limit are out of reach there. A pattern that backtracks without end would freeze the
 * tab of everyone filling the form in, so a pattern of that shape is not run here. The server still
 * checks it, under a limit of its own, and its answer is the one that counts: refusing here would
 * leave a field no answer could pass, on a rule the server accepts.
 *
 * This reads the pattern's shape and cannot prove it safe. It catches a repeated group with no step
 * that every round must pass (`(a+)+`, `(\w+\s?)*`) and a repeated choice (`(a|a)*`), and misses a
 * landmark the repeat can also match (`(a+a)+`). A group with a real landmark stays allowed, because
 * `^[a-z]+(-[a-z]+)*$` and `^([\w-]+\.)+[a-z]{2,}$` are ordinary rules.
 */
const MAX_PATTERN_LENGTH = 500;

const GROUP_PREFIX = /^\(\?(?:[:=!]|<[=!]|<[^>]*>)/;
const QUANTIFIER = /^(?:[+*?]|\{(\d+)(?:(,)(\d*))?\})\??/;

interface OpenGroup {
  /** A step taken exactly once, in every round: with one, the rounds can only be split one way. */
  landmark: boolean;
  /** A `.` that repeats: it matches whatever the landmark does, so the landmark proves nothing. */
  wild: boolean;
  /** A `|` of its own. */
  branches: boolean;
}

/** The index just past the `[...]` that starts at `start`. */
function endOfClass(pattern: string, start: number): number {
  let i = start + 1;
  while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** True when `pattern` must not be run on the main thread. */
export function isUnsafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return true;
  const open: OpenGroup[] = [{ landmark: false, wild: false, branches: false }];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '(') {
      open.push({ landmark: false, wild: false, branches: false });
      i += GROUP_PREFIX.exec(pattern.slice(i))?.[0].length ?? 1;
      continue;
    }
    if (ch === '|') open[open.length - 1].branches = true;
    if (ch === '|' || ch === '^' || ch === '$') {
      i++;
      continue;
    }
    const closed = ch === ')' && open.length > 1 ? open.pop() : undefined;
    i = ch === '\\' ? i + 2 : ch === '[' ? endOfClass(pattern, i) : i + 1;

    const quantifier = QUANTIFIER.exec(pattern.slice(i));
    i += quantifier?.[0].length ?? 0;
    const [text = '', least, comma, most] = quantifier ?? [];
    const repeats = text[0] === '+' || text[0] === '*' || (comma === ',' && (most === '' || Number(most) > Number(least)));
    const once = text === '' || (least !== undefined && comma === undefined);
    if (closed && repeats && (closed.branches || closed.wild || !closed.landmark)) return true;

    const parent = open[open.length - 1];
    if (once && (closed ? closed.landmark && !closed.branches : ch !== '.')) parent.landmark = true;
    if (closed?.wild || (ch === '.' && repeats)) parent.wild = true;
  }
  return false;
}
