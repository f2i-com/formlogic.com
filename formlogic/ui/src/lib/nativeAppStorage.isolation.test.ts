// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as storage from './nativeAppStorage';
import { bumpSessionGeneration, setSessionOwner } from './sessionGeneration';

// Runtime calls deliberately avoid requiring the proposed interface at collection time:
// these exact tests also run against the upstream one-argument implementation.
type Scope = { access: 'members'; appId: string; userId: string } | { access: 'application'; appId: string };
const open = storage.nativeAppStorage as unknown as (slug: string, scope?: unknown) => ReturnType<typeof storage.nativeAppStorage>;
const member = (userId = 'member-a', appId = 'app-one'): Scope => ({ access: 'members', appId, userId });
const application: Scope = { access: 'application', appId: 'app-one' };
const legacy = (slug: string) => `formlogic:native-storage:${encodeURIComponent(slug)}`;
const save = (value: ReturnType<typeof open>, secret = 'synthetic-a') => value.mutate({ operation: 'set', key: 'session', value: secret });
const purge = (userId: string) => (storage as unknown as { clearNativeMemberStorage: (id: string) => Promise<boolean> }).clearNativeMemberStorage(userId);

beforeEach(() => { localStorage.clear(); setSessionOwner('member-a'); bumpSessionGeneration(); });
afterEach(() => { vi.restoreAllMocks(); setSessionOwner(null); });

describe('an application map belongs to the app, not to its slug', () => {
  const app = (appId: string): Scope => ({ access: 'application', appId });

  it('gives an app that claims a freed slug nothing a visitor saved in the app before it', async () => {
    await save(open('cafe', app('app-one')));
    expect(await open('cafe', app('app-evil')).read()).toEqual({});
    expect(await open('cafe', app('app-evil')).exportRaw()).toBeNull();
  });
  it('follows its app through a rename', async () => {
    await save(open('cafe', app('app-one')));
    expect(await open('renamed-cafe', app('app-one')).read()).toEqual({ session: 'synthetic-a' });
  });
  it('moves what was saved under the slug to the app the first time it asks, and only once', async () => {
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'from-before' }));
    expect(await open('cafe', app('app-one')).read()).toEqual({ session: 'from-before' });
    expect(localStorage.getItem(legacy('cafe'))).toBeNull();
    expect(await open('cafe', app('app-evil')).read()).toEqual({});
  });
  it('lets no slug spell another app\'s key', async () => {
    await save(open('cafe', app('app-one')));
    expect(await open('app-one', app('app-evil')).read()).toEqual({});
    expect(await open('cafe', app('app-one')).read()).toEqual({ session: 'synthetic-a' });
  });
  it('prefers what the app already has over an old slug map, and a reset clears both', async () => {
    await save(open('cafe', app('app-one')), 'current');
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'stale' }));
    const value = open('cafe', app('app-one'));
    expect(await value.read()).toEqual({ session: 'current' });
    await value.reset();
    expect(await value.read()).toEqual({});
    expect(localStorage.getItem(legacy('cafe'))).toBeNull();
  });
});

describe('the keys inside a map belong to the app, not to its slug', () => {
  const app = (appId: string): Scope => ({ access: 'application', appId });
  const stored = (appId: string) => JSON.parse(localStorage.getItem(`formlogic:native-app-storage:v1:${appId}`)!);
  const store = (appId: string, map: Record<string, string>) => localStorage.setItem(`formlogic:native-app-storage:v1:${appId}`, JSON.stringify(map));

  it('moves every key named after a slug to the id, seed records and app storage too', async () => {
    store('app-one', { 'xdb:native-cafe:notes': '[1]', 'xdb:native-cafe::seeded': 'yes', 'softn:native-cafe:token': 'kept', other: 'left alone' });
    const expected = { 'xdb:native-app-one:notes': '[1]', 'xdb:native-app-one::seeded': 'yes', 'softn:native-app-one:token': 'kept', other: 'left alone' };
    expect(await open('cafe', app('app-one')).read()).toEqual(expected);
    expect(stored('app-one')).toEqual(expected);
  });
  it('keeps an app\'s records through a rename made before the keys moved', async () => {
    store('app-one', { 'xdb:native-old-name:notes': '[1]' });
    expect(await open('new-name', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
  });
  it('lets the current slug win over an older one, losing neither', async () => {
    store('app-one', { 'xdb:native-old-name:notes': '[old]', 'xdb:native-new-name:notes': '[new]' });
    expect(await open('new-name', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[new]', 'xdb:native-old-name:notes': '[old]' });
  });
  it('never replaces what is already under the id', async () => {
    store('app-one', { 'xdb:native-app-one:notes': '[current]', 'xdb:native-cafe:notes': '[old]' });
    expect(await open('cafe', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[current]', 'xdb:native-cafe:notes': '[old]' });
  });
  it('does nothing to a map already in order, and writes nothing', async () => {
    store('app-one', { 'xdb:native-app-one:notes': '[1]' });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(await open('cafe', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
    expect(write).not.toHaveBeenCalled();
  });
  it('moves a member\'s keys too', async () => {
    localStorage.setItem('formlogic:native-member-storage:v1:member-a:app-one', JSON.stringify({ 'xdb:native-cafe:notes': '[1]' }));
    expect(await open('cafe', member()).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
  });
  it('leaves a key that would pass the key limit where it is', async () => {
    const name = `xdb:native-c:${'n'.repeat(240)}`;
    store('app-one', { [name]: '[1]' });
    expect(await open('c', app('a-rather-long-application-identifier')).read()).toEqual({});
    store('a-rather-long-application-identifier', { [name]: '[1]' });
    expect(await open('c', app('a-rather-long-application-identifier')).read()).toEqual({ [name]: '[1]' });
  });
  it('opens a map at its limit under the new names without rewriting it, and saves once it fits', async () => {
    const value = 'x'.repeat(29_000);
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`xdb:native-c:c${i}`, value]));
    const padded = { ...full, pad: 'y'.repeat(256 * 1024 - JSON.stringify(full).length - 12) };
    store('app-one', padded);
    const before = localStorage.getItem('formlogic:native-app-storage:v1:app-one');
    const opened = open('c', app('app-one'));
    expect((await opened.read())['xdb:native-app-one:c0']).toBe(value);
    expect(localStorage.getItem('formlogic:native-app-storage:v1:app-one')).toBe(before);
    await opened.mutate({ operation: 'remove', key: 'pad' });
    expect(stored('app-one')['xdb:native-app-one:c0']).toBe(value);
    expect(stored('app-one')['xdb:native-c:c0']).toBeUndefined();
  });
});

describe('two tabs on one map', () => {
  const app: Scope = { access: 'application', appId: 'app-one' };
  const write = (value: ReturnType<typeof open>, key: string, text: string) => value.mutate({ operation: 'set', key, value: text });

  it('refuses a save from a snapshot another tab has moved past, and keeps that tab\'s work', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await first.read(); await second.read();
    await write(first, 'notes', '[a]');
    await expect(write(second, 'notes', '[b]')).rejects.toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(await open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('lets two tabs save different keys', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await first.read(); await second.read();
    await write(first, 'notes', '[a]');
    await write(second, 'todos', '[b]');
    expect(await open('cafe', app).read()).toEqual({ notes: '[a]', todos: '[b]' });
  });
  it('lets a tab keep saving over its own writes', async () => {
    const first = open('cafe', app);
    await first.read();
    await write(first, 'notes', '[1]'); await write(first, 'notes', '[1,2]');
    await first.mutate({ operation: 'remove', key: 'notes' }); await write(first, 'notes', '[3]');
    expect(await open('cafe', app).read()).toEqual({ notes: '[3]' });
  });
  it('refuses a key another tab created or removed', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await write(first, 'notes', '[1]');
    await first.read(); await second.read();
    await write(first, 'todos', '[1]');
    await expect(write(second, 'todos', '[2]')).rejects.toThrowError(expect.objectContaining({ code: 'stale' }));
    await first.mutate({ operation: 'remove', key: 'notes' });
    await expect(write(second, 'notes', '[2]')).rejects.toThrowError(expect.objectContaining({ code: 'stale' }));
  });
  it('refuses a whole batch if one key moved, saving none of it', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await first.read(); await second.read();
    await write(first, 'notes', '[a]');
    const batch = { operation: 'batch', replacements: [{ key: 'todos', value: '[b]' }, { key: 'notes', value: '[b]' }] };
    await expect(second.mutate(batch)).rejects.toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(await open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('refuses a clear from an old snapshot', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await first.read(); await second.read();
    await write(first, 'notes', '[a]');
    await expect(second.mutate({ operation: 'clear' })).rejects.toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(await open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('accepts the same save again once the tab has read what changed', async () => {
    const first = open('cafe', app); const second = open('cafe', app);
    await first.read(); await second.read();
    await write(first, 'notes', '[a]');
    await second.read();
    await write(second, 'notes', '[a,b]');
    expect(await open('cafe', app).read()).toEqual({ notes: '[a,b]' });
  });
  it('holds no claim from before a reset', async () => {
    const first = open('cafe', app);
    await write(first, 'notes', '[a]');
    await first.reset();
    await write(first, 'notes', '[b]');
    expect(await open('cafe', app).read()).toEqual({ notes: '[b]' });
  });
});

describe('trusted native member namespaces', () => {
  it('never adopts or exports the previous unbound slug snapshot', async () => {
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'unattributed' }));
    const a = open('cafe', member());
    expect(await a.read()).toEqual({});
    expect(await a.exportRaw()).toBeNull();
    await save(a);
    await a.reset();
    expect(localStorage.getItem(legacy('cafe'))).toContain('unattributed');
  });
  it('separates A and B for the same slug, including export and reset', async () => {
    await save(open('cafe', member()));
    setSessionOwner('member-b');
    const b = open('cafe', member('member-b'));
    expect(await b.read()).toEqual({});
    expect(await b.exportRaw()).toBeNull();
    await save(b, 'synthetic-b');
    await b.reset();
    setSessionOwner('member-a');
    expect(await open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('separates app ids when a slug is reused and preserves app identity after rename', async () => {
    await save(open('cafe', member()));
    expect(await open('cafe', member('member-a', 'app-two')).read()).toEqual({});
    expect(await open('renamed-cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('same member refresh receives its own saved snapshot', async () => {
    await save(open('cafe', member()));
    bumpSessionGeneration();
    expect(await open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('mode changes cannot adopt application state or expose member state', async () => {
    await save(open('cafe', application), 'independent-app-session');
    const a = open('cafe', member());
    expect(await a.read()).toEqual({});
    await save(a);
    expect(await open('cafe', application).read()).toEqual({ session: 'independent-app-session' });
  });
  it.each([undefined, null, {}, { access: 'members', appId: 'app-one' }, { access: 'members', appId: '', userId: 'member-a' }, { access: 'members', appId: 'app-one', userId: '' }, { access: 'application', appId: '' }, { access: 'public', appId: 'app-one' }, { access: 'members', appId: 'x'.repeat(257), userId: 'member-a' }, { access: 'members', appId: 'app-one', userId: 'bad\nidentity' }])('rejects invalid scope %# before touching storage', async (scope) => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const value = open('cafe', scope);
    await expect(Promise.resolve().then(() => value.read())).rejects.toThrow();
    await expect(Promise.resolve().then(() => value.exportRaw())).rejects.toThrow();
    await expect(Promise.resolve().then(() => value.reset())).rejects.toThrow();
    await expect(Promise.resolve().then(() => save(value))).rejects.toThrow();
    expect(await value.status()).toMatchObject({ state: 'unavailable' });
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('rejects missing or mismatched active principal before touching the member map', async () => {
    const a = open('cafe', member());
    await save(a);
    setSessionOwner(null);
    const get = vi.spyOn(Storage.prototype, 'getItem');
    await expect(Promise.resolve().then(() => open('cafe', member()).read())).rejects.toThrow();
    setSessionOwner('member-b');
    await expect(Promise.resolve().then(() => open('cafe', member()).read())).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it.each(['read', 'exportRaw', 'reset', 'mutate'] as const)('rejects stale member %s after a session boundary', async (operation) => {
    const a = open('cafe', member()); await save(a); bumpSessionGeneration();
    await expect(Promise.resolve().then((): Promise<unknown> => operation === 'mutate' ? save(a, 'late') : a[operation]())).rejects.toThrow();
    expect(await open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('captures scope identity instead of following a later mutable response object', async () => {
    const scope = member() as { access: 'members'; appId: string; userId: string };
    const a = open('cafe', scope); await save(a); scope.userId = 'member-b';
    setSessionOwner('member-b');
    await expect(Promise.resolve().then(() => a.read())).rejects.toThrow();
    expect(await open('cafe', member('member-b')).read()).toEqual({});
  });
  it('uses encoded principal/app boundaries without collisions', async () => {
    setSessionOwner('a:b'); await save(open('cafe', member('a:b', 'c')));
    setSessionOwner('a'); expect(await open('cafe', member('a', 'b:c')).read()).toEqual({});
  });
  it('purges only leaving-member namespaces and keeps independent application and legacy data', async () => {
    await save(open('cafe', member())); await save(open('notes', member('member-a', 'app-two')));
    await save(open('cafe', application), 'application');
    setSessionOwner('member-b'); await save(open('cafe', member('member-b')), 'synthetic-b');
    await purge('member-a');
    expect(await open('cafe', member('member-b')).read()).toEqual({ session: 'synthetic-b' });
    expect(await open('cafe', application).read()).toEqual({ session: 'application' });
    setSessionOwner('member-a'); expect(await open('cafe', member()).read()).toEqual({});
    expect(await open('notes', member('member-a', 'app-two')).read()).toEqual({});
  });
  it('a failed purge never permits a stale helper to recreate private state', async () => {
    const a = open('cafe', member()); await save(a);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    bumpSessionGeneration(); await expect(Promise.resolve().then(() => purge('member-a'))).resolves.not.toThrow();
    await expect(Promise.resolve().then(() => save(a, 'late'))).rejects.toThrow();
    setSessionOwner('member-b'); expect(await open('cafe', member('member-b')).read()).toEqual({});
  });
  it('preserves damaged member bytes for only that member to export or reset', async () => {
    const a = open('cafe', member()); await save(a);
    const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(k => localStorage.getItem(k)?.includes('synthetic-a'))!;
    localStorage.setItem(key, '{broken');
    expect(await a.status()).toMatchObject({ state: 'corrupt' });
    await expect(Promise.resolve().then(() => save(a))).rejects.toThrow(); expect(await a.exportRaw()).toBe('{broken');
    setSessionOwner('member-b'); expect(await open('cafe', member('member-b')).exportRaw()).toBeNull();
    setSessionOwner('member-a'); await open('cafe', member()).reset(); expect(localStorage.getItem(key)).toBeNull();
  });
  it('keeps member limits and quota failures atomic', async () => {
    const a = open('cafe', member()); await save(a);
    await expect(Promise.resolve().then(() => save(a, 'x'.repeat(30001)))).rejects.toThrow();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic quota'); });
    await expect(Promise.resolve().then(() => save(a, 'new'))).rejects.toThrow();
    expect(await a.read()).toEqual({ session: 'synthetic-a' });
  });
});
