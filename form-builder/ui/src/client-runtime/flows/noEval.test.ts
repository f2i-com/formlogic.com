import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (docs/FORMLOGIC_FLOWS.md §4): ALL user-authored flow code runs in the QuickJS
// sandbox — condition/logic_block go through the lib/formlogic engine, and templates /
// selectors are pure string/path ops. This static scan asserts the flows runtime NEVER
// reaches for `eval` or `new Function`, so no author-supplied code can escape the sandbox
// into the browser's own realm.

const here = dirname(fileURLToPath(import.meta.url));

/** Source (non-test) files in the flows runtime dir. */
function flowSourceFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(here, f));
}

// Match `eval(` / `window.eval` / `new Function(` — tolerate whitespace; comments that merely
// mention the words are word-boundary-safe because we require the call punctuation.
const EVAL_RE = /\beval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;

describe('flows runtime — no eval / new Function', () => {
  const files = flowSourceFiles();

  it('scans at least the core runtime files', () => {
    const names = files.map((f) => f.replace(/\\/g, '/').split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['nodes.ts', 'flowExecutor.ts', 'flowDispatcher.ts', 'selectors.ts']));
  });

  it.each(files)('%s contains no eval() or new Function()', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(EVAL_RE.test(src), `${file} must not call eval()`).toBe(false);
    expect(NEW_FUNCTION_RE.test(src), `${file} must not use new Function()`).toBe(false);
  });
});
