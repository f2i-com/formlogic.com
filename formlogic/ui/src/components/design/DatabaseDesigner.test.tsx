// @vitest-environment jsdom
// The database designer as a person uses it: an empty diagram to start, a table added and filled in,
// a schema pasted from elsewhere, the design written as Mermaid, the review that makes the backend,
// and the design kept between visits. What a design makes is lib/databaseDesign.test.ts's; the
// diagram itself (React Flow) is tried in a browser.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDesign } from '../../lib/databaseDesign';
import { SHOP_MYSQL } from '../../lib/__fixtures__/schemas';

// React Flow needs a real layout engine: the diagram is stood in for by its tables and what it can be asked to do.
const diagram = vi.hoisted(() => ({ props: null as null | { design: DatabaseDesign; onSelect: (id: string | null) => void; onAdded?: (id: string) => void; onChange: (design: DatabaseDesign) => void; onImport?: () => void; onMermaid?: () => void; readOnly?: boolean } }));
vi.mock('./DesignDiagram', () => ({
  DesignDiagram: (props: NonNullable<typeof diagram.props>) => {
    if (!props.readOnly) diagram.props = props;
    return <div data-testid={props.readOnly ? 'preview' : 'diagram'}>{props.design.tables.map(table => table.name).join(',') || 'empty'}</div>;
  },
}));

const { DatabaseDesigner } = await import('./DatabaseDesigner');
const { newLink, newTable } = await import('../../lib/databaseDesign');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let onCreate: ReturnType<typeof vi.fn>;
let mode: 'diagram' | 'mermaid';

beforeEach(() => {
  localStorage.clear();
  diagram.props = null;
  onCreate = vi.fn(async () => true);
  mode = 'diagram';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(access: 'members' | 'application' = 'members', waiting: string | null = null) {
  await act(async () => root.render(<DatabaseDesigner appId="app-1" appName="Recipes" access={access} mode={mode} waiting={waiting}
    onMode={next => { mode = next; void render(access, waiting); }} onClose={() => {}} onCreate={onCreate} />));
}
const button = (name: string | RegExp) => [...document.body.querySelectorAll('button')].find(b => typeof name === 'string' ? b.textContent?.trim() === name || b.getAttribute('aria-label') === name : name.test(b.textContent ?? '')) as HTMLButtonElement;
const field = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const click = async (target: HTMLElement | undefined) => { expect(target).toBeDefined(); await act(async () => target!.click()); };
/** Types into a box as a person does: React hears the input. */
async function type(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
const shown = () => document.querySelector('[data-testid="diagram"]')?.textContent;
/** A table added as the diagram's Add a table does it. */
async function addTable(name: string) {
  const table = newTable(name, 'members');
  await act(async () => { diagram.props!.onChange({ ...diagram.props!.design, tables: [...diagram.props!.design.tables, table] }); diagram.props!.onAdded!(table.id); });
  return table;
}

describe('DatabaseDesigner', () => {
  it('starts empty, with nothing chosen for the owner', async () => {
    await render();
    expect(shown()).toBe('empty');
    expect(document.body.textContent).toContain('0 tables · 0 connections · 0 routes');
    expect(button('Review and create').disabled).toBe(true);
    // No examples, no steps: what the owner adds is all there is.
    expect(document.body.textContent).not.toMatch(/Bookings|A shop|Step 1/);
  });

  it('opens a table added on the diagram to fill in, and makes a backend of nothing but what was designed', async () => {
    await render();
    const recipes = await addTable('new_table');
    // The new table's editor is open, its name chosen to be typed over.
    const name = field('Name of the table') as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    await type(name, 'Recipes');
    await act(async () => name.blur());
    expect(shown()).toBe('recipes');
    await type(field('Name of the new detail') as HTMLInputElement, 'Cooking time');
    await type(field('What the new detail holds'), 'integer');
    await click(button('Add'));
    expect((field('Name of the detail cooking_time') as HTMLInputElement).value).toBe('cooking_time');
    await click(button('Review and create'));
    expect(document.body.querySelector('h2')!.textContent).toBe('Ready to make it');
    expect(document.body.textContent).toContain('1 table, 0 connections, and 4 routes for the app’s page.');
    await click(button('Create the backend'));
    const made = onCreate.mock.calls[0][0] as DatabaseDesign;
    expect(made.tables.map(table => [table.id, table.name, table.fields.map(f => `${f.name}:${f.kind}`)])).toEqual([[recipes.id, 'recipes', ['cooking_time:integer']]]);
    // Made: the design is no longer kept.
    expect(localStorage.getItem('formlogic:database-design:app-1')).toBeNull();
  });

  it('reads a schema pasted from MySQL, says what it left out, and adds it to the design or puts it in its place', async () => {
    await render();
    await addTable('notes');
    await click(button('Paste SQL'));
    await type(field('The schema') as HTMLTextAreaElement, SHOP_MYSQL);
    await click(button('Read it'));
    expect(document.body.textContent).toContain('Read as MySQL: 4 tables, 3 connections');
    expect(document.body.textContent).toContain('products.photo: MEDIUMBLOB (binary data) is left out.');
    await click(button('Add to the design'));
    expect(shown()).toBe('notes,customers,products,orders,order_lines');
    expect(document.body.textContent).toContain('4 tables and 3 connections from the schema added.');
    await click(button('Paste SQL'));
    await type(field('The schema') as HTMLTextAreaElement, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);');
    await click(button('Read it'));
    await click(button('Replace the design'));
    expect(shown()).toBe('notes');
  });

  it('makes a connection one to one when each row may have at most one, and says so', async () => {
    await render();
    const users = await addTable('users');
    const profiles = await addTable('profiles');
    await act(async () => {
      const design = diagram.props!.design;
      diagram.props!.onChange({ ...design, links: [{ ...newLink(design, design.tables[1], design.tables[0]), required: true }] });
      diagram.props!.onSelect(profiles.id);
    });
    const one = [...document.body.querySelectorAll('[role="switch"]')].find(element => element.getAttribute('aria-labelledby') && document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent === 'Each user has at most one profile') as HTMLButtonElement;
    expect(one.getAttribute('aria-checked')).toBe('false');
    await click(one);
    expect(document.body.textContent).toContain('Each profile belongs to one user, and each user has at most one profile');
    await click(button('Review and create'));
    await click(button('Create the backend'));
    const made = onCreate.mock.calls[0][0] as DatabaseDesign;
    expect(made.links).toEqual([expect.objectContaining({ from: profiles.id, to: users.id, column: 'user_id', required: true, unique: true })]);
  });

  it('shows the design as Mermaid, and changes it as the Mermaid is written, leaving it be while the text cannot be read', async () => {
    await render();
    await addTable('authors');
    await click(button('Mermaid'));
    expect(mode).toBe('mermaid');
    const text = field('The design in Mermaid') as HTMLTextAreaElement;
    expect(text.value).toContain('erDiagram\n  authors {\n    integer id PK');
    // authors has nothing yet to change (no PUT), books has all four.
    await type(text, 'erDiagram\n  authors ||--o{ books : author_id\n  books {\n    text title "required"\n  }');
    expect(document.body.textContent).toContain('2 tables · 1 connection · 7 routes');
    // (Mermaid reads "nonsense here at all" as two attributes: this is not one.)
    await type(text, 'erDiagram\n  authors {\n    this is not, an attribute\n');
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain('Line 3:');
    expect(document.body.textContent).toContain('2 tables · 1 connection · 7 routes');
    // A narrow screen draws no diagram beside the text: the Diagram view shows what was read last.
    expect(document.querySelector('[data-testid="preview"]')).toBeNull();
    await click(button('Diagram'));
    expect(shown()).toBe('authors,books');
  });

  it('keeps the design in this browser until it is made, and comes back to it', async () => {
    await render();
    await addTable('people');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(shown()).toBe('people');
  });

  it('will not make a design with something to fix, and opens the table where it is fixed', async () => {
    await render();
    const order = await addTable('new_table');
    const name = field('Name of the table') as HTMLInputElement;
    await type(name, 'Order');
    await act(async () => name.blur());
    expect(document.body.textContent).toContain('“order” is a word the database keeps for itself: try “orders”.');
    await act(async () => diagram.props!.onSelect(null));
    await click(button('Review and create'));
    expect(button('Create the backend').disabled).toBe(true);
    await click(button('Fix it'));
    expect(document.body.querySelector('[role="dialog"][aria-label="Review and create"]')).toBeNull();
    expect(diagram.props!.design.tables[0].id).toBe(order.id);
    expect((field('Name of the table') as HTMLInputElement).value).toBe('order');
  });

  it('says why it cannot be made just now, and what the server said when it was refused', async () => {
    await render('members', 'Publish or discard your unpublished changes first.');
    await addTable('tasks');
    await click(button('Review and create'));
    expect(document.body.textContent).toContain('Publish or discard your unpublished changes first.');
    expect(button('Create the backend').disabled).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    onCreate.mockRejectedValueOnce(new Error('The backend did not start: a reason.'));
    await render();
    await click(button('Review and create'));
    await click(button('Create the backend'));
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe('The backend did not start: a reason.');
    // Not made: still kept. Nor is one kept only in a live app's draft forgotten.
    expect(localStorage.getItem('formlogic:database-design:app-1')).not.toBeNull();
    onCreate.mockResolvedValueOnce(false);
    await click(button('Create the backend'));
    expect(localStorage.getItem('formlogic:database-design:app-1')).not.toBeNull();
  });

  it('asks inside the designer before a table is removed, and gives an app anyone may open the narrower API', async () => {
    await render('application');
    await addTable('posts');
    expect(document.body.textContent).toContain('GET /api/posts · POST /api/posts');
    await click(button('Remove this table'));
    const asked = document.body.querySelector('[role="alertdialog"]')!;
    expect(asked.textContent).toContain('Remove posts?');
    // The question is the designer's own, not a dialog at the end of the page beneath it.
    expect(container.contains(asked)).toBe(true);
    await click(button('Remove the table'));
    expect(shown()).toBe('empty');
  });
});
