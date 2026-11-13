// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeProject } from '../../lib/nativeHosting';

vi.mock('./NativeSourceEditor', () => ({
  NativeSourceEditor: ({ file, value, onChange, label, readOnly, note, actions }: { file: string; value: string; onChange(value: string): void; label: string; readOnly?: boolean; note?: string; actions?: ReactNode }) =>
    <div data-testid="editor" data-file={file} data-label={label} data-note={note ?? ''}>
      <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />{actions}
    </div>,
}));
const { ProjectSourcePane } = await import('./ProjectSourcePane');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let latest: NativeProject;
const notices: string[] = [];

const MANIFEST = JSON.stringify({ id: 'a', main: 'index.html', server: { entry: 'server/main.logic', database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] } } });
const INSTALLED: Record<string, string> = {
  'manifest.json': MANIFEST, 'index.html': '<Text>Hi</Text>', 'about.html': '<Text>About</Text>', 'main.js': 'let a = 1', 'styles.css': '.a{}',
  'server/main.logic': 'function a() {}', 'server/migrations/001.sql': 'CREATE TABLE a(id);',
};
const project = (files = INSTALLED): NativeProject => ({ version: 2, files, assets: {}, access: 'members' });

function Harness({ start, installed, readOnly = false }: { start: NativeProject; installed: Record<string, string> | null; readOnly?: boolean }) {
  const [draft, setDraft] = useState(start);
  const [file, setFile] = useState('');
  return <ProjectSourcePane appId="app1" project={draft} installed={installed} readOnly={readOnly} file={file} onFile={setFile}
    onEdit={next => { latest = next; setDraft(next); }} onNotice={message => notices.push(message)} />;
}
async function mount(props: { start?: NativeProject; installed?: Record<string, string> | null; readOnly?: boolean } = {}) {
  latest = props.start ?? project();
  await act(async () => root.render(<Harness start={latest} installed={props.installed === undefined ? INSTALLED : props.installed} readOnly={props.readOnly} />));
}
const rail = () => container.querySelector('nav[aria-label="Project files"]')!;
const listed = (group: string) => [...rail().querySelectorAll(`section[aria-label="${group}"] button`)].map(node => node.getAttribute('title'));
const fileButton = (path: string) => rail().querySelector<HTMLButtonElement>(`button[title="${path}"]`)!;
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label);
const editor = () => container.querySelector<HTMLElement>('[data-testid="editor"]')!;
const click = (node: Element | undefined | null) => act(async () => (node as HTMLElement).click());
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); notices.length = 0; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('lists every file in its group and opens the first page', async () => {
  await mount();
  expect(listed('Pages')).toEqual(['index.html', 'about.html']);
  expect(listed('Logic')).toEqual(['main.js']);
  expect(listed('Styles')).toEqual(['styles.css']);
  expect(listed('Backend')).toEqual(['server/main.logic']);
  expect(listed('Database changes')).toEqual(['server/migrations/001.sql']);
  expect(listed('Project')).toEqual(['manifest.json']);
  expect(editor().dataset.file).toBe('index.html');
  expect(fileButton('index.html').getAttribute('aria-current')).toBe('true');
  // A file in its group's own folder is shown by what comes after the folder; its whole name is its title.
  expect(fileButton('server/migrations/001.sql').textContent).toBe('001.sql');
  expect(fileButton('server/main.logic').textContent).toBe('main.logic');
});

it('edits the open file in the draft and marks it changed', async () => {
  await mount();
  await click(fileButton('main.js'));
  expect(editor().dataset.label).toBe('Interface source');
  await type(container.querySelector('textarea')!, 'let a = 2');
  expect(latest.files['main.js']).toBe('let a = 2');
  expect(fileButton('main.js').getAttribute('aria-label')).toBe('main.js, changed');
  expect(fileButton('index.html').getAttribute('aria-label')).toBe('index.html');
});

it('keeps a database change that has run as it is, says why, and offers no way to remove it', async () => {
  await mount();
  await click(fileButton('server/migrations/001.sql'));
  expect(container.querySelector('textarea')!.readOnly).toBe(true);
  expect(editor().dataset.note).toContain('already run');
  expect(editor().dataset.label).toBe('Private backend source');
  expect(container.querySelector('button[aria-label="Remove server/migrations/001.sql"]')).toBeNull();
  // The manifest is edited, and cannot be removed either.
  await click(fileButton('manifest.json'));
  expect(container.querySelector('textarea')!.readOnly).toBe(false);
  expect(editor().dataset.label).toBe('Project file source');
  expect(container.querySelector('button[aria-label="Remove manifest.json"]')).toBeNull();
});

it('adds a database change as the next numbered file, lists it in the manifest and opens it to be written', async () => {
  await mount();
  await click(button('New database change'));
  expect(listed('Database changes')).toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
  expect(editor().dataset.file).toBe('server/migrations/002.sql');
  expect(container.querySelector('textarea')!.readOnly).toBe(false);
  expect((JSON.parse(latest.files['manifest.json']) as { server: { database: { migrations: string[] } } }).server.database.migrations)
    .toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
  expect(fileButton('server/migrations/002.sql').getAttribute('aria-label')).toBe('server/migrations/002.sql, new');
  expect(fileButton('manifest.json').getAttribute('aria-label')).toBe('manifest.json, changed');
  expect(notices).toEqual(['server/migrations/002.sql was added to your draft.']);
  // One added in this draft has not run: it can be taken out again, and comes off the list with it.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(container.querySelector('button[aria-label="Remove server/migrations/002.sql"]'));
  expect(listed('Database changes')).toEqual(['server/migrations/001.sql']);
  expect((JSON.parse(latest.files['manifest.json']) as { server: { database: { migrations: string[] } } }).server.database.migrations).toEqual(['server/migrations/001.sql']);
});

it('offers a database change only to a project that has a database', async () => {
  await mount({ start: project({ 'manifest.json': '{"main":"index.html"}', 'index.html': '<Text/>' }), installed: null });
  expect(button('New database change')).toBeUndefined();
  expect(button('New file')).toBeDefined();
});

it('adds a file by name, refusing a name the host does not keep with the reason', async () => {
  await mount();
  await click(button('New file'));
  const name = container.querySelector<HTMLInputElement>('input[placeholder="pages/about.html"]')!;
  await type(name, 'pages/about page.html');
  await click(button('Add file'));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('letters, digits');
  expect(Object.keys(latest.files)).toEqual(Object.keys(INSTALLED));
  await type(name, 'index.html');
  await click(button('Add file'));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('already in the project');
  await type(name, '/pages/contact.html');
  await click(button('Add file'));
  expect(latest.files['pages/contact.html']).toContain('<Stack');
  expect(listed('Pages')).toEqual(['index.html', 'about.html', 'pages/contact.html']);
  expect(editor().dataset.file).toBe('pages/contact.html');
  expect(notices).toEqual(['pages/contact.html was added to your draft.']);
});

it('removes a file only when its owner says so, and says which installed files the draft has taken out', async () => {
  await mount();
  await click(fileButton('about.html'));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await click(container.querySelector('button[aria-label="Remove about.html"]'));
  expect(confirm).toHaveBeenCalledOnce();
  expect(listed('Pages')).toEqual(['index.html', 'about.html']);
  confirm.mockReturnValue(true);
  await click(container.querySelector('button[aria-label="Remove about.html"]'));
  expect(listed('Pages')).toEqual(['index.html']);
  expect(Object.hasOwn(latest.files, 'about.html')).toBe(false);
  const gone = rail().querySelector('section[aria-label="Removed in this draft"]')!;
  expect(gone.textContent).toContain('about.html');
  // The first page cannot go: the app would open on nothing.
  expect(editor().dataset.file).toBe('index.html');
  expect(container.querySelector('button[aria-label="Remove index.html"]')).toBeNull();
  // What was taken out can be had back, as the installed version has it, and is opened.
  await click(gone.querySelector('button[aria-label="Put about.html back"]'));
  expect(latest.files['about.html']).toBe(INSTALLED['about.html']);
  expect(listed('Pages')).toEqual(['index.html', 'about.html']);
  expect(editor().dataset.file).toBe('about.html');
  expect(rail().querySelector('section[aria-label="Removed in this draft"]')).toBeNull();
});

it('repairs a draft that holds another copy of a database change that has run: the installed copy goes back', async () => {
  // A draft brought in from elsewhere: its 001.sql is not the one that ran here.
  await mount({ start: project({ ...INSTALLED, 'server/migrations/001.sql': 'CREATE TABLE a(id, extra);' }) });
  await click(fileButton('server/migrations/001.sql'));
  expect(container.querySelector('textarea')!.readOnly).toBe(true);
  expect(editor().dataset.note).toContain('holds a different copy');
  // It cannot be typed in or removed: the one way out is offered in their place.
  expect(container.querySelector('button[aria-label="Remove server/migrations/001.sql"]')).toBeNull();
  await click(container.querySelector('button[aria-label="Put the installed copy of server/migrations/001.sql back"]'));
  expect(latest.files['server/migrations/001.sql']).toBe(INSTALLED['server/migrations/001.sql']);
  expect(editor().dataset.note).toContain('already run');
  expect(fileButton('server/migrations/001.sql').getAttribute('aria-label')).toBe('server/migrations/001.sql');
  expect(container.querySelector('button[aria-label^="Put the installed copy"]')).toBeNull();
});

it('numbers a new database change after the installed ones, when the draft lacks the latest of them', async () => {
  const installed = { ...INSTALLED, 'server/migrations/002.sql': 'ALTER TABLE a ADD b;', 'manifest.json': JSON.stringify({ id: 'a', main: 'index.html', server: { entry: 'server/main.logic', database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'] } } }) };
  // The draft is an older copy: no 002.sql. A new change must not take that number.
  await mount({ start: project(INSTALLED), installed });
  await click(button('New database change'));
  expect(editor().dataset.file).toBe('server/migrations/003.sql');
  expect(container.querySelector('textarea')!.readOnly).toBe(false);
  // The change the draft lacks is listed as taken out, with the way to have it back.
  expect(rail().querySelector('button[aria-label="Put server/migrations/002.sql back"]')).not.toBeNull();
});

it('does not offer to make a file under server/ that it would then only show', async () => {
  await mount();
  await click(button('New file'));
  const name = container.querySelector<HTMLInputElement>('input[placeholder="pages/about.html"]')!;
  await type(name, 'server/config.json');
  await click(button('Add file'));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('.logic files');
  expect(Object.keys(latest.files)).toEqual(Object.keys(INSTALLED));
});

it('keeps the search box while something is looked for, so an emptied list can always be cleared', async () => {
  const many = { ...INSTALLED, 'pages/contact.html': '<Text/>', 'pages/terms.html': '<Text/>' };
  await mount({ start: project(many), installed: many });
  expect(Object.keys(many)).toHaveLength(9);
  const find = () => container.querySelector<HTMLInputElement>('input[aria-label="Find a file"]');
  await type(find()!, 'terms');
  await click(fileButton('pages/terms.html'));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(container.querySelector('button[aria-label="Remove pages/terms.html"]'));
  // Eight files are left, under the number the box appears at: the list is whole, not "No file matches".
  expect(Object.keys(latest.files)).toHaveLength(8);
  expect(rail().textContent).not.toContain('No file matches.');
  expect(listed('Pages')).toEqual(['index.html', 'about.html', 'pages/contact.html']);
});

it('keeps Escape in its own boxes: it clears a search and leaves a new name, and the dialog around it never hears it', async () => {
  const heard = vi.fn();
  document.addEventListener('keydown', heard);
  try {
    const many = { ...INSTALLED, 'pages/contact.html': '<Text/>', 'pages/terms.html': '<Text/>' };
    await mount({ start: project(many), installed: many });
    const find = container.querySelector<HTMLInputElement>('input[aria-label="Find a file"]')!;
    await type(find, 'terms');
    await act(async () => { find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(find.value).toBe('');
    await click(button('New file'));
    const name = container.querySelector<HTMLInputElement>('input[placeholder="pages/about.html"]')!;
    await type(name, 'pages/x.html');
    await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('input[placeholder="pages/about.html"]')).toBeNull();
    expect(button('New file')).toBeDefined();
    expect(heard.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  } finally {
    document.removeEventListener('keydown', heard);
  }
});

it('shows the files and changes nothing when it is read-only', async () => {
  await mount({ readOnly: true });
  expect(button('New file')).toBeUndefined();
  expect(button('New database change')).toBeUndefined();
  await click(fileButton('about.html'));
  expect(container.querySelector('textarea')!.readOnly).toBe(true);
  expect(container.querySelector('button[aria-label="Remove about.html"]')).toBeNull();
});

it('finds a file by part of its name once there are many', async () => {
  const many = { ...INSTALLED, ...Object.fromEntries(Array.from({ length: 6 }, (_, n) => [`pages/page-${n}.html`, '<Text/>'])) };
  await mount({ start: project(many), installed: many });
  await type(container.querySelector<HTMLInputElement>('input[aria-label="Find a file"]')!, 'PAGE-3');
  expect([...rail().querySelectorAll('button[title]')].map(node => node.getAttribute('title'))).toEqual(['pages/page-3.html']);
  await type(container.querySelector<HTMLInputElement>('input[aria-label="Find a file"]')!, 'nothing like it');
  expect(rail().textContent).toContain('No file matches.');
});
