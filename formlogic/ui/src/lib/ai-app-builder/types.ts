// AI App Builder — shared types for the plan, the generated forms, and the build pipeline.

export interface PlannedForm {
  key: string;
  title: string;
  purpose: string;
  /** Optional: a description of a custom interactive screen to generate for this form. */
  screen?: string;
}

export interface ScreenContent { enabled: boolean; html: string; css: string; js: string }

export interface PlannedRelation {
  from: string;
  to: string;
  label: string;
}

export interface PlannedRole {
  name: string;
  level: 'admin' | 'contributor' | 'viewer';
}

/** The structured plan returned by POST /api/ai/generate-app-plan. */
export interface AppPlan {
  app: { name: string; description: string };
  forms: PlannedForm[];
  relations: PlannedRelation[];
  roles: PlannedRole[];
}

/** A single AI-generated field (from /api/ai/generate-form). */
export interface GeneratedField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  properties?: Record<string, unknown>;
}

/** Per-form generation output keyed by the plan form's key. */
export interface GeneratedForm {
  fields: GeneratedField[];
  logicScript?: string;
  customScreen?: ScreenContent;
}

/** Progress events emitted during a build, for the UI. */
export interface BuildProgress {
  stage: 'generating' | 'assembling' | 'importing' | 'publishing' | 'done';
  message: string;
  current?: number;
  total?: number;
}

export interface BuildResult {
  appId: string;
  appName: string;
  forms: Array<{ id: string; title: string }>;
}

// ── Pack shapes the assembler emits (compatible with the importer) ──
export interface PackField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  properties: Record<string, unknown>;
}
export interface PackForm {
  packFormId: string;
  title: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  logicScript?: string;
  customScreen?: ScreenContent;
  fields: PackField[];
}
export interface PackApp {
  packAppId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  forms: Array<{ packFormId: string; displayName: string; sortOrder: number; isVisible: boolean }>;
  roles: Array<{ name: string; description: string; permissions: Array<{ packFormId: string; permission: string }> }>;
}
export interface GeneratedPack {
  formatVersion: 1;
  packMeta: { id: string; name: string; description: string; version: string; author: string; tags: string[] };
  forms: PackForm[];
  apps: PackApp[];
}
