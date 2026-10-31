// @vitest-environment jsdom
// A 'custom' expression rule saved on a field (older forms, packs, MCP or API writes) is checked by
// no screen and not by the server. The editor says so instead of offering to test it as if it ran.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { ValidationRule } from '../../types/form';
import { ValidationEditor } from './ValidationEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let rules: ValidationRule[] = [];

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(initial: ValidationRule[]) {
  rules = initial;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ValidationEditor rules={initial} fieldType="short_text" onChange={(next) => { rules = next; }} />);
  });
}

function expand(label: string) {
  const header = Array.from(host!.querySelectorAll<HTMLElement>('[role="button"]')).find((el) => el.textContent?.includes(label));
  if (!header) throw new Error(`no rule headed ${label}`);
  act(() => header.click());
}

const custom: ValidationRule = { id: 'c1', type: 'custom', message: 'Must start with A', expression: 'value[0] === "A" ? null : "Must start with A"' };

it('says a custom expression rule is not checked, and offers no test run', () => {
  render([custom]);
  expect(host!.textContent).toContain('not checked');
  expand('not checked');
  expect(host!.textContent).toContain('is not checked when the form is filled in or submitted');
  expect(host!.textContent).toContain('value[0] === "A"');
  const buttons = Array.from(host!.querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(buttons).not.toContain('Test');
  expect(host!.querySelector('textarea')).toBeNull();
});

// Every screen refuses all answers to such a pattern rather than run it, so the author has to be told.
it('says when a pattern is one the browser will not run', () => {
  render([{ id: 'p1', type: 'pattern', value: '^(a+)+$', message: 'Letters only' }]);
  expand('Pattern:');
  expect(host!.textContent).toContain('could freeze a visitor’s browser');
});

it('says nothing against an ordinary pattern', () => {
  render([{ id: 'p1', type: 'pattern', value: '^[a-z]+(-[a-z]+)*$', message: 'A slug' }]);
  expand('Pattern:');
  expect(host!.textContent).not.toContain('could freeze');
});

it('still lets the author remove it', () => {
  render([custom, { id: 'm1', type: 'minLength', value: 2, message: 'Too short' }]);
  const remove = host!.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove validation rule"]');
  act(() => remove[0].click());
  expect(rules.map((r) => r.id)).toEqual(['m1']);
});
