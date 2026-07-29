import { describe, expect, it } from 'vitest';
import { interleaveMenu, menuForms, menuLinks, roleCanSeeForm } from './appMenu';
import type { AppNavItem, AppRuntimeForm, PermissionAction } from '../../types/app';

const form = (formId: string, extra: Partial<AppRuntimeForm> = {}): AppRuntimeForm => ({
  formId,
  displayName: formId,
  fields: [],
  settings: {},
  ...extra,
});

describe('menuForms', () => {
  it('drops data-only (hidden) and unlisted (menuHidden) forms, keeps the rest', () => {
    const forms = [form('a'), form('b', { hidden: true }), form('c', { menuHidden: true }), form('d')];
    expect(menuForms(forms).map((f) => f.formId)).toEqual(['a', 'd']);
  });
});

// Mirrors AppPublicController::memberCanSeeForm. The Studio's role preview reads the
// SAME rule; when they drifted, the preview told owners that working screens were
// inaccessible and invited them to hide live navigation.
describe('roleCanSeeForm', () => {
  const p = (permission: PermissionAction, formId: string | null = null) => ({ formId, permission });

  it('accepts every per-form permission, not just view/submit', () => {
    for (const perm of ['submit_responses', 'view_own_responses', 'view_all_responses', 'edit_responses', 'delete_responses', 'export_responses'] as PermissionAction[]) {
      expect(roleCanSeeForm([p(perm, 'f1')], 'f1')).toBe(true);
    }
    expect(roleCanSeeForm([p('view_analytics', 'f1')], 'f1')).toBe(true);
  });

  it('an app-wide (formId null) grant covers every form', () => {
    expect(roleCanSeeForm([p('manage_app')], 'anything')).toBe(true);
    expect(roleCanSeeForm([p('view_analytics')], 'anything')).toBe(true);
    expect(roleCanSeeForm([p('submit_responses')], 'anything')).toBe(true);
  });

  it('a grant on another form does not leak, and admin grants that are not app-wide do not either', () => {
    expect(roleCanSeeForm([p('view_all_responses', 'f2')], 'f1')).toBe(false);
    expect(roleCanSeeForm([], 'f1')).toBe(false);
    // manage_users is not a form-reaching permission at all.
    expect(roleCanSeeForm([p('manage_users')], 'f1')).toBe(false);
  });
});

describe('menuLinks', () => {
  const nav = (over: Partial<AppNavItem>): AppNavItem => ({
    kind: 'link',
    id: 'l1',
    displayName: 'Help',
    url: 'https://example.com',
    sortOrder: 0,
    isVisible: true,
    ...over,
  });

  it('keeps http(s) links as external and validates in-app targets', () => {
    const ids = new Set(['f1']);
    const out = menuLinks([
      nav({ id: 'a', url: 'https://example.com/docs' }),
      nav({ id: 'b', url: 'records' }),
      nav({ id: 'c', url: 'form/f1' }),
    ], ids);
    expect(out.map((l) => [l.key, l.externalUrl ?? null, l.appTarget ?? null])).toEqual([
      ['a', 'https://example.com/docs', null],
      ['b', null, 'records'],
      ['c', null, 'form/f1'],
    ]);
  });

  it('never renders unsafe or broken entries: schemes, hidden-form targets, blanks, isVisible=false', () => {
    const ids = new Set(['visible-form']); // the hidden form id is NOT in the navigable set
    const out = menuLinks([
      nav({ id: 'js', url: 'javascript:alert(1)' }),
      nav({ id: 'data', url: 'data:text/html,x' }),
      nav({ id: 'hidden-target', url: 'form/hidden-form' }),
      nav({ id: 'blank-url', url: '  ' }),
      nav({ id: 'blank-label', displayName: ' ' }),
      nav({ id: 'off', isVisible: false }),
      nav({ id: 'ok', url: 'form/visible-form' }),
    ], ids);
    expect(out.map((l) => l.key)).toEqual(['ok']);
  });

  it('legacy form entries (no kind) are never treated as links', () => {
    const legacy = { formId: 'f1', displayName: 'Form', sortOrder: 0, isVisible: true } as AppNavItem;
    expect(menuLinks([legacy], new Set(['f1']))).toEqual([]);
  });

  it('sorts by position; missing sortOrder goes last', () => {
    const out = menuLinks([
      nav({ id: 'z', sortOrder: 5 }),
      nav({ id: 'a', sortOrder: 1 }),
      nav({ id: 'end', sortOrder: Number.NaN }),
    ], new Set());
    expect(out.map((l) => l.key)).toEqual(['a', 'z', 'end']);
  });
});

describe('interleaveMenu', () => {
  it('inserts links at their authored slot, clamping out-of-range to the end', () => {
    const base = ['f1', 'f2', 'f3'];
    const out = interleaveMenu(base, [
      { position: 0, key: 'top' },
      { position: 99, key: 'bottom' },
      { position: 2, key: 'mid' },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : `[${(e as { key: string }).key}]`)))
      .toEqual(['[top]', 'f1', '[mid]', 'f2', 'f3', '[bottom]']);
  });
});
