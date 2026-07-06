import { describe, expect, it } from 'vitest';
import {
  cleanPermissions,
  collectAllGrants,
  effectRequiredPermission,
  isDefaultSafeEffect,
  isPermissionGranted,
} from './appLogicPermissions';
import type { CustomAppLogicBundle, CustomAppLogicEffect } from '../../types/customAppLogic';

const effect = (e: Record<string, unknown>): CustomAppLogicEffect => e as unknown as CustomAppLogicEffect;

describe('isPermissionGranted — wildcard matching', () => {
  it('matches exactly', () => {
    expect(isPermissionGranted('ui.toast', ['ui.toast'])).toBe(true);
    expect(isPermissionGranted('ui.toast', ['ui.setValues'])).toBe(false);
  });
  it('honors the global wildcard', () => {
    expect(isPermissionGranted('connector.vehicle.status.read', ['*'])).toBe(true);
  });
  it('honors a prefix wildcard for nested commands', () => {
    expect(isPermissionGranted('connector.vehicle.status.read', ['connector.vehicle.*'])).toBe(true);
    expect(isPermissionGranted('connector.vehicle', ['connector.vehicle.*'])).toBe(true);
  });
  it('does not over-match a sibling prefix', () => {
    expect(isPermissionGranted('connector.vehicles.x', ['connector.vehicle.*'])).toBe(false);
    expect(isPermissionGranted('connector.device.gps.read', ['connector.vehicle.*'])).toBe(false);
  });
});

describe('effectRequiredPermission', () => {
  it('maps connector.request to connector.<id>.<command>', () => {
    expect(effectRequiredPermission(effect({ type: 'connector.request', connectorId: 'device', command: 'gps.read' }))).toBe(
      'connector.device.gps.read'
    );
  });
  it('maps storage effects to storage.local', () => {
    expect(effectRequiredPermission(effect({ type: 'storage.set', key: 'k', value: 1 }))).toBe('storage.local');
  });
  it('maps response writes', () => {
    expect(effectRequiredPermission(effect({ type: 'formlogic.submitResponse', formKey: 'f', answers: {} }))).toBe(
      'formlogic.responses.write'
    );
  });
});

describe('isDefaultSafeEffect', () => {
  it('allows only ui.setValues and ui.toast', () => {
    expect(isDefaultSafeEffect(effect({ type: 'ui.setValues', values: {} }))).toBe(true);
    expect(isDefaultSafeEffect(effect({ type: 'ui.toast', message: 'x' }))).toBe(true);
  });
  it('never allows connector / storage / response / navigate effects', () => {
    expect(isDefaultSafeEffect(effect({ type: 'connector.request', connectorId: 'v', command: 'c' }))).toBe(false);
    expect(isDefaultSafeEffect(effect({ type: 'storage.set', key: 'k', value: 1 }))).toBe(false);
    expect(isDefaultSafeEffect(effect({ type: 'formlogic.submitResponse', formKey: 'f', answers: {} }))).toBe(false);
    expect(isDefaultSafeEffect(effect({ type: 'ui.navigate', screenId: 's' }))).toBe(false);
  });
});

describe('collectAllGrants', () => {
  it('unions bundle-level and per-script permissions', () => {
    const bundle = {
      version: 1,
      runtime: 'quickjs',
      permissions: ['ui.toast'],
      scripts: [
        { id: 's1', hook: 'onScreenEnter', source: 'x', permissions: ['connector.device.gps.read'] },
        { id: 's2', hook: 'onScreenEnter', source: 'y', permissions: ['ui.setValues'] },
      ],
    } as unknown as CustomAppLogicBundle;
    const grants = collectAllGrants(bundle);
    expect(grants.has('ui.toast')).toBe(true);
    expect(grants.has('connector.device.gps.read')).toBe(true);
    expect(grants.has('ui.setValues')).toBe(true);
  });
  it('returns an empty set for null', () => {
    expect(collectAllGrants(null).size).toBe(0);
  });
});

describe('cleanPermissions', () => {
  it('dedupes, trims, and drops blanks/non-strings', () => {
    expect(cleanPermissions(['ui.toast', 'ui.toast', '', '  ', 123, null, ' ui.setValues '])).toEqual([
      'ui.toast',
      'ui.setValues',
    ]);
  });
  it('returns [] for non-arrays', () => {
    expect(cleanPermissions('nope')).toEqual([]);
  });
});
