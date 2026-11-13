// @vitest-environment jsdom
/**
 * A tool's row keeps the shape the pages and their checks rely on: the title is a heading, its one
 * sentence follows it, anything more comes under the sentence, and the buttons are the row's own.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Database } from 'lucide-react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ToolRow } from './ToolRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('shows a heading, its sentence, what comes under it, and the buttons', async () => {
  await act(async () => root.render(
    <ToolRow icon={Database} title="App backend & database" description="One plain sentence." actions={<><button>Backend code</button><button>Database records</button></>}>
      <a href="/somewhere">A link under the sentence</a>
    </ToolRow>,
  ));
  const heading = container.querySelector('h3')!;
  expect(heading.textContent).toBe('App backend & database');
  const sentence = heading.nextElementSibling!;
  expect(sentence.tagName).toBe('P');
  expect(sentence.textContent).toBe('One plain sentence.');
  expect(sentence.nextElementSibling?.textContent).toBe('A link under the sentence');
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Backend code', 'Database records']);
  // The buttons stand apart from the text, so they can sit beside it or drop under it.
  expect(heading.parentElement!.contains(container.querySelector('button'))).toBe(false);
  // The icon is decoration: the heading names the row.
  expect(container.querySelector('svg')!.closest('[aria-hidden="true"]')).not.toBeNull();
});

it('is one row and nothing else, so a list can put a hairline between rows', async () => {
  await act(async () => root.render(<ToolRow icon={Database} title="A tool" description="What it gives you." actions={<button>Open</button>} />));
  expect(container.children).toHaveLength(1);
  expect(container.firstElementChild!.tagName).toBe('SECTION');
});
