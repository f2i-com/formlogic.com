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
 * The engine's error text in the author's terms. Locations in logic_block.py become the
 * author's own line numbers, and frames and locations in main.py and formlogic.py (the
 * driver) are dropped.
 *
 * ZIPP writes a location as `(logic_block.py:N[:C])`, `Python: logic_block.py:N:C: ...`,
 * `File "logic_block.py", line N` in a traceback, or `logic_block.py: ... (at offset K)`
 * for a construct its parser rejects (K counts characters into the file).
 */
export function authorMessage(raw: string, mode: PythonMode, source: string): string {
  const offset = LINE_OFFSETS[mode];
  const authorLines = Math.max(1, source.split(/\r\n?|\n/).length);
  const line = (engineLine: number) => Math.min(authorLines, Math.max(1, engineLine - offset));
  const block = blockSource(mode, source);
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
          const before = block.slice(0, Number(at));
          const column = Number(at) - before.lastIndexOf('\n');
          return `${message} (line ${line(before.split('\n').length)}, col ${column})`;
        })
        .replace(/logic_block\.py:(\d+)(?::(\d+))?/g, (_m, n: string, col?: string) =>
          `line ${line(Number(n))}${col ? `, col ${col}` : ''}`)
        .replace(/File "logic_block\.py", line (\d+)/g, (_m, n: string) => `line ${line(Number(n))}`)
        .replace(/ \((main|formlogic)\.py:\d+(:\d+)?\)/g, '')
        .replace(/, in __formlogic_value__$/, ', in <expression>')
        .replace(/, in __formlogic_condition__$/, ', in <condition>')
    );
  return lines.join('\n').replace(/\nTraceback \(most recent call last\):$/, '');
}
