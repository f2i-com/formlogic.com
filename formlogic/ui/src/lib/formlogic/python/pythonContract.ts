// formlogic-python/1: how FormLogic runs author-written Python on ZIPP web-python.
//
// One evaluation is one fresh engine over a three-file project: main.py (the entry for the
// kind), formlogic.py (the context names, the prelude helpers and the result normalizer)
// and logic_block.py (the author's code behind a star-import header, wrapped per mode). The
// context crosses only as the entry function's argument, never as program text. These
// sources, the wrappers and the line offsets are the contract: another host (OAIY) runs the
// same bytes to mean the same thing.
//
//   flow       one expression, else statements whose top-level `result` is the value (None
//              when unset). The block is compiled as one parenthesised expression first; if
//              that fails to compile, nothing ran (Python compiles before it runs anything),
//              and it is compiled again as a module. A block with no code is a module, so it
//              means None rather than an empty tuple. There is no top-level return: Python
//              has none, and re-indenting the author's code to allow one would change the
//              contents of multi-line strings.
//   condition  one expression, judged by Python truthiness in the guest.
//   applogic   a module defining run(ctx); the value is what run returns, None without run.
//   syntax     compiles the block as a module and runs none of it.
//
// A wrapper is not a boundary: a column-0 `)` can close it and put code in logic_block's
// module scope, which the author owns anyway. The boundary is the VM.
import FORMLOGIC_PY from './formlogic.py?raw';
import ENTRY_FLOW_EXPRESSION from './entry-flow-expression.py?raw';
import ENTRY_FLOW_MODULE from './entry-flow-module.py?raw';
import ENTRY_CONDITION from './entry-condition.py?raw';
import ENTRY_APPLOGIC from './entry-applogic.py?raw';
import ENTRY_SYNTAX from './entry-syntax.py?raw';

export const CONTRACT_ID = 'formlogic-python/1';

export type PythonKind = 'flow' | 'condition' | 'applogic' | 'syntax';
export type PythonMode = 'flowExpression' | 'flowModule' | 'condition' | 'applogic' | 'syntax';

export const ENTRY_MODULE = 'main';
export const ENTRY_FUNCTION = '__formlogic_run__';
const BLOCK_FILE = 'logic_block.py';
const HEADER = 'from formlogic import *\n';

// ?raw text follows the checkout's line endings (CRLF on a Windows working tree). The
// contract is LF so every checkout and every host runs the same bytes.
const lf = (text: string): string => text.replace(/\r\n?/g, '\n');

/** Guest files every evaluation carries, whatever the mode. */
export const CONTRACT_FILES: Readonly<Record<string, string>> = Object.freeze({
  'formlogic.py': lf(FORMLOGIC_PY),
});

/** main.py for each mode. */
export const ENTRIES: Readonly<Record<PythonMode, string>> = Object.freeze({
  flowExpression: lf(ENTRY_FLOW_EXPRESSION),
  flowModule: lf(ENTRY_FLOW_MODULE),
  condition: lf(ENTRY_CONDITION),
  applogic: lf(ENTRY_APPLOGIC),
  syntax: lf(ENTRY_SYNTAX),
});

/** The text logic_block.py puts before and after the author's code, per mode. */
export const BLOCK_WRAPPERS: Readonly<Record<PythonMode, readonly [before: string, after: string]>> = Object.freeze({
  flowExpression: [`${HEADER}def __formlogic_value__():\n    return (\n`, '\n    )\n'],
  flowModule: [HEADER, ''],
  condition: [`${HEADER}def __formlogic_condition__():\n    return bool((\n`, '\n    ))\n'],
  applogic: [HEADER, ''],
  syntax: [HEADER, ''],
});

/** Generated lines before the author's first line: engine line N is author line N - offset. */
export const LINE_OFFSETS: Readonly<Record<PythonMode, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BLOCK_WRAPPERS).map(([mode, [before]]) => [mode, before.split('\n').length - 1])
  ) as Record<PythonMode, number>
);

const PYTHON_KINDS: readonly string[] = ['flow', 'condition', 'applogic', 'syntax'];

export function isPythonKind(kind: string): kind is PythonKind {
  return PYTHON_KINDS.includes(kind);
}

/** Whether a block has code: blank lines and comment lines are not code. */
function hasCode(source: string): boolean {
  return source.split(/\r\n?|\n/).some((line) => {
    const text = line.trim();
    return text !== '' && !text.startsWith('#');
  });
}

/**
 * The modes a kind tries, in order. Only 'flow' has two, and the second runs only when the
 * first failed to compile (the engine reports a 'source' error while the project
 * initializes).
 */
export function modesFor(kind: PythonKind, source: string): readonly PythonMode[] {
  if (kind === 'flow') return hasCode(source) ? ['flowExpression', 'flowModule'] : ['flowModule'];
  return [kind];
}

export function blockSource(mode: PythonMode, source: string): string {
  const [before, after] = BLOCK_WRAPPERS[mode];
  return before + source + after;
}

/** The project initPythonProject receives: entry, contract files and the wrapped block. */
export function projectFiles(mode: PythonMode, source: string): Record<string, string> {
  return { [`${ENTRY_MODULE}.py`]: ENTRIES[mode], ...CONTRACT_FILES, [BLOCK_FILE]: blockSource(mode, source) };
}

/**
 * The engine's message with locations in logic_block.py moved onto the author's own lines.
 *
 * This is the arithmetic the served profile describes rather than performs: a mode's
 * `lineOffset` (scripts/build-script-profile.mjs, oaiy.com
 * protocol/v1/script-profile.schema.json `$defs/pythonMode`) says how many generated lines
 * precede the author's first, and a consumer's mode-aware runner subtracts it before the result
 * leaves. This host has no such runner in front of it, so it applies the identical rule here -
 * one implementation of the rule, two callers of it, and the corpus proves they agree.
 *
 * ZIPP writes a location in a project file four ways: `(logic_block.py:N)`,
 * `(logic_block.py:N:C)` (also bare, as `Python: logic_block.py:N:C: ...`),
 * `File "logic_block.py", line N` in a traceback, and `logic_block.py: ... (at offset K)` for a
 * construct its parser rejects, where K counts UTF-16 units into the file. Each is renumbered
 * and NOTHING else is: the file keeps its name, frames in other files keep their lines, and no
 * text is added, dropped or reworded. Dropping and renaming is authorMessage's pass.
 *
 * Which line an engine line means, in three tiers:
 *   * BELOW the wrapper (N > lineOffset): N - lineOffset, capped at the author's last line. A
 *     location past the end can only be in the wrapper's closing text, which compiles on its
 *     own, so it is reached because of what the author wrote.
 *   * ON the splice line (N === lineOffset), where the wrapper ends in a newline: line 1.
 *     Python reports a multi-line statement at the line that OPENS it, and the expression
 *     wrapper's last line (`    return (`) opens the author's expression.
 *   * ABOVE it: left exactly as the engine wrote it. `from formlogic import *` and the `def`
 *     header fail on their own account and are not the author's to answer for; reporting no
 *     line is honest where reporting line 1 is not.
 *
 * Columns are never adjusted - lineOffset is a line count and it is the only knob.
 */
export function mapAuthorLines(raw: string, mode: PythonMode, source: string): string {
  const [before] = BLOCK_WRAPPERS[mode];
  const offset = LINE_OFFSETS[mode];
  const authorLines = Math.max(1, source.split(/\r\n?|\n/).length);
  // The author's text begins on its own line only when the wrapper ends with one.
  const splice = before.endsWith('\n') ? offset : offset + 1;
  /** null: the location is inside the wrapper and is not the author's to own. */
  const line = (engineLine: number): number | null =>
    engineLine < splice ? null : Math.min(authorLines, Math.max(1, engineLine - offset));
  return raw
    .replace(/(^|\n)(logic_block\.py: .*?) \(at offset (\d+)\)/g, (whole, lead: string, head: string, k: string) => {
      const at = Number(k) - before.length;
      return at < 0 ? whole : `${lead}${head} (at offset ${Math.min(source.length, at)})`;
    })
    .replace(/File "logic_block\.py", line (\d+)/g, (whole, n: string) => {
      const at = line(Number(n));
      return at === null ? whole : `File "logic_block.py", line ${at}`;
    })
    .replace(/logic_block\.py:(\d+)(?::(\d+))?/g, (whole, n: string, col?: string) => {
      const at = line(Number(n));
      return at === null ? whole : `logic_block.py:${at}${col ? `:${col}` : ''}`;
    });
}

/**
 * The engine's error text in FormLogic's terms, over lines that are ALREADY the author's.
 *
 * No arithmetic happens here. The numbers arriving have been moved onto the author's own lines
 * either by the mode-aware runner that unfolded the served profile or by mapAuthorLines above,
 * and subtracting a wrapper a second time would move every line twice over. What is left is
 * presentation, and it is FormLogic's own: frames and locations in main.py and formlogic.py (the
 * driver) are dropped, a location in logic_block.py is renamed - renamed, not renumbered - to
 * `line N`, and the wrapper's generated function names are given the names an author knows them
 * by. A `logic_block.py:N` a runner deliberately left alone (a line inside the wrapper) is
 * renamed like any other: this pass cannot tell one from another, and it is not told, because
 * the alternative is a second copy of the arithmetic here.
 *
 * A `(at offset K)` counts into the author's `source`, not into the wrapped block - the runner
 * rebased it - so the line and column are measured against `source`.
 */
export function authorMessage(raw: string, source: string): string {
  let droppedLast = false;
  const lines = raw
    .split('\n')
    .filter((text) => {
      const driver = /^\s*File "(main|formlogic)\.py", line \d+/.test(text)
        || (droppedLast && /^\s*\[Previous line repeated \d+ more times?\]$/.test(text));
      droppedLast = driver;
      return !driver;
    })
    .map((text) =>
      text
        .replace(/^logic_block\.py: (.*) \(at offset (\d+)\)$/, (_m, message: string, at: string) => {
          const before = source.slice(0, Number(at));
          const column = Number(at) - before.lastIndexOf('\n');
          return `${message} (line ${before.split('\n').length}, col ${column})`;
        })
        .replace(/logic_block\.py:(\d+)(?::(\d+))?/g, (_m, n: string, col?: string) =>
          `line ${n}${col ? `, col ${col}` : ''}`)
        .replace(/File "logic_block\.py", line (\d+)/g, (_m, n: string) => `line ${n}`)
        .replace(/ \((main|formlogic)\.py:\d+(:\d+)?\)/g, '')
        .replace(/, in __formlogic_value__$/, ', in <expression>')
        .replace(/, in __formlogic_condition__$/, ', in <condition>')
    );
  return lines.join('\n').replace(/\nTraceback \(most recent call last\):$/, '');
}
