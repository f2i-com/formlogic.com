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

/** How much a non-complete finding matters (recommendation #4: quality assistant,
 *  not pass/fail): blocking prevents publish, the rest is advice. */
export type PreflightSeverity = 'blocking' | 'recommended' | 'optional';

export interface PreflightCheck {
  id: string;
  state: PreflightState;
  /** Present on 'warning' checks only. */
  severity?: PreflightSeverity;
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
  /** settings.landingPage when it targets a form: does that form still exist? */
  landingPageMissing?: boolean;
  /** settings.allowSelfRegistration without a defaultRoleId = joiners with no role. */
  signupWithoutDefaultRole?: boolean;
  hasIcon?: boolean;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  checks.push(
    input.formCount > 0
      ? {
          id: 'forms',
          state: input.formsWithoutFields.length === 0 ? 'complete' : 'warning',
          ...(input.formsWithoutFields.length === 0 ? {} : { severity: 'recommended' as const }),
          title: `${input.formCount} data ${input.formCount === 1 ? 'type' : 'types'} configured`,
          detail:
            input.formsWithoutFields.length === 0
              ? 'Every form has at least one field'
              : `No fields yet: ${input.formsWithoutFields.join(', ')}`,
          step: 'data',
        }
      : {
          id: 'forms',
          state: 'warning',
          severity: 'blocking',
          title: 'No data types yet',
          detail: 'Add at least one form so the published app has something to collect',
          step: 'data',
        }
  );

  if (input.landingPageMissing) {
    checks.push({
      id: 'landing',
      state: 'warning',
      severity: 'blocking',
      title: 'Landing screen references a removed form',
      detail: 'Members would land on a screen that no longer exists — pick a new landing screen',
      step: 'screens',
    });
  }

  if (input.signupWithoutDefaultRole) {
    checks.push({
      id: 'signup-role',
      state: 'warning',
      severity: 'blocking',
      title: 'Sign-up is open but has no default role',
      detail: 'People who join would have no permissions — pick a default role in Users & roles',
      step: 'access',
    });
  }

  checks.push({
    id: 'screens',
    state: input.formCount > 0 || input.hasHomeScreen ? 'complete' : 'warning',
    ...(input.formCount > 0 || input.hasHomeScreen ? {} : { severity: 'recommended' as const }),
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
    ...(input.roleCount > 0 ? {} : { severity: 'recommended' as const }),
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

  if (input.hasIcon === false) {
    checks.push({
      id: 'icon',
      state: 'warning',
      severity: 'optional',
      title: 'Add an app icon',
      detail: 'A logo makes the app recognisable in the sidebar and on installed home screens',
    });
  }

  checks.push({
    id: 'domain',
    state: input.hasCustomDomain ? 'complete' : 'warning',
    ...(input.hasCustomDomain ? {} : { severity: 'optional' as const }),
    title: input.hasCustomDomain ? 'Custom domain connected' : 'Custom domain',
    detail: input.hasCustomDomain ? 'Your app answers on its own domain' : 'Using the FormLogic URL for now',
  });

  return checks;
}

// ── Recommended next action (recommendation #1) ─────────────────────────────

export interface NextAction {
  step: StudioStepId;
  title: string;
  detail: string;
  cta: string;
}

/**
 * ONE recommended next action from real app state — the rail says where you
 * are, this says what matters next. Returns null when the app is in good shape
 * (published, no pending changes) so the card disappears instead of nagging.
 */
export function deriveNextAction(s: {
  formCount: number;
  fieldlessFormNames: string[];
  flowCount: number;
  memberCount: number;
  published: boolean;
  unpublishedCount: number;
}): NextAction | null {
  if (s.formCount === 0) {
    return {
      step: 'data',
      title: 'Add your first data type',
      detail: 'Every app is built on forms — create one so the app has something to collect.',
      cta: 'Go to Data & forms',
    };
  }
  if (s.fieldlessFormNames.length > 0) {
    return {
      step: 'data',
      title: `Finish ${s.fieldlessFormNames[0]}`,
      detail: `${s.fieldlessFormNames.length === 1 ? 'It has' : `${s.fieldlessFormNames.length} data types have`} no fields yet — add the fields people will fill in.`,
      cta: 'Add fields',
    };
  }
  if (!s.published) {
    return {
      step: 'publish',
      title: 'Publish your app',
      detail: 'Only you can see it right now — run the checks and make it live for members.',
      cta: 'Review & publish',
    };
  }
  if (s.unpublishedCount > 0) {
    return {
      step: 'publish',
      title: `Publish ${s.unpublishedCount} pending ${s.unpublishedCount === 1 ? 'change' : 'changes'}`,
      detail: 'The live app still serves the previous version until you publish again.',
      cta: 'Review changes',
    };
  }
  if (s.flowCount === 0) {
    return {
      step: 'automations',
      title: 'Connect an automation',
      detail: 'React when records arrive — a notification, an approval, or a data update.',
      cta: 'Add automation',
    };
  }
  if (s.memberCount <= 1) {
    return {
      step: 'access',
      title: 'Invite your first member',
      detail: 'Try the app as a member, or bring in the people who will use it.',
      cta: 'Invite people',
    };
  }
  return null;
}

/** "v3"-style display for the app's live version; drafts that never published show DRAFT. */
export function versionLabel(app: Pick<App, 'publishedVersion'>): string | null {
  const v = app.publishedVersion ?? 0;
  return v > 0 ? `v${v}` : null;
}
