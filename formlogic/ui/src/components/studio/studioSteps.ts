import type { App } from '../../types/app';

/**
 * App Studio: one workspace per app, divided into six sections — Plan, Data,
 * Screens, Automations, Access, Publish. They are sections, not wizard steps:
 * every one is always available, everything saves as you go, and an app is
 * never "part-way through" them. Pure derivations live here so the section
 * nav, the guidance line and the publish preflight are unit-testable.
 */
export type StudioStepId = 'plan' | 'data' | 'screens' | 'automations' | 'access' | 'publish';

export interface StudioStep {
  id: StudioStepId;
  label: string;
  shortLabel: string;
  description: string;
}

export const STUDIO_STEPS: StudioStep[] = [
  { id: 'plan', label: 'Plan', shortLabel: 'Plan', description: 'Sketch the app as a diagram, or plan it with AI' },
  { id: 'data', label: 'Data & forms', shortLabel: 'Data', description: 'The forms behind the app: fields and relationships' },
  { id: 'screens', label: 'Screens', shortLabel: 'Screens', description: 'Home, navigation and the views members get' },
  { id: 'automations', label: 'Automations', shortLabel: 'Automations', description: 'What happens when records arrive' },
  { id: 'access', label: 'Users & roles', shortLabel: 'Access', description: 'Who can open the app and what they can do' },
  { id: 'publish', label: 'Review & publish', shortLabel: 'Publish', description: 'Check the app over and release a version' },
];

export function isStudioStep(value: string | undefined | null): value is StudioStepId {
  return !!value && STUDIO_STEPS.some((step) => step.id === value);
}

/** What the app actually contains — the source for every section badge. */
export interface StudioSnapshot {
  formCount: number;
  hasBlueprint: boolean;
  hasHomeScreen: boolean;
  flowCount: number;
  activeFlowCount: number;
  roleCount: number;
  published: boolean;
  publishedVersion: number;
  unpublishedCount: number;
}

/** A short fact rendered beside a section name in the nav. */
export interface SectionBadge {
  /** Rendered text — a count or a version, never a judgement. */
  text: string;
  /** 'attention' = something is waiting on the owner (unpublished work, nothing built yet). */
  tone: 'muted' | 'attention';
  /** Spoken/hover expansion, since the badge itself is a bare number. */
  title: string;
}

/**
 * Section badges state what a section CONTAINS rather than whether it is "done".
 * The old completion ticks marked Screens and Access complete for every app that
 * had a form (screens are generated, roles ship with the app), so the ticks said
 * nothing — a count is a fact the owner can act on.
 */
export function deriveSectionBadges(s: StudioSnapshot): Record<StudioStepId, SectionBadge | null> {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return {
    plan: s.hasBlueprint ? { text: 'Linked', tone: 'muted', title: 'A diagram is linked to this app' } : null,
    data: {
      text: String(s.formCount),
      tone: s.formCount === 0 ? 'attention' : 'muted',
      title: s.formCount === 0 ? 'No data types yet' : plural(s.formCount, 'data type'),
    },
    // Every form contributes its generated screens; the home screen is always there.
    screens: {
      text: String(s.formCount + 1),
      tone: 'muted',
      title: `${plural(s.formCount + 1, 'screen')} including the app home`,
    },
    automations: s.flowCount > 0
      ? { text: String(s.flowCount), tone: 'muted', title: `${plural(s.flowCount, 'automation')} · ${s.activeFlowCount} active` }
      : null,
    access: s.roleCount > 0 ? { text: String(s.roleCount), tone: 'muted', title: plural(s.roleCount, 'role') } : null,
    publish: s.unpublishedCount > 0
      ? { text: String(s.unpublishedCount), tone: 'attention', title: `${plural(s.unpublishedCount, 'change')} not published yet` }
      : s.published
        ? { text: s.publishedVersion > 0 ? `v${s.publishedVersion}` : 'Live', tone: 'muted', title: 'The live app is up to date' }
        : { text: 'Draft', tone: 'attention', title: 'This app has never been published' },
  };
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
  /** settings.allowSelfRegistration without a defaultRoleId = joiners on the automatic role. */
  signupWithoutDefaultRole?: boolean;
  hasIcon?: boolean;
  /** False when the member fetch failed — the count is unknown, not zero. */
  memberCountKnown?: boolean;
  /** False when the attachment list failed to load — the app's forms are unknown, not zero. */
  formCountKnown?: boolean;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  if (input.formCountKnown === false) {
    // A failed read is not "no data types": blocking publish on it would stop an
    // owner releasing a twelve-form app because one request dropped.
    checks.push({
      id: 'forms',
      state: 'warning',
      severity: 'recommended',
      title: 'Data types not loaded',
      detail: 'The form list could not be read — reload to check it before publishing',
      step: 'data',
    });
  } else {
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
  }

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
      // NOT blocking: with no default role the server assigns the lowest-privilege role, so
      // sign-up works. Blocking publish here contradicted App Settings, which describes the
      // same blank value as "Lowest-privilege role (automatic)".
      severity: 'recommended',
      title: 'Sign-up is open with no default role picked',
      detail: 'New members get the lowest-privilege role automatically — pick one to be explicit',
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
    title: input.memberCountKnown === false
      ? 'Members not loaded'
      : `${input.memberCount} ${input.memberCount === 1 ? 'member' : 'members'}`,
    detail: input.memberCountKnown === false
      ? 'The member list could not be read — reload to check it'
      : input.memberCount <= 1
        ? 'Invite people from Users & roles when you are ready'
        : 'People already have access',
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

export interface PreflightSummary {
  blocking: PreflightCheck[];
  /** Worth doing before release. */
  recommended: PreflightCheck[];
  /** Nice to have — never counted against readiness. */
  optional: PreflightCheck[];
  /** Checks that pass, out of the ones readiness is scored on (blocking + recommended). */
  passed: number;
  scored: number;
  /** True when nothing blocking or recommended is outstanding. */
  ready: boolean;
}

/**
 * Split the checklist into the part that describes readiness and the part that is
 * advice. Scoring optional findings (a custom domain almost nobody connects) meant
 * a healthy app sat permanently on an amber "6/8", which teaches owners to ignore
 * amber — including when it means something.
 */
export function summarizePreflight(checks: PreflightCheck[]): PreflightSummary {
  const warnings = checks.filter((c) => c.state === 'warning');
  const blocking = warnings.filter((c) => c.severity === 'blocking');
  const recommended = warnings.filter((c) => c.severity === 'recommended');
  const optional = warnings.filter((c) => c.severity === 'optional');
  const scored = checks.length - optional.length;
  return {
    blocking,
    recommended,
    optional,
    passed: scored - blocking.length - recommended.length,
    scored,
    ready: blocking.length === 0 && recommended.length === 0,
  };
}

// ── Recommended next action (recommendation #1) ─────────────────────────────

export interface NextAction {
  step: StudioStepId;
  title: string;
  detail: string;
  cta: string;
}

/**
 * ONE recommended next action from real app state — the section nav says where you
 * are, this says what matters next. Returns null when the app is in good shape
 * (published, no pending changes) so the line disappears instead of nagging.
 */
export function deriveNextAction(s: {
  formCount: number;
  fieldlessFormNames: string[];
  flowCount: number;
  memberCount: number;
  published: boolean;
  unpublishedCount: number;
  /** False when the member fetch failed — never suggest inviting on an unknown count. */
  memberCountKnown?: boolean;
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
  if (s.memberCount <= 1 && s.memberCountKnown !== false) {
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
