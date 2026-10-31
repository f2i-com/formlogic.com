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
const purge = (userId: string) => (storage as unknown as { clearNativeMemberStorage: (id: string) => void }).clearNativeMemberStorage(userId);

beforeEach(() => { localStorage.clear(); setSessionOwner('member-a'); bumpSessionGeneration(); });
afterEach(() => { vi.restoreAllMocks(); setSessionOwner(null); });

describe('an application map belongs to the app, not to its slug', () => {
  const app = (appId: string): Scope => ({ access: 'application', appId });

  it('gives an app that claims a freed slug nothing a visitor saved in the app before it', () => {
    save(open('cafe', app('app-one')));
    expect(open('cafe', app('app-evil')).read()).toEqual({});
    expect(open('cafe', app('app-evil')).exportRaw()).toBeNull();
  });
  it('follows its app through a rename', () => {
    save(open('cafe', app('app-one')));
    expect(open('renamed-cafe', app('app-one')).read()).toEqual({ session: 'synthetic-a' });
  });
  it('moves what was saved under the slug to the app the first time it asks, and only once', () => {
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'from-before' }));
    expect(open('cafe', app('app-one')).read()).toEqual({ session: 'from-before' });
    expect(localStorage.getItem(legacy('cafe'))).toBeNull();
    expect(open('cafe', app('app-evil')).read()).toEqual({});
  });
  it('lets no slug spell another app\'s key', () => {
    save(open('cafe', app('app-one')));
    expect(open('app-one', app('app-evil')).read()).toEqual({});
    expect(open('cafe', app('app-one')).read()).toEqual({ session: 'synthetic-a' });
  });
  it('prefers what the app already has over an old slug map, and a reset clears both', () => {
    save(open('cafe', app('app-one')), 'current');
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'stale' }));
    const value = open('cafe', app('app-one'));
    expect(value.read()).toEqual({ session: 'current' });
    value.reset();
    expect(value.read()).toEqual({});
    expect(localStorage.getItem(legacy('cafe'))).toBeNull();
  });
});

describe('the keys inside a map belong to the app, not to its slug', () => {
  const app = (appId: string): Scope => ({ access: 'application', appId });
  const stored = (appId: string) => JSON.parse(localStorage.getItem(`formlogic:native-app-storage:v1:${appId}`)!);
  const store = (appId: string, map: Record<string, string>) => localStorage.setItem(`formlogic:native-app-storage:v1:${appId}`, JSON.stringify(map));

  it('moves every key named after a slug to the id, seed records and app storage too', () => {
    store('app-one', { 'xdb:native-cafe:notes': '[1]', 'xdb:native-cafe::seeded': 'yes', 'softn:native-cafe:token': 'kept', other: 'left alone' });
    const expected = { 'xdb:native-app-one:notes': '[1]', 'xdb:native-app-one::seeded': 'yes', 'softn:native-app-one:token': 'kept', other: 'left alone' };
    expect(open('cafe', app('app-one')).read()).toEqual(expected);
    expect(stored('app-one')).toEqual(expected);
  });
  it('keeps an app\'s records through a rename made before the keys moved', () => {
    store('app-one', { 'xdb:native-old-name:notes': '[1]' });
    expect(open('new-name', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
  });
  it('lets the current slug win over an older one, losing neither', () => {
    store('app-one', { 'xdb:native-old-name:notes': '[old]', 'xdb:native-new-name:notes': '[new]' });
    expect(open('new-name', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[new]', 'xdb:native-old-name:notes': '[old]' });
  });
  it('never replaces what is already under the id', () => {
    store('app-one', { 'xdb:native-app-one:notes': '[current]', 'xdb:native-cafe:notes': '[old]' });
    expect(open('cafe', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[current]', 'xdb:native-cafe:notes': '[old]' });
  });
  it('does nothing to a map already in order, and writes nothing', () => {
    store('app-one', { 'xdb:native-app-one:notes': '[1]' });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(open('cafe', app('app-one')).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
    expect(write).not.toHaveBeenCalled();
  });
  it('moves a member\'s keys too', () => {
    localStorage.setItem('formlogic:native-member-storage:v1:member-a:app-one', JSON.stringify({ 'xdb:native-cafe:notes': '[1]' }));
    expect(open('cafe', member()).read()).toEqual({ 'xdb:native-app-one:notes': '[1]' });
  });
  it('leaves a key that would pass the key limit where it is', () => {
    const name = `xdb:native-c:${'n'.repeat(240)}`;
    store('app-one', { [name]: '[1]' });
    expect(open('c', app('a-rather-long-application-identifier')).read()).toEqual({});
    store('a-rather-long-application-identifier', { [name]: '[1]' });
    expect(open('c', app('a-rather-long-application-identifier')).read()).toEqual({ [name]: '[1]' });
  });
  it('opens a map at its limit under the new names without rewriting it, and saves once it fits', () => {
    const value = 'x'.repeat(29_000);
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`xdb:native-c:c${i}`, value]));
    const padded = { ...full, pad: 'y'.repeat(256 * 1024 - JSON.stringify(full).length - 12) };
    store('app-one', padded);
    const before = localStorage.getItem('formlogic:native-app-storage:v1:app-one');
    const opened = open('c', app('app-one'));
    expect(opened.read()['xdb:native-app-one:c0']).toBe(value);
    expect(localStorage.getItem('formlogic:native-app-storage:v1:app-one')).toBe(before);
    opened.mutate({ operation: 'remove', key: 'pad' });
    expect(stored('app-one')['xdb:native-app-one:c0']).toBe(value);
    expect(stored('app-one')['xdb:native-c:c0']).toBeUndefined();
  });
});

describe('two tabs on one map', () => {
  const app: Scope = { access: 'application', appId: 'app-one' };
  const write = (value: ReturnType<typeof open>, key: string, text: string) => value.mutate({ operation: 'set', key, value: text });

  it('refuses a save from a snapshot another tab has moved past, and keeps that tab\'s work', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    first.read(); second.read();
    write(first, 'notes', '[a]');
    expect(() => write(second, 'notes', '[b]')).toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('lets two tabs save different keys', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    first.read(); second.read();
    write(first, 'notes', '[a]');
    write(second, 'todos', '[b]');
    expect(open('cafe', app).read()).toEqual({ notes: '[a]', todos: '[b]' });
  });
  it('lets a tab keep saving over its own writes', () => {
    const first = open('cafe', app);
    first.read();
    write(first, 'notes', '[1]'); write(first, 'notes', '[1,2]');
    first.mutate({ operation: 'remove', key: 'notes' }); write(first, 'notes', '[3]');
    expect(open('cafe', app).read()).toEqual({ notes: '[3]' });
  });
  it('refuses a key another tab created or removed', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    write(first, 'notes', '[1]');
    first.read(); second.read();
    write(first, 'todos', '[1]');
    expect(() => write(second, 'todos', '[2]')).toThrowError(expect.objectContaining({ code: 'stale' }));
    first.mutate({ operation: 'remove', key: 'notes' });
    expect(() => write(second, 'notes', '[2]')).toThrowError(expect.objectContaining({ code: 'stale' }));
  });
  it('refuses a whole batch if one key moved, saving none of it', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    first.read(); second.read();
    write(first, 'notes', '[a]');
    const batch = { operation: 'batch', replacements: [{ key: 'todos', value: '[b]' }, { key: 'notes', value: '[b]' }] };
    expect(() => second.mutate(batch)).toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('refuses a clear from an old snapshot', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    first.read(); second.read();
    write(first, 'notes', '[a]');
    expect(() => second.mutate({ operation: 'clear' })).toThrowError(expect.objectContaining({ code: 'stale' }));
    expect(open('cafe', app).read()).toEqual({ notes: '[a]' });
  });
  it('accepts the same save again once the tab has read what changed', () => {
    const first = open('cafe', app); const second = open('cafe', app);
    first.read(); second.read();
    write(first, 'notes', '[a]');
    second.read();
    write(second, 'notes', '[a,b]');
    expect(open('cafe', app).read()).toEqual({ notes: '[a,b]' });
  });
  it('holds no claim from before a reset', () => {
    const first = open('cafe', app);
    write(first, 'notes', '[a]');
    first.reset();
    write(first, 'notes', '[b]');
    expect(open('cafe', app).read()).toEqual({ notes: '[b]' });
  });
});

describe('trusted native member namespaces', () => {
  it('never adopts or exports the previous unbound slug snapshot', () => {
    localStorage.setItem(legacy('cafe'), JSON.stringify({ session: 'unattributed' }));
    const a = open('cafe', member());
    expect(a.read()).toEqual({});
    expect(a.exportRaw()).toBeNull();
    save(a);
    a.reset();
    expect(localStorage.getItem(legacy('cafe'))).toContain('unattributed');
  });
  it('separates A and B for the same slug, including export and reset', () => {
    save(open('cafe', member()));
    setSessionOwner('member-b');
    const b = open('cafe', member('member-b'));
    expect(b.read()).toEqual({});
    expect(b.exportRaw()).toBeNull();
    save(b, 'synthetic-b');
    b.reset();
    setSessionOwner('member-a');
    expect(open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('separates app ids when a slug is reused and preserves app identity after rename', () => {
    save(open('cafe', member()));
    expect(open('cafe', member('member-a', 'app-two')).read()).toEqual({});
    expect(open('renamed-cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('same member refresh receives its own saved snapshot', () => {
    save(open('cafe', member()));
    bumpSessionGeneration();
    expect(open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('mode changes cannot adopt application state or expose member state', () => {
    save(open('cafe', application), 'independent-app-session');
    const a = open('cafe', member());
    expect(a.read()).toEqual({});
    save(a);
    expect(open('cafe', application).read()).toEqual({ session: 'independent-app-session' });
  });
  it.each([undefined, null, {}, { access: 'members', appId: 'app-one' }, { access: 'members', appId: '', userId: 'member-a' }, { access: 'members', appId: 'app-one', userId: '' }, { access: 'application', appId: '' }, { access: 'public', appId: 'app-one' }, { access: 'members', appId: 'x'.repeat(257), userId: 'member-a' }, { access: 'members', appId: 'app-one', userId: 'bad\nidentity' }])('rejects invalid scope %# before touching storage', (scope) => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const value = open('cafe', scope);
    expect(() => value.read()).toThrow();
    expect(() => value.exportRaw()).toThrow();
    expect(() => value.reset()).toThrow();
    expect(() => save(value)).toThrow();
    expect(value.status()).toMatchObject({ state: 'unavailable' });
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('rejects missing or mismatched active principal before touching the member map', () => {
    const a = open('cafe', member());
    save(a);
    setSessionOwner(null);
    const get = vi.spyOn(Storage.prototype, 'getItem');
    expect(() => open('cafe', member()).read()).toThrow();
    setSessionOwner('member-b');
    expect(() => open('cafe', member()).read()).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it.each(['read', 'exportRaw', 'reset', 'mutate'] as const)('rejects stale member %s after a session boundary', (operation) => {
    const a = open('cafe', member()); save(a); bumpSessionGeneration();
    expect(() => operation === 'mutate' ? save(a, 'late') : a[operation]()).toThrow();
    expect(open('cafe', member()).read()).toEqual({ session: 'synthetic-a' });
  });
  it('captures scope identity instead of following a later mutable response object', () => {
    const scope = member() as { access: 'members'; appId: string; userId: string };
    const a = open('cafe', scope); save(a); scope.userId = 'member-b';
    setSessionOwner('member-b');
    expect(() => a.read()).toThrow();
    expect(open('cafe', member('member-b')).read()).toEqual({});
  });
  it('uses encoded principal/app boundaries without collisions', () => {
    setSessionOwner('a:b'); save(open('cafe', member('a:b', 'c')));
    setSessionOwner('a'); expect(open('cafe', member('a', 'b:c')).read()).toEqual({});
  });
  it('purges only leaving-member namespaces and keeps independent application and legacy data', () => {
    save(open('cafe', member())); save(open('notes', member('member-a', 'app-two')));
    save(open('cafe', application), 'application');
    setSessionOwner('member-b'); save(open('cafe', member('member-b')), 'synthetic-b');
    purge('member-a');
    expect(open('cafe', member('member-b')).read()).toEqual({ session: 'synthetic-b' });
    expect(open('cafe', application).read()).toEqual({ session: 'application' });
    setSessionOwner('member-a'); expect(open('cafe', member()).read()).toEqual({});
    expect(open('notes', member('member-a', 'app-two')).read()).toEqual({});
  });
  it('a failed purge never permits a stale helper to recreate private state', () => {
    const a = open('cafe', member()); save(a);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    bumpSessionGeneration(); expect(() => purge('member-a')).not.toThrow();
    expect(() => save(a, 'late')).toThrow();
    setSessionOwner('member-b'); expect(open('cafe', member('member-b')).read()).toEqual({});
  });
  it('preserves damaged member bytes for only that member to export or reset', () => {
    const a = open('cafe', member()); save(a);
    const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(k => localStorage.getItem(k)?.includes('synthetic-a'))!;
    localStorage.setItem(key, '{broken');
    expect(a.status()).toMatchObject({ state: 'corrupt' });
    expect(() => save(a)).toThrow(); expect(a.exportRaw()).toBe('{broken');
    setSessionOwner('member-b'); expect(open('cafe', member('member-b')).exportRaw()).toBeNull();
    setSessionOwner('member-a'); open('cafe', member()).reset(); expect(localStorage.getItem(key)).toBeNull();
  });
  it('keeps member limits and quota failures atomic', () => {
    const a = open('cafe', member()); save(a);
    expect(() => save(a, 'x'.repeat(30001))).toThrow();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic quota'); });
    expect(() => save(a, 'new')).toThrow();
    expect(a.read()).toEqual({ session: 'synthetic-a' });
  });
});
