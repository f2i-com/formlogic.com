// The member screens decide which roles only the Owner may hand out from a client copy of the
// server's rule, because a role being chosen has no member row to carry the server's answer. The
// copy must be the server's own list (AppPermissions::APP_LEVEL, read from the backend source here)
// and must count a grant whether or not it is scoped to a form, as roleGrantsAppLevel does.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWNER_GUARDED_PERMISSIONS, roleGrantsOwnerGuarded, viewerOwnsApp, type AppPermission, type PermissionAction } from './app';

const php = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/src/Constants/AppPermissions.php'), 'utf8');

function serverAppLevel(): string[] {
  const values = new Map([...php.matchAll(/public const (\w+) = '([^']+)';/g)].map((m) => [m[1], m[2]]));
  const list = php.match(/public const APP_LEVEL = \[([\s\S]*?)\];/)?.[1] ?? '';
  return [...list.matchAll(/self::(\w+)/g)].map((m) => values.get(m[1]) ?? `unknown ${m[1]}`);
}

const grant = (permission: PermissionAction, formId: string | null): AppPermission => ({ id: 'p', roleId: 'r', formId, permission });

describe('the client copy of the server’s app-level rule', () => {
  it('is exactly AppPermissions::APP_LEVEL', () => {
    const server = serverAppLevel();
    expect(server.length).toBeGreaterThan(0);
    expect([...OWNER_GUARDED_PERMISSIONS].sort()).toEqual([...server].sort());
  });

  it('counts a form-scoped grant, and not running flows', () => {
    expect(roleGrantsOwnerGuarded({ permissions: [grant('manage_users', 'form-1')] })).toBe(true);
    expect(roleGrantsOwnerGuarded({ permissions: [grant('view_analytics', null)] })).toBe(true);
    expect(roleGrantsOwnerGuarded({ permissions: [grant('execute_flows', null)] })).toBe(false);
    expect(roleGrantsOwnerGuarded({ permissions: [grant('view_all_responses', 'form-1')] })).toBe(false);
  });
});

describe('viewerOwnsApp', () => {
  it('takes the server’s word: canManage, or the ownerId only the owner is sent', () => {
    expect(viewerOwnsApp({ ownerId: 'u1', canManage: true }, 'u1')).toBe(true);
    expect(viewerOwnsApp({ ownerId: 'u1' } as never, 'u1')).toBe(true);
    expect(viewerOwnsApp({ canManage: false } as never, 'u2')).toBe(false);
    expect(viewerOwnsApp({ ownerId: 'u1' } as never, 'u2')).toBe(false);
  });

  it('does not take an app that is not loaded as owned', () => {
    expect(viewerOwnsApp(undefined, 'u1')).toBe(false);
  });
});
