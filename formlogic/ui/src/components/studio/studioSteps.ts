import type { App } from '../../types/app';

/**
 * App Studio (app-first redesign): the six-step guided builder — Plan, Data,
 * Screens, Automations, Access, Publish. Pure derivations live here so the
 * step rail, footer and publish preflight can be unit-tested without the DOM.
 */
export type StudioStepId = 'plan' | 'data' | 'screens' | 'automations' | 'access' | 'publish';

export interface StudioStep {
  id: StudioStepId;
  label: string;
  shortLabel: string;
  description: string;
  optional?: boolean;
}

export const STUDIO_STEPS: StudioStep[] = [
  { id: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Describe or diagram the app', optional: true },
  { id: 'data', label: 'Data & forms', shortLabel: 'Data', description: 'Fields, forms and relationships' },
  { id: 'screens', label: 'Screens', shortLabel: 'Screens', description: 'Home, navigation and record views' },
  { id: 'automations', label: 'Automations', shortLabel: 'Flows', description: 'Triggers, actions and advanced flows' },
  { id: 'access', label: 'Users & roles', shortLabel: 'Access', description: 'People, roles and permissions' },
  { id: 'publish', label: 'Review & publish', shortLabel: 'Publish', description: 'Test, publish and manage versions' },
];

export function isStudioStep(value: string | undefined | null): value is StudioStepId {
  return !!value && STUDIO_STEPS.some((step) => step.id === value);
}

/** The facts each step's "complete" state derives from — all real app state, no wizard bookkeeping. */
export interface StudioSnapshot {
  formCount: number;
  hasBlueprint: boolean;
  hasHomeScreen: boolean;
  flowCount: number;
  roleCount: number;
  published: boolean;
}

/**
 * Steps are "complete" when the app genuinely has that aspect configured —
 * the studio is prefilled and skippable, so completion is DERIVED from real
 * state rather than tracked as wizard progress.
 */
export function deriveCompletedSteps(s: StudioSnapshot): StudioStepId[] {
  const done: StudioStepId[] = [];
  if (s.hasBlueprint || s.formCount > 0) done.push('plan');
  if (s.formCount > 0) done.push('data');
  // Generated screens exist as soon as there are forms; a custom home also counts.
  if (s.formCount > 0 || s.hasHomeScreen) done.push('screens');
  if (s.flowCount > 0) done.push('automations');
  if (s.roleCount > 0) done.push('access');
  if (s.published) done.push('publish');
  return done;
}

/**
 * Parse an API timestamp. Zone-less "YYYY-MM-DD HH:MM:SS" values are UTC
 * (server convention) — append Z before parsing so local-zone drift can't
 * miscount unpublished changes. Returns NaN for absent/invalid values.
 */
export function parseApiDate(value: string | null | undefined): number {
  if (!value) return NaN;
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value);
  return Date.parse(zoneless ? value.replace(' ', 'T') + 'Z' : value);
}

export interface ChangedResource {
  kind: 'app' | 'form' | 'flow';
  id: string;
  label: string;
  updatedAt: string;
}

export interface UnpublishedChanges {
  /** False when the app has never been published (everything is "the draft"). */
  everPublished: boolean;
  count: number;
  changed: ChangedResource[];
}

/**
 * "N unpublished changes" = resources touched strictly AFTER the last publish.
 * Publishing stamps apps.updated_at = published_at, so the app row itself only
 * counts when edited again afterwards.
 */
export function computeUnpublishedChanges(
  app: Pick<App, 'updatedAt' | 'publishedAt' | 'name'>,
  forms: Array<{ id: string; title: string; updatedAt: string }>,
  flows: Array<{ id: string; name: string; updatedAt: string }>
): UnpublishedChanges {
  const publishedAt = parseApiDate(app.publishedAt ?? null);
  if (Number.isNaN(publishedAt)) {
    return { everPublished: false, count: 0, changed: [] };
  }

  const changed: ChangedResource[] = [];
  if (parseApiDate(app.updatedAt) > publishedAt) {
    changed.push({ kind: 'app', id: 'app', label: 'App settings & screens', updatedAt: app.updatedAt });
  }
  for (const form of forms) {
    if (parseApiDate(form.updatedAt) > publishedAt) {
      changed.push({ kind: 'form', id: form.id, label: form.title, updatedAt: form.updatedAt });
    }
  }
  for (const flow of flows) {
    if (parseApiDate(flow.updatedAt) > publishedAt) {
      changed.push({ kind: 'flow', id: flow.id, label: flow.name, updatedAt: flow.updatedAt });
    }
  }
  return { everPublished: true, count: changed.length, changed };
}

export type PreflightState = 'complete' | 'warning';

export interface PreflightCheck {
  id: string;
  state: PreflightState;
  title: string;
  detail: string;
  /** Studio step that fixes a warning (drives the "Set up" link). */
  step?: StudioStepId;
}

/** The publish-step readiness checklist, derived entirely from real app state. */
export function buildPreflightChecks(input: {
  formCount: number;
  formsWithoutFields: string[];
  flowCount: number;
  activeFlowCount: number;
  roleCount: number;
  hasHomeScreen: boolean;
  hasCustomDomain: boolean;
  memberCount: number;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  checks.push(
    input.formCount > 0
      ? {
          id: 'forms',
          state: input.formsWithoutFields.length === 0 ? 'complete' : 'warning',
          title: `${input.formCount} data ${input.formCount === 1 ? 'type' : 'types'} configured`,
          detail:
            input.formsWithoutFields.length === 0
              ? 'Every form has at least one field'
              : `No fields yet: ${input.formsWithoutFields.join(', ')}`,
          step: 'data',
        }
      : { id: 'forms', state: 'warning', title: 'No data types yet', detail: 'Add at least one form so the app has something to collect', step: 'data' }
  );

  checks.push({
    id: 'screens',
    state: input.formCount > 0 || input.hasHomeScreen ? 'complete' : 'warning',
    title: input.hasHomeScreen ? 'Custom home screen configured' : 'Generated screens ready',
    detail:
      input.formCount > 0 || input.hasHomeScreen
        ? 'Home, record lists and detail views render for every form'
        : 'Screens appear once the app has forms',
    step: 'screens',
  });

  checks.push({
    id: 'automations',
    state: 'complete',
    title: `${input.flowCount} ${input.flowCount === 1 ? 'automation' : 'automations'}`,
    detail:
      input.flowCount === 0
        ? 'None yet — the app works without them'
        : `${input.activeFlowCount} active · ${input.flowCount - input.activeFlowCount} paused`,
    step: 'automations',
  });

  checks.push({
    id: 'roles',
    state: input.roleCount > 0 ? 'complete' : 'warning',
    title: `${input.roleCount} ${input.roleCount === 1 ? 'role' : 'roles'} configured`,
    detail: input.roleCount > 0 ? 'Access is controlled per role and per form' : 'Roles are created with the app — reload to retry',
    step: 'access',
  });

  checks.push({
    id: 'members',
    state: 'complete',
    title: `${input.memberCount} ${input.memberCount === 1 ? 'member' : 'members'}`,
    detail: input.memberCount <= 1 ? 'Invite people from Users & roles when you are ready' : 'People already have access',
    step: 'access',
  });

  checks.push({
    id: 'domain',
    state: input.hasCustomDomain ? 'complete' : 'warning',
    title: input.hasCustomDomain ? 'Custom domain connected' : 'Custom domain',
    detail: input.hasCustomDomain ? 'Your app answers on its own domain' : 'Using the FormLogic URL for now',
  });

  return checks;
}

/** "v3"-style display for the app's live version; drafts that never published show DRAFT. */
export function versionLabel(app: Pick<App, 'publishedVersion'>): string | null {
  const v = app.publishedVersion ?? 0;
  return v > 0 ? `v${v}` : null;
}
