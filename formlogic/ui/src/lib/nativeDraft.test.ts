// @vitest-environment jsdom
// Audit FL-S08: a draft checkpoint says whether it was kept and, when not,
// why; drafts share a budget well under the origin's storage so hosted apps'
// own storage keeps its room, and a draft that does not fit is refused rather
// than written over another draft.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeDraftStore, type NativeDraftCheckpoint } from './nativeDraft';

const MiB = 1024 * 1024;
const draftKey = (user: string, app = 'app1') => `formlogic:native-draft:${user}:${app}`;
const checkpoint = (logic: string, media = ''): NativeDraftCheckpoint => ({ baseVersion: 2, savedAt: '2026-09-15T00:00:00.000Z', project: { version: 2, files: { 'server/main.logic': logic }, assets: media ? { 'media/photo.png': media } : {}, access: 'application' } });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('keeps a draft only for a signed-in account', () => {
  expect(nativeDraftStore(undefined, 'app1').write(checkpoint('mine()'))).toBe('unscoped');
  expect(localStorage.length).toBe(0);
  const drafts = nativeDraftStore('u1', 'app1');
  expect(drafts.write(checkpoint('mine()'))).toBe('kept');
  expect(drafts.read()?.project.files['server/main.logic']).toBe('mine()');
});

it('refuses a draft over the per-draft limit without serialising it, and keeps the previous checkpoint', () => {
  const drafts = nativeDraftStore('u1', 'app1');
  expect(drafts.write(checkpoint('before()'))).toBe('kept');
  const stringify = vi.spyOn(JSON, 'stringify');
  expect(drafts.write(checkpoint('after()', 'A'.repeat(MiB + 1)))).toBe('too-large');
  expect(stringify).not.toHaveBeenCalled();
  expect(drafts.read()?.project.files['server/main.logic']).toBe('before()');
});

it('measures the stored JSON, not just the sources, against the limit', () => {
  // Every quote doubles when escaped: under the limit as text, over it as JSON.
  expect(nativeDraftStore('u1', 'app1').write(checkpoint('"'.repeat(600_000)))).toBe('too-large');
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
});

it('shares one budget across all drafts and refuses rather than evicting another draft', () => {
  const other = 'x'.repeat(1_500_000);
  localStorage.setItem(draftKey('u2', 'app9'), other);
  const drafts = nativeDraftStore('u1', 'app1');
  expect(drafts.write(checkpoint('big()', 'A'.repeat(600_000)))).toBe('full');
  expect(localStorage.getItem(draftKey('u2', 'app9'))).toBe(other);
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(drafts.write(checkpoint('small()'))).toBe('kept');
});

it('counts a draft an earlier version kept under a larger limit, and leaves it for its owner', () => {
  localStorage.setItem(draftKey('u2', 'app9'), JSON.stringify(checkpoint('legacy()', 'A'.repeat(2_500_000))));
  expect(nativeDraftStore('u1', 'app1').write(checkpoint('mine()'))).toBe('full');
  expect(localStorage.getItem(draftKey('u1'))).toBeNull();
  expect(nativeDraftStore('u2', 'app9').read()?.project.files['server/main.logic']).toBe('legacy()');
});

it('counts only other drafts: rewriting its own draft or other storage does not use the budget', () => {
  localStorage.setItem(draftKey('u2', 'app9'), 'x'.repeat(MiB));
  localStorage.setItem('formlogic:native-storage:notes', 'y'.repeat(1_500_000));
  const drafts = nativeDraftStore('u1', 'app1');
  expect(drafts.write(checkpoint('first()', 'A'.repeat(900_000)))).toBe('kept');
  expect(drafts.write(checkpoint('second()', 'A'.repeat(900_000)))).toBe('kept');
  expect(drafts.read()?.project.files['server/main.logic']).toBe('second()');
});

it('reports a storage refusal, and the previous checkpoint stays', () => {
  const drafts = nativeDraftStore('u1', 'app1');
  expect(drafts.write(checkpoint('before()'))).toBe('kept');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  expect(drafts.write(checkpoint('after()'))).toBe('unavailable');
  expect(drafts.read()?.project.files['server/main.logic']).toBe('before()');
});
