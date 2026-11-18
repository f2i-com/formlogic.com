import { describe, expect, it } from 'vitest';
import { appClickLabel, appClickPath } from './appNavigation';

describe('where clicking an app goes', () => {
  it('takes an owner to the App Studio, or to a SoftN app\'s workspace, and a member to the running app', () => {
    expect(appClickPath({ id: 'a1', slug: 'ops', canManage: true })).toBe('/apps/a1/studio');
    expect(appClickPath({ id: 'a2', slug: 'recipes', canManage: true, settings: { softnApp: true } })).toBe('/apps/a2/web');
    expect(appClickPath({ id: 'a2', slug: 'recipes', canManage: false, settings: { softnApp: true } })).toBe('/app/recipes');
    expect(appClickLabel({ id: 'a2', slug: 'recipes', name: 'Recipes', canManage: true, settings: { softnApp: true } })).toBe('Open Recipes in its workspace');
    expect(appClickLabel({ id: 'a1', slug: 'ops', name: 'Ops', canManage: true })).toBe('Open Ops in its workspace');
  });
  it('resolves an older list entry against the signed-in owner', () => {
    const entry = { id: 'a1', slug: 'ops', ownerId: 'u1' };
    expect(appClickPath(entry, 'u1')).toBe('/apps/a1/studio');
    expect(appClickPath(entry, 'u2')).toBe('/app/ops');
    expect(appClickPath({ ...entry, canManage: false }, 'u1')).toBe('/app/ops');
  });
});
