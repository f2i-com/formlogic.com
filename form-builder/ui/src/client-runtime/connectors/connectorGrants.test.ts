import { describe, expect, it } from 'vitest';
import { collectConnectorGrants } from './connectorGrants';
import { isPermissionGranted } from '../logic/appLogicPermissions';
import type { CustomAppLogicBundle, CustomAppLogicPermission } from '../../types/customAppLogic';
import type { AppRuntimeConfig } from '../../types/app';

/** Build a customLogic bundle with bundle-level + optional per-script permissions. */
function bundle(permissions: string[], scriptPerms: string[][] = []): CustomAppLogicBundle {
  return {
    version: 1,
    runtime: 'quickjs',
    permissions: permissions as CustomAppLogicPermission[],
    scripts: scriptPerms.map((perms, i) => ({
      id: `s${i}`,
      hook: 'onScreenEnter',
      runtime: 'quickjs',
      source: '',
      permissions: perms as CustomAppLogicPermission[],
    })),
  };
}

/** Minimal runtime config accepted by collectConnectorGrants (only app + forms customLogic are read). */
function config(
  appLogic: CustomAppLogicBundle | undefined,
  forms: Array<{ formId: string; customLogic?: CustomAppLogicBundle | null }>
): Pick<AppRuntimeConfig, 'app' | 'forms'> {
  return { app: { customLogic: appLogic }, forms } as unknown as Pick<AppRuntimeConfig, 'app' | 'forms'>;
}

const can = (grants: Set<string>, cmd: string) => isPermissionGranted(cmd, grants);

describe('collectConnectorGrants', () => {
  it('resolves an app-level connector grant', () => {
    const grants = collectConnectorGrants(config(bundle(['connector.vehicle.status.read']), []));
    expect(can(grants, 'connector.vehicle.status.read')).toBe(true);
    expect(can(grants, 'connector.vehicle.lock.set')).toBe(false); // denied — not granted
  });

  it('resolves a FORM-level connector grant (union of all visible forms when no formId)', () => {
    const grants = collectConnectorGrants(
      config(undefined, [{ formId: 'A', customLogic: bundle(['connector.printer.print']) }])
    );
    expect(can(grants, 'connector.printer.print')).toBe(true);
  });

  it('unions app-level AND every form-level grant', () => {
    const grants = collectConnectorGrants(
      config(bundle(['connector.vehicle.status.read']), [
        { formId: 'A', customLogic: bundle(['connector.printer.print']) },
        { formId: 'B', customLogic: bundle(['connector.scale.weigh']) },
      ])
    );
    expect(can(grants, 'connector.vehicle.status.read')).toBe(true);
    expect(can(grants, 'connector.printer.print')).toBe(true);
    expect(can(grants, 'connector.scale.weigh')).toBe(true);
  });

  it('includes script-level grants (additive on top of bundle grants)', () => {
    const grants = collectConnectorGrants(
      config(undefined, [
        { formId: 'A', customLogic: bundle([], [['connector.camera.capture']]) },
      ])
    );
    expect(can(grants, 'connector.camera.capture')).toBe(true);
  });

  it('honors wildcard grants (connector.<id>.* and *)', () => {
    const scoped = collectConnectorGrants(config(bundle(['connector.vehicle.*']), []));
    expect(can(scoped, 'connector.vehicle.status.read')).toBe(true);
    expect(can(scoped, 'connector.vehicle.lock.set')).toBe(true);
    expect(can(scoped, 'connector.printer.print')).toBe(false);

    const all = collectConnectorGrants(config(bundle(['*']), []));
    expect(can(all, 'connector.anything.at.all')).toBe(true);
  });

  it('scopes to app + one form when { formId } is passed (excludes other forms grants)', () => {
    const cfg = config(bundle(['connector.vehicle.status.read']), [
      { formId: 'A', customLogic: bundle(['connector.printer.print']) },
      { formId: 'B', customLogic: bundle(['connector.scale.weigh']) },
    ]);
    const grants = collectConnectorGrants(cfg, { formId: 'A' });
    expect(can(grants, 'connector.vehicle.status.read')).toBe(true); // app-level always included
    expect(can(grants, 'connector.printer.print')).toBe(true); // form A included
    expect(can(grants, 'connector.scale.weigh')).toBe(false); // form B excluded when scoped to A
  });

  it('returns an empty set (everything denied) for a null config or forms without logic', () => {
    expect(collectConnectorGrants(null).size).toBe(0);
    const grants = collectConnectorGrants(config(undefined, [{ formId: 'A', customLogic: null }]));
    expect(can(grants, 'connector.vehicle.status.read')).toBe(false);
  });
});
