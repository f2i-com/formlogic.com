import { describe, expect, it } from 'vitest';
import {
  STUDIO_STEPS,
  buildPreflightChecks,
  computeUnpublishedChanges,
  deriveNextAction,
  deriveSectionBadges,
  isStudioStep,
  parseApiDate,
  summarizePreflight,
  versionLabel,
} from './studioSteps';

describe('studioSteps', () => {
  it('defines the six sections in order, none of them a wizard step', () => {
    expect(STUDIO_STEPS.map((s) => s.id)).toEqual(['plan', 'data', 'screens', 'automations', 'access', 'publish']);
    expect(STUDIO_STEPS.every((s) => s.label && s.shortLabel && s.description)).toBe(true);
    // No "optional" marking: the studio is a workspace, so every section is
    // always available and nothing is a step you can be part-way through.
    expect(STUDIO_STEPS.some((s) => 'optional' in s)).toBe(false);
  });

  it('isStudioStep accepts only real step ids', () => {
    expect(isStudioStep('data')).toBe(true);
    expect(isStudioStep('publish')).toBe(true);
    expect(isStudioStep('settings')).toBe(false);
    expect(isStudioStep(undefined)).toBe(false);
    expect(isStudioStep(null)).toBe(false);
  });

  describe('deriveSectionBadges', () => {
    const empty = {
      formCount: 0,
      flowCount: 0,
      activeFlowCount: 0,
      roleCount: 0,
      published: false,
      publishedVersion: 0,
      unpublishedCount: 0,
    };

    it('states what a section holds, and flags an app with nothing built yet', () => {
      const badges = deriveSectionBadges(empty);
      expect(badges.data).toMatchObject({ text: '0', tone: 'attention' });
      // Screens always include the app home, so an empty app still has one.
      expect(badges.screens?.text).toBe('1');
      // Overview describes the app; it never carries a count of its own.
      expect(badges.plan).toBeNull();
      expect(badges.automations).toBeNull();
      expect(badges.access).toBeNull();
    });

    it('counts real content once the app has some', () => {
      const badges = deriveSectionBadges({ ...empty, formCount: 3, flowCount: 2, activeFlowCount: 1, roleCount: 4 });
      expect(badges.data).toMatchObject({ text: '3', tone: 'muted' });
      expect(badges.screens?.text).toBe('4');
      expect(badges.automations).toMatchObject({ text: '2' });
      expect(badges.automations?.title).toContain('1 active');
      expect(badges.access?.text).toBe('4');
      expect(badges.plan).toBeNull();
    });

    it('publish reports the live version, pending changes, or an unpublished draft', () => {
      expect(deriveSectionBadges(empty).publish).toMatchObject({ text: 'Draft', tone: 'attention' });
      expect(deriveSectionBadges({ ...empty, published: true, publishedVersion: 4 }).publish)
        .toMatchObject({ text: 'v4', tone: 'muted' });
      expect(deriveSectionBadges({ ...empty, published: true, publishedVersion: 4, unpublishedCount: 2 }).publish)
        .toMatchObject({ text: '2', tone: 'attention' });
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
      // NOT blocking: with no default role the server assigns the lowest-privilege
      // one, which is exactly what App Settings promises for the same blank value.
      expect(checks.find((c) => c.id === 'signup-role')?.severity).toBe('recommended');
      expect(checks.find((c) => c.id === 'signup-role')?.detail).toContain('lowest-privilege role');
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

    it('never blocks publish on a form list that failed to load', () => {
      // Reading a dropped request as "no data types" disabled Publish on an app that
      // has plenty, with no way forward but a page reload.
      const checks = buildPreflightChecks({ ...base, formCount: 0, formCountKnown: false });
      const forms = checks.find((c) => c.id === 'forms')!;
      expect(forms.severity).toBe('recommended');
      expect(forms.title).toBe('Data types not loaded');
      expect(summarizePreflight(checks).blocking).toEqual([]);
    });

    it('reports an unknown member count instead of asserting zero', () => {
      const checks = buildPreflightChecks({ ...base, memberCount: 0, memberCountKnown: false });
      const members = checks.find((c) => c.id === 'members')!;
      expect(members.title).toBe('Members not loaded');
      expect(members.title).not.toContain('0 members');
    });
  });

  describe('summarizePreflight', () => {
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

    it('scores readiness on blocking + recommended only, so a healthy app can reach green', () => {
      // No custom domain and no icon: both optional, so readiness is still met.
      const summary = summarizePreflight(buildPreflightChecks({ ...base, hasIcon: false }));
      expect(summary.ready).toBe(true);
      expect(summary.passed).toBe(summary.scored);
      expect(summary.optional.map((c) => c.id).sort()).toEqual(['domain', 'icon']);
    });

    it('a blocking finding fails readiness and is listed separately', () => {
      const summary = summarizePreflight(buildPreflightChecks({ ...base, formCount: 0, hasHomeScreen: false }));
      expect(summary.ready).toBe(false);
      expect(summary.blocking.map((c) => c.id)).toEqual(['forms']);
      expect(summary.passed).toBeLessThan(summary.scored);
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

    it('never suggests inviting when the member count could not be read', () => {
      // A failed members fetch used to read as "0 members", so a twenty-person app
      // was told to invite its first member.
      expect(deriveNextAction({ ...base, memberCount: 0, memberCountKnown: false })).toBeNull();
      expect(deriveNextAction({ ...base, memberCount: 0, memberCountKnown: true })?.step).toBe('access');
    });
  });

  it('versionLabel shows v-numbers only after the first publish', () => {
    expect(versionLabel({ publishedVersion: 0 })).toBeNull();
    expect(versionLabel({})).toBeNull();
    expect(versionLabel({ publishedVersion: 3 })).toBe('v3');
  });
});
