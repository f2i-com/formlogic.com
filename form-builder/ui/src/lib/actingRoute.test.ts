import { describe, expect, it } from 'vitest';
import { actingRoute } from './api';

/**
 * The platform-admin acting-mode endpoint router. This table IS the client
 * side of the no-response-data boundary (the backend allowlist is the
 * authoritative one): owner endpoints rewrite onto the mirror, record-data
 * endpoints refuse, unknown endpoints default-deny.
 */
describe('actingRoute', () => {
  const OWNER = 'owner-123';
  const route = (endpoint: string) => actingRoute(endpoint, OWNER);

  it('rewrites owner-scoped endpoints onto the acting-as mirror', () => {
    for (const [from, to] of [
      ['/forms', `/admin/users/${OWNER}/forms`],
      ['/forms?limit=200&offset=0', `/admin/users/${OWNER}/forms?limit=200&offset=0`],
      ['/forms/f1', `/admin/users/${OWNER}/forms/f1`],
      ['/forms/f1/webhooks', `/admin/users/${OWNER}/forms/f1/webhooks`],
      ['/forms/f1/webhooks/w1/deliveries', `/admin/users/${OWNER}/forms/f1/webhooks/w1/deliveries`],
      ['/forms/f1/flow-bindings', `/admin/users/${OWNER}/forms/f1/flow-bindings`],
      ['/forms/f1/versions/3/restore', `/admin/users/${OWNER}/forms/f1/versions/3/restore`],
      ['/forms/f1/app-contexts', `/admin/users/${OWNER}/forms/f1/app-contexts`],
      ['/apps', `/admin/users/${OWNER}/apps`],
      ['/apps/form-usage', `/admin/users/${OWNER}/apps/form-usage`],
      ['/apps/a1', `/admin/users/${OWNER}/apps/a1`],
      ['/apps/a1/forms/reorder', `/admin/users/${OWNER}/apps/a1/forms/reorder`],
      ['/apps/a1/roles/r1/permissions', `/admin/users/${OWNER}/apps/a1/roles/r1/permissions`],
      ['/apps/a1/users', `/admin/users/${OWNER}/apps/a1/users`],
      ['/apps/a1/invitations', `/admin/users/${OWNER}/apps/a1/invitations`],
      ['/apps/a1/domains/d1/verify', `/admin/users/${OWNER}/apps/a1/domains/d1/verify`],
      ['/apps/a1/flows/fl1/test-run', `/admin/users/${OWNER}/apps/a1/flows/fl1/test-run`],
      ['/apps/a1/flow-bindings', `/admin/users/${OWNER}/apps/a1/flow-bindings`],
      ['/apps/a1/flow-runs', `/admin/users/${OWNER}/apps/a1/flow-runs`],
      ['/flows', `/admin/users/${OWNER}/flows`],
      ['/flows/fl1/bindings', `/admin/users/${OWNER}/flows/fl1/bindings`],
      ['/flow-runs', `/admin/users/${OWNER}/flow-runs`],
      ['/flow-runs/r1', `/admin/users/${OWNER}/flow-runs/r1`],
    ] as const) {
      expect(route(from)).toEqual({ endpoint: to, blocked: false });
    }
  });

  it('refuses every record-data surface', () => {
    for (const endpoint of [
      '/forms/f1/responses',
      '/forms/f1/responses/export',
      '/forms/f1/responses/import',
      '/forms/f1/responses/r1',
      '/forms/f1/responses/r1/recompute',
      '/forms/f1/analytics',
      '/forms/f1/lookup?field=x',
      '/forms/f1/reports/run',
      '/forms/f1/reports/run-batch',
      '/forms/f1/script/test',
      '/forms/f1/export/sqlite',
      '/forms/f1/export/json',
      '/forms/f1/start',
      '/forms/f1/upload',
      '/app/some-slug/records',
      '/app/some-slug/reports/run',
      '/apps/a1/export',
      '/apps/a1/export/signed',
      '/apps/a1/export/package',
      '/files/f1/file1/name.png',
      '/flow-runs/queued',
      '/flow-runs/r1/claim',
      '/flow-kv',
      '/flow-kv?scope=x',
    ]) {
      expect(route(endpoint).blocked, `${endpoint} must be blocked`).toBe(true);
    }
  });

  it('passes admin-self surfaces through untouched', () => {
    for (const endpoint of [
      '/admin/users/u1',
      '/admin/apps/a1',
      '/auth/me',
      '/notices',
      '/ai/generate-screen',
      '/packs/installed',
      '/desktop-connections',
      '/health/deep',
    ]) {
      expect(route(endpoint)).toEqual({ endpoint, blocked: false });
    }
  });

  it('default-denies anything unmapped (loud failure, never a silent owner call)', () => {
    for (const endpoint of ['/v1/responses', '/some-future-endpoint', '/desktop']) {
      expect(route(endpoint).blocked, `${endpoint} must default-deny`).toBe(true);
    }
  });

  it('refuses account backups while acting — the export zip CONTAINS record data', () => {
    for (const endpoint of ['/account/backup/export', '/account/backup/import']) {
      expect(route(endpoint).blocked, `${endpoint} must be refused for acting admins`).toBe(true);
    }
  });
});
