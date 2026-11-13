// @vitest-environment jsdom
/**
 * The History section of an app's page: the versions as a list a person can scan, one of them
 * opened to see what differs from the app now (a text file's two versions side by side), going
 * back to it with a confirmation that says what will happen, pinning, and removing one from the
 * history. Each of its states is told apart: loading, nothing replaced yet, a read that failed, a
 * version no longer kept, a version that was not kept, one that is damaged.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeVersion, NativeVersionChanges, NativeVersionDetail, NativeVersionList } from '../../lib/api';
import type { App } from '../../types/app';

const mocks = vi.hoisted(() => ({
  getNativeVersions: vi.fn(), getNativeVersionDetail: vi.fn(), getNativeVersionFile: vi.fn(), restoreNativeVersion: vi.fn(), pinNativeVersion: vi.fn(), removeNativeVersion: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: mocks }));
const { SoftnHistory } = await import('./SoftnHistory');
const { changesInWords, gapInWords, howInWords, whoInWords } = await import('../../lib/nativeVersions');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
/** Where the page is, as the address bar would say. */
const address = () => container.querySelector('[data-testid="address"]')?.textContent ?? '';
const onRestored = vi.fn();
const app = { id: 'app-1', name: 'Pottery classes', slug: 'pottery', status: 'published', ownerId: 'u1' } as App;

const changes = (over: Partial<NativeVersionChanges> = {}): NativeVersionChanges => ({ added: 0, removed: 0, changed: 0, routes: false, database: false, outside: false, asks: false, access: false, home: false, first: false, ...over });
const row = (version: number, over: Partial<NativeVersion> = {}): NativeVersion => ({
  version, current: false, madeAt: '2026-11-13T09:00:00+00:00', by: 'u1', byYou: true, byName: null, how: 'page', restored: null, summary: null, pinned: false, expires: false,
  damaged: false, gap: null, startedAgain: false,
  changes: changes({ changed: 1 }), files: 4, assets: 2, bytes: 5000, access: 'members', home: true, ...over,
});
const listOf = (versions: NativeVersion[], over: Partial<NativeVersionList> = {}): NativeVersionList => ({ current: versions[0].version, versions, bytes: 1536, limits: { versions: 30, bytes: 256 * 1024 * 1024, pinned: 20 }, unreadable: false, ...over });
/** Four versions: the current one changed by an AI, an upload, a going back, and the first. */
const four = () => listOf([
  row(4, { current: true, how: 'mcp', summary: 'Adds a waiting list', changes: changes({ changed: 3, added: 1, routes: true }) }),
  row(3, { how: 'upload', by: 'u2', byYou: false, byName: 'Sam Rivera', pinned: true, changes: changes({ added: 2, removed: 1, database: true }) }),
  row(2, { how: 'rollback', restored: 1, summary: 'Back to version 1', changes: changes({ changed: 2 }) }),
  row(1, { how: null, by: null, byYou: false, changes: changes({ first: true, added: 5 }) }),
]);
const detailOf = (version: NativeVersion, current: number, over: Partial<NativeVersionDetail> = {}): NativeVersionDetail => ({
  current, version,
  differs: { changed: [{ path: 'server/main.logic', text: true }, { path: 'site/assets/app.js', text: false }], removed: [{ path: 'old.html', text: true }], added: [{ path: 'server/migrations/002_waiting.sql', text: true }], routes: true, database: true, outside: false, asks: false, access: false, home: false },
  databaseAhead: [], outside: { version: [], now: [] }, ...over,
});
/** The button of a version's row that removes it from the history. */
const removeButton = (n: number) => container.querySelector(`ul[aria-label="Versions"] button[data-remove="${n}"]`) as HTMLButtonElement | null;
const inDialog = (text: string) => [...dialog()!.querySelectorAll('button')].find(node => node.textContent === text) as HTMLButtonElement;

/** The section as the app's page hands it its place: the version and the file from the address. */
function Page({ version, readOnly, waiting, backend }: { version: number; readOnly: boolean; waiting: string | null; backend: boolean }) {
  const location = useLocation();
  const parts = (useParams()['*'] ?? '').split('/').filter(Boolean);
  return <>
    <output data-testid="address" hidden>{location.pathname + location.search}</output>
    <SoftnHistory app={app} version={version} open={parts[1] ? Number(parts[1]) : undefined} file={new URLSearchParams(location.search).get('file') ?? undefined}
      backend={backend} readOnly={readOnly} waiting={waiting} onRestored={onRestored} />
  </>;
}
async function mount(at = '', props: Partial<{ version: number; readOnly: boolean; waiting: string | null; backend: boolean }> = {}) {
  const all = { version: 4, readOnly: false, waiting: null, backend: true, ...props };
  await act(async () => root.render(<MemoryRouter initialEntries={[`/apps/app-1/softn/history${at}`]}><Routes><Route path="/apps/:appId/softn/*" element={<Page {...all} />} /></Routes></MemoryRouter>));
  await act(async () => {});
}
const button = (text: RegExp) => [...document.body.querySelectorAll('button')].find(node => text.test(node.textContent ?? '')) as HTMLButtonElement | undefined;
const versionLinks = () => [...container.querySelectorAll('ul[aria-label="Versions"] > li > a')] as HTMLAnchorElement[];
const dialog = () => document.body.querySelector('[role="dialog"]');
/** Follow a link of the page, as a click does. */
const follow = async (link: Element) => { await act(async () => (link as HTMLElement).click()); await act(async () => {}); };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  onRestored.mockReset();
  mocks.getNativeVersions.mockResolvedValue({ data: four() });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('what a version is said to be', () => {
  it('says how each was made in words', () => {
    expect(howInWords({ how: 'page', restored: null })).toBe('Published from this page');
    expect(howInWords({ how: 'upload', restored: null })).toBe('Uploaded');
    expect(howInWords({ how: 'mcp', restored: null })).toBe('Changed by an AI over MCP');
    expect(howInWords({ how: 'chat', restored: null })).toBe('Changed by an AI in the chat');
    expect(howInWords({ how: 'rollback', restored: 4 })).toBe('Went back to version 4');
    expect(howInWords({ how: null, restored: null })).toBe('How it was made was not recorded');
  });

  it('says what changed in a few words', () => {
    expect(changesInWords(changes({ changed: 3, added: 1, routes: true }))).toBe('3 files changed, 1 added · API routes changed');
    expect(changesInWords(changes({ changed: 1 }))).toBe('1 file changed');
    expect(changesInWords(changes({ added: 2, removed: 1, database: true }))).toBe('2 files added, 1 removed · Database changes added');
    expect(changesInWords(changes({ access: true, home: true }))).toBe('Who can use it changed · Address changed');
    expect(changesInWords(changes({ first: true, added: 5 }))).toBe('First version · 5 files');
    expect(changesInWords(changes())).toBe('Nothing changed in its files');
    expect(changesInWords(null)).toBeNull();
  });

  it('says a change to what the app may reach or ask for as what it is, never only as a changed file', () => {
    expect(changesInWords(changes({ changed: 1, outside: true }))).toBe('1 file changed · Outside sites changed');
    expect(changesInWords(changes({ changed: 1, asks: true }))).toBe('1 file changed · What it asks for changed');
    expect(changesInWords(changes({ changed: 2, routes: true, outside: true, asks: true }))).toBe('2 files changed · API routes changed · Outside sites changed · What it asks for changed');
    // A version recorded before these were looked for says nothing of them.
    expect(changesInWords({ added: 0, removed: 0, changed: 1, routes: false, database: false, access: false, home: false, first: false } as NativeVersionChanges)).toBe('1 file changed');
  });

  it('says which versions were not kept', () => {
    expect(gapInWords({ from: 5, to: 5 })).toBe('Version 5 was not kept. It could not be saved in the history when it was replaced.');
    expect(gapInWords({ from: 5, to: 7 })).toBe('Versions 5 to 7 were not kept. They could not be saved in the history when they were replaced.');
  });

  it('names who made it only as far as it is known', () => {
    expect(whoInWords({ by: 'u1', byYou: true, byName: null })).toBe('You');
    expect(whoInWords({ by: 'u2', byYou: false, byName: 'Sam Rivera' })).toBe('Sam Rivera');
    expect(whoInWords({ by: 'u2', byYou: false, byName: null })).toBe('Someone else');
    expect(whoInWords({ by: null, byYou: false, byName: null })).toBeNull();
  });
});

describe('the list', () => {
  it('shows every version newest first with its number, when, who, how, its summary and what it changed, and marks the current one', async () => {
    await mount();
    expect(mocks.getNativeVersions).toHaveBeenCalledWith('app-1');
    const links = versionLinks();
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/apps/app-1/softn/history/4', '/apps/app-1/softn/history/3', '/apps/app-1/softn/history/2', '/apps/app-1/softn/history/1']);
    expect(links[0].textContent).toContain('Version 4');
    expect(links[0].textContent).toContain('Current');
    expect(links[0].textContent).toContain('Changed by an AI over MCP · You');
    expect(links[0].textContent).toContain('Adds a waiting list');
    expect(links[0].textContent).toContain('3 files changed, 1 added · API routes changed');
    expect(links[1].textContent).not.toContain('Current');
    expect(links[1].textContent).toContain('Uploaded · Sam Rivera');
    expect(links[1].textContent).toContain('Pinned');
    // A going back says where to; its summary would only say it again.
    expect(links[2].textContent).toContain('Went back to version 1 · You');
    expect(links[2].textContent).not.toContain('Back to version 1');
    expect(links[3].textContent).toContain('First version · 5 files');
    // When: relative, with the exact time on hover.
    const when = links[0].querySelector('time')!;
    expect(when.getAttribute('datetime')).toBe('2026-11-13T09:00:00+00:00');
    expect(when.getAttribute('title')).toBe(new Date('2026-11-13T09:00:00+00:00').toLocaleString());
    expect(when.textContent).not.toBe('');
    // What is kept, said once under the list.
    expect(container.textContent).toContain('The newest 30 versions are kept. A pinned version is kept past the 30. All within 256 MB: past that the oldest go, pinned ones last (the history takes 1.5 KB now).');
  });

  it('gives a finger room: every row and every pin is at least 44 px', async () => {
    await mount();
    for (const link of versionLinks()) expect(link.className).toContain('min-h-11');
    for (const pin of container.querySelectorAll('ul[aria-label="Versions"] button')) expect(pin.className).toContain('w-11');
  });

  it('says nothing has been replaced yet for an app with one version, and still shows that version', async () => {
    mocks.getNativeVersions.mockResolvedValue({ data: listOf([row(1, { current: true, changes: changes({ first: true, added: 3 }) })], { bytes: 0 }) });
    await mount('', { version: 1 });
    expect(versionLinks()).toHaveLength(1);
    expect(container.textContent).toContain('Nothing has been replaced yet.');
    expect(container.textContent).toContain('past that the oldest go, pinned ones last.');
    expect(container.textContent).not.toContain('the history takes');
  });

  it('says it is loading, then that a failed read failed, never that there is no history, and reads again when asked', async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.getNativeVersions.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    await mount();
    expect(container.textContent).toContain('Loading history…');
    await act(async () => answer({ error: 'The app is being updated. Try again shortly.', status: 409 }));
    expect(container.textContent).toContain('The app’s history could not be loaded');
    expect(container.textContent).toContain('The app is being updated. Try again shortly.');
    expect(container.textContent).not.toContain('Nothing has been replaced yet');
    mocks.getNativeVersions.mockResolvedValue({ data: four() });
    await act(async () => button(/Try again/)!.click());
    await act(async () => {});
    expect(versionLinks()).toHaveLength(4);
  });

  it('keeps the list it has when a later read fails, and reads again when the page installs a version', async () => {
    await mount();
    mocks.getNativeVersions.mockResolvedValue({ error: 'Server error', status: 500 });
    await mount('', { version: 5 });
    expect(mocks.getNativeVersions).toHaveBeenCalledTimes(2);
    expect(versionLinks()).toHaveLength(4);
  });

  it('pins and unpins a version from its row, and says why when it cannot', async () => {
    // A server that keeps what it is told: the list is read again after a pin, and says the same.
    const kept = four();
    let refuse: string | null = null;
    mocks.getNativeVersions.mockImplementation(async () => ({ data: { ...kept, versions: kept.versions.map(version => ({ ...version })) } }));
    mocks.pinNativeVersion.mockImplementation(async (_id: string, version: number, pinned: boolean) => {
      if (refuse) return { error: refuse, status: 409 };
      kept.versions.find(candidate => candidate.version === version)!.pinned = pinned;
      return { data: { version, pinned } };
    });
    await mount();
    const pin = (n: number) => container.querySelector(`button[aria-label$="in version ${n}"]`) as HTMLButtonElement;
    expect(pin(2).getAttribute('aria-pressed')).toBe('false');
    expect(pin(3).getAttribute('aria-label')).toBe('Unpin version 3');
    await act(async () => pin(2).click());
    await act(async () => {});
    expect(mocks.pinNativeVersion).toHaveBeenCalledWith('app-1', 2, true);
    expect(pin(2).getAttribute('aria-pressed')).toBe('true');
    refuse = 'At most 20 versions can be pinned. Unpin one first.';
    await act(async () => pin(1).click());
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('At most 20 versions can be pinned. Unpin one first.');
    expect(pin(1).getAttribute('aria-pressed')).toBe('false');
    refuse = null;
    await act(async () => pin(3).click());
    await act(async () => {});
    expect(mocks.pinNativeVersion).toHaveBeenLastCalledWith('app-1', 3, false);
    expect(pin(3).getAttribute('aria-label')).toBe('Pin version 3');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('marks an unpinned version that is past the newest kept', async () => {
    const list = four();
    list.versions[3] = { ...list.versions[3], expires: true };
    mocks.getNativeVersions.mockResolvedValue({ data: list });
    await mount();
    expect(versionLinks()[3].textContent).toContain('it goes at the next publish');
  });

  it('says where a version was not kept, where one is damaged, and where the history starts again', async () => {
    const list = four();
    // Version 3 was replaced when the history could not be written; version 2 has lost a file; before version 1 nothing could be read.
    list.versions = [list.versions[0], { ...list.versions[2], gap: { from: 3, to: 3 }, damaged: true }, { ...list.versions[3], startedAgain: true }];
    mocks.getNativeVersions.mockResolvedValue({ data: list });
    await mount();
    const items = [...container.querySelectorAll('ul[aria-label="Versions"] > li')].map(item => item.textContent ?? '');
    expect(items).toHaveLength(5);
    expect(items[1]).toContain('Version 2');
    expect(items[1]).toContain('Damaged: one of this version’s files is missing from the history, so you cannot go back to it. You can remove it from the history.');
    expect(items[2]).toBe('Version 3 was not kept. It could not be saved in the history when it was replaced.');
    expect(items[4]).toBe('The history from before version 1 could not be read, so it starts again here.');
    // A version that is whole says none of it.
    expect(items[0]).not.toContain('Damaged');
    expect(versionLinks()).toHaveLength(3);
  });

  it('does not say nothing has been replaced where the one version before could not be kept', async () => {
    mocks.getNativeVersions.mockResolvedValue({ data: listOf([row(2, { current: true, how: null, by: null, byYou: false, changes: null, gap: { from: 1, to: 1 } })], { bytes: 0 }) });
    await mount('', { version: 2 });
    expect(container.textContent).toContain('Version 1 was not kept. It could not be saved in the history when it was replaced.');
    expect(container.textContent).not.toContain('Nothing has been replaced yet');
  });

  it('says a history that could not be read is that, not that nothing has been replaced', async () => {
    mocks.getNativeVersions.mockResolvedValue({ data: listOf([row(7, { current: true, how: null, by: null, byYou: false, changes: null })], { bytes: 0, unreadable: true }) });
    await mount('', { version: 7 });
    expect(container.textContent).toContain('This app’s history could not be read, so only the current version is shown. The next time the app is published, the history starts again.');
    expect(container.textContent).not.toContain('Nothing has been replaced yet');
    expect(versionLinks()).toHaveLength(1);
  });
});

describe('removing a version from the history', () => {
  it('offers it on each earlier version, never on the current one, and on a pinned one only once it is unpinned', async () => {
    await mount();
    expect(removeButton(4)).toBeNull();
    expect(removeButton(2)!.getAttribute('aria-label')).toBe('Remove version 2 from the history');
    expect(removeButton(2)!.disabled).toBe(false);
    expect(removeButton(1)!.disabled).toBe(false);
    expect(removeButton(3)!.disabled).toBe(true);
    expect(removeButton(3)!.getAttribute('aria-label')).toBe('Version 3 is pinned: unpin it to remove it from the history');
    for (const n of [1, 2, 3]) expect(removeButton(n)!.className).toContain('w-11');
  });

  it('asks first, saying what it does and that it cannot be undone, then removes it and says so', async () => {
    const kept = four();
    mocks.getNativeVersions.mockImplementation(async () => ({ data: { ...kept, versions: kept.versions.map(version => ({ ...version })) } }));
    mocks.removeNativeVersion.mockImplementation(async (_id: string, version: number) => {
      kept.versions = kept.versions.filter(candidate => candidate.version !== version);
      return { data: { version, removed: true } };
    });
    await mount();
    await act(async () => removeButton(2)!.click());
    const asked = dialog()!;
    expect(asked.textContent).toContain('Remove version 2 from the history?');
    expect(asked.textContent).toContain('Version 2’s files are deleted from the history.');
    expect(asked.textContent).toContain('The app as it is now is not changed.');
    expect(asked.textContent).toContain('This cannot be undone.');
    expect(mocks.removeNativeVersion).not.toHaveBeenCalled();
    // Cancel leaves everything as it was.
    await act(async () => inDialog('Cancel').click());
    expect(dialog()).toBeNull();
    expect(mocks.removeNativeVersion).not.toHaveBeenCalled();
    expect(versionLinks()).toHaveLength(4);

    await act(async () => removeButton(2)!.click());
    await act(async () => inDialog('Remove from history').click());
    await act(async () => {});
    expect(mocks.removeNativeVersion).toHaveBeenCalledWith('app-1', 2);
    expect(dialog()).toBeNull();
    expect(versionLinks().map(link => link.getAttribute('href'))).toEqual(['/apps/app-1/softn/history/4', '/apps/app-1/softn/history/3', '/apps/app-1/softn/history/1']);
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Version 2 was removed from the history. The app as it is now was not changed.');
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('keeps the question open and says why when the server refuses', async () => {
    mocks.removeNativeVersion.mockResolvedValue({ error: 'Version 2 is pinned. Unpin it first, then remove it.', status: 409 });
    await mount();
    await act(async () => removeButton(2)!.click());
    await act(async () => inDialog('Remove from history').click());
    await act(async () => {});
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('Version 2 is pinned. Unpin it first, then remove it.');
    expect(versionLinks()).toHaveLength(4);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('can be done from the open version, and returns to the list', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    mocks.removeNativeVersion.mockResolvedValue({ data: { version: 2, removed: true } });
    await mount('/2');
    await act(async () => button(/Remove from history/)!.click());
    expect(dialog()!.textContent).toContain('Remove version 2 from the history?');
    await act(async () => inDialog('Remove from history').click());
    await act(async () => {});
    expect(mocks.removeNativeVersion).toHaveBeenCalledWith('app-1', 2);
    expect(address()).toBe('/apps/app-1/softn/history');
  });

  it('is the way out for a damaged version, which cannot be gone back to', async () => {
    const damaged = { ...four().versions[2], damaged: true };
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(damaged, 4) });
    await mount('/2');
    expect(button(/Go back to this version/)!.disabled).toBe(true);
    expect(container.textContent).toContain('Damaged: one of this version’s files is missing from the history, so you cannot go back to it.');
    expect(button(/Remove from history/)!.disabled).toBe(false);
  });

  it('is not offered in the open version when that is the current one, or is pinned', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[0], 4, { differs: { added: [], removed: [], changed: [], routes: false, database: false, outside: false, asks: false, access: false, home: false } }) });
    await mount('/4');
    expect(button(/Remove from history/)).toBeUndefined();
    await act(async () => root.unmount());

    root = createRoot(container);
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[1], 4) });
    await mount('/3');
    expect(button(/Remove from history/)!.disabled).toBe(true);
    expect(container.textContent).toContain('Unpin it to remove it from the history.');
  });
});

describe('one version', () => {
  it('opens at its own address and shows what differs from the app now, file by file', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    await mount();
    await follow(versionLinks()[2]);
    expect(address()).toBe('/apps/app-1/softn/history/2');
    expect(mocks.getNativeVersionDetail).toHaveBeenCalledWith('app-1', 2);
    const differs = container.querySelector('section[aria-label="What differs from the app now"]')!;
    expect(differs.querySelector('h3')!.textContent).toBe('What differs from the app now (version 4)');
    expect(differs.textContent).toContain('Changed since · 2');
    expect(differs.textContent).toContain('Only in version 2 · 1');
    expect(differs.textContent).toContain('Only in the app now · 1');
    // A text file opens in place; a media or built file is named and says why it is not shown.
    expect([...differs.querySelectorAll('a')].map(link => link.textContent)).toEqual(['server/main.logic', 'old.html', 'server/migrations/002_waiting.sql']);
    expect(differs.textContent).toContain('site/assets/app.jsmedia or built file, not shown');
    for (const link of differs.querySelectorAll('a')) expect(link.className).toContain('min-h-11');
    // On a phone the list gives way to the version, with a way back to it.
    expect(container.querySelector('ul[aria-label="Versions"]')!.closest('section')!.className).toContain('max-lg:hidden');
    expect([...container.querySelectorAll('a')].find(link => link.textContent === 'All versions')!.getAttribute('href')).toBe('/apps/app-1/softn/history');
    expect(container.textContent).toContain('Pinned versions are kept past the newest 30.');
  });

  it('shows a text file’s two versions side by side, the lines that differ marked on each side', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    mocks.getNativeVersionFile.mockImplementation(async (_id: string, version: number, path: string) => ({ data: { current: 4, version, path, text: version === 2 ? 'function list() {\n  return all();\n}\n' : 'function list() {\n  return open();\n}\n' } }));
    await mount('/2');
    await follow([...container.querySelectorAll('section[aria-label="What differs from the app now"] a')].find(link => link.textContent === 'server/main.logic')!);
    expect(address()).toBe('/apps/app-1/softn/history/2?file=server%2Fmain.logic');
    expect(mocks.getNativeVersionFile.mock.calls).toEqual([['app-1', 2, 'server/main.logic'], ['app-1', 4, 'server/main.logic']]);
    const compare = container.querySelector('[data-testid="softn-history-file"]')!;
    const [before, after] = [...compare.querySelectorAll('[role="group"]')];
    expect(before.getAttribute('aria-label')).toBe('Version 2');
    expect(after.getAttribute('aria-label')).toBe('Now (version 4)');
    expect(before.textContent).toContain('return all();');
    expect(after.textContent).toContain('return open();');
    // The changed line is marked on each side; the lines around it are not.
    const marked = (pane: Element) => [...pane.querySelectorAll('.font-mono > div')].filter(line => /bg-(red|emerald)-50/.test(line.className)).map(line => line.textContent);
    expect(marked(before)).toEqual(['2  return all();']);
    expect(marked(after)).toEqual(['2  return open();']);
    // Side by side where the box has room, one above the other where it has not; long lines wrap, nothing scrolls sideways.
    expect(before.parentElement!.className).toContain('grid');
    expect(before.parentElement!.className).toContain('@xl/compare:grid-cols-2');
    expect(compare.innerHTML).toContain('whitespace-pre-wrap');
    expect(compare.innerHTML).not.toContain('overflow-x');
    expect(compare.textContent).toContain('1 line only in version 2, 1 only in the app now.');
    // The file's source is text on the page, never markup of it.
    expect(compare.querySelector('script')).toBeNull();
  });

  it('shows a file only one of the two holds from that one alone, and says when a file cannot be read', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    mocks.getNativeVersionFile.mockResolvedValue({ data: { current: 4, version: 2, path: 'old.html', text: '<p>Old page</p>' } });
    await mount('/2?file=old.html');
    expect(mocks.getNativeVersionFile.mock.calls).toEqual([['app-1', 2, 'old.html']]);
    expect(container.querySelector('[data-testid="softn-history-file"] [role="group"]')!.getAttribute('aria-label')).toBe('Version 2, not in the app now');
    expect(container.querySelector('[data-testid="softn-history-file"]')!.textContent).toContain('<p>Old page</p>');
    await act(async () => root.unmount());

    root = createRoot(container);
    mocks.getNativeVersionFile.mockReset().mockResolvedValue({ error: 'Version 2 has no such file.', status: 404 });
    await mount('/2?file=server%2Fmain.logic');
    expect(container.textContent).toContain('This file could not be loaded');
    expect(container.textContent).toContain('Version 2 has no such file.');
  });

  it('says what the current version changed, and offers no going back to it', async () => {
    const current = { ...four().versions[0], changes: changes({ changed: 1, added: 1, paths: { changed: ['server/main.logic'], added: ['waiting.html'], removed: [] } }) };
    mocks.getNativeVersionDetail.mockResolvedValue({ data: { current: 4, version: current, differs: { added: [], removed: [], changed: [], routes: false, database: false, outside: false, asks: false, access: false, home: false }, databaseAhead: [], outside: { version: [], now: [] } } });
    await mount('/4');
    expect(container.textContent).toContain('This is the app as it is now.');
    expect(container.textContent).toContain('server/main.logic');
    expect(container.textContent).toContain('waiting.html');
    expect(button(/Go back to this version/)).toBeUndefined();
    expect(button(/Pin this version/)).toBeDefined();
  });

  it('says a version is not kept any more, and that a read failed, each as what it is', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ error: 'Version 9 is not kept any more.', status: 404 });
    await mount('/9');
    expect(container.textContent).toContain('Version 9 is not kept any more.');
    expect(container.textContent).not.toContain('could not be loaded');
    await act(async () => root.unmount());

    root = createRoot(container);
    mocks.getNativeVersionDetail.mockResolvedValue({ error: 'Server error', status: 500 });
    await mount('/2');
    expect(container.textContent).toContain('Version 2 could not be loaded');
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    await act(async () => button(/Try again/)!.click());
    await act(async () => {});
    expect(container.querySelector('section[aria-label="What differs from the app now"]')).not.toBeNull();
  });
});

describe('going back', () => {
  it('asks first, saying plainly what will happen, then goes back and hands the page the new version', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    mocks.restoreNativeVersion.mockResolvedValue({ data: { version: 5, restored: 2, databaseAhead: [] } });
    await mount('/2');
    await act(async () => button(/Go back to this version/)!.click());
    const asked = dialog()!;
    expect(asked.textContent).toContain('Go back to version 2?');
    expect(asked.textContent).toContain('That is saved as a new version, 5, so version 4 stays in the history and you can return to it.');
    expect(asked.textContent).toContain('Records in the app’s database stay as they are. Nothing is deleted.');
    // What the app's own files say goes back with them, and is said to: its manifest is one of them.
    expect(asked.textContent).toContain('The app’s settings that are kept in its files go back too: what it asks this server for, and the outside sites it may reach, become what version 2 had.');
    expect(asked.textContent).toContain('Who can use the app, and its address, stay as they are now.');
    expect(asked.textContent).toContain('The app is live, so visitors get this version at once.');
    expect(asked.querySelector('[role="note"]')).toBeNull();
    expect(mocks.restoreNativeVersion).not.toHaveBeenCalled();

    await act(async () => [...asked.querySelectorAll('button')].find(node => node.textContent === 'Go back to version 2')!.click());
    await act(async () => {});
    // From the version this section was looking at, so one published meanwhile is not gone back over unseen.
    expect(mocks.restoreNativeVersion).toHaveBeenCalledWith('app-1', 2, 4);
    expect(onRestored).toHaveBeenCalledWith({ version: 5, restored: 2, databaseAhead: [] });
    expect(address()).toBe('/apps/app-1/softn/history');
    const said = container.querySelector('[role="status"]')!;
    expect(said.textContent).toContain('The app is as it was in version 2 again, saved as version 5.');
    expect(said.querySelector('a')!.getAttribute('href')).toBe('/apps/app-1/softn/edit');
    expect(mocks.getNativeVersions.mock.calls.length).toBeGreaterThan(1);
  });

  it('names the database changes a version was written before, in the question and in what it says after', async () => {
    const ahead = ['server/migrations/002_waiting.sql', 'server/migrations/003_prices.sql'];
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4, { databaseAhead: ahead }) });
    mocks.restoreNativeVersion.mockResolvedValue({ data: { version: 5, restored: 2, databaseAhead: ahead } });
    await mount('/2');
    // Before the question is even asked, the version says so.
    expect(container.querySelector('[role="note"]')!.textContent).toContain('The app’s database has changes made after this version: 002_waiting.sql, 003_prices.sql.');
    await act(async () => button(/Go back to this version/)!.click());
    const warning = dialog()!.querySelector('[role="note"]')!;
    expect(warning.textContent).toContain('Version 2 was written before these database changes:');
    expect([...warning.querySelectorAll('li')].map(item => item.textContent)).toEqual(['002_waiting.sql', '003_prices.sql']);
    expect(warning.textContent).toContain('They stay applied to the database, and this version’s code may not expect them.');
    await act(async () => [...dialog()!.querySelectorAll('button')].find(node => node.textContent === 'Go back to version 2')!.click());
    await act(async () => {});
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Its database keeps the changes made since: 002_waiting.sql, 003_prices.sql.');
  });

  it('names the outside sites each may reach when the two differ in them, and says when what the app asks for goes back', async () => {
    const base = detailOf(four().versions[2], 4);
    mocks.getNativeVersionDetail.mockResolvedValue({ data: { ...base, differs: { ...base.differs, outside: true, asks: true }, outside: { version: ['https://api.example.com', 'wss://live.example.com'], now: [] } } });
    await mount('/2');
    // Said where the version is open, before anything is asked.
    expect(container.querySelector('[role="note"]')!.textContent).toContain('This version may reach other outside sites than the app does now (https://api.example.com, wss://live.example.com, against none now).');
    expect(container.querySelector('[role="note"]')!.textContent).toContain('Going back brings this version’s own back.');
    await act(async () => button(/Go back to this version/)!.click());
    const warning = dialog()!.querySelector('[data-testid="softn-history-settings-back"]')!;
    expect(warning.textContent).toContain('The outside sites the app may reach go back to version 2’s.');
    expect(warning.textContent).toContain('Version 2 may reach: https://api.example.com, wss://live.example.com.');
    expect(warning.textContent).toContain('The app now may reach: none.');
    expect(warning.textContent).toContain('What the app asks this server for goes back to what version 2 asked for.');
    await act(async () => inDialog('Cancel').click());
    await act(async () => root.unmount());

    // The other way round: the app now reaches a site that version did not, and after going back it will not.
    root = createRoot(container);
    mocks.getNativeVersionDetail.mockResolvedValue({ data: { ...base, differs: { ...base.differs, outside: true }, outside: { version: [], now: ['https://api.example.com'] } } });
    await mount('/2');
    await act(async () => button(/Go back to this version/)!.click());
    const other = dialog()!.querySelector('[data-testid="softn-history-settings-back"]')!;
    expect(other.textContent).toContain('Version 2 may reach: none.');
    expect(other.textContent).toContain('The app now may reach: https://api.example.com.');
    expect(other.textContent).not.toContain('asks this server');
  });

  it('says what stays for an app with no database, and nothing about visitors for one that is not live', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    app.status = 'draft';
    try {
      await mount('/2', { backend: false });
      await act(async () => button(/Go back to this version/)!.click());
      expect(dialog()!.textContent).toContain('What people have saved in their browsers stays as it is.');
      expect(dialog()!.textContent).not.toContain('database');
      expect(dialog()!.textContent).not.toContain('visitors get this version');
    } finally { app.status = 'published'; }
  });

  it('keeps the question open and says why when the server refuses, and changes nothing on the page', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    mocks.restoreNativeVersion.mockResolvedValue({ error: 'The app is now at version 5. Reload and look again before going back.', status: 409 });
    await mount('/2');
    await act(async () => button(/Go back to this version/)!.click());
    await act(async () => [...dialog()!.querySelectorAll('button')].find(node => node.textContent === 'Go back to version 2')!.click());
    await act(async () => {});
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('The app is now at version 5. Reload and look again before going back.');
    expect(onRestored).not.toHaveBeenCalled();
    expect(address()).toBe('/apps/app-1/softn/history/2');
  });

  it('waits while the page has unpublished changes, and offers nothing to change in the read-only demo', async () => {
    mocks.getNativeVersionDetail.mockResolvedValue({ data: detailOf(four().versions[2], 4) });
    await mount('/2', { waiting: 'Publish or discard your unpublished changes first: going back makes a new version.' });
    expect(button(/Go back to this version/)!.disabled).toBe(true);
    expect(container.textContent).toContain('Publish or discard your unpublished changes first');
    await act(async () => root.unmount());

    root = createRoot(container);
    await mount('/2', { readOnly: true });
    expect(button(/Go back to this version/)).toBeUndefined();
    expect(button(/Pin/)).toBeUndefined();
    expect(container.querySelectorAll('ul[aria-label="Versions"] button')).toHaveLength(0);
    expect(container.querySelector('section[aria-label="What differs from the app now"]')).not.toBeNull();
  });
});
