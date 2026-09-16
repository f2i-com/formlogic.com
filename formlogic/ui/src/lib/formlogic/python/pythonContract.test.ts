// formlogic-python/1's host-independent pieces: the file set, wrappers, line offsets, the
// attempt order and the error mapping. Pure; the engine runs in pythonLogicCorpus.test.ts.
import { describe, expect, it } from 'vitest';
import {
  BLOCK_WRAPPERS,
  CONTRACT_FILES,
  CONTRACT_ID,
  ENTRIES,
  LINE_OFFSETS,
  authorMessage,
  blockSource,
  mapAuthorLines,
  modesFor,
  projectFiles,
  type PythonMode,
} from './pythonContract';

describe('formlogic-python/1 contract', () => {
  it('names itself', () => {
    expect(CONTRACT_ID).toBe('formlogic-python/1');
  });

  it('puts 3 generated lines before an expression or condition and 1 before a module', () => {
    expect(LINE_OFFSETS).toEqual({ flowExpression: 3, flowModule: 1, condition: 3, applogic: 1, syntax: 1 });
    for (const [mode, [before]] of Object.entries(BLOCK_WRAPPERS)) {
      const block = blockSource(mode as keyof typeof BLOCK_WRAPPERS, 'AUTHOR');
      expect(block.split('\n').indexOf('AUTHOR'), mode).toBe(LINE_OFFSETS[mode as keyof typeof LINE_OFFSETS]);
      expect(before.startsWith('from formlogic import *\n'), mode).toBe(true);
    }
  });

  it('ships LF sources whatever the checkout does', () => {
    for (const text of [...Object.values(CONTRACT_FILES), ...Object.values(ENTRIES)]) {
      expect(text).not.toMatch(/\r/);
    }
  });

  it('builds the three-file project around the author code', () => {
    const files = projectFiles('flowModule', 'result = 1');
    expect(files).toEqual({
      'main.py': ENTRIES.flowModule,
      'formlogic.py': CONTRACT_FILES['formlogic.py'],
      'logic_block.py': 'from formlogic import *\nresult = 1',
    });
  });

  it('tries an expression, then a module, for flow code; one mode for everything else', () => {
    expect(modesFor('flow', 'inputs["n"]')).toEqual(['flowExpression', 'flowModule']);
    expect(modesFor('flow', '# only a comment\n\n')).toEqual(['flowModule']);
    expect(modesFor('flow', '')).toEqual(['flowModule']);
    expect(modesFor('condition', '')).toEqual(['condition']);
    expect(modesFor('applogic', 'def run(ctx):\n    return 1')).toEqual(['applogic']);
    expect(modesFor('syntax', 'x = 1')).toEqual(['syntax']);
  });
});

// The wrapper arithmetic, as `script-profile.schema.json` `$defs/pythonMode.lineOffset`
// describes it. A consumer's runner does this for itself from the served `modes`; the browser
// host has no such runner and does it here, from the very numbers the profile carries.
describe('mapAuthorLines', () => {
  it('subtracts the wrapper from every location form the engine writes, and touches nothing else', () => {
    const raw =
      "KeyError: 'missing' (logic_block.py:3)\nTraceback (most recent call last):\n  File \"main.py\", line 7, in __formlogic_run__\n  File \"logic_block.py\", line 4, in <module>\n  File \"logic_block.py\", line 3, in f\n  File \"formlogic.py\", line 90, in helper";
    // Renumbered, and NOTHING else: the file keeps its name, frames in other files keep their
    // lines, no text is added, dropped or reworded. That pass is authorMessage's, below.
    expect(mapAuthorLines(raw, 'flowModule', 'def f():\n    return x["missing"]\nresult = f()')).toBe(
      "KeyError: 'missing' (logic_block.py:2)\nTraceback (most recent call last):\n  File \"main.py\", line 7, in __formlogic_run__\n  File \"logic_block.py\", line 3, in <module>\n  File \"logic_block.py\", line 2, in f\n  File \"formlogic.py\", line 90, in helper"
    );
    expect(mapAuthorLines("Python: logic_block.py:2:1: 'return' outside function", 'flowModule', 'return 1')).toBe(
      "Python: logic_block.py:1:1: 'return' outside function"
    );
    // A column is never adjusted: lineOffset is a line count and it is the only knob.
    expect(mapAuthorLines('SyntaxError: invalid syntax (logic_block.py:5:3)', 'condition', 'a\nb')).toBe(
      'SyntaxError: invalid syntax (logic_block.py:2:3)'
    );
  });

  it('reads the splice line as the author first line, because Python blames the line a statement opens', () => {
    // `    return (` is the wrapper's last line and opens the author's expression, so the engine
    // reports anything inside that expression there - including an error two author lines down.
    expect(mapAuthorLines('KeyError (logic_block.py:3)', 'flowExpression', 'a\nb\nc')).toBe('KeyError (logic_block.py:1)');
    expect(mapAuthorLines('KeyError (logic_block.py:5)', 'condition', 'a\nb\nc')).toBe('KeyError (logic_block.py:2)');
  });

  it('leaves a location above the author first line exactly as the engine wrote it', () => {
    // logic_block.py:1 is `from formlogic import *` and :2 is the `def`: wrapper lines that fail
    // on their own account. Reporting them as author line 1 blames the author for a line they
    // never wrote, so they are left alone - never 0, never negative, never clamped to 1.
    expect(mapAuthorLines('ImportError: x (logic_block.py:1)', 'flowExpression', 'a\nb')).toBe('ImportError: x (logic_block.py:1)');
    expect(mapAuthorLines('SyntaxError: x (logic_block.py:2:9)', 'condition', 'a\nb')).toBe('SyntaxError: x (logic_block.py:2:9)');
    expect(mapAuthorLines('File "logic_block.py", line 2, in <module>', 'flowExpression', 'a\nb')).toBe(
      'File "logic_block.py", line 2, in <module>'
    );
    // A module wrapper is one line and ends in a newline, so its splice IS line 1: there is no
    // wrapper interior to protect and every location the engine reports is the author's.
    expect(mapAuthorLines('ImportError: x (logic_block.py:1)', 'flowModule', 'a\nb')).toBe('ImportError: x (logic_block.py:1)');
  });

  it('caps a location past the author last line at that line', () => {
    // The expression wrapper's closing lines come after the author's code and compile on their
    // own, so a failure there is reached because of what the author wrote.
    expect(mapAuthorLines('SyntaxError: unexpected EOF while parsing (logic_block.py:6:1)', 'flowExpression', '(1 +')).toBe(
      'SyntaxError: unexpected EOF while parsing (logic_block.py:1:1)'
    );
  });

  it('rebases a character offset by the length of the wrapper text before the author code', () => {
    const source = 'x = 1\nawait x';
    const at = blockSource('flowModule', source).indexOf('await');
    expect(mapAuthorLines(`logic_block.py: Python: await are not supported yet (at offset ${at})`, 'flowModule', source)).toBe(
      'logic_block.py: Python: await are not supported yet (at offset 6)'
    );
    // Inside the wrapper: left whole, for the same reason a line above the splice is.
    expect(mapAuthorLines('logic_block.py: Python: x (at offset 5)', 'flowModule', source)).toBe(
      'logic_block.py: Python: x (at offset 5)'
    );
    // Past the author's text: capped at its length, never beyond it.
    expect(mapAuthorLines('logic_block.py: Python: x (at offset 999)', 'flowModule', source)).toBe(
      `logic_block.py: Python: x (at offset ${source.length})`
    );
  });
});

// FormLogic's own pass over a message whose lines are ALREADY the author's: what it drops,
// renames and tidies. It does no arithmetic - a runner that unfolded a profile mode has done it
// (script-profile.schema.json, pythonMode.lineOffset), and mapAuthorLines does it for this host.
describe('authorMessage', () => {
  it('renames a location without renumbering it', () => {
    // The old shape subtracted the wrapper here too. It cannot any more: it is not told which
    // mode ran, and subtracting twice moves every line a second time. `line 3` rather than
    // `line 2` is what proves the arithmetic is gone.
    expect(authorMessage("KeyError: 'missing' (logic_block.py:3)", 'a\nb\nc')).toBe("KeyError: 'missing' (line 3)");
    expect(authorMessage('  File "logic_block.py", line 3, in <module>', 'a\nb\nc')).toBe('  line 3, in <module>');
    expect(authorMessage("Python: logic_block.py:1:1: 'return' outside function", 'return 1')).toBe(
      "Python: line 1, col 1: 'return' outside function"
    );
    expect(authorMessage('SyntaxError: invalid syntax (logic_block.py:2:3)', 'a\nb')).toBe(
      'SyntaxError: invalid syntax (line 2, col 3)'
    );
  });

  it('drops the driver frames, a traceback left with no frames, and driver locations in the message', () => {
    const raw = 'TypeError: the result holds a set (formlogic.py:470)\nTraceback (most recent call last):\n  File "main.py", line 9, in __formlogic_run__\n  File "formlogic.py", line 470, in _plain';
    expect(authorMessage(raw, 'result = {1}')).toBe('TypeError: the result holds a set');
    const recursive = 'ValueError: too deep (formlogic.py:12)\nTraceback (most recent call last):\n  File "formlogic.py", line 12, in _plain\n  [Previous line repeated 64 more times]';
    expect(authorMessage(recursive, 'result = v')).toBe('ValueError: too deep');
    const author = "RecursionError: deep (logic_block.py:1)\nTraceback (most recent call last):\n  File \"logic_block.py\", line 1, in f\n  [Previous line repeated 99 more times]";
    expect(authorMessage(author, 'def f():\n    return f()')).toBe(
      'RecursionError: deep (line 1)\nTraceback (most recent call last):\n  line 1, in f\n  [Previous line repeated 99 more times]'
    );
  });

  it('names the expression and condition wrappers for what they are', () => {
    const raw = "KeyError: 'k' (logic_block.py:1)\nTraceback (most recent call last):\n  File \"logic_block.py\", line 1, in __formlogic_value__";
    expect(authorMessage(raw, 'x["k"]')).toBe("KeyError: 'k' (line 1)\nTraceback (most recent call last):\n  line 1, in <expression>");
    expect(authorMessage(raw.replace('__formlogic_value__', '__formlogic_condition__'), 'x["k"]')).toMatch(/in <condition>$/);
  });

  it('turns a rebased character offset into a line and column of the AUTHOR text', () => {
    // The offset that arrives counts into `source`, not into the wrapped block: measuring it
    // against the block would put a first-line column one wrapper-width out.
    const source = 'x = 1\nawait x';
    expect(authorMessage('logic_block.py: Python: await are not supported yet (at offset 6)', source)).toBe(
      'Python: await are not supported yet (line 2, col 1)'
    );
    expect(authorMessage('logic_block.py: Python: x (at offset 0)', source)).toBe('Python: x (line 1, col 1)');
  });
});

// Both halves in the order the browser host applies them: the same raw engine text the host saw
// before the split, and the same answer. A consumer applies the first half from the profile's
// `modes` (its runner does) and the second from its own presentation rules.
describe('mapAuthorLines then authorMessage (the browser host pipeline)', () => {
  const through = (raw: string, mode: PythonMode, source: string) => authorMessage(mapAuthorLines(raw, mode, source), source);

  it('answers what the host answered before the arithmetic moved', () => {
    const raw =
      "KeyError: 'missing' (logic_block.py:3)\nTraceback (most recent call last):\n  File \"main.py\", line 7, in __formlogic_run__\n  File \"logic_block.py\", line 4, in <module>\n  File \"logic_block.py\", line 3, in f\n  File \"formlogic.py\", line 90, in helper";
    expect(through(raw, 'flowModule', 'def f():\n    return x["missing"]\nresult = f()')).toBe(
      "KeyError: 'missing' (line 2)\nTraceback (most recent call last):\n  line 3, in <module>\n  line 2, in f"
    );
    expect(through("Python: logic_block.py:2:1: 'return' outside function", 'flowModule', 'return 1')).toBe(
      "Python: line 1, col 1: 'return' outside function"
    );
    expect(through('SyntaxError: invalid syntax (logic_block.py:5:3)', 'condition', 'a\nb')).toBe(
      'SyntaxError: invalid syntax (line 2, col 3)'
    );
    const expression = "KeyError: 'k' (logic_block.py:4)\nTraceback (most recent call last):\n  File \"logic_block.py\", line 4, in __formlogic_value__";
    expect(through(expression, 'flowExpression', 'x["k"]')).toBe(
      "KeyError: 'k' (line 1)\nTraceback (most recent call last):\n  line 1, in <expression>"
    );
    const source = 'x = 1\nawait x';
    const at = blockSource('flowModule', source).indexOf('await');
    expect(through(`logic_block.py: Python: await are not supported yet (at offset ${at})`, 'flowModule', source)).toBe(
      'Python: await are not supported yet (line 2, col 1)'
    );
    expect(through('SyntaxError: unexpected EOF while parsing (logic_block.py:6:1)', 'flowExpression', '(1 +')).toBe(
      'SyntaxError: unexpected EOF while parsing (line 1, col 1)'
    );
    expect(through('ValueError: x (logic_block.py:1)', 'flowModule', 'raise ValueError("x")')).toBe('ValueError: x (line 1)');
  });
});
