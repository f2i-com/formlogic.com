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
  modesFor,
  projectFiles,
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

describe('authorMessage', () => {
  it('maps each location form to the author line and drops the driver', () => {
    const raw = "KeyError: 'missing' (logic_block.py:3)\nTraceback (most recent call last):\n  File \"main.py\", line 7, in __formlogic_run__\n  File \"logic_block.py\", line 4, in <module>\n  File \"logic_block.py\", line 3, in f\n  File \"formlogic.py\", line 90, in helper";
    expect(authorMessage(raw, 'flowModule', 'def f():\n    return x["missing"]\nresult = f()')).toBe(
      "KeyError: 'missing' (line 2)\nTraceback (most recent call last):\n  line 3, in <module>\n  line 2, in f"
    );
    expect(authorMessage("Python: logic_block.py:2:1: 'return' outside function", 'flowModule', 'return 1')).toBe(
      "Python: line 1, col 1: 'return' outside function"
    );
    expect(authorMessage('SyntaxError: invalid syntax (logic_block.py:5:3)', 'condition', 'a\nb')).toBe(
      'SyntaxError: invalid syntax (line 2, col 3)'
    );
  });

  it('drops a traceback left with no frames, and driver locations in the message', () => {
    const raw = 'TypeError: the result holds a set (formlogic.py:470)\nTraceback (most recent call last):\n  File "main.py", line 9, in __formlogic_run__\n  File "formlogic.py", line 470, in _plain';
    expect(authorMessage(raw, 'flowModule', 'result = {1}')).toBe('TypeError: the result holds a set');
    const recursive = 'ValueError: too deep (formlogic.py:12)\nTraceback (most recent call last):\n  File "formlogic.py", line 12, in _plain\n  [Previous line repeated 64 more times]';
    expect(authorMessage(recursive, 'flowModule', 'result = v')).toBe('ValueError: too deep');
    const author = "RecursionError: deep (logic_block.py:2)\nTraceback (most recent call last):\n  File \"logic_block.py\", line 2, in f\n  [Previous line repeated 99 more times]";
    expect(authorMessage(author, 'flowModule', 'def f():\n    return f()')).toBe(
      'RecursionError: deep (line 1)\nTraceback (most recent call last):\n  line 1, in f\n  [Previous line repeated 99 more times]'
    );
  });

  it('names the expression and condition wrappers for what they are', () => {
    const raw = "KeyError: 'k' (logic_block.py:4)\nTraceback (most recent call last):\n  File \"logic_block.py\", line 4, in __formlogic_value__";
    expect(authorMessage(raw, 'flowExpression', 'x["k"]')).toBe("KeyError: 'k' (line 1)\nTraceback (most recent call last):\n  line 1, in <expression>");
    const condition = raw.replace('__formlogic_value__', '__formlogic_condition__');
    expect(authorMessage(condition, 'condition', 'x["k"]')).toMatch(/in <condition>$/);
  });

  it('turns a character offset into the author line and column', () => {
    const source = 'x = 1\nawait x';
    const at = blockSource('flowModule', source).indexOf('await');
    expect(authorMessage(`logic_block.py: Python: await are not supported yet (at offset ${at})`, 'flowModule', source)).toBe(
      'Python: await are not supported yet (line 2, col 1)'
    );
  });

  it('never points outside the author code', () => {
    // The expression wrapper's closing lines come after the author's last line.
    expect(authorMessage('SyntaxError: unexpected EOF while parsing (logic_block.py:6:1)', 'flowExpression', '(1 +')).toBe(
      'SyntaxError: unexpected EOF while parsing (line 1, col 1)'
    );
    expect(authorMessage('ValueError: x (logic_block.py:1)', 'flowModule', 'raise ValueError("x")')).toBe('ValueError: x (line 1)');
  });
});
