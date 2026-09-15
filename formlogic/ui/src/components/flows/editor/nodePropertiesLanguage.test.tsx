// @vitest-environment jsdom
// The properties panel of a code node (condition / logic_block) follows its language select
// (formlogic-python/1): the Monaco mode, the help and the "insert a value" chip syntax change
// with it, and changing it patches `language` alone, so the author's source is never rewritten.
// Monaco cannot mount in jsdom; a stand-in editor reports the language it was given and plays
// the editor's focus/insert calls.
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { editors } = vi.hoisted(() => ({
  editors: [] as Array<{ focus: () => void; inserted: string[] }>,
}));

vi.mock('../../ui/CodeEditor', async () => {
  const { useEffect } = await import('react');
  return {
    CodeEditor: ({ value, language, onMount }: { value: string; language?: string; onMount?: (editor: unknown) => void }) => {
      useEffect(() => {
        const record = { focus: () => {}, inserted: [] as string[] };
        editors.push(record);
        onMount?.({
          onDidFocusEditorText: (cb: () => void) => { record.focus = cb; },
          getSelection: () => ({}),
          executeEdits: (_source: string, edits: Array<{ text: string }>) => { record.inserted.push(...edits.map((e) => e.text)); },
          focus: () => {},
        });
        // Monaco mounts once per editor, whatever its props do later.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <textarea data-testid="code-editor" data-language={language} value={value} readOnly />;
    },
  };
});

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: { id: 'u1' } }),
}));

vi.mock('../../../client-runtime/desktop/desktopClient', () => ({
  desktopClient: {},
}));

import { NodeProperties } from './NodeProperties';
import { EMPTY_FLOW_EDITOR_CONTEXT } from './nodeCatalog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => { r.unmount(); });
    root = null;
  }
  editors.length = 0;
  document.body.innerHTML = '';
});

/** The panel over live node data: patches merge into it, as FlowEditor's onPatch does. */
function Harness({ type, initial, patches, hints }: { type: string; initial: Record<string, unknown>; patches: Array<Record<string, unknown>>; hints: string[] }) {
  const [data, setData] = useState(initial);
  return (
    <NodeProperties
      nodeId={`${type}-1`}
      type={type}
      data={data}
      onPatch={(patch) => { patches.push(patch); setData((d) => ({ ...d, ...patch })); }}
      onDelete={() => {}}
      forms={[]}
      context={EMPTY_FLOW_EDITOR_CONTEXT}
      insertHints={hints}
    />
  );
}

async function mount(type: string, initial: Record<string, unknown>, hints: string[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const patches: Array<Record<string, unknown>> = [];
  root = createRoot(container);
  await act(async () => { root!.render(<Harness type={type} initial={initial} patches={patches} hints={hints} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, patches };
}

function languageSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'python'));
  if (!select) throw new Error('no language select rendered');
  return select;
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function editor(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('[data-testid="code-editor"]');
  if (!el) throw new Error('no code editor rendered');
  return el;
}

async function clickChip(container: HTMLElement, hint: string) {
  const chip = [...container.querySelectorAll('button')].find((b) => b.textContent === hint);
  if (!chip) throw new Error(`no chip ${hint}`);
  await act(async () => { chip.click(); });
}

describe('NodeProperties — a code node follows its language select', () => {
  it('switching the language changes the editor and help, and keeps the source', async () => {
    const source = 'total = 1\nresult = total';
    const { container, patches } = await mount('logic_block', { expr: source, language: 'javascript' });

    expect(editor(container).dataset.language).toBe('javascript');
    expect(container.textContent).toContain('ZIPP sandboxed · JavaScript');
    expect(container.textContent).toContain('return it');

    await choose(languageSelect(container), 'python');

    expect(patches).toEqual([{ language: 'python' }]);
    expect(editor(container).dataset.language).toBe('python');
    expect(editor(container).value).toBe(source);
    expect(container.textContent).toContain('ZIPP sandboxed · Python');
    expect(container.textContent).toContain('no top-level return');

    await choose(languageSelect(container), 'javascript');
    expect(patches).toEqual([{ language: 'python' }, { language: 'javascript' }]);
    expect(editor(container).value).toBe(source);
  });

  it('a stored graph without a language is JavaScript', async () => {
    const { container } = await mount('condition', { expr: 'inputs.x > 1' });
    expect(languageSelect(container).value).toBe('javascript');
    expect(editor(container).dataset.language).toBe('javascript');
  });

  it('chip inserts subscript every segment in Python, and follow a later switch back to JavaScript', async () => {
    const { container } = await mount('condition', { expr: '', language: 'python' }, ['$inputs.from', '$event', '$nodes.lookup-1']);
    expect(editors).toHaveLength(1);
    await act(async () => { editors[0].focus(); });

    await clickChip(container, '$inputs.from');
    await clickChip(container, '$nodes.lookup-1');
    await clickChip(container, '$event');
    expect(editors[0].inserted).toEqual(['inputs["from"]', 'nodes["lookup-1"]', 'event']);

    // The same Monaco instance stays mounted; its inserts use the language chosen now.
    await choose(languageSelect(container), 'javascript');
    await clickChip(container, '$inputs.from');
    expect(editors).toHaveLength(1);
    expect(editors[0].inserted.at(-1)).toBe('inputs.from');
  });
});
