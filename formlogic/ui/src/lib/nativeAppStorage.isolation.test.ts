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
