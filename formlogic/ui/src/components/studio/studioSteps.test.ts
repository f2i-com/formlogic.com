import { describe, expect, it } from 'vitest';
import {
  STUDIO_STEPS,
  buildPreflightChecks,
  computeUnpublishedChanges,
  deriveCompletedSteps,
  deriveNextAction,
  isStudioStep,
  parseApiDate,
  versionLabel,
} from './studioSteps';

describe('studioSteps', () => {
  it('defines the six steps in order with Plan optional', () => {
    expect(STUDIO_STEPS.map((s) => s.id)).toEqual(['plan', 'data', 'screens', 'automations', 'access', 'publish']);
    expect(STUDIO_STEPS[0].optional).toBe(true);
    expect(STUDIO_STEPS.slice(1).every((s) => !s.optional)).toBe(true);
  });

  it('isStudioStep accepts only real step ids', () => {
    expect(isStudioStep('data')).toBe(true);
    expect(isStudioStep('publish')).toBe(true);
    expect(isStudioStep('settings')).toBe(false);
    expect(isStudioStep(undefined)).toBe(false);
    expect(isStudioStep(null)).toBe(false);
  });

  describe('deriveCompletedSteps', () => {
    const empty = {
      formCount: 0,
      hasBlueprint: false,
      hasHomeScreen: false,
      flowCount: 0,
      roleCount: 0,
      published: false,
    };

    it('a fresh app with roles only has access complete', () => {
      expect(deriveCompletedSteps({ ...empty, roleCount: 3 })).toEqual(['access']);
    });

    it('forms complete plan, data and screens together', () => {
      expect(deriveCompletedSteps({ ...empty, formCount: 2, roleCount: 3 })).toEqual([
        'plan',
        'data',
        'screens',
        'access',
      ]);
    });

    it('a blueprint alone completes plan; a custom home alone completes screens', () => {
      expect(deriveCompletedSteps({ ...empty, hasBlueprint: true })).toEqual(['plan']);
      expect(deriveCompletedSteps({ ...empty, hasHomeScreen: true })).toEqual(['screens']);
    });

    it('flows and publish complete their steps', () => {
      expect(
        deriveCompletedSteps({ ...empty, formCount: 1, flowCount: 2, roleCount: 3, published: true })
      ).toEqual(['plan', 'data', 'screens', 'automations', 'access', 'publish']);
    });
  });

  describe('parseApiDate', () => {
    it('treats zone-less DB timestamps as UTC', () => {
      expect(parseApiDate('2026-07-23 10:00:00')).toBe(Date.parse('2026-07-23T10:00:00Z'));
    });

    it('passes ISO strings through', () => {
      expect(parseApiDate('2026-07-23T10:00:00.000Z')).toBe(Date.parse('2026-07-23T10:00:00.000Z'));
    });

    it('returns NaN for absent values', () => {
      expect(Number.isNaN(parseApiDate(null))).toBe(true);
      expect(Number.isNaN(parseApiDate(''))).toBe(true);
    });
  });

  describe('computeUnpublishedChanges', () => {
    const app = { name: 'App', updatedAt: '2026-07-23 10:00:00', publishedAt: '2026-07-23 10:00:00' };

    it('never-published apps report everPublished false', () => {
      const result = computeUnpublishedChanges({ ...app, publishedAt: null }, [], []);
      expect(result.everPublished).toBe(false);
      expect(result.count).toBe(0);
    });

    it('publish stamps app.updated_at = published_at, so an untouched app counts zero', () => {
      const result = computeUnpublishedChanges(app, [], []);
      expect(result.everPublished).toBe(true);
      expect(result.count).toBe(0);
    });

    it('counts app, forms and flows updated strictly after the publish', () => {
      const result = computeUnpublishedChanges(
        { ...app, updatedAt: '2026-07-23 11:00:00' },
        [
          { id: 'f1', title: 'Jobs', updatedAt: '2026-07-23 12:00:00' },
          { id: 'f2', title: 'Old', updatedAt: '2026-07-23 09:00:00' },
        ],
        [{ id: 'fl1', name: 'Notify', updatedAt: '2026-07-24 00:00:00' }]
      );
      expect(result.count).toBe(3);
      expect(result.changed.map((c) => c.kind)).toEqual(['app', 'form', 'flow']);
      expect(result.changed.find((c) => c.kind === 'form')?.label).toBe('Jobs');
    });
  });

  describe('buildPreflightChecks', () => {
    const base = {
      formCount: 3,
      formsWithoutFields: [] as string[],
      flowCount: 2,
      activeFlowCount: 1,
      roleCount: 3,
      hasHomeScreen: true,
      hasCustomDomain: false,
      memberCount: 5,
    };

    it('an equipped app passes everything except the optional domain', () => {
      const checks = buildPreflightChecks(base);
      const warnings = checks.filter((c) => c.state === 'warning');
      expect(warnings.map((c) => c.id)).toEqual(['domain']);
    });

    it('flags empty forms with the offending names and routes to the data step', () => {
      const checks = buildPreflightChecks({ ...base, formsWithoutFields: ['Invoices'] });
      const forms = checks.find((c) => c.id === 'forms')!;
      expect(forms.state).toBe('warning');
      expect(forms.detail).toContain('Invoices');
      expect(forms.step).toBe('data');
    });

    it('an app with no forms warns on forms and screens', () => {
      const checks = buildPreflightChecks({ ...base, formCount: 0, hasHomeScreen: false });
      expect(checks.find((c) => c.id === 'forms')?.state).toBe('warning');
      expect(checks.find((c) => c.id === 'screens')?.state).toBe('warning');
    });

    it('automations never block publishing', () => {
      const checks = buildPreflightChecks({ ...base, flowCount: 0, activeFlowCount: 0 });
      expect(checks.find((c) => c.id === 'automations')?.state).toBe('complete');
    });

    it('tiers findings: real breakage blocks, advice recommends, polish stays optional', () => {
      const checks = buildPreflightChecks({
        ...base,
        formCount: 0,
        formsWithoutFields: [],
        landingPageMissing: true,
        signupWithoutDefaultRole: true,
        hasIcon: false,
      });
      expect(checks.find((c) => c.id === 'forms')?.severity).toBe('blocking');
      expect(checks.find((c) => c.id === 'landing')?.severity).toBe('blocking');
      expect(checks.find((c) => c.id === 'landing')?.step).toBe('screens');
      expect(checks.find((c) => c.id === 'signup-role')?.severity).toBe('blocking');
      expect(checks.find((c) => c.id === 'signup-role')?.step).toBe('access');
      expect(checks.find((c) => c.id === 'icon')?.severity).toBe('optional');
      expect(checks.find((c) => c.id === 'domain')?.severity).toBe('optional');
      // Fieldless forms are advice, never a wall.
      const fieldless = buildPreflightChecks({ ...base, formsWithoutFields: ['Invoices'] });
      expect(fieldless.find((c) => c.id === 'forms')?.severity).toBe('recommended');
      // Healthy inputs surface none of the conditional checks.
      const healthy = buildPreflightChecks({ ...base, hasIcon: true });
      expect(healthy.some((c) => c.id === 'landing' || c.id === 'signup-role' || c.id === 'icon')).toBe(false);
      expect(healthy.filter((c) => c.state === 'complete').every((c) => c.severity === undefined)).toBe(true);
    });
  });

  describe('deriveNextAction', () => {
    const base = {
      formCount: 2,
      fieldlessFormNames: [] as string[],
      flowCount: 1,
      memberCount: 3,
      published: true,
      unpublishedCount: 0,
    };

    it('recommends exactly one action in priority order', () => {
      expect(deriveNextAction({ ...base, formCount: 0 })?.step).toBe('data');
      expect(deriveNextAction({ ...base, fieldlessFormNames: ['Jobs'] })).toMatchObject({ step: 'data', title: 'Finish Jobs' });
      expect(deriveNextAction({ ...base, published: false })?.step).toBe('publish');
      expect(deriveNextAction({ ...base, unpublishedCount: 2 })?.title).toBe('Publish 2 pending changes');
      expect(deriveNextAction({ ...base, flowCount: 0 })?.step).toBe('automations');
      expect(deriveNextAction({ ...base, memberCount: 1 })?.step).toBe('access');
    });

    it('unfinished data outranks publishing; a healthy app gets no nag', () => {
      expect(deriveNextAction({ ...base, formCount: 0, published: false })?.step).toBe('data');
      expect(deriveNextAction(base)).toBeNull();
    });
  });

  it('versionLabel shows v-numbers only after the first publish', () => {
    expect(versionLabel({ publishedVersion: 0 })).toBeNull();
    expect(versionLabel({})).toBeNull();
    expect(versionLabel({ publishedVersion: 3 })).toBe('v3');
  });
});
