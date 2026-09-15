// @vitest-environment jsdom
// The App logic editor's script language (formlogic-python/1): a card's language select sets
// the editor's language and the saved script's `language` and never rewrites the source; a
// script added in Python starts from Python. Monaco cannot mount in jsdom; a stand-in editor
// reports its language and value.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateApp } = vi.hoisted(() => ({ updateApp: vi.fn() }));

vi.mock('../ui/CodeEditor', () => ({
  CodeEditor: ({ value, language }: { value: string; language?: string }) => (
    <textarea data-testid="code-editor" data-language={language} value={value} readOnly />
  ),
}));
vi.mock('../../lib/api', () => ({ api: { updateApp } }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../client-runtime/logic/appLogicHost', () => ({ runHook: vi.fn() }));

import { AppLogicPanel } from './AppLogicPanel';
import { STARTERS } from './appLogicStarters';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  updateApp.mockReset();
  updateApp.mockResolvedValue({ data: {} });
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => { r.unmount(); });
    root = null;
  }
  document.body.innerHTML = '';
});

const JS_SOURCE = 'function run(ctx) {\n  return { ok: true };\n}';

async function mount(initialLogic?: CustomAppLogicBundle) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AppLogicPanel appId="app-1" initialLogic={initialLogic} />); });
  // The panel starts collapsed.
  await click(container.querySelector('button[aria-expanded]') as HTMLElement);
  return container;
}

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => { el.click(); });
}

async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('no select');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

const editor = (scope: ParentNode) => scope.querySelector<HTMLTextAreaElement>('[data-testid="code-editor"]')!;
const cardLanguage = (scope: ParentNode) => scope.querySelector<HTMLSelectElement>('select[aria-label="Language"]');

function savedScripts(): Array<Record<string, unknown>> {
  const [, payload] = updateApp.mock.calls.at(-1) as [string, { customLogic: CustomAppLogicBundle }];
  // What goes over the wire: an unset language is no key at all.
  return (JSON.parse(JSON.stringify(payload.customLogic)) as CustomAppLogicBundle).scripts as unknown as Array<Record<string, unknown>>;
}

describe('AppLogicPanel — script language', () => {
  it("a card's language select changes the editor and the saved language, never the source", async () => {
    const container = await mount({
      version: 1,
      runtime: 'quickjs',
      scripts: [{ id: 's1', hook: 'onBeforeSubmit', runtime: 'quickjs', source: JS_SOURCE }],
    });
    expect(cardLanguage(container)?.value).toBe('javascript');
    expect(editor(container).dataset.language).toBe('javascript');

    await choose(cardLanguage(container), 'python');
    expect(editor(container).dataset.language).toBe('python');
    expect(editor(container).value).toBe(JS_SOURCE);
    expect(container.textContent).toContain('def run(ctx):');

    await click(button(container, 'Save app logic'));
    expect(updateApp).toHaveBeenCalledTimes(1);
    expect(savedScripts()).toEqual([
      expect.objectContaining({ id: 's1', runtime: 'quickjs', source: JS_SOURCE, language: 'python' }),
    ]);

    await choose(cardLanguage(container), 'javascript');
    await click(button(container, 'Save app logic'));
    expect(savedScripts()[0]).not.toHaveProperty('language');
    expect(savedScripts()[0].source).toBe(JS_SOURCE);
  });

  it('a script added in Python starts from the Python starter', async () => {
    const container = await mount();
    await click(button(container, 'Add script'));
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();

    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.startsWith('onBeforeSubmit')));
    const languageLabel = [...dialog.querySelectorAll('label')].find((l) => l.textContent === 'Language');
    await choose(dialog.querySelector<HTMLSelectElement>(`#${CSS.escape(languageLabel!.htmlFor)}`), 'python');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Starter example')));
    await click(button(dialog, 'Add script'));

    expect(editor(container).value).toBe(STARTERS.python.onBeforeSubmit);
    expect(editor(container).dataset.language).toBe('python');
    expect(cardLanguage(container)?.value).toBe('python');
    await click(button(container, 'Save app logic'));
    expect(savedScripts()).toEqual([
      expect.objectContaining({ hook: 'onBeforeSubmit', runtime: 'quickjs', language: 'python', source: STARTERS.python.onBeforeSubmit }),
    ]);
  });
});
