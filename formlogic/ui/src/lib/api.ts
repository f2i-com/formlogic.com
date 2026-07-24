/**
 * API Client for FormLogic Backend
 */

import type { Form } from '../types/form';
import type { App, AppForm, AppFormUsageApp, AppListItem, AppSettings, AppVersion, FormAppContext } from '../types/app';
import { APP_LEVEL_PERMISSIONS, FORM_LEVEL_PERMISSIONS } from '../types/app';
import type {
  ClaimResult,
  ConnectorCommand,
  ConnectorCommandStatus,
  FlowBinding,
  FlowDefinition,
  FlowKvEntry,
  FlowRunError,
  FlowRunLog,
  FlowRunStatus,
  FlowRuntimeKind,
  PackFlowBinding,
  PackFlowDefinition,
  RuntimeFlows,
  WorkflowGraph,
} from '../types/flows';
import { logger } from './logger';
import {
  addDemoRecord, getDemoRecords, getDemoRecord, updateDemoRecord, deleteDemoRecord, isDemoLocalId, clearDemoRecords,
  listDemoBlueprints, getDemoBlueprint, createDemoBlueprint, renameDemoBlueprint, deleteDemoBlueprint, commitDemoBlueprintOperations,
  demoApplyFlowOverlay, demoCreateFlow, demoUpdateFlow, demoDeleteFlow,
} from './demoLocal';
import {
  addDemoAppForm,
  clearDemoApps,
  createDemoApp,
  createDemoAppBinding,
  createDemoAppRole,
  deleteDemoApp,
  deleteDemoAppBinding,
  deleteDemoAppRole,
  getDemoApp,
  getDemoAppBySlug,
  getDemoAppRolePermissions,
  listDemoAppBindings,
  listDemoAppRoles,
  listDemoApps,
  listDemoAppsFormUsage,
  listDemoAppVersions,
  listDemoBindingsForFlow,
  listDemoFormAppContexts,
  publishDemoApp,
  removeDemoAppForm,
  reorderDemoAppForms,
  setDemoAppRolePermissions,
  updateDemoApp,
  updateDemoAppBinding,
  updateDemoAppForm,
  updateDemoAppRole,
} from './demoLocalApps';
import { API_BASE_URL } from './apiBase';
import type { ResponseEnvelope } from './crypto/envelope';
import type {
  EnableEncryptionPayload,
  FormEncryptionStateWire,
  PublishSchemaPayload,
  VaultWire,
} from '../types/e2ee';

interface ApiResponse<T> {
  data?: T;
  error?: string;
  /** HTTP status of an error response (FL-SYNC-001): lets callers tell a definitive
   *  404 apart from a transport/server failure. Undefined on network errors and on
   *  success — never branch on it without also checking `error`. */
  status?: number;
}

/** Result of running an onSubmit script via the test endpoint (mirrors ScriptResult). */
export interface DeepHealthCheck {
  ok: boolean;
  critical: boolean;
  detail: string;
  warning?: string;
}

export interface DeepHealth {
  status: string; // 'ok' | 'degraded'
  checks: Record<string, DeepHealthCheck>;
  info?: Record<string, unknown>;
  timestamp: string;
}

export interface ScriptTestResult {
  success: boolean;
  error: string | null;
  rejected: boolean;
  rejectionMessage: string | null;
  status: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  computed: unknown;
  instructionCount: number;
  executionTimeMs: number;
}

export interface PlanUsage {
  enforced: boolean;
  plan: string;
  forms: { used: number; limit: number | null };
  storage: { usedBytes: number; limitBytes: number | null };
}

export interface BillingStatus {
  cloudUntil: string | null;
  active: boolean;
  pricePerMonthCents: number;
  currency: string;
  maxMonths: number;
  /** Public beta: Cloud is free and payments are turned off. */
  betaMode?: boolean;
  paypalEnabled: boolean;
  paypalClientId: string | null;
  usage: PlanUsage | null;
}

/** Public, credential-free view of the app-specific Aokie Companion discovery document. */
export interface AokieCompanionDiscovery {
  schemaVersion: number;
  issuer: string | null;
  deploymentId: string | null;
  appId: string | null;
  appSlug: string | null;
  available: boolean;
  gatewayUrl: string | null;
  features: string[];
  scopesSupported: string[];
  trustStatus: 'signed' | 'unverified' | 'unknown';
  signatureVerified: boolean;
  signatureAlgorithm: string | null;
  signingKeyId: string | null;
  iceServerCount: number;
  hasTurnRelay: boolean;
  relayOnly: boolean;
  /** Earliest short-lived TURN expiry, as a Unix timestamp. Credentials and URLs are never exposed. */
  turnCredentialExpiresAt: number | null;
  remoteConsent: AokieCompanionRemoteConsent;
  media: {
    transport: string | null;
    gatewayRelaysMedia: boolean;
    companionUsesBluetoothDongle: boolean;
    relayOnly: boolean;
  };
}

/** Explicit application-level remote access policy. Missing/malformed policy fails closed. */
export interface AokieCompanionRemoteConsent {
  configured: boolean;
  remoteMonitoring: boolean;
  remoteConsult: boolean;
  remoteTakeover: boolean;
  remoteCaptions: boolean;
  remoteAssistance: boolean;
}

export type AokieCompanionRemoteConsentInput = Omit<AokieCompanionRemoteConsent, 'configured'>;

/** One owner-managed Desktop/plugin or Companion enrollment. */
export interface AokieCompanionDevice {
  id: string;
  userId: string;
  appId: string;
  subjectId: string;
  role: 'mobile' | 'plugin' | string;
  displayName: string;
  grants: string[];
  approvedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface AokieCompanionActivity {
  id: string;
  eventId: string;
  appId: string;
  sessionRecordId: string | null;
  callId: string | null;
  deviceId: string | null;
  actorUserId: string | null;
  subjectId: string;
  eventType: string;
  mode: string | null;
  reason: string | null;
  ownerEpoch: number | null;
  occurredAt: string;
}

export interface AokieCompanionSession {
  id: string;
  sessionId: string;
  callId: string;
  deviceId: string | null;
  subjectId: string;
  mode: string;
  state: string;
  joinedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  lastEventId: string;
  lastEventAt: string;
}

export type AokieCompanionRoutingPolicy = 'all' | 'priority' | 'round_robin';
export type AokieCompanionAvailability = 'available' | 'busy' | 'offline' | 'do_not_disturb';

export interface AokieCompanionRoutingMember {
  deviceId: string;
  userId: string;
  subjectId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  availability: AokieCompanionAvailability;
  availabilityUpdatedAt: string;
}

export interface AokieCompanionRoutingGroup {
  id: string;
  appId: string;
  name: string;
  policy: AokieCompanionRoutingPolicy;
  enabled: boolean;
  members: AokieCompanionRoutingMember[];
  createdAt: string;
  updatedAt: string;
}

export interface AokieCompanionRoutingGroupInput {
  appId: string;
  name: string;
  policy: AokieCompanionRoutingPolicy;
  enabled: boolean;
  members: Array<{ deviceId: string; priority: number; enabled: boolean }>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function companionRemoteConsent(value: unknown): AokieCompanionRemoteConsent {
  const row = recordValue(value);
  return {
    configured: row?.configured === true,
    remoteMonitoring: row?.remoteMonitoring === true,
    remoteConsult: row?.remoteConsult === true,
    remoteTakeover: row?.remoteTakeover === true,
    remoteCaptions: row?.remoteCaptions === true,
    remoteAssistance: row?.remoteAssistance === true,
  };
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function decodeBase64(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return ownedArrayBuffer(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** Strip credentials, query strings and fragments before a gateway URL reaches rendered UI. */
function displayEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !['ws:', 'wss:'].includes(parsed.protocol)) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Verify the normative signed envelope against the advertised same-issuer Ed25519 key.
 * Discovery stays useful for diagnostics when WebCrypto/key retrieval is unavailable, but
 * callers get signatureVerified=false and must not present the deployment as trusted.
 */
async function verifyAokieCompanionDiscovery(raw: Record<string, unknown>): Promise<boolean> {
  const envelope = recordValue(raw.signatureEnvelope);
  const payload = recordValue(envelope?.payload);
  const keyUrl = typeof raw.signingKeyUrl === 'string' ? raw.signingKeyUrl : '';
  const issuer = typeof raw.issuer === 'string' ? raw.issuer : '';
  const signature = typeof envelope?.signature === 'string' ? envelope.signature : '';
  const algorithm = typeof envelope?.alg === 'string' ? envelope.alg : '';
  const keyId = typeof envelope?.keyId === 'string' ? envelope.keyId : '';
  if (!envelope || !payload || raw.trustStatus !== 'signed' || algorithm !== 'Ed25519' || !signature || !keyId) {
    return false;
  }
  if (raw.signature !== signature || raw.signatureAlgorithm !== algorithm || raw.signingKeyId !== keyId) {
    return false;
  }
  // The additive top-level document must agree exactly with every signed payload member.
  for (const [name, value] of Object.entries(payload)) {
    if (JSON.stringify(raw[name]) !== JSON.stringify(value)) return false;
  }
  try {
    const key = new URL(keyUrl);
    const issuerUrl = new URL(issuer);
    if (key.origin !== issuerUrl.origin || key.pathname !== '/api/public/signing-key') return false;
    if (!globalThis.crypto?.subtle) return false;
    const response = await fetch(key.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const keyDocument = recordValue(await response.json());
    if (!keyDocument
      || keyDocument.alg !== 'Ed25519'
      || keyDocument.keyId !== keyId
      || typeof keyDocument.publicKey !== 'string') {
      return false;
    }
    const publicKey = await globalThis.crypto.subtle.importKey(
      'raw',
      decodeBase64(keyDocument.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      decodeBase64(signature),
      ownedArrayBuffer(new TextEncoder().encode(JSON.stringify(payload))),
    );
  } catch {
    return false;
  }
}

function companionDiscoveryView(raw: Record<string, unknown>, signatureVerified: boolean): AokieCompanionDiscovery {
  const envelope = recordValue(raw.signatureEnvelope);
  // Prefer the signed payload even when local verification is unavailable; the trust flag remains
  // false, so the UI can show diagnostics without silently treating unsigned top-level edits as ready.
  const payload = recordValue(envelope?.payload) ?? raw;
  const media = recordValue(payload.media);
  const iceServers = Array.isArray(payload.iceServers) ? payload.iceServers : [];
  const hasTurnRelay = iceServers.some((candidate) => {
    const server = recordValue(candidate);
    const urls = stringList(server?.urls);
    return urls.some((url) => /^turns?:/i.test(url));
  });
  const rawTrust = typeof raw.trustStatus === 'string' ? raw.trustStatus : '';
  return {
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : 0,
    issuer: typeof payload.issuer === 'string' ? payload.issuer : null,
    deploymentId: typeof payload.deploymentId === 'string' ? payload.deploymentId : null,
    appId: typeof payload.appId === 'string' ? payload.appId : null,
    appSlug: typeof payload.appSlug === 'string' ? payload.appSlug : null,
    available: payload.available === true,
    gatewayUrl: displayEndpoint(payload.gatewayUrl),
    features: stringList(payload.features),
    scopesSupported: stringList(payload.scopesSupported),
    trustStatus: rawTrust === 'signed' || rawTrust === 'unverified' ? rawTrust : 'unknown',
    signatureVerified,
    signatureAlgorithm: typeof raw.signatureAlgorithm === 'string' ? raw.signatureAlgorithm : null,
    signingKeyId: typeof raw.signingKeyId === 'string' ? raw.signingKeyId : null,
    iceServerCount: iceServers.length,
    hasTurnRelay,
    relayOnly: payload.relayOnly === true,
    turnCredentialExpiresAt: typeof payload.turnCredentialExpiresAt === 'number'
      && Number.isSafeInteger(payload.turnCredentialExpiresAt)
      ? payload.turnCredentialExpiresAt
      : null,
    remoteConsent: companionRemoteConsent(payload.remoteConsent),
    media: {
      transport: typeof media?.transport === 'string' ? media.transport : null,
      gatewayRelaysMedia: media?.gatewayRelaysMedia === true,
      companionUsesBluetoothDongle: media?.companionUsesBluetoothDongle === true,
      relayOnly: media?.relayOnly === true,
    },
  };
}

function companionDevice(value: unknown): AokieCompanionDevice | null {
  const row = recordValue(value);
  if (!row
    || typeof row.id !== 'string'
    || typeof row.userId !== 'string'
    || typeof row.appId !== 'string'
    || typeof row.subjectId !== 'string'
    || typeof row.role !== 'string'
    || typeof row.displayName !== 'string'
    || typeof row.approvedAt !== 'string'
    || typeof row.lastSeenAt !== 'string') {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    appId: row.appId,
    subjectId: row.subjectId,
    role: row.role,
    displayName: row.displayName,
    grants: stringList(row.grants),
    approvedAt: row.approvedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: typeof row.revokedAt === 'string' ? row.revokedAt : null,
  };
}

function companionActivity(value: unknown): AokieCompanionActivity | null {
  const row = recordValue(value);
  if (!row
    || typeof row.id !== 'string'
    || typeof row.eventId !== 'string'
    || typeof row.appId !== 'string'
    || typeof row.subjectId !== 'string'
    || typeof row.eventType !== 'string'
    || typeof row.occurredAt !== 'string') return null;
  return {
    id: row.id,
    eventId: row.eventId,
    appId: row.appId,
    sessionRecordId: typeof row.sessionRecordId === 'string' ? row.sessionRecordId : null,
    callId: typeof row.callId === 'string' ? row.callId : null,
    deviceId: typeof row.deviceId === 'string' ? row.deviceId : null,
    actorUserId: typeof row.actorUserId === 'string' ? row.actorUserId : null,
    subjectId: row.subjectId,
    eventType: row.eventType,
    mode: typeof row.mode === 'string' ? row.mode : null,
    reason: typeof row.reason === 'string' ? row.reason : null,
    ownerEpoch: typeof row.ownerEpoch === 'number' && Number.isSafeInteger(row.ownerEpoch) ? row.ownerEpoch : null,
    occurredAt: row.occurredAt,
  };
}

function companionSession(value: unknown): AokieCompanionSession | null {
  const row = recordValue(value);
  if (!row
    || typeof row.id !== 'string'
    || typeof row.sessionId !== 'string'
    || typeof row.callId !== 'string'
    || typeof row.subjectId !== 'string'
    || typeof row.mode !== 'string'
    || typeof row.state !== 'string'
    || typeof row.lastEventId !== 'string'
    || typeof row.lastEventAt !== 'string') return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    callId: row.callId,
    deviceId: typeof row.deviceId === 'string' ? row.deviceId : null,
    subjectId: row.subjectId,
    mode: row.mode,
    state: row.state,
    joinedAt: typeof row.joinedAt === 'string' ? row.joinedAt : null,
    endedAt: typeof row.endedAt === 'string' ? row.endedAt : null,
    endReason: typeof row.endReason === 'string' ? row.endReason : null,
    lastEventId: row.lastEventId,
    lastEventAt: row.lastEventAt,
  };
}

function companionRoutingGroup(value: unknown): AokieCompanionRoutingGroup | null {
  const row = recordValue(value);
  const policy = row?.policy;
  if (!row
    || typeof row.id !== 'string'
    || typeof row.appId !== 'string'
    || typeof row.name !== 'string'
    || !['all', 'priority', 'round_robin'].includes(String(policy))
    || typeof row.enabled !== 'boolean'
    || !Array.isArray(row.members)
    || typeof row.createdAt !== 'string'
    || typeof row.updatedAt !== 'string') return null;
  const members = row.members.flatMap((value): AokieCompanionRoutingMember[] => {
    const member = recordValue(value);
    const availability = member?.availability;
    if (!member
      || typeof member.deviceId !== 'string'
      || typeof member.userId !== 'string'
      || typeof member.subjectId !== 'string'
      || typeof member.displayName !== 'string'
      || typeof member.priority !== 'number'
      || !Number.isSafeInteger(member.priority)
      || typeof member.enabled !== 'boolean'
      || !['available', 'busy', 'offline', 'do_not_disturb'].includes(String(availability))
      || typeof member.availabilityUpdatedAt !== 'string') return [];
    return [{
      deviceId: member.deviceId,
      userId: member.userId,
      subjectId: member.subjectId,
      displayName: member.displayName,
      priority: member.priority,
      enabled: member.enabled,
      availability: availability as AokieCompanionAvailability,
      availabilityUpdatedAt: member.availabilityUpdatedAt,
    }];
  });
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    policy: policy as AokieCompanionRoutingPolicy,
    enabled: row.enabled,
    members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A collision-resistant idempotency key for a submission (crypto UUID when available). */
export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* ignore */ }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Rich result of an app-runtime submission that PRESERVES the server's 409 conflict signalling so the
 * offline queue can tell a terminal conflict (key reused with a different payload) apart from a
 * retryable "already being processed" race. Unlike the generic ApiResponse (which flattens the body to
 * a single `error` string), this exposes the {conflict}/{processing} flags from the 409 body.
 */
export interface AppSubmitResult {
  ok: boolean;
  response?: unknown;
  error?: string;
  /** 409: this idempotency key was already used with a DIFFERENT submission — terminal conflict. */
  conflict?: boolean;
  /** 409: an identical submission is already in flight server-side — retryable. */
  processing?: boolean;
  /** 200: an idempotent replay of an already-completed submission. */
  idempotent?: boolean;
  status?: number;
}

export interface AppDomain {
  id: string;
  appId: string;
  domain: string;
  normalizedDomain: string;
  mode: string;
  status: 'pending' | 'verifying' | 'active' | 'failed' | 'disabled' | string;
  verificationMethod: string;
  verificationToken: string;
  dns: { type: string; name: string; value: string };
  verifiedAt: string | null;
  tlsStatus: string;
  landingConfig: Record<string, unknown>;
  nativeConfig?: Record<string, unknown>;
  pwaConfig?: Record<string, unknown>;
  securityConfig?: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** OPTIONAL app archetype stored at app.settings.appKind (absent = untyped, treat as 'custom' in UI).
 *  The server drops invalid values when settings are saved (createApp/updateApp/companion). */
export type AppKind = 'admin' | 'client' | 'staff' | 'public' | 'internal' | 'custom';

/** OPTIONAL createApp preset that tunes ONLY the new app's default system-role permissions
 *  (owner role untouched; invalid values are ignored server-side). */
export type AppRolePreset = 'admin-console' | 'client-portal' | 'staff-field-app' | 'public-intake';

/** RFC 6749-style error from the OAuth consent support endpoints ({ error, error_description }
 *  on the wire) — kept typed (not flattened to one string) so the consent page can follow the
 *  spec, e.g. NEVER redirect back to the client on invalid_request. */
export interface OAuthErrorInfo {
  /** OAuth error code, e.g. 'invalid_request' | 'invalid_client' | 'access_denied'. */
  error: string;
  errorDescription?: string;
}

/** What the /oauth/authorize consent page renders — GET /api/oauth/authorize-info. */
export interface OAuthAuthorizeInfo {
  clientName: string;
  clientUri?: string | null;
  /** Host of the validated redirect_uri — displayed prominently (anti-phishing). */
  redirectHost: string;
  scopes: string[];
  /** Human-readable labels for `scopes`, keyed by scope id. */
  scopeLabels?: Record<string, string>;
  /** True when this consent is for linking a FormLogic Desktop install (client_id=formlogic-desktop). */
  isDesktopLink?: boolean;
  /** Hostname the desktop sent, when `isDesktopLink` is true (may be null). */
  device?: string | null;
}

export interface OAuthAuthorizeResult {
  data?: OAuthAuthorizeInfo;
  oauthError?: OAuthErrorInfo;
  networkError?: string;
}

export interface OAuthApproveResult {
  data?: { redirectTo: string };
  oauthError?: OAuthErrorInfo;
  networkError?: string;
}

/** One row of the app runtime's cross-form activity feed (GET /api/app/{slug}/activity).
 *  Server-side permission filtered: only forms the CALLER can view, newest-first. */
export interface AppActivityItem {
  formId: string;
  formName: string;
  recordId: string;
  title: string;
  submittedAt: string;
}

/** One linked_record relation endpoint (GET /api/apps/{id}/forms/relations). In `outgoingLinks`
 *  the target* fields name the form the field points AT; in `incomingLinks` they name the OTHER
 *  form (the one whose field links here). */
export interface AppFormRelationLink {
  fieldId: string;
  fieldLabel: string;
  targetFormId: string;
  targetFormName: string;
  allowMultiple: boolean;
}

/** A form's linked_record relations within an app (owner-scoped) — powers the Manage-forms
 *  relation badges + remove-form dependency warning without fetching every full form. */
export interface AppFormRelations {
  formId: string;
  displayName: string;
  outgoingLinks: AppFormRelationLink[];
  incomingLinks: AppFormRelationLink[];
}

/** Owner-self surfaces that must NOT be rewritten while acting (they act on the ADMIN's
 *  own session/account or are already admin-scoped). */
const ACTING_PASSTHROUGH = [
  '/admin', '/auth', '/notices', '/ai', '/packs', '/billing', '/api-keys',
  '/desktop-connections', '/oauth', '/health', '/mcp', '/sample-apps',
  '/application-packages', '/demo',
];

/** Record-data surfaces: refused while acting (the backend mirror has no variants). */
const ACTING_BLOCKED: RegExp[] = [
  /^\/forms\/[^/]+\/(responses|analytics|lookup|reports|script|export|start|upload)(\/|\?|$)/,
  /^\/app\//,                          // the entire app runtime shows record data
  /^\/apps\/[^/]+\/export(\/|\?|$)/,   // app exports can embed seeded records
  /^\/files\//,
  /^\/flow-runs\/queued(\/|\?|$)/,     // queue/claim hand answer snapshots to executors
  /\/claim(\/|\?|$)/,
  /^\/flow-kv(\/|\?|$)/,
];

/**
 * Platform-admin acting-mode endpoint router (pure — unit-tested directly):
 * pass through admin-self surfaces, refuse record-data surfaces, rewrite
 * everything owner-scoped onto the server's /admin/users/{ownerId} mirror, and
 * DEFAULT-DENY anything unmapped (a loud 403, never a silent owner-surface call).
 */
export function actingRoute(endpoint: string, ownerId: string): { endpoint: string; blocked: boolean } {
  for (const prefix of ACTING_PASSTHROUGH) {
    if (endpoint === prefix || endpoint.startsWith(prefix + '/') || endpoint.startsWith(prefix + '?')) {
      return { endpoint, blocked: false };
    }
  }
  for (const re of ACTING_BLOCKED) {
    if (re.test(endpoint)) return { endpoint, blocked: true };
  }
  if (/^\/(forms|apps|flows|flow-runs|trash)(\/|\?|$)/.test(endpoint)) {
    return { endpoint: `/admin/users/${encodeURIComponent(ownerId)}${endpoint}`, blocked: false };
  }
  return { endpoint, blocked: true };
}

class ApiClient {
  private baseUrl: string;
  // Track authentication state without storing the token (it's in HttpOnly cookie)
  private _isAuthenticated: boolean = false;
  // Callbacks invoked when a 401 response invalidates the session (Set prevents duplicates)
  private _onSessionExpiredCallbacks: Set<() => void> = new Set();
  // When true (the shared public Demo account), app-runtime writes stay in this browser's IndexedDB
  // instead of hitting the server, so the demo can't be polluted for other visitors.
  private _demoMode: boolean = false;
  // Platform-admin ACTING mode: while an admin manages ANOTHER user's account under the
  // /admin/... routes (AdminActingBoundary sets this), owner-scoped endpoints are rewritten
  // onto the server's acting-as mirror (/admin/users/{ownerId}/...), and record-data
  // endpoints are refused before any network call. The authoritative boundary is the
  // backend allowlist (AdminActingAsRoutes) — this is defense in depth + honest UX.
  private _adminActing: { ownerId: string } | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Toggle the demo local-overlay (set from the auth store when the Demo account is active). */
  setDemoMode(on: boolean): void {
    this._demoMode = on;
  }

  /** Whether the shared Demo account is active (writes should stay in the browser). */
  isDemoMode(): boolean {
    return this._demoMode;
  }

  /** Enter/leave platform-admin acting mode (AdminActingBoundary mounts/unmounts). */
  setAdminActing(ctx: { ownerId: string } | null): void {
    this._adminActing = ctx;
  }

  /** Whether requests are currently acting on another user's account as a platform admin. */
  isAdminActing(): boolean {
    return this._adminActing !== null;
  }

  static readonly ACTING_BLOCKED_MESSAGE = 'Record data is not visible to platform administrators.';

  /** Route an endpoint for acting mode (see the exported actingRoute — pure and unit-tested). */
  private routeForAdminActing(endpoint: string): { endpoint: string; blocked: boolean } {
    const acting = this._adminActing;
    if (!acting) return { endpoint, blocked: false };
    const routed = actingRoute(endpoint, acting.ownerId);
    if (routed.blocked) {
      logger.warn('Admin acting mode refused an endpoint:', endpoint);
    }
    return routed;
  }

  /**
   * Register a callback to be invoked when a 401 response is received,
   * allowing stores to clear user state. Uses a Set to prevent duplicate registrations.
   */
  onSessionExpired(callback: () => void): void {
    this._onSessionExpiredCallbacks.add(callback);
  }

  removeSessionExpiredCallback(callback: () => void): void {
    this._onSessionExpiredCallbacks.delete(callback);
  }

  /**
   * Handle a 401 response — clear local auth state and notify listeners.
   * Only triggers callbacks if we were previously authenticated,
   * to avoid spurious notifications during login/initialization.
   */
  private handleUnauthorized(): void {
    const wasAuthenticated = this._isAuthenticated;
    this._isAuthenticated = false;
    if (wasAuthenticated && this._onSessionExpiredCallbacks.size > 0) {
      for (const cb of this._onSessionExpiredCallbacks) {
        cb();
      }
    }
  }

  /**
   * Read the CSRF token from the non-HttpOnly cookie set by the server.
   */
  private getCsrfToken(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Mark the client as authenticated (called after successful login/register)
   */
  setAuthenticated(authenticated: boolean): void {
    this._isAuthenticated = authenticated;
  }

  /**
   * Check if user appears to be authenticated
   * Note: This is a client-side hint only. The actual auth check happens server-side via the HttpOnly cookie.
   */
  isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const routed = this.routeForAdminActing(endpoint);
    if (routed.blocked) {
      return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    }
    const url = `${this.baseUrl}${routed.endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    // Include CSRF token on state-changing requests
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        // Include cookies in requests for HttpOnly cookie authentication
        credentials: 'include',
      });

      let data: T;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          if (response.status === 401) {
            this.handleUnauthorized();
          }
          return { error: `Server error (${response.status})`, status: response.status };
        }
        return { error: 'Invalid response from server' };
      }

      if (!response.ok) {
        if (response.status === 401) {
          this.handleUnauthorized();
        }
        const d = data as Record<string, unknown>;
        let message = (d?.message as string) || 'An error occurred';
        // Surface per-field validation errors so failures are actionable rather
        // than a generic "Validation failed".
        if (d?.errors && typeof d.errors === 'object') {
          const fieldMsgs = Object.values(d.errors as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
          if (fieldMsgs.length > 0) message = `${message}: ${fieldMsgs.join('; ')}`;
        }
        return { error: message, status: response.status };
      }

      return { data };
    } catch (error) {
      logger.error('API request failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  /**
   * Like request(), but returns the raw HTTP status + parsed body instead of flattening a non-2xx
   * response to a single `error` string. Used where the caller needs structured fields from an error
   * body (e.g. the 409 {conflict}/{processing} flags on an app submission). Additive: existing
   * endpoints keep using request().
   */
  private async requestWithMeta(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; networkError?: string }> {
    const routed = this.routeForAdminActing(endpoint);
    if (routed.blocked) {
      return { ok: false, status: 403, body: { error: true, message: ApiClient.ACTING_BLOCKED_MESSAGE } };
    }
    const url = `${this.baseUrl}${routed.endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = this.getCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    try {
      const response = await fetch(url, { ...options, headers, credentials: 'include' });
      let body: Record<string, unknown> | null = null;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (response.status === 401) this.handleUnauthorized();
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      logger.error('API request failed:', error);
      return { ok: false, status: 0, body: null, networkError: error instanceof Error ? error.message : 'Network error' };
    }
  }

  /**
   * Desktop-AI relay variant of request(): preserves the typed `code` from the standard
   * {error:true, code, message} failure envelope (plan §5.8 taxonomy) so the tunnel client
   * can branch on queue_full_user / ambiguous_desktop / e2e_key_unknown / … honestly.
   */
  private async desktopAiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<DesktopAiApiResponse<T>> {
    const res = await this.requestWithMeta(endpoint, options);
    if (res.ok) return { data: (res.body ?? {}) as T, status: res.status };
    const code = typeof res.body?.code === 'string' ? res.body.code : undefined;
    const message = typeof res.body?.message === 'string' ? res.body.message : res.networkError;
    return {
      error: message ?? `Server error (${res.status})`,
      status: res.status || undefined,
      ...(code ? { code } : {}),
    };
  }

  // Auth endpoints
  async register(email: string, password: string, name?: string, timezone?: string): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, timezone }),
    });

    if (result.data?.user) {
      this.setAuthenticated(true);
    }

    return result;
  }

  async login(email: string, password: string): Promise<ApiResponse<{ user?: User; mfaRequired?: boolean; mfaToken?: string }>> {
    // With MFA enabled on an unknown browser, the server answers
    // { mfaRequired, mfaToken } instead of { user } — no session yet.
    const result = await this.request<{ user?: User; mfaRequired?: boolean; mfaToken?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (result.data?.user) {
      this.setAuthenticated(true);
    }

    return result;
  }

  /** Finish a two-step login: the pending token from login() + an authenticator (or recovery) code. */
  async verifyMfa(mfaToken: string, code: string, rememberBrowser: boolean): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code, rememberBrowser }),
    });
    if (result.data?.user) {
      this.setAuthenticated(true);
    }
    return result;
  }

  // ── MFA management (Settings → Security) ─────────────────────────────────

  async getMfaStatus(): Promise<ApiResponse<{
    enabled: boolean;
    pendingSetup: boolean;
    recoveryCodesRemaining: number;
    trustedBrowsers: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }>;
  }>> {
    return this.request('/auth/mfa');
  }

  /** Start enrollment: a fresh secret + otpauth:// URI to render as a QR. */
  async startMfaSetup(): Promise<ApiResponse<{ secret: string; uri: string }>> {
    return this.request('/auth/mfa/setup', { method: 'POST' });
  }

  /** Prove the authenticator works and switch MFA on. Returns the one-time recovery codes. */
  async enableMfa(code: string): Promise<ApiResponse<{ enabled: boolean; recoveryCodes: string[] }>> {
    return this.request('/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code }) });
  }

  async disableMfa(password: string): Promise<ApiResponse<{ enabled: boolean }>> {
    return this.request('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password }) });
  }

  async regenerateMfaRecoveryCodes(code: string): Promise<ApiResponse<{ recoveryCodes: string[] }>> {
    return this.request('/auth/mfa/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) });
  }

  async revokeMfaTrustedBrowser(id: string): Promise<ApiResponse<{ revoked: boolean }>> {
    return this.request(`/auth/mfa/trusted-browsers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Start (or resume) the public no-signup demo — mints a session for the shared "Demo" account. */
  async startDemo(): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User; seedEpoch?: string | null }>('/demo/start', { method: 'POST' });
    if (result.data?.user) {
      this.setAuthenticated(true);
      // The seed epoch bumps whenever the shared demo data is regenerated. Purge this browser's
      // local overlay on mismatch — records referencing the replaced dataset would dangle forever
      // ("Record not found" on every linked field).
      await this.syncDemoSeedEpoch(result.data.seedEpoch);
    }
    return result;
  }

  /** Public list of demoable apps (published apps owned by the Demo account). */
  async getDemoApps(): Promise<ApiResponse<{ apps: Array<{ slug: string; name: string; description: string; logoUrl: string | null; icon?: string | null; accent?: string | null; packName?: string; catalogSlug?: string; tags?: string[] }> }>> {
    return this.request('/demo/apps');
  }

  /** Public list of standalone example forms (published, Demo-owned, not in any app) for the landing showcase. */
  async getDemoForms(): Promise<ApiResponse<{ forms: Array<{ id: string; title: string; description: string; icon?: string | null; hasLogic: boolean }> }>> {
    return this.request('/demo/forms');
  }

  async requestPasswordReset(email: string): Promise<ApiResponse<{ message: string }>> {
    // The reset-link host is resolved server-side from trusted config — we do
    // NOT send it from the client (that would be a reset-poisoning vector).
    return this.request('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async resetPassword(token: string, password: string): Promise<ApiResponse<{ message: string }>> {
    return this.request('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  async deleteAccount(password: string): Promise<ApiResponse<{ message: string }>> {
    const result = await this.request<{ message: string }>('/auth/me', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    if (!result.error) this.setAuthenticated(false);
    return result;
  }

  // Download the user's account data (GDPR portability) as a JSON file.
  async downloadMyData(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/me/export`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      throw new Error('Failed to export your data');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formlogic-my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Download an app form's responses as CSV (server-gated on the export_responses permission). */
  async exportAppResponses(appSlug: string, formId: string, fileLabel: string): Promise<void> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const response = await fetch(`${this.baseUrl}/app/${encodeURIComponent(appSlug)}/forms/${encodeURIComponent(formId)}/export`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      throw new Error(response.status === 403 ? 'You do not have permission to export responses.' : 'Failed to export responses');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (fileLabel || 'form').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'form';
    a.download = `${safe}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async logout(): Promise<ApiResponse<{ message: string }>> {
    const result = await this.request<{ message: string }>('/auth/logout', {
      method: 'POST',
    });
    this.setAuthenticated(false);
    return result;
  }

  /** Compare the server's demo seed epoch to the one this browser last saw; on mismatch, purge
   *  the local demo overlay (its records reference a dataset that no longer exists). */
  private async syncDemoSeedEpoch(epoch: string | null | undefined): Promise<void> {
    if (!epoch) return;
    const KEY = 'formlogic-demo-seed-epoch';
    try {
      const prev = localStorage.getItem(KEY);
      if (prev !== null && prev !== epoch) {
        await Promise.all([clearDemoRecords(), clearDemoApps()]);
      }
      localStorage.setItem(KEY, epoch);
    } catch { /* storage unavailable — skip */ }
  }

  async getMe(): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User; seedEpoch?: string | null }>('/auth/me');
    // Update auth state based on response
    this.setAuthenticated(!!result.data?.user);
    // Returning demo sessions restore here without ever hitting /demo/start — sync the seed
    // epoch so a reopened tab also drops overlay records from a replaced dataset.
    if (result.data?.user?.isDemo) {
      await this.syncDemoSeedEpoch(result.data.seedEpoch);
    }
    return result;
  }

  async updateProfile(data: Partial<User>): Promise<ApiResponse<{ user: User }>> {
    return this.request('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ── Account backup (Settings → Backup & restore) ──────────────────────────
  // The export zip CONTAINS record data (per-form SQLite + uploads), so acting
  // mode must refuse both directions: /account/* is default-denied by
  // actingRoute, and these raw-fetch methods carry their own explicit guards.

  /** Download the full account backup zip (apps/forms/flows + records + files). */
  async exportAccountBackup(): Promise<void> {
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const response = await fetch(`${this.baseUrl}/account/backup/export`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to export the backup';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `formlogic-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Restore a backup zip — creates COPIES of everything (never overwrites). */
  async importAccountBackup(file: File): Promise<ApiResponse<AccountBackupImportResult>> {
    if (this.isAdminActing()) return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    const formData = new FormData();
    formData.append('file', file);
    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) fetchHeaders['X-CSRF-Token'] = csrfToken;
      const response = await fetch(`${this.baseUrl}/account/backup/import`, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data?.message || 'Backup import failed', status: response.status };
      }
      return { data };
    } catch (error) {
      logger.error('Backup import failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  /** Admin: the structure-only backup manifest for a user (paths + schema, never data). */
  async adminGetBackupManifest(userId: string): Promise<ApiResponse<{ manifest: Record<string, unknown> }>> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/backup-manifest`);
  }

  /** Admin: the retained scheduled-backup days + the cron heartbeat. */
  async adminListScheduledBackups(): Promise<ApiResponse<{ runs: ScheduledBackupRun[]; lastRun: string | null; lastStatus: ScheduledBackupStatus | null }>> {
    return this.request('/admin/backups');
  }

  /** Admin: run a scheduled-backup pass now (same as the nightly cron). */
  async adminRunScheduledBackup(): Promise<ApiResponse<{ summary: ScheduledBackupStatus & { prunedDays?: string[] } }>> {
    return this.request('/admin/backups/run', { method: 'POST' });
  }

  /** Admin: restore ONE account from a backup day into that user's account (new copies). */
  async adminRestoreScheduledBackup(userId: string, date: string): Promise<ApiResponse<AccountBackupImportResult>> {
    return this.request('/admin/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ userId, date }),
    });
  }

  // ── Recycle bin ────────────────────────────────────────────────────────────
  // Owner-scoped, so acting mode rewrites these onto the admin mirror
  // (names/kinds/counts only — snapshot contents are never downloadable).

  async listTrash(): Promise<ApiResponse<{ items: TrashItem[] }>> {
    return this.request('/trash');
  }

  /** Restore an item (consumes it). Original ids are kept when still free. */
  async restoreTrashItem(id: string): Promise<ApiResponse<{ success: boolean; item: TrashItem; restored: AccountBackupImportResult }>> {
    return this.request(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  }

  /** Delete forever. */
  async purgeTrashItem(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // Form endpoints
  async getForms(options?: { status?: string; limit?: number; offset?: number }): Promise<ApiResponse<{ forms: Form[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const query = params.toString();
    const server = await this.request<{ forms: Form[]; count: number }>(`/forms${query ? `?${query}` : ''}`);
    if (!this._demoMode || !this._demoLocalForms) return server;
    const local = Array.from(
      new Map(
        this._demoLocalForms.list()
          .filter((form) => !options?.status || form.status === options.status)
          .map((form) => [form.id, form]),
      ).values(),
    );
    // Local demo forms are a prefix of the combined catalogue, so expose them
    // only on the first page. Repeating the overlay on every server page made a
    // single browser-created form appear once per page on larger demo accounts.
    const localForPage = (options?.offset ?? 0) === 0 ? local : [];
    return {
      ...server,
      // A browser-created demo form is a complete, usable local result. Do not
      // surface the shared API's transient error as a failed load when that
      // fallback succeeded—the caller would otherwise show a scary error toast
      // while rendering the local form correctly.
      error: localForPage.length > 0 ? undefined : server.error,
      data: {
        forms: [...localForPage, ...(server.data?.forms ?? [])],
        count: local.length + (server.data?.count ?? server.data?.forms.length ?? 0),
      },
    };
  }

  // Demo-local FORM access, registered by formStore at module init (a direct import
  // here would be circular: formStore imports api). Demo-created forms live ONLY in
  // the store's per-browser state — this bridge lets every page that reads through
  // the api (custom-screen Studio /forms/:id/screen/edit, Play /forms/:id/screen, …)
  // view AND edit them in the demo instead of 404ing against a server that has
  // never heard of the form.
  private _demoLocalForms: {
    list: () => Form[];
    get: (id: string) => Form | undefined;
    update: (id: string, updates: Partial<Form>) => Promise<Form | undefined>;
  } | null = null;

  registerDemoLocalForms(resolver: {
    list: () => Form[];
    get: (id: string) => Form | undefined;
    update: (id: string, updates: Partial<Form>) => Promise<Form | undefined>;
  }): void {
    this._demoLocalForms = resolver;
  }

  async getForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    if (this._demoMode && isDemoLocalId(id) && this._demoLocalForms) {
      const form = this._demoLocalForms.get(id);
      return form
        ? { data: { form } }
        : { error: 'This demo form was not found in this browser (demo forms are never saved to the server).', status: 404 };
    }
    return this.request(`/forms/${id}`);
  }

  async createForm(data: Partial<Form>): Promise<ApiResponse<{ form: Form }>> {
    if (this._demoMode && isDemoLocalId(data.id) && this._demoLocalForms) {
      const form = this._demoLocalForms.get(data.id as string);
      return form
        ? { data: { form } }
        : { error: 'This demo form was not found in this browser.', status: 404 };
    }
    return this.request('/forms', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateForm(id: string, data: Partial<Form>): Promise<ApiResponse<{ form: Form }>> {
    // Demo-local form: the write lands in the store (persisted per browser), so the
    // Studio's save works in the demo — the server stays untouched and read-only.
    if (this._demoMode && isDemoLocalId(id) && this._demoLocalForms) {
      const form = await this._demoLocalForms.update(id, data);
      return form
        ? { data: { form } }
        : { error: 'This demo form was not found in this browser (demo forms are never saved to the server).', status: 404 };
    }
    return this.request(`/forms/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** PUT /api/forms/{id} with the raw status/body preserved — used where typed
   *  error codes (409 encryption_enabling / manifest_required) must survive to the
   *  caller, and where the optional E2EE `encryptionSchema` rides along so fields,
   *  status and the signed schema land in ONE transaction (atomic private publish). */
  async updateFormWithMeta(
    id: string,
    data: Partial<Form> & { encryptionSchema?: PublishSchemaPayload },
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    return this.requestWithMeta(`/forms/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteForm(id: string): Promise<ApiResponse<{ success: boolean; trashed?: boolean }>> {
    return this.request(`/forms/${id}`, {
      method: 'DELETE',
    });
  }

  async duplicateForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${id}/duplicate`, {
      method: 'POST',
    });
  }

  // Public form endpoint (for form submission)
  async getPublicForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/public/forms/${id}`);
  }

  /** Public, opt-in records for a custom screen's leaderboard (answers only). */
  async getScreenRecords(id: string, opts?: { limit?: number }): Promise<ApiResponse<{ records: Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }> }>> {
    return this.request(`/public/forms/${id}/screen-records${opts?.limit ? `?limit=${opts.limit}` : ''}`);
  }

  // Response endpoints
  async getResponses(
    formId: string,
    options?: { status?: string; from?: string; to?: string; limit?: number; offset?: number; answersEq?: Record<string, string>; answersPhoneEq?: Record<string, string>; answersGte?: Record<string, string>; answersLte?: Record<string, string> }
  ): Promise<ApiResponse<{ responses: FormResponse[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.from) params.set('from', options.from);
    if (options?.to) params.set('to', options.to);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    // Server-side equality lookups (audit AOK-FLOW-001).
    for (const [field, value] of Object.entries(options?.answersEq ?? {})) {
      params.set(`answers.${field}`, value);
    }
    // Phone-normalized lookups (flow filter op phone_eq): digits-suffix match in the DB.
    for (const [field, value] of Object.entries(options?.answersPhoneEq ?? {})) {
      params.set(`answersPhone.${field}`, value);
    }
    // Range bounds (flow filter ops gte/lte): filtered server-side BEFORE the limit.
    for (const [field, value] of Object.entries(options?.answersGte ?? {})) {
      params.set(`answersGte.${field}`, value);
    }
    for (const [field, value] of Object.entries(options?.answersLte ?? {})) {
      params.set(`answersLte.${field}`, value);
    }

    // Demo-local form (created in-browser by the demo account, id prefixed demolocal_):
    // the server has never heard of it, so its records live in the demo overlay only.
    // This is what lets a demo visitor's custom screen call records() and see real data.
    if (this._demoMode && isDemoLocalId(formId)) {
      const local = await getDemoRecords(formId);
      const rows = local.slice(0, Math.max(1, options?.limit ?? local.length)) as unknown as FormResponse[];
      return { data: { responses: rows, count: local.length } };
    }

    const query = params.toString();
    return this.request(`/forms/${formId}/responses${query ? `?${query}` : ''}`);
  }

  async getResponse(formId: string, responseId: string): Promise<ApiResponse<{ response: FormResponse }>> {
    if (this._demoMode && isDemoLocalId(formId)) {
      const response = await getDemoRecord(formId, responseId);
      return response
        ? { data: { response: response as unknown as FormResponse } }
        : { error: 'Record not found', status: 404 };
    }
    return this.request(`/forms/${formId}/responses/${responseId}`);
  }

  async submitResponse(formId: string, data: { answers: Record<string, unknown>; completionTime?: number; idempotencyKey?: string }): Promise<ApiResponse<{ response: FormResponse }>> {
    // Demo-local form: store the submission in the demo overlay (never the server) —
    // the mirror of the getResponses branch above, so demo custom screens can submit.
    if (this._demoMode && isDemoLocalId(formId)) {
      const rec = await addDemoRecord(formId, data.answers);
      return { data: { response: rec as unknown as FormResponse } };
    }
    // Stamp a stable idempotency key so a replayed submission (Workbox background-sync replaying a
    // request up to 24h later, or a manual retry after a dropped ack) returns the SAME response
    // instead of creating a duplicate row — same one-line pattern as createAppResponse/
    // createAppResponseResult above. The key rides in the same JSON body Workbox captures + replays,
    // so a replay of this exact request is byte-identical and hits the server's dedup by design.
    const body = data.idempotencyKey == null ? { ...data, idempotencyKey: newIdempotencyKey() } : data;
    return this.request(`/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Record a form "start" (first interaction) for the analytics funnel. Fire-and-forget. */
  async recordFormStart(formId: string): Promise<void> {
    if (this.isAdminActing()) return; // never pollute an owner's analytics funnel
    try {
      await fetch(`${this.baseUrl}/forms/${formId}/start`, { method: 'POST', credentials: 'include' });
    } catch { /* best-effort: never block the fill on an analytics ping */ }
  }

  // --- Billing (pay-as-you-go cloud months via PayPal) ---
  async getBillingStatus(): Promise<ApiResponse<BillingStatus>> {
    return this.request('/billing');
  }
  async createPaypalOrder(months: number): Promise<ApiResponse<{ orderId: string }>> {
    return this.request('/billing/orders', { method: 'POST', body: JSON.stringify({ months }) });
  }
  async capturePaypalOrder(orderId: string): Promise<ApiResponse<{ cloudUntil: string | null; active: boolean; monthsAdded?: number; alreadyProcessed?: boolean; processing?: boolean; message?: string }>> {
    return this.request(`/billing/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
  }

  async updateResponse(formId: string, responseId: string, data: Partial<FormResponse>): Promise<ApiResponse<{ response: FormResponse }>> {
    if (this._demoMode && isDemoLocalId(formId)) {
      const existing = await getDemoRecord(formId, responseId);
      if (!existing) return { error: 'Record not found', status: 404 };
      const response = await updateDemoRecord(
        formId,
        responseId,
        data.answers ?? existing.answers,
        data.status,
      );
      return response
        ? { data: { response: response as unknown as FormResponse } }
        : { error: 'Record not found', status: 404 };
    }
    return this.request(`/forms/${formId}/responses/${responseId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteResponse(formId: string, responseId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode && isDemoLocalId(formId)) {
      const response = await getDemoRecord(formId, responseId);
      if (!response) return { error: 'Record not found', status: 404 };
      await deleteDemoRecord(formId, responseId);
      return { data: { success: true } };
    }
    return this.request(`/forms/${formId}/responses/${responseId}`, {
      method: 'DELETE',
    });
  }

  // --- E2EE private forms (docs/E2EE_PRIVATE_FORMS_PLAN.md) ---
  // All of these are owner-only surfaces: refused outright in admin acting-as mode and
  // unavailable in the demo account (D9 / §9.2). They use requestWithMeta so typed
  // error codes (vault_version_conflict 409, private_enable_blocked, revision_conflict)
  // survive to the caller. Success bodies are wrapped in {data: …} and error bodies
  // are {error:true, message, code, details?} — the backend's canonical envelope.

  private privateFormsBlocked(): string | null {
    if (this.isAdminActing()) return ApiClient.ACTING_BLOCKED_MESSAGE;
    if (this._demoMode) return 'Private forms are not available in the demo.';
    return null;
  }

  /** GET /api/vault — the caller's wrapped vault, or null when none exists yet (404). */
  async getVault(): Promise<ApiResponse<{ vault: VaultWire | null }>> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { error: blocked, status: 403 };
    const res = await this.requestWithMeta('/vault');
    if (res.status === 404) return { data: { vault: null } };
    if (!res.ok) {
      return { error: (res.body?.message as string) ?? `Server error (${res.status})`, status: res.status };
    }
    const vault = (res.body?.data as { vault?: VaultWire } | undefined)?.vault ?? null;
    return { data: { vault } };
  }

  /** PUT /api/vault — create-only (409 vault_exists). Body = the vault fields at root. */
  async createVault(vault: VaultWire): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { ok: false, status: 403, body: { error: true, message: blocked } };
    return this.requestWithMeta('/vault', { method: 'PUT', body: JSON.stringify(vault) });
  }

  /** POST /api/vault/change-passphrase — rewrap-only, version-checked (409 on stale).
   *  Also the recovery-rewrap path: the rewrap payload is identical either way. */
  async changeVaultPassphrase(
    expectedVersion: number,
    rewrap: Pick<VaultWire, 'kdf' | 'kdfSalt' | 'kdfMemlimit' | 'kdfOpslimit' | 'wrappedUmk'>,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { ok: false, status: 403, body: { error: true, message: blocked } };
    return this.requestWithMeta('/vault/change-passphrase', {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, ...rewrap }),
    });
  }

  /** POST /api/forms/{id}/encryption — atomic §9.1 enable with the client-computed key set. */
  async enableFormEncryption(formId: string, payload: EnableEncryptionPayload): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { ok: false, status: 403, body: { error: true, message: blocked } };
    return this.requestWithMeta(`/forms/${formId}/encryption`, { method: 'POST', body: JSON.stringify(payload) });
  }

  /** GET /api/forms/{id}/encryption — owner state: grant + ingestion keys + manifest rows. */
  async getFormEncryptionState(formId: string): Promise<ApiResponse<FormEncryptionStateWire>> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { error: blocked, status: 403 };
    const res = await this.requestWithMeta(`/forms/${formId}/encryption`);
    if (!res.ok) {
      return { error: (res.body?.message as string) ?? `Server error (${res.status})`, status: res.status };
    }
    return { data: (res.body?.data ?? {}) as FormEncryptionStateWire };
  }

  /** POST /api/forms/{id}/encryption/schema — cut a new schema version + signed manifest on field publish. */
  async publishFormSchemaVersion(formId: string, payload: PublishSchemaPayload): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { ok: false, status: 403, body: { error: true, message: blocked } };
    return this.requestWithMeta(`/forms/${formId}/encryption/schema`, { method: 'POST', body: JSON.stringify(payload) });
  }

  // --- Encrypted data nodes (docs/FORMLOGIC_DATA_NODES.md §11) ---

  /** GET /api/data-nodes — this owner's enrolled desktop data nodes. */
  async getDataNodes(): Promise<ApiResponse<{ nodes: import('../types/dataPlacement').DataNodeWire[] }>> {
    const res = await this.requestWithMeta('/data-nodes');
    if (!res.ok) {
      return { error: (res.body?.message as string) ?? `Server error (${res.status})`, status: res.status };
    }
    return { data: (res.body?.data ?? { nodes: [] }) as { nodes: import('../types/dataPlacement').DataNodeWire[] } };
  }

  /** POST /api/data-nodes/{id}/approve — store the owner-signed flnodecert:1. */
  async approveDataNode(nodeId: string, certificate: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    return this.requestWithMeta(`/data-nodes/${nodeId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ certificate }),
    });
  }

  /** DELETE /api/data-nodes/{id} — revoke node authority (credentials/data are separate actions). */
  async revokeDataNode(nodeId: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    return this.requestWithMeta(`/data-nodes/${nodeId}`, { method: 'DELETE' });
  }

  /** GET /api/forms/{id}/data-placement — signed placement state for a Private form. */
  async getDataPlacement(formId: string): Promise<ApiResponse<import('../types/dataPlacement').DataPlacementState>> {
    const res = await this.requestWithMeta(`/forms/${formId}/data-placement`);
    if (!res.ok) {
      return { error: (res.body?.message as string) ?? `Server error (${res.status})`, status: res.status };
    }
    return { data: (res.body?.data ?? {}) as import('../types/dataPlacement').DataPlacementState };
  }

  /** PUT /api/forms/{id}/data-placement — the owner-signed epoch-1 baseline (CAS). */
  async putDataPlacement(formId: string, manifest: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    return this.requestWithMeta(`/forms/${formId}/data-placement`, {
      method: 'PUT',
      body: JSON.stringify({ manifest }),
    });
  }

  /** POST /api/forms/{id}/responses with {envelope} — the only private-mode create shape (§6). */
  async submitEncryptedResponse(formId: string, envelope: ResponseEnvelope, idempotencyKey?: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    return this.requestWithMeta(`/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify({ envelope, idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
    });
  }

  /** PUT /api/forms/{id}/responses/{id} with {envelope, expectedRev} — atomic rev CAS (§6). */
  async updateEncryptedResponse(formId: string, responseId: string, envelope: ResponseEnvelope, expectedRev: number, idempotencyKey?: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const blocked = this.privateFormsBlocked();
    if (blocked) return { ok: false, status: 403, body: { error: true, message: blocked } };
    return this.requestWithMeta(`/forms/${formId}/responses/${responseId}`, {
      method: 'PUT',
      body: JSON.stringify({ envelope, expectedRev, idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
    });
  }

  // Re-run the form's logic script against a stored response
  async recomputeResponse(formId: string, responseId: string): Promise<ApiResponse<{ success: boolean; computed?: Record<string, unknown>; status?: string; tags?: string[]; error?: string }>> {
    return this.request(`/forms/${formId}/responses/${responseId}/recompute`, {
      method: 'POST',
    });
  }

  // Analytics
  // tzOffsetMinutes: the viewer's local timezone expressed as minutes AHEAD of UTC (e.g.
  // AEST/UTC+10 = +600, US Eastern EST/UTC-5 = -300), so the server can bucket
  // "Responses over time" by the viewer's local calendar day instead of UTC. Optional —
  // omitting it (or passing undefined) preserves the exact pre-existing UTC-bucketed behavior.
  async getFormAnalytics(formId: string, tzOffsetMinutes?: number): Promise<ApiResponse<{ analytics: FormAnalytics }>> {
    const query = tzOffsetMinutes === undefined ? '' : `?tzOffsetMinutes=${encodeURIComponent(tzOffsetMinutes)}`;
    return this.request(`/forms/${formId}/analytics${query}`);
  }

  // Export
  async exportResponses(formId: string): Promise<string> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const url = `${this.baseUrl}/forms/${formId}/responses/export`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to export responses');
    }

    return response.text();
  }

  // Download SQLite database file
  async downloadSqlite(formId: string, filename: string): Promise<void> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const url = `${this.baseUrl}/forms/${formId}/export/sqlite`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to download SQLite database';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${filename}.sqlite`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  // Download JSON export
  async downloadJson(formId: string, filename: string): Promise<void> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const url = `${this.baseUrl}/forms/${formId}/export/json`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to download JSON export';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${filename}-export.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  // Health check
  async healthCheck(): Promise<ApiResponse<{ status: string; timestamp: string; betaMode?: boolean; emailConfigured?: boolean; supportEmail?: string; maintenanceMode?: boolean; maintenanceMessage?: string | null }>> {
    return this.request('/health');
  }

  /** Public rotating hero headlines for the landing page (backend/resources/landing-hero.json). */
  async getLandingHero(): Promise<ApiResponse<{ intervalMs?: number; slides?: Array<{ pre?: string; em?: string; post?: string }> }>> {
    return this.request('/landing/hero');
  }

  /**
   * Authenticated deep health ("Doctor"). Returns the body even on 503 (degraded) so the UI can
   * render the failing checks. Null on auth failure / network error.
   */
  async getDeepHealth(): Promise<DeepHealth | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health/deep`, { credentials: 'include' });
      if (res.status === 401) { this.handleUnauthorized(); return null; }
      return await res.json();
    } catch {
      return null;
    }
  }

  // AI endpoints
  async getAIStatus(): Promise<ApiResponse<AIStatus>> {
    return this.request('/ai/status');
  }

  async generateFormFromPrompt(
    prompt: string,
    existingFields?: Array<{ id: string; label: string; type: string; required?: boolean }>,
    existingScript?: string,
  ): Promise<ApiResponse<AIFormGenerationResult>> {
    // existingFields/existingScript make this an EDIT of the current form (the AI modifies it,
    // preserving field ids) rather than a from-scratch generation.
    return this.request('/ai/generate-form', {
      method: 'POST',
      body: JSON.stringify({ prompt, existingFields, existingScript }),
    });
  }

  /** AI App Builder: turn a prompt (+ optional reference image data URL) into a multi-form app plan. */
  async generateAppPlan(prompt: string, maxForms = 6, image?: string): Promise<ApiResponse<{ data: import('./ai-app-builder/types').AppPlan }>> {
    return this.request('/ai/generate-app-plan', {
      method: 'POST',
      body: JSON.stringify({ prompt, maxForms, image }),
    });
  }

  /** Generate a custom screen — preferred result is a multi-file TSX project (`files`); legacy
   *  models may return the html/css/js triple. Pass appForms for an APP HOME (multi-form SDK). */
  async generateScreen(
    prompt: string,
    fields?: Array<{ id: string; label: string; type: string }>,
    existing?: string,
    appForms?: Array<{ formId: string; title: string; fields: unknown[] }>,
    screenType?: 'section' | 'record',
  ): Promise<ApiResponse<{ data: { html: string; css: string; js: string; files?: Array<{ path: string; content: string }> } }>> {
    return this.request('/ai/generate-screen', {
      method: 'POST',
      body: JSON.stringify({ prompt, fields, existing, appForms, screenType }),
    });
  }

  async generateFormFromFile(file: File, prompt?: string): Promise<ApiResponse<AIFormGenerationResult>> {
    const url = `${this.baseUrl}/ai/generate-form-from-file`;
    const formData = new FormData();
    formData.append('file', file);
    if (prompt) {
      formData.append('prompt', prompt);
    }

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        // Include cookies for HttpOnly cookie authentication
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          this.handleUnauthorized();
        }
        // The backend's `error` field is a boolean flag (true), never the message;
        // `data.error ||` short-circuited to `true`, surfacing a useless boolean to
        // the user. Read the human-readable message like the other multipart calls.
        return { error: data.message || 'An error occurred' };
      }

      return { data };
    } catch (error) {
      logger.error('API request failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async generateScript(prompt: string, fields: FormField[], example?: string): Promise<ApiResponse<AIScriptGenerationResult>> {
    return this.request('/ai/generate-script', {
      method: 'POST',
      // `example` is a field-grounded starter script the AI uses as a reference for
      // the correct API shape + this form's real field IDs.
      body: JSON.stringify({ prompt, fields, example }),
    });
  }

  async improveScript(script: string, prompt: string, fields: FormField[]): Promise<ApiResponse<AIScriptGenerationResult>> {
    return this.request('/ai/improve-script', {
      method: 'POST',
      body: JSON.stringify({ script, prompt, fields }),
    });
  }

  /**
   * Run an onSubmit script against sample answers WITHOUT persisting (auth +
   * form ownership required). Powers the ScriptEditor "Test" button.
   */
  async testScript(
    formId: string,
    script: string,
    answers: Record<string, unknown>
  ): Promise<ApiResponse<{ result: ScriptTestResult }>> {
    return this.request(`/forms/${formId}/script/test`, {
      method: 'POST',
      body: JSON.stringify({ script, answers }),
    });
  }

  /** How many responses hold a value for a field — powers the builder's delete-field warning. */
  async getFieldUsage(formId: string, fieldId: string): Promise<ApiResponse<{ fieldId: string; responsesWithValue: number }>> {
    return this.request(`/forms/${formId}/fields/${encodeURIComponent(fieldId)}/usage`);
  }

  /** Permanently remove a DELETED field's data from every response (post-structure-save step). */
  async purgeFieldData(formId: string, fieldId: string): Promise<ApiResponse<{ purged: number }>> {
    return this.request(`/forms/${formId}/fields/${encodeURIComponent(fieldId)}/purge-data`, { method: 'POST' });
  }

  // App Admin endpoints
  async getApps(): Promise<ApiResponse<{ apps: AppListItem[]; count: number }>> {
    const server = await this.request<{ apps: AppListItem[]; count: number }>('/apps');
    if (!this._demoMode) return server;
    const local = (await listDemoApps()).map((stored) => stored.app as AppListItem);
    return {
      ...server,
      data: {
        apps: [...local, ...(server.data?.apps ?? [])],
        count: local.length + (server.data?.count ?? server.data?.apps.length ?? 0),
      },
    };
  }

  /**
   * All of the caller's apps (owner + member, same visibility as getApps) WITH their attached
   * forms in ONE round trip — the batched replacement for the per-app getAppForms fan-out that
   * powers "in <app>" share badges and the companion picker's form lists.
   */
  async getAppsFormUsage(): Promise<ApiResponse<{ apps: AppFormUsageApp[] }>> {
    const server = await this.request<{ apps: AppFormUsageApp[] }>('/apps/form-usage');
    if (!this._demoMode) return server;
    const local = await listDemoAppsFormUsage();
    return { ...server, data: { apps: [...local, ...(server.data?.apps ?? [])] } };
  }

  /**
   * The caller-owned apps that contain this form (404 when the form isn't the caller's) —
   * drives context-aware Preview routing: 1 published context opens /app/{slug}/form/{formId}.
   */
  async getFormAppContexts(formId: string): Promise<ApiResponse<{ contexts: FormAppContext[] }>> {
    // Demo-local forms never exist server-side — asking would just 404 in the console.
    if (this._demoMode && isDemoLocalId(formId)) {
      return { data: { contexts: await listDemoFormAppContexts(formId) } };
    }
    return this.request(`/forms/${formId}/app-contexts`);
  }

  /**
   * Create an app. Optional `formIds` (each form must be owned by the caller) attach forms
   * ATOMICALLY inside one server transaction — any invalid form rolls the whole create back
   * (400, no app row, no attachments), replacing the old create-then-attach loop.
   *
   * Optional `settings.appKind` tags the app's archetype (server drops invalid values);
   * optional `rolePreset` tunes ONLY the new app's default system-role permissions
   * (owner role untouched; invalid presets ignored server-side).
   */
  async createApp(
    data: Partial<Omit<App, 'settings'>> & {
      settings?: Partial<AppSettings> & { appKind?: AppKind };
      formIds?: string[];
      rolePreset?: AppRolePreset;
    }
  ): Promise<ApiResponse<{ app: App }>> {
    if (this._demoMode) {
      const stored = await createDemoApp(data as Partial<App> & { formIds?: string[] });
      return { data: { app: stored.app } };
    }
    return this.request('/apps', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getApp(id: string): Promise<ApiResponse<{ app: unknown }>> {
    if (this._demoMode && isDemoLocalId(id)) {
      const stored = await getDemoApp(id);
      return stored
        ? { data: { app: stored.app } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${id}`);
  }

  async updateApp(id: string, data: Record<string, unknown>): Promise<ApiResponse<{ app: unknown }>> {
    if (this._demoMode && isDemoLocalId(id)) {
      const stored = await updateDemoApp(id, data as Partial<App>);
      return stored
        ? { data: { app: stored.app } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteApp(id: string): Promise<ApiResponse<{ success: boolean; trashed?: boolean }>> {
    if (this._demoMode && isDemoLocalId(id)) {
      await deleteDemoApp(id);
      return { data: { success: true } };
    }
    return this.request(`/apps/${id}`, {
      method: 'DELETE',
    });
  }

  /**
   * App Studio publish: status → published, published_version bumped, history row
   * recorded server-side (owner-only). `label` is an optional release note (≤160 chars).
   */
  async publishApp(id: string, label?: string): Promise<ApiResponse<{ app: App; version: number }>> {
    if (this._demoMode && isDemoLocalId(id)) {
      const published = await publishDemoApp(id, label);
      return published
        ? { data: { app: published.app, version: published.version.version } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    });
  }

  /** Publish history for an app, newest first (owner or member). */
  async listAppVersions(id: string): Promise<ApiResponse<{ versions: AppVersion[] }>> {
    if (this._demoMode && isDemoLocalId(id)) {
      return { data: { versions: await listDemoAppVersions(id) } };
    }
    return this.request(`/apps/${id}/versions`);
  }

  /**
   * One-click companion (e.g. admin console) app over the same forms + data. Omitting name
   * defaults to "<App> Admin". Optional copy toggles: copyDashboard brings the source's
   * widget dashboard (customScreen, only when kind === 'dashboard' — the shared forms keep
   * every widget valid), copyReports its saved reports, copyLogic its app-LEVEL custom
   * logic. Theme + nav always copy; members, roles, domains, slug and status never do.
   * Flags are sent only when explicitly set, so the server's defaults govern otherwise.
   *
   * Optional `appKind` overrides the companion's default settings.appKind ('admin' when
   * absent); optional `rolePreset` tunes the new app's default system-role permissions.
   * Both are sent only when set, so companion behavior is unchanged otherwise.
   */
  async createCompanionApp(
    appId: string,
    opts?: {
      name?: string;
      copyDashboard?: boolean;
      copyReports?: boolean;
      copyLogic?: boolean;
      appKind?: AppKind;
      rolePreset?: AppRolePreset;
    }
  ): Promise<ApiResponse<{ app: App }>> {
    const body: Record<string, unknown> = {};
    if (opts?.name) body.name = opts.name;
    if (typeof opts?.copyDashboard === 'boolean') body.copyDashboard = opts.copyDashboard;
    if (typeof opts?.copyReports === 'boolean') body.copyReports = opts.copyReports;
    if (typeof opts?.copyLogic === 'boolean') body.copyLogic = opts.copyLogic;
    if (opts?.appKind) body.appKind = opts.appKind;
    if (opts?.rolePreset) body.rolePreset = opts.rolePreset;
    return this.request(`/apps/${appId}/companion`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Custom domains (owner-gated)
  async getAppDomains(appId: string): Promise<ApiResponse<{ domains: AppDomain[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) return { data: { domains: [] } };
    return this.request(`/apps/${appId}/domains`);
  }
  async createAppDomain(appId: string, data: { domain: string; mode?: string }): Promise<ApiResponse<{ domain: AppDomain }>> {
    return this.request(`/apps/${appId}/domains`, { method: 'POST', body: JSON.stringify(data) });
  }
  async updateAppDomain(appId: string, domainId: string, data: Record<string, unknown>): Promise<ApiResponse<{ domain: AppDomain }>> {
    return this.request(`/apps/${appId}/domains/${domainId}`, { method: 'PUT', body: JSON.stringify(data) });
  }
  /** The app's signed client manifest ({payload, signature, alg, keyId}). Public for a published app. */
  async getClientManifest(slug: string): Promise<ApiResponse<{ payload: Record<string, unknown>; signature: string; alg: string; keyId: string }>> {
    return this.request(`/app/${slug}/client-manifest`, { method: 'GET' });
  }
  /**
   * The same signed client manifest, discovered at the CURRENT origin's root:
   * GET /.well-known/formlogic-app.json (custom-domain discovery; 404 when this host
   * isn't a connected custom domain of a published app).
   *
   * Deliberately NOT routed through request(): that helper prepends baseUrl — the /api
   * prefix, or a different origin entirely when VITE_API_URL is absolute — while this
   * endpoint lives at the DOMAIN ROOT of whatever host the page was loaded from (the
   * deploy's .htaccess maps it to the backend front controller). A raw same-origin
   * root-path fetch is the only correct routing. Any failure (404 off-domain, SPA
   * index.html fallback, non-manifest JSON, network error) flattens to { error } so
   * callers can fall back to the slug route.
   */
  async getWellKnownManifest(): Promise<ApiResponse<{ payload: Record<string, unknown>; signature: string; alg: string; keyId: string }>> {
    try {
      const response = await fetch('/.well-known/formlogic-app.json', {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        // Non-JSON body (e.g. the SPA fallback served index.html) → treated as unavailable below.
        data = null;
      }
      const d = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
      // Require the minimal signed-envelope shape; a 200 that isn't a manifest must
      // surface as an error so useAppManifest falls back to the slug route.
      if (!response.ok || !d || typeof d.payload !== 'object' || d.payload === null || typeof d.signature !== 'string') {
        const message = typeof d?.message === 'string' ? d.message : `Manifest not available (${response.status})`;
        return { error: message };
      }
      return { data: d as { payload: Record<string, unknown>; signature: string; alg: string; keyId: string } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }
  async verifyAppDomain(appId: string, domainId: string): Promise<ApiResponse<{ ok: boolean; status: string; message: string; domain: AppDomain | null }>> {
    return this.request(`/apps/${appId}/domains/${domainId}/verify`, { method: 'POST' });
  }
  async deleteAppDomain(appId: string, domainId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/domains/${domainId}`, { method: 'DELETE' });
  }

  /**
   * Record a successful FormLogic Desktop pairing in the server-side registry
   * (desktop_connections, owned by the Flows backend). Best-effort: callers must degrade
   * gracefully when the endpoint isn't deployed yet (404 flattens to { error }).
   */
  async registerDesktopConnection(data: {
    deviceName?: string;
    desktopInstanceId?: string;
    capabilities?: Record<string, unknown>;
    trustedOrigins?: string[];
  }): Promise<ApiResponse<{ connection?: Record<string, unknown> }>> {
    return this.request('/desktop-connections', { method: 'POST', body: JSON.stringify(data) });
  }

  /** Export the app as a signed .formlogic package (payload + Ed25519 signature + capabilities). */
  async exportAppSignedPackage(appId: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request(`/apps/${appId}/export/signed`);
  }

  // App Form management
  async getAppForms(appId: string): Promise<ApiResponse<{ forms: AppForm[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const stored = await getDemoApp(appId);
      return stored
        ? { data: { forms: stored.forms } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/forms`);
  }

  /**
   * All linked_record relations between an app's forms in ONE round trip (owner-scoped) —
   * replaces the per-form getForm fan-out that Manage-forms used for relation badges and
   * the remove-form dependency warning.
   */
  async getAppFormRelations(appId: string): Promise<ApiResponse<{ forms: AppFormRelations[] }>> {
    return this.request(`/apps/${appId}/forms/relations`);
  }

  // MCP: ephemeral tokens that let an external AI drive the API via the MCP server.
  // `extraScopes` (e.g. ['responses:read']) opts into scopes beyond the default builder set.
  // The backend REPLACES its default scopes with whatever `scopes` array is sent (no merge), so
  // whenever we opt into anything extra we resend the base builder scopes too — otherwise a
  // manually-generated token would lose apps/forms/screens access. When nothing extra is
  // requested we omit `scopes` entirely, so the request (and the resulting token) is unchanged
  // from before extraScopes existed.
  async createMcpToken(appId?: string, creator = false, connectorAccess = false, extraScopes: string[] = []): Promise<ApiResponse<{ token: string; expiresAt: string; idleTimeout: number; mcpUrl: string }>> {
    const BASE_SCOPES = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write'];
    const scopes = (connectorAccess || extraScopes.length > 0)
      ? Array.from(new Set([...BASE_SCOPES, ...(connectorAccess ? ['connector:command'] : []), ...extraScopes]))
      : undefined;
    return this.request('/mcp/tokens', { method: 'POST', body: JSON.stringify({ appId, creator, connectorAccess, ...(scopes ? { scopes } : {}) }) });
  }
  async listMcpTokens(appId?: string): Promise<ApiResponse<{ sessions: Array<{ id: string; appId: string | null; creator?: boolean; scopes?: string[]; expiresAt: string; idleTimeout: number; lastUsedAt: string | null; createdAt: string }> }>> {
    return this.request(`/mcp/tokens${appId ? `?appId=${appId}` : ''}`);
  }
  async revokeMcpToken(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/mcp/tokens/${id}`, { method: 'DELETE' });
  }

  /**
   * OAuth 2.1 consent support (external AI connectors: Claude / ChatGPT). Validates the raw
   * OAuth query params server-side; `params` are passed through VERBATIM under their OAuth
   * wire names (client_id, redirect_uri, scope, state, code_challenge, …). Non-2xx bodies are
   * RFC 6749-style { error, error_description }, surfaced as a typed oauthError.
   */
  async getOAuthAuthorizeInfo(params: Record<string, string>): Promise<OAuthAuthorizeResult> {
    const r = await this.requestWithMeta(`/oauth/authorize-info?${new URLSearchParams(params).toString()}`);
    if (r.networkError) return { networkError: r.networkError };
    if (r.ok && r.body) return { data: r.body as unknown as OAuthAuthorizeInfo };
    const b = (r.body || {}) as Record<string, unknown>;
    return {
      oauthError: {
        error: typeof b.error === 'string' ? b.error : 'server_error',
        errorDescription: typeof b.error_description === 'string'
          ? b.error_description
          : (typeof b.message === 'string' ? b.message : undefined),
      },
    };
  }

  /**
   * Approve the OAuth consent as the signed-in user (session cookie + CSRF, like other authed
   * POSTs). `params` are the same verbatim OAuth params the consent page received; optional
   * `appId` narrows the grant to one app. On success the server mints a one-time code and
   * returns { redirectTo } — the CALLER performs the redirect.
   */
  async approveOAuth(params: Record<string, string>, appId?: string): Promise<OAuthApproveResult> {
    const r = await this.requestWithMeta('/oauth/approve', {
      method: 'POST',
      body: JSON.stringify(appId ? { ...params, appId } : { ...params }),
    });
    if (r.networkError) return { networkError: r.networkError };
    const redirectTo = r.body && typeof r.body.redirectTo === 'string' ? r.body.redirectTo : null;
    if (r.ok && redirectTo) return { data: { redirectTo } };
    const b = (r.body || {}) as Record<string, unknown>;
    return {
      oauthError: {
        error: typeof b.error === 'string' ? b.error : 'server_error',
        errorDescription: typeof b.error_description === 'string'
          ? b.error_description
          : (typeof b.message === 'string' ? b.message : undefined),
      },
    };
  }

  async addAppForm(appId: string, formId: string, displayName?: string): Promise<ApiResponse<{ forms: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const forms = await addDemoAppForm(appId, formId, displayName);
      return forms
        ? { data: { forms } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/forms`, {
      method: 'POST',
      body: JSON.stringify({ formId, displayName }),
    });
  }

  async updateAppForm(appId: string, formId: string, data: Record<string, unknown>): Promise<ApiResponse<{ forms: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const forms = await updateDemoAppForm(appId, formId, data as Partial<AppForm>);
      return forms
        ? { data: { forms } }
        : { error: 'This form is not attached to the browser-only demo app.', status: 404 };
    }
    return this.request(`/apps/${appId}/forms/${formId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async removeAppForm(appId: string, formId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return await removeDemoAppForm(appId, formId)
        ? { data: { success: true } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/forms/${formId}`, {
      method: 'DELETE',
    });
  }

  async reorderAppForms(appId: string, formIds: string[]): Promise<ApiResponse<{ forms: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const forms = await reorderDemoAppForms(appId, formIds);
      return forms
        ? { data: { forms } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/forms/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ formIds }),
    });
  }

  // App Role management
  async getAppRoles(appId: string): Promise<ApiResponse<{ roles: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { data: { roles: await listDemoAppRoles(appId) } };
    }
    return this.request(`/apps/${appId}/roles`);
  }

  async createAppRole(appId: string, data: { name: string; description?: string }): Promise<ApiResponse<{ role: unknown }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const role = await createDemoAppRole(appId, data.name, data.description);
      return role
        ? { data: { role } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/roles`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateAppRole(appId: string, roleId: string, data: Record<string, unknown>): Promise<ApiResponse<{ roles: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const roles = await updateDemoAppRole(appId, roleId, data as Partial<import('../types/app').AppRole>);
      return roles
        ? { data: { roles } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/roles/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppRole(appId: string, roleId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return await deleteDemoAppRole(appId, roleId)
        ? { data: { success: true } }
        : { error: 'System roles cannot be deleted from a demo app.' };
    }
    return this.request(`/apps/${appId}/roles/${roleId}`, {
      method: 'DELETE',
    });
  }

  // App Role Permissions
  async getAppRolePermissions(appId: string, roleId: string): Promise<ApiResponse<{ permissions: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { data: { permissions: await getDemoAppRolePermissions(appId, roleId) } };
    }
    return this.request(`/apps/${appId}/roles/${roleId}/permissions`);
  }

  async setAppRolePermissions(appId: string, roleId: string, permissions: unknown[]): Promise<ApiResponse<{ permissions: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const saved = await setDemoAppRolePermissions(
        appId,
        roleId,
        permissions as Array<{ formId?: string | null; permission?: unknown }>,
      );
      return saved
        ? { data: { permissions: saved } }
        : { error: 'This browser-only demo role was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/roles/${roleId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    });
  }

  // App User management
  async getAppUsers(appId: string): Promise<ApiResponse<{ users: unknown[]; count: number }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const stored = await getDemoApp(appId);
      return stored
        ? { data: { users: stored.users, count: stored.users.length } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/users`);
  }

  async updateAppUser(appId: string, appUserId: string, data: Record<string, unknown>): Promise<ApiResponse<{ users: unknown[] }>> {
    return this.request(`/apps/${appId}/users/${appUserId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async removeAppUser(appId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/users/${appUserId}`, {
      method: 'DELETE',
    });
  }

  // App Invitations
  async getAppInvitations(appId: string): Promise<ApiResponse<{ invitations: unknown[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) return { data: { invitations: [] } };
    return this.request(`/apps/${appId}/invitations`);
  }

  async createAppInvitation(appId: string, email: string, roleId: string): Promise<ApiResponse<{ invitation: unknown }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { error: 'Browser-only demo apps cannot send email invitations. Sign up free to invite real people.' };
    }
    return this.request(`/apps/${appId}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email, roleId }),
    });
  }

  async revokeAppInvitation(appId: string, invitationId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode && isDemoLocalId(appId)) return { data: { success: true } };
    return this.request(`/apps/${appId}/invitations/${invitationId}`, {
      method: 'DELETE',
    });
  }

  async acceptAppInvitation(token: string): Promise<ApiResponse<{ success: boolean; membership: unknown }>> {
    return this.request('/apps/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  // App Groups
  async getAppGroups(appId: string): Promise<ApiResponse<{ groups: unknown[] }>> {
    return this.request(`/apps/${appId}/groups`);
  }

  async createAppGroup(appId: string, data: { name: string; description?: string }): Promise<ApiResponse<{ group: unknown }>> {
    return this.request(`/apps/${appId}/groups`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateAppGroup(appId: string, groupId: string, data: Record<string, unknown>): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppGroup(appId: string, groupId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}`, {
      method: 'DELETE',
    });
  }

  async getAppGroupMembers(appId: string, groupId: string): Promise<ApiResponse<{ members: Array<{ appUserId: string; name: string; email: string }> }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members`);
  }

  async addAppGroupMember(appId: string, groupId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members/${appUserId}`, {
      method: 'POST',
    });
  }

  async removeAppGroupMember(appId: string, groupId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members/${appUserId}`, {
      method: 'DELETE',
    });
  }

  // App Runtime endpoints (end-user facing)
  async getAppRuntime(slug: string): Promise<ApiResponse<{ app: unknown; forms: unknown[]; user: unknown; permissions: unknown }>> {
    if (this._demoMode) {
      const stored = await getDemoAppBySlug(slug);
      if (stored) {
        const forms = (await Promise.all(stored.forms.map(async (attachment) => {
          const result = await this.getForm(attachment.formId);
          const form = result.data?.form;
          if (!form) return null;
          return {
            formId: form.id,
            displayName: attachment.displayName || form.title,
            hidden: attachment.settings?.hidden === true,
            menuHidden: attachment.settings?.menuHidden === true,
            icon: form.icon,
            description: form.description ?? null,
            fields: form.fields ?? [],
            settings: { ...(form.settings ?? {}), ...(attachment.settings ?? {}) },
            customScreen: form.customScreen ?? null,
            customLogic: form.customLogic ?? null,
          };
        }))).filter((form): form is NonNullable<typeof form> => form !== null);
        const formLevel = Object.fromEntries(
          stored.forms.map((attachment) => [attachment.formId, [...FORM_LEVEL_PERMISSIONS]])
        );
        const permissions = { appLevel: [...APP_LEVEL_PERMISSIONS], formLevel };
        return {
          data: {
            app: stored.app,
            forms,
            user: { id: 'demo', name: 'Demo visitor', roleName: 'Owner', timezone: null },
            permissions,
          },
        };
      }
    }
    return this.request(`/app/${slug}`);
  }

  async getAppMyPermissions(slug: string): Promise<ApiResponse<{ permissions: unknown }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) {
      return { data: { permissions: { appLevel: [...APP_LEVEL_PERMISSIONS], formLevel: {} } } };
    }
    return this.request(`/app/${slug}/my-permissions`);
  }

  /**
   * App-bound Aokie Companion discovery plus an in-browser Ed25519 trust check.
   * The returned view is deliberately credential-free: TURN usernames/credentials,
   * gateway admissions, SDP and ICE candidates never escape this method.
   */
  async getAokieCompanionDiscovery(slug: string): Promise<ApiResponse<AokieCompanionDiscovery>> {
    const result = await this.request<Record<string, unknown>>(
      `/app/${encodeURIComponent(slug)}/aokie-discovery`,
    );
    if (result.error || !result.data) return { error: result.error ?? 'Companion discovery is unavailable', status: result.status };
    const verified = await verifyAokieCompanionDiscovery(result.data);
    return { data: companionDiscoveryView(result.data, verified) };
  }

  /** Owner-only enrollment registry, optionally narrowed to one app. */
  async getAokieCompanionDevices(appId?: string): Promise<ApiResponse<{ devices: AokieCompanionDevice[] }>> {
    const query = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    const result = await this.request<{ devices?: unknown[] }>(`/aokie-companion/devices${query}`);
    if (result.error || !result.data) return { error: result.error ?? 'Companion endpoints are unavailable', status: result.status };
    return {
      data: {
        devices: (Array.isArray(result.data.devices) ? result.data.devices : [])
          .map(companionDevice)
          .filter((device): device is AokieCompanionDevice => device !== null),
      },
    };
  }

  /** Immediately revoke an endpoint and all of that native endpoint's access/refresh sessions. */
  async revokeAokieCompanionDevice(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/aokie-companion/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Re-open a revoked registry row; the endpoint must still complete native authorization again. */
  async approveAokieCompanionDevice(id: string): Promise<ApiResponse<{ success: boolean; reauthorizationRequired: boolean }>> {
    return this.request(`/aokie-companion/devices/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  }

  /** Read the fail-closed app policy. Every published app member may inspect it. */
  async getAokieCompanionPolicy(appId: string): Promise<ApiResponse<{ appId: string; remoteConsent: AokieCompanionRemoteConsent }>> {
    const result = await this.request<{ appId?: unknown; remoteConsent?: unknown }>(
      `/aokie-companion/policy?appId=${encodeURIComponent(appId)}`,
    );
    if (result.error || !result.data) return { error: result.error ?? 'Companion policy is unavailable', status: result.status };
    return {
      data: {
        appId: typeof result.data.appId === 'string' ? result.data.appId : appId,
        remoteConsent: companionRemoteConsent(result.data.remoteConsent),
      },
    };
  }

  /** Management-permission update; all four booleans are sent explicitly. */
  async updateAokieCompanionPolicy(
    appId: string,
    remoteConsent: AokieCompanionRemoteConsentInput,
  ): Promise<ApiResponse<{ appId: string; remoteConsent: AokieCompanionRemoteConsent }>> {
    const result = await this.request<{ appId?: unknown; remoteConsent?: unknown }>('/aokie-companion/policy', {
      method: 'PUT',
      body: JSON.stringify({ appId, remoteConsent }),
    });
    if (result.error || !result.data) return { error: result.error ?? 'Companion policy could not be saved', status: result.status };
    return {
      data: {
        appId: typeof result.data.appId === 'string' ? result.data.appId : appId,
        remoteConsent: { ...companionRemoteConsent(result.data.remoteConsent), configured: true },
      },
    };
  }

  async getAokieCompanionHistory(
    appId: string,
    limit = 100,
    before?: number,
  ): Promise<ApiResponse<{ activity: AokieCompanionActivity[]; sessions: AokieCompanionSession[] }>> {
    const query = new URLSearchParams({ appId, limit: String(limit) });
    if (before !== undefined) query.set('before', String(before));
    const result = await this.request<{ activity?: unknown[]; sessions?: unknown[] }>(
      `/aokie-companion/history?${query.toString()}`,
    );
    if (result.error || !result.data) return { error: result.error ?? 'Companion history is unavailable', status: result.status };
    return {
      data: {
        activity: (Array.isArray(result.data.activity) ? result.data.activity : [])
          .map(companionActivity).filter((row): row is AokieCompanionActivity => row !== null),
        sessions: (Array.isArray(result.data.sessions) ? result.data.sessions : [])
          .map(companionSession).filter((row): row is AokieCompanionSession => row !== null),
      },
    };
  }

  async getAokieCompanionRoutingGroups(appId: string): Promise<ApiResponse<{ groups: AokieCompanionRoutingGroup[] }>> {
    const result = await this.request<{ groups?: unknown[] }>(
      `/aokie-companion/routing-groups?appId=${encodeURIComponent(appId)}`,
    );
    if (result.error || !result.data) return { error: result.error ?? 'Companion routing is unavailable', status: result.status };
    return {
      data: {
        groups: (Array.isArray(result.data.groups) ? result.data.groups : [])
          .map(companionRoutingGroup).filter((row): row is AokieCompanionRoutingGroup => row !== null),
      },
    };
  }

  async createAokieCompanionRoutingGroup(
    input: AokieCompanionRoutingGroupInput,
  ): Promise<ApiResponse<{ group: AokieCompanionRoutingGroup }>> {
    return this.request('/aokie-companion/routing-groups', { method: 'POST', body: JSON.stringify(input) });
  }

  async updateAokieCompanionRoutingGroup(
    id: string,
    input: AokieCompanionRoutingGroupInput,
  ): Promise<ApiResponse<{ group: AokieCompanionRoutingGroup }>> {
    return this.request(`/aokie-companion/routing-groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  async deleteAokieCompanionRoutingGroup(id: string, appId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(
      `/aokie-companion/routing-groups/${encodeURIComponent(id)}?appId=${encodeURIComponent(appId)}`,
      { method: 'DELETE' },
    );
  }

  async setAokieCompanionAvailability(
    appId: string,
    deviceId: string,
    availability: AokieCompanionAvailability,
  ): Promise<ApiResponse<{ success: boolean; availability: AokieCompanionAvailability }>> {
    return this.request('/aokie-companion/availability', {
      method: 'PUT',
      body: JSON.stringify({ appId, deviceId, availability }),
    });
  }

  /**
   * Cross-form recent-activity feed for the app runtime's Activity widget: newest records
   * across ALL forms the caller can view (permission filtering is server-side), in one call.
   * `limit` is clamped 1..25 server-side (default 8).
   */
  async getAppActivity(slug: string, limit?: number): Promise<ApiResponse<{ activity: AppActivityItem[] }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) return { data: { activity: [] } };
    return this.request(`/app/${slug}/activity${limit ? `?limit=${limit}` : ''}`);
  }

  async getAppMembership(slug: string): Promise<ApiResponse<{ appName: string; status: string; isMember: boolean; canSelfRegister: boolean }>> {
    if (this._demoMode) {
      const stored = await getDemoAppBySlug(slug);
      if (stored) {
        return {
          data: {
            appName: stored.app.name,
            status: 'active',
            isMember: true,
            canSelfRegister: stored.app.settings.allowSelfRegistration === true,
          },
        };
      }
    }
    return this.request(`/app/${slug}/membership`);
  }

  async joinApp(slug: string): Promise<ApiResponse<{ success: boolean; status: string }>> {
    return this.request(`/app/${slug}/join`, { method: 'POST' });
  }

  async getAppForm(slug: string, formId: string): Promise<ApiResponse<{ form: unknown }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) return this.getForm(formId);
    return this.request(`/app/${slug}/forms/${formId}`);
  }

  async getAppAnalytics(slug: string, formId: string): Promise<ApiResponse<{ analytics: FormAnalytics }>> {
    return this.request(`/app/${slug}/forms/${formId}/analytics`);
  }

  /** Merge server-seeded rows with this browser's local demo records (local shown first, newest). */
  private async _mergeDemoResponses(
    server: ApiResponse<{ responses: unknown[]; count: number; scope: string }>,
    formId: string
  ): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    const local = await getDemoRecords(formId);
    const serverRows = server.data?.responses ?? [];
    return {
      ...server,
      data: {
        responses: [...local, ...serverRows],
        count: (server.data?.count ?? serverRows.length) + local.length,
        scope: server.data?.scope ?? 'all',
      },
    };
  }

  async createAppResponse(slug: string, formId: string, data: Record<string, unknown>): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode) {
      // Keep demo submissions in this browser only — never touch the shared demo on the server.
      const answers = (data.answers as Record<string, unknown>) ?? {};
      const response = await addDemoRecord(formId, answers);
      return { data: { response } };
    }
    // Stamp a stable idempotency key so a replayed submission (offline background-sync
    // or a manual retry after a dropped ack) returns the SAME response instead of
    // creating a duplicate. The key is part of the body Workbox captures + replays.
    const body = data.idempotencyKey == null ? { ...data, idempotencyKey: newIdempotencyKey() } : data;
    return this.request(`/app/${slug}/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Submit one app response, preserving the server's 409 conflict/processing signalling (unlike
   * createAppResponse, which flattens it). Used by the offline queue's deliver() so it can distinguish
   * a terminal conflict from a retryable in-flight race. Same demo-mode + idempotency-key behaviour.
   */
  async createAppResponseResult(slug: string, formId: string, data: Record<string, unknown>): Promise<AppSubmitResult> {
    if (this._demoMode) {
      const answers = (data.answers as Record<string, unknown>) ?? {};
      const response = await addDemoRecord(formId, answers);
      return { ok: true, response, status: 200 };
    }
    const body = data.idempotencyKey == null ? { ...data, idempotencyKey: newIdempotencyKey() } : data;
    const res = await this.requestWithMeta(`/app/${slug}/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const b = res.body ?? {};
    if (res.ok) {
      return { ok: true, response: (b as { response?: unknown }).response, idempotent: b.idempotent === true, status: res.status };
    }
    const message = typeof b.message === 'string' ? b.message : (res.networkError ?? 'An error occurred');
    return {
      ok: false,
      error: message,
      conflict: b.conflict === true,
      processing: b.processing === true,
      status: res.status,
    };
  }

  /**
   * Offline sync: submit a batch of queued responses in one request (the same idempotent pipeline as a
   * single submit). Returns per-item results keyed by idempotencyKey. Used by flushNativeQueue().
   */
  async syncBatch(
    slug: string,
    items: Array<{ idempotencyKey: string; formId: string; answers: Record<string, unknown> }>
  ): Promise<ApiResponse<{ results: Array<{
    idempotencyKey: string | null;
    success: boolean;
    responseId: string | null;
    error: string | null;
    /** HTTP-ish status of the per-item submission (200 idempotent replay, 201 created, 409 conflict/processing, …). Optional: older servers omit it. */
    status?: number;
    /** Reused idempotency key with a DIFFERENT body — a permanent failure that never succeeds on retry (terminal-fail). */
    conflict?: boolean;
    /** An in-flight duplicate is being handled server-side — keep the item queued and retry on a later flush (do NOT fail). */
    processing?: boolean;
    /** Idempotent replay: the server already holds this exact submission — ack it (do NOT re-queue). */
    idempotent?: boolean;
  }> }>> {
    return this.request(`/app/${slug}/sync/batch`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  /** Bulk clear of one app form's records (Device Setup 'start fresh'). */
  async clearAppFormResponses(slug: string, formId: string): Promise<ApiResponse<{ success: boolean; deleted: number }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) {
      const records = await getDemoRecords(formId);
      await Promise.all(records.map((record) => deleteDemoRecord(formId, record.id)));
      return { data: { success: true, deleted: records.length } };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses`, { method: 'DELETE' });
  }

  async getAppResponses(slug: string, formId: string, options?: { limit?: number; offset?: number; answersEq?: Record<string, string>; answersPhoneEq?: Record<string, string>; answersGte?: Record<string, string>; answersLte?: Record<string, string> }): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    // Server-side equality lookups (audit AOK-FLOW-001).
    for (const [field, value] of Object.entries(options?.answersEq ?? {})) {
      params.set(`answers.${field}`, value);
    }
    // Phone-normalized lookups (flow filter op phone_eq): digits-suffix match in the DB.
    for (const [field, value] of Object.entries(options?.answersPhoneEq ?? {})) {
      params.set(`answersPhone.${field}`, value);
    }
    // Range bounds (flow filter ops gte/lte): filtered server-side BEFORE the limit.
    for (const [field, value] of Object.entries(options?.answersGte ?? {})) {
      params.set(`answersGte.${field}`, value);
    }
    for (const [field, value] of Object.entries(options?.answersLte ?? {})) {
      params.set(`answersLte.${field}`, value);
    }
    if (this._demoMode && await getDemoAppBySlug(slug)) {
      let records = await getDemoRecords(formId);
      for (const [field, value] of Object.entries(options?.answersEq ?? {})) {
        records = records.filter((record) => String(record.answers[field] ?? '') === value);
      }
      for (const [field, value] of Object.entries(options?.answersPhoneEq ?? {})) {
        const wanted = value.replace(/\D/g, '');
        records = records.filter((record) => String(record.answers[field] ?? '').replace(/\D/g, '').endsWith(wanted));
      }
      for (const [field, value] of Object.entries(options?.answersGte ?? {})) {
        records = records.filter((record) => String(record.answers[field] ?? '') >= value);
      }
      for (const [field, value] of Object.entries(options?.answersLte ?? {})) {
        records = records.filter((record) => String(record.answers[field] ?? '') <= value);
      }
      const count = records.length;
      const offset = options?.offset ?? 0;
      const page = records.slice(offset, options?.limit ? offset + options.limit : undefined);
      return { data: { responses: page, count, scope: 'all' } };
    }
    const query = params.toString();
    const res = await this.request<{ responses: unknown[]; count: number; scope: string }>(`/app/${slug}/forms/${formId}/responses${query ? `?${query}` : ''}`);
    return this._demoMode ? this._mergeDemoResponses(res, formId) : res;
  }

  /**
   * Server-paginated + searchable page of an app form's responses (returns the total matching count).
   * Used by the records grid for fast, large-dataset browsing. Non-demo only (no browser overlay).
   */
  async getAppResponsesPage(slug: string, formId: string, options: { limit: number; offset: number; search?: string; resolve?: boolean; sort?: string; sortDir?: 'asc' | 'desc' }): Promise<ApiResponse<{ responses: unknown[]; count: number; total: number; scope: string }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) {
      let records = await getDemoRecords(formId);
      const search = options.search?.trim().toLowerCase();
      if (search) {
        records = records.filter((record) =>
          Object.values(record.answers).some((value) => String(value ?? '').toLowerCase().includes(search))
        );
      }
      if (options.sort) {
        const direction = options.sortDir === 'asc' ? 1 : -1;
        records.sort((a, b) =>
          String(a.answers[options.sort!] ?? '').localeCompare(String(b.answers[options.sort!] ?? '')) * direction
        );
      }
      const total = records.length;
      const responses = records.slice(options.offset, options.offset + options.limit);
      return { data: { responses, count: responses.length, total, scope: 'all' } };
    }
    const params = new URLSearchParams();
    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));
    if (options.search) params.set('search', options.search);
    if (options.resolve) params.set('resolve', 'linked');
    // Server-side column sort — the database orders across ALL rows so it
    // composes with pagination (never a client-side sort of one page).
    if (options.sort) {
      params.set('sort', options.sort);
      params.set('dir', options.sortDir ?? 'desc');
    }
    return this.request(`/app/${slug}/forms/${formId}/responses?${params.toString()}`);
  }

  async getAppResponseById(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode && isDemoLocalId(responseId)) {
      const response = await getDemoRecord(formId, responseId);
      return response ? { data: { response } } : { error: 'Record not found' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`);
  }

  async updateAppResponse(slug: string, formId: string, responseId: string, data: Record<string, unknown>): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode) {
      if (isDemoLocalId(responseId)) {
        const response = await updateDemoRecord(formId, responseId, (data.answers as Record<string, unknown>) ?? {});
        return response ? { data: { response } } : { error: 'Record not found' };
      }
      return { error: 'This is a shared live demo — the seeded data is read-only. Your own entries can be edited.' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppResponse(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode) {
      if (isDemoLocalId(responseId)) {
        await deleteDemoRecord(formId, responseId);
        return { data: { success: true } };
      }
      return { error: 'This is a shared live demo — the seeded data is read-only.' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`, {
      method: 'DELETE',
    });
  }

  // Linked record lookup
  async lookupLinkedRecords(
    slug: string,
    formId: string,
    options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; offset?: number; ids?: string[] }
  ): Promise<ApiResponse<{ records: LinkedRecord[]; count: number }>> {
    const params = new URLSearchParams();
    params.set('targetFormId', options.targetFormId);
    if (options.displayFieldIds?.length) params.set('displayFieldIds', options.displayFieldIds.join(','));
    if (options.searchFieldIds?.length) params.set('searchFieldIds', options.searchFieldIds.join(','));
    if (options.q) params.set('q', options.q);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.ids?.length) params.set('ids', options.ids.join(','));
    const localApp = this._demoMode ? await getDemoAppBySlug(slug) : null;
    const serverResult = localApp
      ? { data: { records: [] as LinkedRecord[], count: 0 } }
      : await this.request<{ records: LinkedRecord[]; count: number }>(`/app/${slug}/forms/${formId}/lookup?${params.toString()}`);
    // Demo: records created in this browser live only in the IndexedDB overlay — merge them into
    // the picker so a locally-added client is selectable on a new appointment (local first).
    if (this._demoMode) {
      try {
        const local = await getDemoRecords(options.targetFormId);
        const q = (options.q || '').toLowerCase();
        const wanted = options.ids ? new Set(options.ids) : null;
        const toDisplay = (answers: Record<string, unknown>): string => {
          if (options.displayFieldIds?.length) {
            const parts = options.displayFieldIds
              .map((id) => answers[id])
              .filter((v) => v != null && v !== '')
              .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)));
            if (parts.length) return parts.join(' - ');
          }
          const first = Object.values(answers).find((v) => typeof v === 'string' && v.trim());
          return typeof first === 'string' ? first : 'New record';
        };
        const localRecords: LinkedRecord[] = local
          .map((r) => ({ id: r.id, display: toDisplay(r.answers || {}), fields: r.answers || {}, submittedAt: r.submittedAt }))
          .filter((r) => (wanted ? wanted.has(r.id) : true))
          .filter((r) => (q ? r.display.toLowerCase().includes(q) : true));
        if (localRecords.length) {
          const server = serverResult.data?.records ?? [];
          return { data: { records: [...localRecords, ...server], count: localRecords.length + (serverResult.data?.count ?? server.length) } };
        }
      } catch { /* overlay unavailable — server results only */ }
    }
    return serverResult;
  }

  /**
   * Owner-scoped linked-record lookup (no app context) — powers linked_record fields on standalone /
   * pack forms. Returns only the caller's own records.
   */
  /** Run a no-code report spec against one of an app's forms (read-only, permission-scoped). */
  async runReport(slug: string, spec: Record<string, unknown>): Promise<ApiResponse<import('../types/app').AppReportResult>> {
    return this.request(`/app/${encodeURIComponent(slug)}/reports/run`, {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
  }

  /** Run several report specs in one round (a widget dashboard fetches all charts at once). */
  async runReportBatch(slug: string, specs: Record<string, unknown>[]): Promise<ApiResponse<{ results: Array<import('../types/app').AppReportResult & { error?: boolean }> }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/reports/run-batch`, {
      method: 'POST',
      body: JSON.stringify({ specs }),
    });
  }

  /** Owner-scoped report for a form section-screen dashboard (builder preview / play / standalone form). */
  async runFormReport(formId: string, spec: Record<string, unknown>): Promise<ApiResponse<import('../types/app').AppReportResult>> {
    return this.request(`/forms/${encodeURIComponent(formId)}/reports/run`, { method: 'POST', body: JSON.stringify({ spec }) });
  }
  async runFormReportBatch(formId: string, specs: Record<string, unknown>[]): Promise<ApiResponse<{ results: Array<import('../types/app').AppReportResult & { error?: boolean }> }>> {
    return this.request(`/forms/${encodeURIComponent(formId)}/reports/run-batch`, { method: 'POST', body: JSON.stringify({ specs }) });
  }

  /** Anonymous public-link report for a section-screen dashboard (whitelisted fields only, no joins). */
  async runPublicFormReport(formId: string, spec: Record<string, unknown>): Promise<ApiResponse<import('../types/app').AppReportResult>> {
    return this.request(`/public/forms/${encodeURIComponent(formId)}/reports/run`, { method: 'POST', body: JSON.stringify({ spec }) });
  }
  async runPublicFormReportBatch(formId: string, specs: Record<string, unknown>[]): Promise<ApiResponse<{ results: Array<import('../types/app').AppReportResult & { error?: boolean }> }>> {
    return this.request(`/public/forms/${encodeURIComponent(formId)}/reports/run-batch`, { method: 'POST', body: JSON.stringify({ specs }) });
  }

  // ── FormLogic Flows (docs/FORMLOGIC_FLOWS.md §3) ──────────────────────────────────────────
  // Owner CRUD under /apps/{id}; runtime (browser runner) under /app/{slug}.

  async listFlows(appId: string): Promise<ApiResponse<{ flows: FlowDefinition[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { data: { flows: await demoApplyFlowOverlay(appId, []) } };
    }
    return this.request(`/apps/${appId}/flows`);
  }

  async createFlow(
    appId: string,
    data: { name: string; slug?: string; description?: string; flowJson?: WorkflowGraph; enabled?: boolean; nodeCapabilities?: string[] }
  ): Promise<ApiResponse<{ flow: FlowDefinition }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const existing = await demoApplyFlowOverlay(appId, []);
      const base = (data.slug || data.name || 'new-automation')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-automation';
      const taken = new Set(existing.map((flow) => flow.slug));
      let slug = base;
      let suffix = 2;
      while (taken.has(slug)) {
        slug = `${base}-${suffix}`;
        suffix += 1;
      }
      const flow = await demoCreateFlow({
        appId,
        name: data.name,
        slug,
        description: data.description ?? null,
        flowJson: data.flowJson ?? { nodes: [], edges: [] },
        enabled: data.enabled,
        nodeCapabilities: data.nodeCapabilities ?? null,
      });
      return { data: { flow } };
    }
    return this.request(`/apps/${appId}/flows`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateFlow(
    appId: string,
    flowId: string,
    data: Partial<{ name: string; slug: string; description: string | null; flowJson: WorkflowGraph; enabled: boolean; nodeCapabilities: string[] | null }>
  ): Promise<ApiResponse<{ flow: FlowDefinition }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const flow = (await demoApplyFlowOverlay(appId, [])).find((candidate) => candidate.id === flowId);
      if (!flow) return { error: 'This browser-only automation was not found.', status: 404 };
      return { data: { flow: await demoUpdateFlow(flow, data) } };
    }
    return this.request(`/apps/${appId}/flows/${flowId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteFlow(appId: string, flowId: string): Promise<ApiResponse<{ success: boolean; trashed?: boolean }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const flow = (await demoApplyFlowOverlay(appId, [])).find((candidate) => candidate.id === flowId);
      if (!flow) return { error: 'This browser-only automation was not found.', status: 404 };
      await demoDeleteFlow(flow);
      return { data: { success: true } };
    }
    return this.request(`/apps/${appId}/flows/${flowId}`, { method: 'DELETE' });
  }

  /** Records a 'running' run log with trigger_event 'test'; the builder executes locally and PATCHes the result in. */
  async testRunFlow(appId: string, flowId: string): Promise<ApiResponse<{ run: FlowRunLog }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const flow = (await demoApplyFlowOverlay(appId, [])).find((candidate) => candidate.id === flowId);
      if (!flow) return { error: 'This browser-only automation was not found.', status: 404 };
      const now = new Date().toISOString();
      return {
        data: {
          run: {
            runId: 'demolocal_' + newIdempotencyKey(),
            appId,
            formId: null,
            responseId: null,
            bindingId: null,
            flowDefinitionId: flow.id,
            parentRunId: null,
            rootRunId: null,
            callNodeId: null,
            depth: 0,
            flow: flow.slug,
            triggerEvent: 'test',
            correlationId: 'demo',
            idempotencyKey: newIdempotencyKey(),
            status: 'done',
            runtime: 'browser',
            claimedBy: null,
            inputSnapshot: {},
            result: { demo: true },
            outputActions: null,
            error: null,
            startedAt: now,
            finishedAt: now,
            createdAt: now,
          },
        },
      };
    }
    return this.request(`/apps/${appId}/flows/${flowId}/test-run`, { method: 'POST', body: JSON.stringify({}) });
  }

  async listFlowBindings(appId: string): Promise<ApiResponse<{ bindings: FlowBinding[] }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { data: { bindings: await listDemoAppBindings(appId) } };
    }
    return this.request(`/apps/${appId}/flow-bindings`);
  }

  async createFlowBinding(appId: string, data: Record<string, unknown>): Promise<ApiResponse<{ binding: FlowBinding }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const binding = await createDemoAppBinding(appId, data);
      return binding
        ? { data: { binding } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/flow-bindings`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateFlowBinding(appId: string, bindingId: string, data: Record<string, unknown>): Promise<ApiResponse<{ binding: FlowBinding }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      const binding = await updateDemoAppBinding(appId, bindingId, data);
      return binding
        ? { data: { binding } }
        : { error: 'This browser-only trigger was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/flow-bindings/${bindingId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteFlowBinding(appId: string, bindingId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return await deleteDemoAppBinding(appId, bindingId)
        ? { data: { success: true } }
        : { error: 'This browser-only demo app was not found.', status: 404 };
    }
    return this.request(`/apps/${appId}/flow-bindings/${bindingId}`, { method: 'DELETE' });
  }

  /** Paginated run history, newest first (owner-scoped; filter by flowId / bindingId / status). */
  async listFlowRuns(
    appId: string,
    options?: { flowId?: string; bindingId?: string; status?: string; page?: number; limit?: number }
  ): Promise<ApiResponse<{ runs: FlowRunLog[]; page: number; limit: number; total: number }>> {
    if (this._demoMode && isDemoLocalId(appId)) {
      return { data: { runs: [], page: options?.page ?? 1, limit: options?.limit ?? 25, total: 0 } };
    }
    const params = new URLSearchParams();
    if (options?.flowId) params.set('flowId', options.flowId);
    if (options?.bindingId) params.set('bindingId', options.bindingId);
    if (options?.status) params.set('status', options.status);
    if (options?.page) params.set('page', String(options.page));
    if (options?.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.request(`/apps/${appId}/flow-runs${query ? `?${query}` : ''}`);
  }

  /** Enabled flow definitions + bindings for the app runtime's browser runner (member-gated). */
  async getAppFlows(slug: string): Promise<ApiResponse<RuntimeFlows>> {
    if (this._demoMode) {
      const stored = await getDemoAppBySlug(slug);
      if (stored) {
        const flows = (await demoApplyFlowOverlay(stored.app.id, []))
          .filter((flow) => flow.enabled)
          .map((flow) => ({
            id: flow.id,
            slug: flow.slug,
            name: flow.name,
            engine: flow.engine,
            flowJson: flow.flowJson,
            inputSchema: flow.inputSchema,
            outputSchema: flow.outputSchema,
            nodeCapabilities: flow.nodeCapabilities,
            version: flow.version,
          }));
        const bindings = stored.bindings
          .filter((binding) => binding.enabled)
          .map(({ id, flow, formId, connectorId, event, mode, condition, inputMap, outputActions, timeoutMs, retryPolicy, fallbackPolicy, sortOrder }) => ({
            id, flow, formId, connectorId, event, mode, condition, inputMap, outputActions, timeoutMs, retryPolicy, fallbackPolicy, sortOrder,
          }));
        return { data: { flows, bindings } };
      }
    }
    return this.request(`/app/${encodeURIComponent(slug)}/flows`);
  }

  /**
   * Reserve a run BEFORE executing it — the UNIQUE idempotency key is the cross-tab dedupe gate:
   * 201 {runId} when this caller won the reservation, 200 {runId, idempotent:true} on a replay.
   */
  async reserveFlowRun(
    slug: string,
    payload: {
      flowSlug: string;
      bindingId?: string;
      triggerEvent: string;
      correlationId: string;
      idempotencyKey: string;
      inputSnapshot?: Record<string, unknown>;
      formId?: string;
      responseId?: string;
      /** true = reserve as 'queued' (no execution yet); a runtime claims it later. */
      queued?: boolean;
      /**
       * Run lineage (extensible-flows plan §8.7): the reserving run's parent run and the
       * flow_call node that spawned it. Root/depth are SERVER-derived from the parent row.
       */
      parentRunId?: string;
      callNodeId?: string;
    }
  ): Promise<ApiResponse<{ runId: string; idempotent?: boolean; run: FlowRunLog }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/flow-runs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** Complete a run: transition running/queued → a terminal status per flow-run-result.schema.json. */
  async completeFlowRun(
    slug: string,
    runId: string,
    payload: { status: FlowRunStatus; result?: Record<string, unknown> | null; error?: FlowRunError | null; instanceId?: string }
  ): Promise<ApiResponse<{ run: FlowRunLog }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/flow-runs/${encodeURIComponent(runId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  /** Claimable 'queued' runs for this app (member-gated), oldest first. */
  async listQueuedAppFlowRuns(slug: string, limit?: number): Promise<ApiResponse<{ runs: FlowRunLog[] }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/flow-runs/queued${limit ? `?limit=${limit}` : ''}`);
  }

  /**
   * Claim a queued run for this app (queued→running exactly once): 200 {run, claimed:true},
   * 409 when another runtime — a browser tab or FormLogic Desktop — got there first.
   */
  async claimAppFlowRun(
    slug: string,
    runId: string,
    payload: { runtime: FlowRuntimeKind; instanceId?: string }
  ): Promise<ApiResponse<ClaimResult>> {
    return this.request(`/app/${encodeURIComponent(slug)}/flow-runs/${encodeURIComponent(runId)}/claim`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // ── Remote command relay (docs/API.md §connector:relay) ──────────────────────────────────
  // A web member enqueues a connector command for the owner's paired FormLogic Desktop runtime
  // (member + connector.<connectorId>.<command> grant gated) and reads the outcome back. The
  // desktop agent (Rust, not this client) claims/completes over /api/v1/connector-commands.

  /**
   * Enqueue a connector command for the app owner's desktop runtime. 201 {commandId, status} on a
   * fresh command; 200 {commandId, status, idempotent:true} when idempotencyKey replays an existing
   * one. 403 when the caller lacks the connector.<connectorId>.<command> grant.
   */
  async enqueueConnectorCommand(
    slug: string,
    payload: { connectorId: string; command: string; payload?: Record<string, unknown>; idempotencyKey?: string }
  ): Promise<ApiResponse<{ commandId: string; status: ConnectorCommandStatus; idempotent?: boolean }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/connector-commands`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** Read a connector command's current status/result/error (member-gated). */
  async getConnectorCommand(slug: string, commandId: string): Promise<ApiResponse<{ command: ConnectorCommand }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/connector-commands/${encodeURIComponent(commandId)}`);
  }

  /**
   * Typed service.invoke for pack-owned sandboxed screens (plan §8.3, APP-503).
   * Only operations the SERVER registry names exist (404 otherwise); each is
   * permission-gated + connector-bound server-side and returns a projection.
   */
  async invokeAppService(
    slug: string,
    operationId: string,
    input?: Record<string, unknown>
  ): Promise<ApiResponse<{ operationId: string; result: unknown }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/service-invoke/${encodeURIComponent(operationId)}`, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? {} }),
    });
  }

  // ── FormLogic Flows — workspace scope (docs/FORMLOGIC_FLOWS.md §8) ────────────────────────
  // App-independent flows owned by the signed-in user (/api/flows, /api/flow-runs); slug is
  // unique per owner across the workspace scope (enforced server-side).

  async listWorkspaceFlows(): Promise<ApiResponse<{ flows: FlowDefinition[] }>> {
    return this.request('/flows');
  }

  async listFlowBindingsForFlow(flowId: string): Promise<ApiResponse<{ bindings: FlowBinding[] }>> {
    if (this._demoMode && isDemoLocalId(flowId)) {
      return { data: { bindings: await listDemoBindingsForFlow(flowId) } };
    }
    return this.request(`/flows/${encodeURIComponent(flowId)}/bindings`);
  }

  async createWorkspaceFlow(
    data: { name: string; slug?: string; description?: string; flowJson?: WorkflowGraph; enabled?: boolean; nodeCapabilities?: string[] }
  ): Promise<ApiResponse<{ flow: FlowDefinition }>> {
    return this.request('/flows', { method: 'POST', body: JSON.stringify(data) });
  }

  async getWorkspaceFlow(flowId: string): Promise<ApiResponse<{ flow: FlowDefinition }>> {
    return this.request(`/flows/${encodeURIComponent(flowId)}`);
  }

  async updateWorkspaceFlow(
    flowId: string,
    data: Partial<{ name: string; slug: string; description: string | null; flowJson: WorkflowGraph; enabled: boolean; nodeCapabilities: string[] | null }>
  ): Promise<ApiResponse<{ flow: FlowDefinition }>> {
    return this.request(`/flows/${encodeURIComponent(flowId)}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteWorkspaceFlow(flowId: string): Promise<ApiResponse<{ success: boolean; trashed?: boolean }>> {
    return this.request(`/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE' });
  }

  /**
   * Paginated run history across EVERY flow the user owns (workspace + app), newest first.
   * appId filter: an app id, or 'workspace' for workspace-only runs.
   */
  async listMyFlowRuns(
    options?: { flowId?: string; status?: FlowRunStatus; appId?: string; page?: number; offset?: number; limit?: number }
  ): Promise<ApiResponse<{ runs: FlowRunLog[]; page: number; offset: number; limit: number; total: number }>> {
    const params = new URLSearchParams();
    if (options?.flowId) params.set('flowId', options.flowId);
    if (options?.status) params.set('status', options.status);
    if (options?.appId) params.set('appId', options.appId);
    if (options?.page) params.set('page', String(options.page));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    if (options?.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.request(`/flow-runs${query ? `?${query}` : ''}`);
  }

  /**
   * Direct children of one run (extensible-flows plan §14.4) — runs a flow_call spawned
   * from it, oldest first. 404 when the run isn't visible to the caller.
   */
  async listFlowRunChildren(
    runId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<ApiResponse<{ runs: FlowRunLog[]; total: number; limit: number; offset: number }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request(`/flow-runs/${encodeURIComponent(runId)}/children${query ? `?${query}` : ''}`);
  }

  /** Claimable 'queued' runs across every flow the user owns, oldest first. */
  async listMyQueuedFlowRuns(limit?: number): Promise<ApiResponse<{ runs: FlowRunLog[] }>> {
    return this.request(`/flow-runs/queued${limit ? `?limit=${limit}` : ''}`);
  }

  // ── Blueprints (extensible-flows plan §11/§14) ──────────────────────────────────────

  // Demo overlay: the demo account SKETCHES locally — demolocal_ blueprints live in the
  // browser (lib/demoLocal.ts mini gateway) because the server is read-only for demo.
  // Undo/proposals/materialise stay server-only and refuse honestly below.

  async listBlueprints(): Promise<ApiResponse<{ blueprints: import('../types/blueprints').Blueprint[] }>> {
    if (this._demoMode) {
      const [server, local] = await Promise.all([
        this.request<{ blueprints: import('../types/blueprints').Blueprint[] }>('/blueprints'),
        listDemoBlueprints(),
      ]);
      return { data: { blueprints: [...local.map((s) => s.row), ...(server.data?.blueprints ?? [])] } };
    }
    return this.request('/blueprints');
  }

  async createBlueprint(payload: { name: string; appId?: string }): Promise<ApiResponse<{ blueprint: import('../types/blueprints').Blueprint }>> {
    if (this._demoMode) {
      const stored = await createDemoBlueprint(payload.name, payload.appId ?? null);
      return { data: { blueprint: stored.row } };
    }
    return this.request('/blueprints', { method: 'POST', body: JSON.stringify(payload) });
  }

  async getBlueprint(blueprintId: string): Promise<ApiResponse<{ blueprint: import('../types/blueprints').Blueprint }>> {
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      const stored = await getDemoBlueprint(blueprintId);
      if (!stored) return { error: 'Diagram not found in this browser', status: 404 };
      return { data: { blueprint: { ...stored.row, elements: stored.elements } } };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}`);
  }

  async renameBlueprint(blueprintId: string, name: string): Promise<ApiResponse<{ blueprint: import('../types/blueprints').Blueprint }>> {
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      const stored = await renameDemoBlueprint(blueprintId, name);
      if (!stored) return { error: 'Diagram not found in this browser', status: 404 };
      return { data: { blueprint: stored.row } };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  }

  async deleteBlueprint(blueprintId: string): Promise<ApiResponse<{ deleted: boolean }>> {
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      await deleteDemoBlueprint(blueprintId);
      return { data: { deleted: true } };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}`, { method: 'DELETE' });
  }

  /** §11B O3 Build Timeline: the audited operation log grouped by change set, newest first. */
  async listBlueprintHistory(blueprintId: string, limit = 30): Promise<ApiResponse<{
    history: Array<{
      changeSetId: string; origin: string; actorUserId: string | null; createdAt: string;
      semanticRevision: number | null; operations: Array<{ type: string; targetId: string | null }>;
    }>;
  }>> {
    // Demo-local diagrams keep no operation log (no undo either) — an empty timeline.
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      return { data: { history: [] } };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/history?limit=${limit}`);
  }

  /** §14 undo: apply the newest change set's stored inverses as a new audited batch. */
  async undoBlueprint(blueprintId: string): Promise<ApiResponse<import('../types/blueprints').BlueprintCommitResult & { undid: string }>> {
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      return { error: 'Undo is not available for demo diagrams — they live only in this browser.' };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/undo`, { method: 'POST' });
  }

  // §12 Copilot change sets: proposals parked for approval (the canvas ghost layer).
  async listBlueprintChangeSets(blueprintId: string): Promise<ApiResponse<{
    changeSets: Array<{ id: string; origin: string; summary: string | null; baseSemanticRevision: number; operations: import('../types/blueprints').BlueprintOperation[]; createdAt: string }>;
  }>> {
    // Demo-local diagrams never carry parked proposals (no AI writes them in the demo).
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      return { data: { changeSets: [] } };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/change-sets`);
  }

  async approveBlueprintChangeSet(blueprintId: string, changeSetId: string): Promise<ApiResponse<import('../types/blueprints').BlueprintCommitResult>> {
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/change-sets/${encodeURIComponent(changeSetId)}/approve`, { method: 'POST' });
  }

  async discardBlueprintChangeSet(blueprintId: string, changeSetId: string): Promise<ApiResponse<{ discarded: boolean }>> {
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/change-sets/${encodeURIComponent(changeSetId)}/discard`, { method: 'POST' });
  }

  /** §11A D3: create the app from the diagram (concept forms → real forms, relations →
   *  linked_record fields, all attached to a NEW app; the blueprint links to it). */
  async materializeBlueprint(blueprintId: string): Promise<ApiResponse<{
    mode: 'created' | 'delta'; appId: string; appSlug: string | null;
    createdFormIds: string[]; reusedFormIds: string[]; relations: number;
    createdFlowIds: string[]; bindings: number; roles: number;
  }>> {
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      return { error: 'Demo diagrams stay in this browser — creating a real app from a diagram needs a free account.' };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/materialize`, { method: 'POST' });
  }

  /**
   * Commit one §14.3 operation batch. Semantic batches carry baseSemanticRevision —
   * a stale value returns 409 {code:'revision_conflict', currentSemanticRevision};
   * layout-only batches omit it (a drag never conflicts with a semantic edit).
   */
  async commitBlueprintOperations(
    blueprintId: string,
    batch: {
      baseSemanticRevision?: number;
      origin?: 'manual' | 'copilot' | 'launcher';
      operations: import('../types/blueprints').BlueprintOperation[];
    }
  ): Promise<ApiResponse<import('../types/blueprints').BlueprintCommitResult>> {
    // Demo-local diagram: the batch runs through the browser mini gateway. The 409
    // conflict shape mirrors the server ({code:'revision_conflict'}) so the canvas's
    // conflict handling behaves identically.
    if (this._demoMode && isDemoLocalId(blueprintId)) {
      const out = await commitDemoBlueprintOperations(blueprintId, batch);
      if (out.ok) return { data: out.result };
      if (out.code === 'revision_conflict') {
        return {
          error: { code: 'revision_conflict', currentSemanticRevision: out.currentSemanticRevision } as unknown as string,
          status: 409,
        };
      }
      return { error: out.code === 'not_found' ? 'Diagram not found in this browser' : (out.message ?? 'Invalid operation batch') };
    }
    return this.request(`/blueprints/${encodeURIComponent(blueprintId)}/operations/commit`, {
      method: 'POST',
      body: JSON.stringify(batch),
    });
  }

  /** Claim a queued run (owner scope — workspace runs + any run of a flow the user owns). */
  /**
   * Owner-scoped run reserve (POST /api/flow-runs) — workspace flow_call children ride
   * this (lineage via parentRunId/callNodeId, plan §8.7). 201 {run, created:true} |
   * 200 {run, created:false, idempotent:true} on an idempotency replay.
   */
  async reserveMyFlowRun(payload: {
    flowSlug: string;
    triggerEvent: string;
    correlationId: string;
    idempotencyKey: string;
    inputSnapshot?: Record<string, unknown>;
    parentRunId?: string;
    callNodeId?: string;
  }): Promise<ApiResponse<{ run: FlowRunLog; created: boolean; idempotent?: boolean }>> {
    return this.request('/flow-runs', { method: 'POST', body: JSON.stringify(payload) });
  }

  async claimMyFlowRun(
    runId: string,
    payload: { runtime: FlowRuntimeKind; instanceId?: string }
  ): Promise<ApiResponse<ClaimResult>> {
    return this.request(`/flow-runs/${encodeURIComponent(runId)}/claim`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** Complete a run (owner scope) — running/queued → terminal, per flow-run-result.schema.json. */
  async completeMyFlowRun(
    runId: string,
    payload: { status: FlowRunStatus; result?: Record<string, unknown> | null; error?: FlowRunError | null; instanceId?: string }
  ): Promise<ApiResponse<{ run: FlowRunLog }>> {
    return this.request(`/flow-runs/${encodeURIComponent(runId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  // ── Flow KV storage (docs/FORMLOGIC_FLOWS.md §9) ─────────────────────────────────────────
  // Owner surface: appId omitted = the user's workspace store; appId set = an app the user
  // OWNS. Caps: value ≤ 64 KiB, ≤ 500 keys per scope. Scopes are labels like 'flow:<slug>'.

  /** List a scope's entries (or every scope when scope is omitted). */
  async listFlowKv(options?: { appId?: string; scope?: string }): Promise<ApiResponse<{ entries: FlowKvEntry[] }>> {
    const params = new URLSearchParams();
    if (options?.appId) params.set('appId', options.appId);
    if (options?.scope) params.set('scope', options.scope);
    const query = params.toString();
    return this.request(`/flow-kv${query ? `?${query}` : ''}`);
  }

  /** Read one key (404 → success:false when absent). */
  async getFlowKv(scope: string, k: string, appId?: string): Promise<ApiResponse<{ entry: FlowKvEntry }>> {
    const params = new URLSearchParams({ scope, k });
    if (appId) params.set('appId', appId);
    return this.request(`/flow-kv?${params.toString()}`);
  }

  /** Upsert one key. */
  async putFlowKv(
    payload: { scope: string; k: string; v: unknown; appId?: string }
  ): Promise<ApiResponse<{ entry: FlowKvEntry }>> {
    return this.request('/flow-kv', { method: 'PUT', body: JSON.stringify(payload) });
  }

  /** Delete one key. */
  async deleteFlowKv(scope: string, k: string, appId?: string): Promise<ApiResponse<{ success: boolean }>> {
    const params = new URLSearchParams({ scope, k });
    if (appId) params.set('appId', appId);
    return this.request(`/flow-kv?${params.toString()}`, { method: 'DELETE' });
  }

  /** Runtime KV read (member-gated; the store is shared app-wide, keyed by the app owner). */
  async getAppFlowKv(
    slug: string,
    options?: { scope?: string; k?: string }
  ): Promise<ApiResponse<{ entry?: FlowKvEntry; entries?: FlowKvEntry[] }>> {
    const params = new URLSearchParams();
    if (options?.scope) params.set('scope', options.scope);
    if (options?.k) params.set('k', options.k);
    const query = params.toString();
    return this.request(`/app/${encodeURIComponent(slug)}/flow-kv${query ? `?${query}` : ''}`);
  }

  /** Runtime KV upsert (member-gated, rate-limited like flow-runs). */
  async putAppFlowKv(
    slug: string,
    payload: { scope: string; k: string; v: unknown }
  ): Promise<ApiResponse<{ entry: FlowKvEntry }>> {
    return this.request(`/app/${encodeURIComponent(slug)}/flow-kv`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  // ── Form flow-bindings (workspace scope on standalone forms — /api/forms/{id}) ────────────
  // Bind the owner's WORKSPACE flows to a form's events (e.g. 'form.submitted'); the server
  // enqueues a 'queued' run per enabled binding after each successful submission (max 5).

  async listFormFlowBindings(formId: string): Promise<ApiResponse<{ bindings: FlowBinding[] }>> {
    // Demo-local forms never exist server-side — return empty rows (the demo overlay's
    // own locally-created bindings still merge in at the call sites) instead of a 404.
    if (this._demoMode && isDemoLocalId(formId)) {
      return { data: { bindings: [] } };
    }
    return this.request(`/forms/${encodeURIComponent(formId)}/flow-bindings`);
  }

  async createFormFlowBinding(formId: string, data: Record<string, unknown>): Promise<ApiResponse<{ binding: FlowBinding }>> {
    return this.request(`/forms/${encodeURIComponent(formId)}/flow-bindings`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateFormFlowBinding(formId: string, bindingId: string, data: Record<string, unknown>): Promise<ApiResponse<{ binding: FlowBinding }>> {
    return this.request(`/forms/${encodeURIComponent(formId)}/flow-bindings/${encodeURIComponent(bindingId)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteFormFlowBinding(formId: string, bindingId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/forms/${encodeURIComponent(formId)}/flow-bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' });
  }

  async lookupOwnedRecords(
    formId: string,
    options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; offset?: number; ids?: string[] }
  ): Promise<ApiResponse<{ records: LinkedRecord[]; count: number }>> {
    const params = new URLSearchParams();
    params.set('targetFormId', options.targetFormId);
    if (options.displayFieldIds?.length) params.set('displayFieldIds', options.displayFieldIds.join(','));
    if (options.searchFieldIds?.length) params.set('searchFieldIds', options.searchFieldIds.join(','));
    if (options.q) params.set('q', options.q);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.ids?.length) params.set('ids', options.ids.join(','));
    return this.request(`/forms/${formId}/lookup?${params.toString()}`);
  }

  // Related records (inverse relations)
  async getRelatedRecords(slug: string, formId: string, responseId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ related: Record<string, RelatedRecordGroup> }>> {
    // Demo-local records exist only in this browser — the server 404s on their ids, and nothing
    // server-side can reference them. Empty related-groups → the panel's quiet empty state.
    if (this._demoMode && isDemoLocalId(responseId)) {
      return { data: { related: {} } };
    }
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}/related${qs ? `?${qs}` : ''}`);
  }

  /** Owner-scoped inverse related records (the builder responses page). Same shape as
   *  getRelatedRecords, but authorized by form ownership rather than an app membership. */
  async getOwnerRelatedRecords(formId: string, responseId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ related: Record<string, RelatedRecordGroup> }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this.request(`/forms/${formId}/responses/${responseId}/related${qs ? `?${qs}` : ''}`);
  }

  // Get app responses with resolve option
  async getAppResponsesResolved(slug: string, formId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    if (this._demoMode && await getDemoAppBySlug(slug)) {
      return this.getAppResponses(slug, formId, options);
    }
    const params = new URLSearchParams();
    params.set('resolve', 'linked');
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const res = await this.request<{ responses: unknown[]; count: number; scope: string }>(`/app/${slug}/forms/${formId}/responses?${params.toString()}`);
    return this._demoMode ? this._mergeDemoResponses(res, formId) : res;
  }

  // Get single app response with resolve
  async getAppResponseByIdResolved(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode && isDemoLocalId(responseId)) {
      const response = await getDemoRecord(formId, responseId);
      return response ? { data: { response } } : { error: 'Record not found' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}?resolve=linked`);
  }

  // Webhook endpoints
  async getWebhooks(formId: string): Promise<ApiResponse<{ webhooks: Webhook[] }>> {
    return this.request(`/forms/${formId}/webhooks`);
  }

  async createWebhook(formId: string, data: { url: string; events: string[]; description?: string }): Promise<ApiResponse<{ webhook: Webhook & { secret: string } }>> {
    return this.request(`/forms/${formId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateWebhook(formId: string, webhookId: string, data: Partial<{ url: string; events: string[]; is_active: boolean; description: string }>): Promise<ApiResponse<{ webhook: Webhook }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteWebhook(formId: string, webhookId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  }

  async getWebhookDeliveries(formId: string, webhookId: string): Promise<ApiResponse<{ deliveries: WebhookDelivery[] }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}/deliveries`);
  }

  // Pack management. catalogId/versionId (from downloadPack) link the install to
  // its marketplace entry so "Installed" state and update checks work.
  // SAFE-001: approvedConnectorGrants is REQUIRED — the server fails closed (400
  // grant_review_required) without it. Send the reviewed set; [] approves none.
  async importPack(
    pack: PackData,
    opts: { catalogId?: string; versionId?: string; approvedConnectorGrants: string[] },
  ): Promise<ApiResponse<PackImportResult>> {
    return this.request('/packs/import', {
      method: 'POST',
      body: JSON.stringify({
        pack,
        catalogId: opts.catalogId,
        versionId: opts.versionId,
        approvedConnectorGrants: opts.approvedConnectorGrants,
      }),
    });
  }

  /** Preview a pack's capabilities + server-computed trust BEFORE installing (capability review). */
  async describePack(body: { pack?: unknown; package?: unknown; signature?: string; alg?: string }): Promise<ApiResponse<PackDescribeResult>> {
    return this.request('/packs/describe', { method: 'POST', body: JSON.stringify(body) });
  }

  /**
   * SAFE-001: preview a binary .formlogic ARCHIVE's capabilities + trust BEFORE installing — the server
   * parses + signature-verifies it without importing, so an archive gets the same review as JSON sources.
   */
  async describePackArchive(file: File): Promise<ApiResponse<PackDescribeResult>> {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) fetchHeaders['X-CSRF-Token'] = csrfToken;
      const response = await fetch(`${this.baseUrl}/packs/describe`, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to review the application package' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  /** Download a whole app as a full .formlogic ARCHIVE (ZIP: manifest + pack + quickjs + signature). */
  async exportAppPackageArchive(appId: string, filename = 'application'): Promise<void> {
    // Raw fetch bypasses request() — app exports can embed seeded records, so acting mode refuses.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const response = await fetch(`${this.baseUrl}/apps/${appId}/export/package`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to export application package';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${filename}.formlogic`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  /**
   * Owner data export for an app: 'sqlite' = zip of per-form SQLite snapshots +
   * schema.json + uploads; 'mysql' / 'mssql' = a relational .sql dump (forms as
   * tables, records as rows). Triggers a browser download.
   */
  async exportAppData(appId: string, format: 'sqlite' | 'mysql' | 'mssql', filename = 'app'): Promise<void> {
    // Raw fetch bypasses request() — record data is never exposed to acting admins.
    if (this.isAdminActing()) throw new Error(ApiClient.ACTING_BLOCKED_MESSAGE);
    const response = await fetch(`${this.baseUrl}/apps/${appId}/export/data?format=${format}`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to export app data';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = format === 'sqlite' ? `${filename}-data.zip` : `${filename}-${format}.sql`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  /** Import a .formlogic ARCHIVE (ZIP) — the server verifies + extracts it and stamps trust.
   *  SAFE-001: the reviewed connector-grant array is required (rides as a JSON multipart field). */
  async importApplicationPackage(file: File, approvedConnectorGrants: string[]): Promise<ApiResponse<ApplicationPackageImportResult>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('approvedConnectorGrants', JSON.stringify(approvedConnectorGrants));
    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) fetchHeaders['X-CSRF-Token'] = csrfToken;
      const response = await fetch(`${this.baseUrl}/application-packages/import`, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to import application package' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  /**
   * Import a signed Application Package ENVELOPE (JSON). The whole envelope is sent so the SERVER verifies
   * the signature and stamps trust — a client-side trust claim is never trusted.
   * SAFE-001: the reviewed connector-grant array is required (the server fails closed without it).
   */
  async importSignedPackage(envelope: Record<string, unknown>, approvedConnectorGrants: string[]): Promise<ApiResponse<ApplicationPackageImportResult>> {
    return this.request('/application-packages/import', {
      method: 'POST',
      body: JSON.stringify({ ...envelope, approvedConnectorGrants }),
    });
  }

  /** Export a whole app (forms + screens + scripts + roles) as a self-contained pack. */
  async exportApp(appId: string): Promise<ApiResponse<{ pack: PackData }>> {
    return this.request(`/apps/${appId}/export`);
  }

  /** Bundled sample apps for the "Try a sample app" gallery. */
  async getSampleApps(): Promise<ApiResponse<{ samples: Array<{ id: string; name: string; description: string; formCount: number }> }>> {
    return this.request('/sample-apps');
  }
  /** Install a bundled sample app into the current account (a fresh copy). */
  async installSampleApp(id: string): Promise<ApiResponse<{ success: boolean; apps: Array<{ id: string; name: string }>; forms: Array<{ id: string; title: string }> }>> {
    return this.request(`/sample-apps/${id}/install`, { method: 'POST' });
  }

  async getInstalledPacks(): Promise<ApiResponse<{ installations: PackInstallation[] }>> {
    return this.request('/packs/installed');
  }

  async uninstallPack(installationId: string): Promise<ApiResponse<PackUninstallResult>> {
    return this.request(`/packs/${installationId}`, { method: 'DELETE' });
  }

  // Pack Marketplace
  async browsePacks(params?: { search?: string; category?: string; tag?: string; sort?: string; page?: number; limit?: number }): Promise<ApiResponse<PackCatalogBrowseResult>> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.category) qs.set('category', params.category);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.request(`/packs/catalog${q ? `?${q}` : ''}`);
  }

  async getPackFacets(): Promise<ApiResponse<PackFacets>> {
    return this.request('/packs/catalog/facets');
  }

  async getPackDetail(slug: string): Promise<ApiResponse<{ pack: CatalogPack & { versions: PackVersionInfo[]; formTitles?: string[]; appNames?: string[] } }>> {
    return this.request(`/packs/catalog/${slug}`);
  }

  async publishPack(data: { pack: PackData; name: string; description?: string; tags?: string[]; icon?: string; category?: string; visibility?: string; version?: string; changelog?: string; slug?: string }): Promise<ApiResponse<{ success: boolean; catalogId: string; versionId: string; slug: string }>> {
    return this.request('/packs/catalog', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async publishPackVersion(slug: string, data: { pack: PackData; version: string; changelog?: string }): Promise<ApiResponse<{ success: boolean; versionId: string; version: string }>> {
    return this.request(`/packs/catalog/${slug}/versions`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePackMeta(slug: string, meta: Partial<{ name: string; description: string; icon: string; tags: string[]; category: string; visibility: string }>): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}`, {
      method: 'PUT',
      body: JSON.stringify(meta),
    });
  }

  async archivePack(slug: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}`, { method: 'DELETE' });
  }

  async getMyPacks(): Promise<ApiResponse<{ packs: CatalogPack[] }>> {
    return this.request('/packs/catalog/mine');
  }

  async downloadPack(slug: string, versionId?: string): Promise<ApiResponse<{ pack: PackData; version: string; catalogId: string; versionId: string }>> {
    const qs = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
    return this.request(`/packs/catalog/${slug}/download${qs}`);
  }

  async uploadPackZip(file: File): Promise<ApiResponse<{ success: boolean; pack: PackData; formCount: number; appCount: number }>> {
    const url = `${this.baseUrl}/packs/catalog/upload`;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload pack' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async seedPacks(packs: Array<{ name: string; description?: string; icon?: string; tags?: string[]; category?: string; pack: PackData }>): Promise<ApiResponse<{ success: boolean; seeded: number }>> {
    return this.request('/packs/catalog/seed', {
      method: 'POST',
      body: JSON.stringify({ packs }),
    });
  }

  // Pack Ratings
  async ratePack(slug: string, rating: number, review?: string): Promise<ApiResponse<{ success: boolean; rating: { id: string; rating: number; review: string | null } }>> {
    return this.request(`/packs/catalog/${slug}/ratings`, {
      method: 'POST',
      body: JSON.stringify({ rating, review }),
    });
  }

  async getPackRatings(slug: string, page?: number): Promise<ApiResponse<PackRatingsResult>> {
    const qs = page ? `?page=${page}` : '';
    return this.request(`/packs/catalog/${slug}/ratings${qs}`);
  }

  async deletePackRating(slug: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}/ratings`, { method: 'DELETE' });
  }

  // File upload for form responses
  async uploadFile(formId: string, file: File, fieldId?: string): Promise<ApiResponse<UploadedFileMetadata>> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    const url = `${this.baseUrl}/forms/${formId}/upload`;
    const formData = new FormData();
    formData.append('file', file);
    if (fieldId) formData.append('fieldId', fieldId);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload file' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async uploadAppFile(slug: string, formId: string, file: File, fieldId?: string): Promise<ApiResponse<UploadedFileMetadata>> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    const url = `${this.baseUrl}/app/${slug}/forms/${formId}/upload`;
    const formData = new FormData();
    formData.append('file', file);
    if (fieldId) formData.append('fieldId', fieldId);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload file' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // CSV import
  async parseImportCsv(formId: string, file: File): Promise<ApiResponse<CsvParseResult>> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    const url = `${this.baseUrl}/forms/${formId}/responses/import`;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to parse CSV' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async importCsv(formId: string, file: File, columnMapping: Record<string, string>): Promise<ApiResponse<CsvImportResult>> {
    // Raw fetch bypasses request() — enforce the acting-mode boundary explicitly.
    if (this.isAdminActing()) return { error: ApiClient.ACTING_BLOCKED_MESSAGE, status: 403 };
    const url = `${this.baseUrl}/forms/${formId}/responses/import`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('columnMapping', JSON.stringify(columnMapping));

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to import CSV' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // Audit verification
  async verifyAuditIntegrity(): Promise<ApiResponse<AuditVerifyResult>> {
    return this.request('/admin/audit/verify');
  }

  // Form version endpoints
  async getFormVersions(formId: string): Promise<ApiResponse<{ versions: FormVersion[] }>> {
    return this.request(`/forms/${formId}/versions`);
  }

  async getFormVersion(formId: string, version: number): Promise<ApiResponse<{ version: FormVersion }>> {
    return this.request(`/forms/${formId}/versions/${version}`);
  }

  async restoreFormVersion(formId: string, version: number, force = false): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${formId}/versions/${version}/restore`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  }

  // API Key management
  async getApiKeys(): Promise<ApiResponse<{ keys: ApiKey[] }>> {
    return this.request('/api-keys');
  }

  async createApiKey(data: { name: string; scopes: string[]; formIds?: string[]; expiresAt?: string }): Promise<ApiResponse<{ key: ApiKeyCreated }>> {
    return this.request('/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async revokeApiKey(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/api-keys/${id}`, {
      method: 'DELETE',
    });
  }

  // Linked FormLogic Desktop installs
  async getDesktopConnections(): Promise<ApiResponse<{ connections: DesktopConnection[] }>> {
    return this.request('/desktop-connections');
  }

  async revokeDesktopConnection(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/desktop-connections/${id}`, { method: 'DELETE' });
  }

  // ── Desktop AI E2E tunnel relay (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5, Phase 1) ──
  // The browser tunnel client (client-runtime/desktop/desktopTunnel.ts) seals every
  // sensitive body end-to-end to the desktop's X25519 identity key; these routes carry
  // only routing metadata + sealed envelopes. Typed relay errors (plan §5.8) ride the
  // standard {error:true, code, message} envelope and surface via DesktopAiApiResponse.code.

  /** GET /api/desktop/ai/pubkey — the target desktop's long-term X25519 public key (TOFU-pinned by the tunnel client). */
  async getDesktopAiPubkey(instanceId?: string): Promise<DesktopAiApiResponse<DesktopAiPubkeyResponse>> {
    const query = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.desktopAiRequest(`/desktop/ai/pubkey${query}`);
  }

  /** POST /api/desktop/ai/requests — enqueue a sealed AI request onto the desktop's FIFO lane. */
  async enqueueDesktopAiRequest(body: DesktopAiEnqueueBody): Promise<DesktopAiApiResponse<DesktopAiEnqueueResponse>> {
    return this.desktopAiRequest('/desktop/ai/requests', { method: 'POST', body: JSON.stringify(body) });
  }

  /** GET /api/desktop/ai/requests/{id} — status + read-time queue position (requesting user only). */
  async getDesktopAiRequest(requestId: string): Promise<DesktopAiApiResponse<DesktopAiRequestStatusResponse>> {
    return this.desktopAiRequest(`/desktop/ai/requests/${encodeURIComponent(requestId)}`);
  }

  /** POST /api/desktop/ai/requests/{id}/input — a sealed inbound frame (e.g. a tool-approval answer). */
  async postDesktopAiInput(requestId: string, envelope: string): Promise<DesktopAiApiResponse<{ accepted: boolean }>> {
    return this.desktopAiRequest(`/desktop/ai/requests/${encodeURIComponent(requestId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ envelope }),
    });
  }

  // ── Site AI preferences + plan allowances (plan Phase 2, §5.5/§6) ────────────
  // Typed §5.8 codes (e.g. ai_allowance_exceeded) ride through via .code; the
  // {data: …} response envelope is unwrapped (a pre-Phase-2 backend that returns
  // the fields top-level still parses).

  /** GET /api/ai/preferences — the signed-in user's AI source + chat tool mode (+ usage when metered). */
  async getAiPreferences(): Promise<DesktopAiApiResponse<AiPreferencesState>> {
    const res = await this.desktopAiRequest<unknown>('/ai/preferences');
    if (res.error) return desktopAiErrorOnly(res);
    return { data: normalizeAiPreferences(res.data), status: res.status };
  }

  /** PUT /api/ai/preferences — save the AI source + chat tool mode. Returns the saved state. */
  async putAiPreferences(input: AiPreferencesInput): Promise<DesktopAiApiResponse<AiPreferencesState>> {
    const res = await this.desktopAiRequest<unknown>('/ai/preferences', { method: 'PUT', body: JSON.stringify(input) });
    if (res.error) return desktopAiErrorOnly(res);
    return { data: normalizeAiPreferences(res.data), status: res.status };
  }

  /** Admin: GET /api/admin/allowances — per-plan monthly AI/credit allowances (plan_allowances). */
  async adminListAllowances(): Promise<DesktopAiApiResponse<{ allowances: PlanAllowance[] }>> {
    const res = await this.desktopAiRequest<unknown>('/admin/allowances');
    if (res.error) return desktopAiErrorOnly(res);
    return { data: { allowances: normalizePlanAllowances(res.data) }, status: res.status };
  }

  /** Admin: PUT /api/admin/allowances — update ONE plan+metric allowance (audited server-side). */
  async adminPutAllowance(input: PlanAllowanceInput): Promise<DesktopAiApiResponse<{ allowance: PlanAllowance }>> {
    const res = await this.desktopAiRequest<unknown>('/admin/allowances', { method: 'PUT', body: JSON.stringify(input) });
    if (res.error) return desktopAiErrorOnly(res);
    const body = recordValue(res.data);
    const updated = normalizePlanAllowance(recordValue(body?.data) ?? body?.allowance ?? body);
    return { data: { allowance: updated ?? { ...input } }, status: res.status };
  }

  // ── Chat tool grants + catalog (plan Phase 6, §5.4) ────────────────────────
  // The browser mints ONE 10-minute grant per chat turn and sends it inside the sealed
  // tunnel envelope; the desktop presents it to /api/ai/chat-tools/execute, which
  // verifies the mint/introspect pair + the grant's bound desktop instance.

  /** POST /api/ai/chat-tool-grant — mint a chat-tool grant bound to this user (+ desktop instance). */
  async mintChatToolGrant(instanceId?: string): Promise<DesktopAiApiResponse<ChatToolGrant>> {
    const res = await this.desktopAiRequest<unknown>('/ai/chat-tool-grant', {
      method: 'POST',
      body: JSON.stringify(instanceId ? { instanceId } : {}),
    });
    if (res.error) return desktopAiErrorOnly(res);
    const grant = normalizeChatToolGrant(res.data);
    if (!grant) return { error: 'The grant response was not understood.', status: res.status };
    return { data: grant, status: res.status };
  }

  /** GET /api/ai/chat-tools/catalog — the v1 chat tool subset (additive/read + guarded writes). */
  async getChatToolsCatalog(): Promise<DesktopAiApiResponse<{ tools: ChatToolDescriptor[] }>> {
    const res = await this.desktopAiRequest<unknown>('/ai/chat-tools/catalog');
    if (res.error) return desktopAiErrorOnly(res);
    return { data: { tools: normalizeChatToolCatalog(res.data) }, status: res.status };
  }

  // ── Flow execution location: cloud runs + the desktop flow relay lane ────────────────
  // (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7, Phase 5.)
  // POST /api/flows/{id}/run executes synchronously on FormLogic Cloud (credit-metered).
  // /api/desktop/flows/* is the E2E flow relay lane mirroring the Desktop-AI one above:
  // the browser seals the run inputs to the desktop's X25519 identity (see
  // client-runtime/desktop/desktopFlowRun.ts); the backend stores/relays only routing
  // metadata + sealed blobs. Typed failures (plan §5.8) surface via .code like the AI lane.

  /**
   * POST /api/flows/{id}/run — a synchronous FormLogic Cloud run. Typed failures:
   * `flow_credits_exceeded`, `cloud_unsupported_node` (offenders in details.nodes),
   * `use_browser_runner` (409 — the flow's executionLocation is still 'auto').
   */
  async runFlowCloud(flowId: string, inputs?: Record<string, unknown>): Promise<CloudFlowRunApiResponse> {
    const res = await this.requestWithMeta(`/flows/${encodeURIComponent(flowId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ inputs: inputs ?? {} }),
    });
    if (res.ok) {
      const inner = recordValue(res.body?.data) ?? recordValue(res.body?.run) ?? res.body ?? {};
      return { data: normalizeCloudFlowRunResult(inner), status: res.status };
    }
    const code = typeof res.body?.code === 'string' ? res.body.code : undefined;
    const message = typeof res.body?.message === 'string' ? res.body.message : res.networkError;
    const details = recordValue(res.body?.details);
    const rawNodes = Array.isArray(details?.nodes) ? details.nodes : Array.isArray(res.body?.nodes) ? res.body.nodes : null;
    const nodes = rawNodes?.filter((n): n is string => typeof n === 'string');
    return {
      error: message ?? `Server error (${res.status})`,
      status: res.status || undefined,
      ...(code ? { code } : {}),
      ...(nodes && nodes.length > 0 ? { details: { nodes } } : {}),
    };
  }

  /** POST /api/desktop/flows/run — enqueue a sealed flow run onto the desktop's flow lane. */
  async enqueueDesktopFlowRun(body: DesktopFlowRunEnqueueBody): Promise<DesktopAiApiResponse<DesktopFlowRunEnqueueResponse>> {
    const res = await this.desktopAiRequest<unknown>('/desktop/flows/run', { method: 'POST', body: JSON.stringify(body) });
    if (res.error) return desktopAiErrorOnly(res);
    const body2 = recordValue(res.data);
    const inner = recordValue(body2?.data) ?? body2 ?? {};
    return { data: normalizeDesktopFlowRunEnqueue(inner), status: res.status };
  }

  /** GET /api/desktop/flows/runs/{id} — status + read-time queue position + sealed result (requesting user only). */
  async getDesktopFlowRun(requestId: string): Promise<DesktopAiApiResponse<DesktopFlowRunStatus>> {
    const res = await this.desktopAiRequest<unknown>(`/desktop/flows/runs/${encodeURIComponent(requestId)}`);
    if (res.error) return desktopAiErrorOnly(res);
    const body = recordValue(res.data);
    const inner = recordValue(body?.data) ?? recordValue(body?.run) ?? body ?? {};
    return { data: normalizeDesktopFlowRunStatus(inner), status: res.status };
  }

  // Connector routing (ROUTE-001): connector→app(+desktop) assignments — which ONE
  // machine services a connector's relay commands when several desktops are linked.
  async getConnectorAssignments(): Promise<ApiResponse<ConnectorAssignments>> {
    return this.request('/connector-assignments');
  }

  async putConnectorAssignment(payload: {
    connectorId: string;
    appId: string | null;
    desktopConnectionId?: string | null;
  }): Promise<ApiResponse<ConnectorAssignments>> {
    return this.request('/connector-assignments', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  // ── Broadcast notices (signed-in dashboards poll this) ──────────────────────

  async getNotices(): Promise<ApiResponse<{ notices: AdminNotice[]; maintenance?: boolean; message?: string }>> {
    return this.request('/notices');
  }

  // ── Admin panel (platform administrators only) ──────────────────────────────

  async adminOverview(): Promise<ApiResponse<AdminOverview>> {
    return this.request('/admin/overview');
  }

  async adminListUsers(search = '', page = 1, limit = 25): Promise<ApiResponse<{ users: AdminUser[]; total: number; page: number; pages: number }>> {
    // Keep `limit` in lockstep with the caller's table pageSize — the server
    // slices pages by THIS value, the table computes page math from ITS value,
    // and a mismatch renders oversized first pages + wrong page counts.
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    return this.request(`/admin/users?${params.toString()}`);
  }

  async adminGetUser(id: string): Promise<ApiResponse<{ user: AdminUserDetail }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}`);
  }

  async adminSetAdmin(id: string, isAdmin: boolean): Promise<ApiResponse<{ success: boolean; isAdmin: boolean }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/admin`, { method: 'POST', body: JSON.stringify({ isAdmin }) });
  }

  /** Lockout recovery: switch a user's two-factor auth OFF (they re-enroll themselves).
   *  Step-up: the acting admin confirms with their OWN password. */
  async adminResetMfa(id: string, password: string): Promise<ApiResponse<{ success: boolean; mfaEnabled: boolean }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/mfa/reset`, { method: 'POST', body: JSON.stringify({ password }) });
  }

  /** Set (or generate) a user's password; their sessions are revoked. The temp password is shown ONCE. */
  async adminResetPassword(id: string, password?: string): Promise<ApiResponse<{ success: boolean; tempPassword?: string }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    });
  }

  /** Change a user's email address (sessions revoked). */
  async adminUpdateEmail(id: string, email: string): Promise<ApiResponse<{ success: boolean; email: string }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/email`, {
      method: 'PUT',
      body: JSON.stringify({ email }),
    });
  }

  /** The user's payment ledger + plan/complimentary state. */
  async adminListPayments(id: string): Promise<ApiResponse<{
    payments: Array<{ id: string; provider: string; orderId: string; captureId: string | null; amountCents: number; currency: string; months: number; status: string; createdAt: string }>;
    plan: string;
    cloudUntil: string | null;
    complimentary: boolean;
  }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/payments`);
  }

  /** Complimentary access: the account stays active with no payments required. */
  async adminSetComplimentary(id: string, enabled: boolean): Promise<ApiResponse<{ success: boolean; complimentary: boolean }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/complimentary`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  /** Permanently erase an account + ALL its data. confirmEmail must match the target exactly. */
  async adminDeleteUser(id: string, confirmEmail: string): Promise<ApiResponse<{ status: string; message?: string }>> {
    return this.request(`/admin/users/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ confirmEmail }),
    });
  }

  async adminGetForm(id: string): Promise<ApiResponse<{ form: Record<string, unknown> & { responseCount?: number | null }; ownerId?: string }>> {
    return this.request(`/admin/forms/${encodeURIComponent(id)}`);
  }

  async adminUpdateForm(id: string, input: Record<string, unknown>): Promise<ApiResponse<{ form: Record<string, unknown> }>> {
    return this.request(`/admin/forms/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async adminGetApp(id: string): Promise<ApiResponse<{ app: Record<string, unknown>; ownerId?: string; forms: Array<{ formId: string; displayName?: string; formStatus?: string; responseCount?: number | null }>; flows: Array<Record<string, unknown>>; bindings: Array<Record<string, unknown>> }>> {
    return this.request(`/admin/apps/${encodeURIComponent(id)}`);
  }

  async adminUpdateApp(id: string, input: Record<string, unknown>): Promise<ApiResponse<{ app: Record<string, unknown> }>> {
    return this.request(`/admin/apps/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async adminGetFlow(id: string): Promise<ApiResponse<{ flow: Record<string, unknown>; ownerId?: string }>> {
    return this.request(`/admin/flows/${encodeURIComponent(id)}`);
  }

  async adminUpdateFlow(id: string, input: Record<string, unknown>): Promise<ApiResponse<{ flow: Record<string, unknown> }>> {
    return this.request(`/admin/flows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async adminGetMaintenance(): Promise<ApiResponse<{ maintenance: MaintenanceStatus; onlineUsers: number }>> {
    return this.request('/admin/maintenance');
  }

  async adminSetMaintenance(enabled: boolean, message?: string): Promise<ApiResponse<{ maintenance: MaintenanceStatus }>> {
    return this.request('/admin/maintenance', { method: 'PUT', body: JSON.stringify({ enabled, message }) });
  }

  async adminBootSessions(): Promise<ApiResponse<{ success: boolean; epoch: number }>> {
    return this.request('/admin/boot-sessions', { method: 'POST', body: JSON.stringify({}) });
  }

  async adminListNotices(): Promise<ApiResponse<{ notices: AdminNotice[] }>> {
    return this.request('/admin/notices');
  }

  async adminCreateNotice(message: string, level: string, audience: string, expiresMinutes?: number): Promise<ApiResponse<{ notice: AdminNotice }>> {
    return this.request('/admin/notices', { method: 'POST', body: JSON.stringify({ message, level, audience, expiresMinutes }) });
  }

  async adminRevokeNotice(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/admin/notices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async adminUpgradeStatus(): Promise<ApiResponse<AdminUpgradeStatus>> {
    return this.request('/admin/upgrade/status');
  }

  /** Upload a release zip for the upgrade wizard (multipart — raw fetch like the other uploads). */
  async adminUpgradeUpload(file: File): Promise<ApiResponse<{ staged: AdminStagedPackage }>> {
    try {
      const formData = new FormData();
      formData.append('package', file);
      const headers: Record<string, string> = {};
      const csrf = this.getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(`${this.baseUrl}/admin/upgrade/upload`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: formData,
      });
      if (res.status === 401) { this.handleUnauthorized(); return { error: 'Session expired', status: 401 }; }
      const body = await res.json().catch(() => null);
      if (!res.ok) return { error: body?.message || `Upload failed (HTTP ${res.status})`, status: res.status };
      return { data: body };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Upload failed' };
    }
  }

  /** Apply is bound to the EXACT reviewed package (review FL-008): id + digest ride along. */
  async adminUpgradeApply(packageId: string, digest: string, keepMaintenanceOn = false): Promise<ApiResponse<{ ok: boolean; fromVersion: string; toVersion: string; backupId: string; journal: string[] }>> {
    return this.request('/admin/upgrade/apply', { method: 'POST', body: JSON.stringify({ confirm: true, keepMaintenanceOn, packageId, digest }) });
  }

  async adminUpgradeRollback(backupId: string): Promise<ApiResponse<{ ok: boolean; restoredVersion: string; journal: string[] }>> {
    return this.request('/admin/upgrade/rollback', { method: 'POST', body: JSON.stringify({ backupId, confirm: true }) });
  }

  async adminUpgradeRestoreDb(backupId: string): Promise<ApiResponse<{ ok: boolean; statements: number }>> {
    return this.request('/admin/upgrade/restore-db', { method: 'POST', body: JSON.stringify({ backupId, confirm: 'RESTORE-DATABASE' }) });
  }

  async adminUpgradeExportDb(): Promise<ApiResponse<{ ok: boolean; backupId: string }>> {
    return this.request('/admin/upgrade/export-db', { method: 'POST', body: JSON.stringify({}) });
  }

  async adminUpgradeDiscard(): Promise<ApiResponse<{ success: boolean }>> {
    return this.request('/admin/upgrade/package', { method: 'DELETE' });
  }
}

// Types
interface User {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  /** IANA timezone the user prefers record times shown in ('' / undefined = unset). */
  timezone?: string;
  /** True when this is the shared public "Demo" account (drives the demo banner). */
  isDemo?: boolean;
  /** Platform administrator (unlocks the /admin panel). */
  isAdmin?: boolean;
  /** Two-factor authentication switched on (drives the Settings card + signup nudge). */
  mfaEnabled?: boolean;
}

// ── Admin panel types ─────────────────────────────────────────────────────────

export interface MaintenanceStatus {
  enabled: boolean;
  message: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface AdminNotice {
  id: string;
  message: string;
  level: 'info' | 'success' | 'warning';
  audience: 'online' | 'all';
  createdBy?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  active: boolean;
}

export interface AdminOverview {
  stats: {
    users: number;
    admins: number;
    onlineUsers: number;
    apps: number;
    forms: number;
    flows: number;
    responses: number;
    signups7d: number;
  };
  maintenance: MaintenanceStatus;
  version: string;
  sessionEpoch: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name?: string | null;
  plan: string;
  cloudUntil?: string | null;
  isAdmin: boolean;
  isDemo: boolean;
  createdAt?: string | null;
  lastSeenAt?: string | null;
  online: boolean;
  appsCount?: number;
  formsCount?: number;
  flowsCount?: number;
  responsesCount?: number;
}

export interface AdminUserDetail extends AdminUser {
  /** Two-factor auth switched on — shows the lockout-recovery "Reset 2FA" control. */
  mfaEnabled?: boolean;
  apps: Array<{ id: string; name: string; slug?: string | null; status?: string | null; createdAt?: string; formCount: number; flowCount: number; bindingCount: number; memberCount: number }>;
  forms: Array<{ id: string; title: string; status?: string | null; createdAt?: string; updatedAt?: string; responseCount: number | null; apps?: string | null }>;
  flows: Array<{ id: string; appId?: string | null; appName?: string | null; name: string; slug: string; enabled: boolean; version: number; updatedAt?: string }>;
}

export interface AdminStagedPackage {
  packageId: string;
  digest: string;
  version: string;
  integrity: 'signed' | 'unsigned-dev-override' | 'verified' | 'unverified';
  verifiedFiles: number;
  currentVersion: string;
  isDowngrade: boolean;
  stagedAt: string;
  state?: 'verified' | 'applying' | 'failed';
  error?: string;
}

export interface AdminUpgradeStatus {
  currentVersion: string;
  layout: { apiRoot: string; webRoot: string | null; mode: string; supported: boolean };
  staged: AdminStagedPackage | null;
  backups: Array<{ id: string; at?: string | null; version?: string | null; manual: boolean; hasCode: boolean; hasDatabase: boolean; sizeBytes: number }>;
  history: Array<{ action: string; at: string; by?: string; fromVersion?: string; toVersion?: string; backupId?: string }>;
  maintenance: MaintenanceStatus;
}

interface FormResponse {
  id: string;
  answers: Record<string, unknown>;
  status: 'draft' | 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'archived';
  submittedAt: string;
  updatedAt?: string;
  metadata?: {
    userAgent?: string;
    referrer?: string;
    completionTime?: number;
    ipAddress?: string;
    /** Accept-Language of the submitting browser (e.g. "en-AU,en;q=0.9"). */
    language?: string;
    /** Account id of a signed-in submitter (server-derived, never client-supplied). */
    submittedByUserId?: string;
  };
}

interface FormAnalytics {
  totalResponses: number;
  totalViews?: number;
  totalStarts?: number;
  completionRate: number;
  averageCompletionTime: number;
  responsesByDate: Array<{ date: string; count: number }>;
  /** Most recent submission (offsetless UTC MySQL datetime); null with no responses. */
  lastResponseAt?: string | null;
}

interface AIStatus {
  available: boolean;
  message: string;
}

interface AIGeneratedField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  properties?: Record<string, unknown>;
}

interface AIFormGenerationResult {
  success: boolean;
  data: {
    title: string;
    description?: string;
    fields: AIGeneratedField[];
    needsScript?: boolean;
    suggestedScript?: string;
  };
  pagesProcessed?: number;
}

interface AIScriptGenerationResult {
  success: boolean;
  data: {
    script: string;
    explanation: string;
  };
}

interface FormField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  properties?: Record<string, unknown>;
}

interface LinkedRecord {
  id: string;
  display: string;
  fields: Record<string, unknown>;
  submittedAt?: string;
}

interface RelatedRecordGroup {
  /** Stable identity for the RELATIONSHIP (source form + field) — two links from one
   *  form via different linked_record fields are distinct groups. */
  key?: string;
  formId: string;
  displayName: string;
  fieldLabel: string;
  /** The source form's linked_record field that points back at the parent — used
   *  to pre-link a newly added related record. */
  fieldId?: string;
  /** Whether that link field accepts multiple targets (array-valued answer). */
  allowMultiple?: boolean;
  /** Per-relationship sub-grid CRUD toggles (default true) — combined with the
   *  viewer's form permissions to decide whether Add / Delete show. */
  allowAdd?: boolean;
  allowDelete?: boolean;
  /** Rows shown per group before the "Show all" expander (relatedPageSize, default 8). */
  pageSize?: number;
  /** Columns to render in the related grid (the link's displayFieldIds, or a
   *  fallback of simple fields). Choice columns carry their option map so the grid
   *  renders labels, not raw option values. */
  columns?: Array<{ id: string; label: string; type: string; options?: Array<{ value: string; label: string }> }>;
  records: Array<{ id: string; display: string; submittedAt: string; fields?: Record<string, unknown> }>;
  count: number;
}

interface Webhook {
  id: string;
  formId: string;
  userId: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  responseStatus: number | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
}

interface FormVersion {
  id: string;
  formId: string;
  version: number;
  changelog: string | null;
  createdAt: string;
  createdBy: string | null;
  data?: Record<string, unknown>;
}

interface PackData {
  formatVersion: number;
  packMeta: { id?: string; name: string; description: string; version: string; author?: string; tags?: string[] };
  forms: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
  /** FormLogic Flows (docs/FORMLOGIC_FLOWS.md §6): flow definitions shipped with the pack. */
  flows?: PackFlowDefinition[];
  /** Event bindings for the pack's flows ('@pack:<formId>' form refs remapped on import). */
  flowBindings?: PackFlowBinding[];
}

interface PackImportResult {
  success: boolean;
  message: string;
  installationId: string;
  forms: Array<{ id: string; title: string }>;
  apps: Array<{ id: string; name: string }>;
  /** APP-502: connector grants the pack requested that the importer did not
   *  approve (empty when no review ran / everything was approved). */
  withheldGrants?: string[];
}

/** An App Feature bundled with a pack's app (the `apps[].services` toggle — NOT a Desktop service). */
export interface PackAppFeatureSummary {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
}

/** Server-derived capability summary for a pack / application package (capability review, spec §30.1). */
interface PackCapabilitySummary {
  forms: number;
  apps: number;
  hasScreens: boolean;
  hasCustomLogic: boolean;
  logicScripts: number;
  /** SAFE-002: packaged flows / bindings — the server always sent these; the type dropped them. */
  flows?: number;
  flowBindings?: number;
  connectors: string[];
  permissions: string[];
  /** APP-502: the connector grants the install review may approve/deny — the
   *  subset importPack can actually strip (app customLogic + role carriers;
   *  flow-declared connector access is structural and not listed here).
   *  Absent from older servers. */
  connectorGrants?: string[];
  /** SAFE-002: App Features shipped with the pack's apps (owner-toggleable post-install;
   *  informational at review time). These are NOT Desktop services. */
  services?: PackAppFeatureSummary[];
}

/** APP-502: the embedded vendor-signing verdict, for the install review. */
export interface PackVendorSigning {
  signed: boolean;
  keyId?: string;
  publisher?: string;
  /** Component keys ('form:<id>' / 'app:<id>') whose bytes match the vendor signature. */
  verified?: string[];
  /** Component keys present but NOT matching (edited after signing). */
  modified?: string[];
}

interface PackDescribeResult {
  /** official | verified | local-only | community | unverified — computed server-side, never trusted from a client. */
  trust: string;
  capabilities: PackCapabilitySummary;
  /** APP-502: embedded vendor-signing verdict (absent from older servers). */
  vendorSigning?: PackVendorSigning;
}

/** Result of importing a full Application Package (archive or signed envelope) — importPack + a trust stamp. */
interface ApplicationPackageImportResult {
  success: boolean;
  trust: string;
  installationId: string;
  forms: Array<{ id: string; title: string }>;
  apps: Array<{ id: string; name: string }>;
  /** SAFE-001: connector grants the package requested that the review did not approve
   *  (pack carriers AND envelope customLogic). */
  withheldGrants?: string[];
}

export interface AccountBackupImportResult {
  apps: Array<{ id: string; name: string }>;
  forms: Array<{ id: string; title: string }>;
  flows: number;
  bindings: number;
  responses: number;
  files: number;
  warnings?: string[];
}

export interface TrashItem {
  id: string;
  kind: 'form' | 'app' | 'flow';
  originalId: string;
  name: string;
  sizeBytes: number;
  meta: {
    slug?: string | null;
    appId?: string | null;
    counts?: { forms?: number; apps?: number; flows?: number; bindings?: number; responses?: number; files?: number };
  };
  status: 'trashed' | 'restoring';
  deletedAt: string;
  expiresAt: string;
  daysRemaining: number;
}

export interface ScheduledBackupRun {
  date: string;
  users: number;
  failed: number;
  totalBytes: number;
  finishedAt: string | null;
  includeFiles: boolean;
  accounts: Array<{ id: string | null; email: string | null; sizeBytes: number; error?: string | null }>;
}

export interface ScheduledBackupStatus {
  date: string;
  users: number;
  ok: number;
  failed: number;
  totalBytes: number;
}

interface PackInstallation {
  id: string;
  packId: string;
  catalogId: string | null;
  versionId: string | null;
  packName: string;
  packVersion: string;
  packDescription: string | null;
  formCount: number;
  appCount: number;
  existingFormCount: number;
  existingAppCount: number;
  formIds: string[];
  appIds: string[];
  installedAt: string;
  updateAvailable?: { version: string; changelog: string | null } | null;
}

interface CatalogPack {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  screenshot: string | null;
  screenshots: PackScreenshot[];
  tags: string[];
  category: string | null;
  /** Marketplace artifact type (spec §30). Only 'application_package' has a runtime install target today. */
  itemType?: string;
  /** Server-derived trust level: official | verified | community | private. Never from client input. */
  trustLevel?: string;
  visibility: string;
  status: string;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  featured: boolean;
  /** Published by the real official/platform account — server-computed, not from the display name. */
  official?: boolean;
  publisherId: string;
  publisherName: string | null;
  latestVersion: string | null;
  formCount: number;
  appCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PackScreenshot {
  label: string;
  url: string;
}

interface PackVersionInfo {
  id: string;
  version: string;
  changelog: string | null;
  form_count: number;
  app_count: number;
  created_at: string;
}

interface PackCatalogBrowseResult {
  packs: CatalogPack[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PackFacet {
  name: string;
  count: number;
}

interface PackFacets {
  categories: PackFacet[];
  tags: PackFacet[];
}

interface PackRatingEntry {
  id: string;
  userId: string;
  userName: string;
  rating: number;
  review: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PackRatingsResult {
  ratings: PackRatingEntry[];
  total: number;
  page: number;
  totalPages: number;
  userRating: { rating: number; review: string | null } | null;
}

interface PackUninstallResult {
  success: boolean;
  message: string;
  formsDeleted: number;
  appsDeleted: number;
}

interface CsvParseResult {
  headers: string[];
  rowCount: number;
  previewRows: Array<Record<string, string>>;
  fields: Array<{ id: string; label: string; type: string }>;
}

interface CsvImportResult {
  created: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; errors: string[] }>;
}

interface AuditVerifyResult {
  intact: boolean;
  verified: number;
  total: number;
  brokenAt: { id: string; sequenceNumber: number; action: string; createdAt: string } | null;
}

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  formIds: string[] | null;
  lastUsedAt: string | null;
  lastUsedIp?: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface ApiKeyCreated extends ApiKey {
  key: string;
}

interface DesktopConnection {
  id: string;
  deviceName: string;
  desktopInstanceId: string;
  apiKeyId: string | null;
  capabilities: string[];
  trustedOrigins: string[];
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Connector routing (ROUTE-001): assignments + candidates + the machines to pick from. */
export interface ConnectorAssignment {
  connectorId: string;
  appId: string;
  appName: string;
  appSlug: string;
  desktopConnectionId: string | null;
  desktopDeviceName: string | null;
  desktopInstanceId: string | null;
  desktopLastSeenAt: string | null;
}

export interface ConnectorAssignments {
  assignments: ConnectorAssignment[];
  candidates: Record<string, Array<{ appId: string; appName: string }>>;
  desktops: Array<{
    id: string;
    deviceName: string;
    desktopInstanceId: string;
    lastSeenAt: string | null;
  }>;
}

// ── Desktop AI E2E tunnel relay wire shapes (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5) ──

/**
 * The plan §5.1 frame blob: {nonce (24B b64), ct}. On the wire it travels inside the
 * backend's `envelope` string field — base64 of this JSON object (see
 * client-runtime/desktop/desktopTunnel.ts encodeTunnelEnvelope/decodeTunnelEnvelope).
 * The backend stores/relays the decoded bytes verbatim and never opens them.
 */
export interface DesktopAiSealedEnvelope {
  nonce: string;
  ct: string;
}

/** GET /api/desktop/ai/pubkey response — the desktop's published long-term X25519 identity. */
export interface DesktopAiPubkeyResponse {
  instanceId: string;
  /** Long-term X25519 public key, base64 (32 bytes). */
  publicKey: string;
  deviceName?: string;
}

export type DesktopAiRequestKind = 'chat' | 'models' | 'providers';

/** POST /api/desktop/ai/requests body — routing plaintext + sealed envelope (plan §5.1). */
export interface DesktopAiEnqueueBody {
  targetInstanceId?: string;
  kind: DesktopAiRequestKind;
  providerId: string;
  /** Browser per-thread ephemeral X25519 public key (base64, 32 bytes) — never persisted. */
  ephPub: string;
  /** Base64 of the sealed frame blob (JSON {nonce, ct}) — the backend relays it verbatim. */
  envelope: string;
  idempotencyKey: string;
}

export interface DesktopAiEnqueueResponse {
  requestId: string;
  status: string;
  queuePos?: number;
  targetInstanceId?: string;
}

/** GET /api/desktop/ai/requests/{id} — the queue position is computed at read time (plan §5.2). */
export interface DesktopAiRequestStatus {
  requestId: string;
  status: 'pending' | 'claimed' | 'streaming' | 'done' | 'failed' | 'expired';
  queuePos?: number;
  /** Typed failure code (plan §5.8) when status is failed/expired. */
  code?: string;
  message?: string;
}

export interface DesktopAiRequestStatusResponse {
  request: DesktopAiRequestStatus;
}

/** ApiResponse + the relay's typed failure code (plan §5.8), when the server provided one. */
export interface DesktopAiApiResponse<T> {
  data?: T;
  error?: string;
  status?: number;
  code?: string;
}

/**
 * Re-type an errored `desktopAiRequest<unknown>` response for a narrower T: on the
 * error path `data` is meaningless, so dropping it makes the result assignable to any
 * DesktopAiApiResponse<T> without a cast.
 */
function desktopAiErrorOnly(res: DesktopAiApiResponse<unknown>): DesktopAiApiResponse<never> {
  return {
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.status !== undefined ? { status: res.status } : {}),
    ...(res.code !== undefined ? { code: res.code } : {}),
  };
}

// ── Site AI preferences + plan allowances (plan Phase 2, §5.5/§6) ─────────────

export type AiSourceSetting = 'site' | 'desktop' | 'custom';
export type AiChatToolMode = 'auto' | 'confirm';

/** Monthly Site AI usage — present only on backends that meter (Phase 2 usage_meter). */
export interface AiUsageInfo {
  used: number;
  /** null = unlimited/unmetered limit (the row exists, the plan has no cap). */
  limit: number | null;
}

/** The signed-in user's AI settings (GET/PUT /api/ai/preferences), normalized client-side. */
export interface AiPreferencesState {
  aiSource: AiSourceSetting;
  desktopProviderId: string | null;
  desktopModel: string | null;
  customProviderId: string | null;
  chatToolMode: AiChatToolMode;
  /** Default reasoning effort for the Codex/ChatGPT desktop connector (null = provider default). */
  desktopReasoning: string | null;
  /** Present only when the backend meters Site AI; absent = "not tracked". */
  usage?: AiUsageInfo | null;
}

/** PUT /api/ai/preferences body — usage is server-owned and never sent. */
export interface AiPreferencesInput {
  aiSource: AiSourceSetting;
  desktopProviderId: string | null;
  desktopModel: string | null;
  customProviderId: string | null;
  chatToolMode: AiChatToolMode;
  desktopReasoning?: string | null;
}

export type AiAllowanceMetric = 'ai_messages' | 'cloud_flow_runs';

/** One plan_allowances row (GET/PUT /api/admin/allowances). */
export interface PlanAllowance {
  plan: string;
  metric: AiAllowanceMetric | string;
  monthlyValue: number;
  enabled: boolean;
}

export type PlanAllowanceInput = PlanAllowance;

function nullableTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeAiPreferences(raw: unknown): AiPreferencesState {
  const body = recordValue(raw) ?? {};
  const inner = recordValue(body.data) ?? body;
  const usage = recordValue(inner.usage);
  return {
    aiSource: inner.aiSource === 'desktop' || inner.aiSource === 'custom' ? inner.aiSource : 'site',
    desktopProviderId: nullableTrimmedString(inner.desktopProviderId),
    desktopModel: nullableTrimmedString(inner.desktopModel),
    customProviderId: nullableTrimmedString(inner.customProviderId),
    chatToolMode: inner.chatToolMode === 'confirm' ? 'confirm' : 'auto',
    desktopReasoning: nullableTrimmedString(inner.desktopReasoning),
    ...(usage
      ? {
          usage: {
            used: typeof usage.used === 'number' && Number.isFinite(usage.used) ? usage.used : 0,
            limit: typeof usage.limit === 'number' && Number.isFinite(usage.limit) ? usage.limit : null,
          },
        }
      : {}),
  };
}

function normalizePlanAllowance(value: unknown): PlanAllowance | null {
  const row = recordValue(value);
  if (!row || typeof row.plan !== 'string' || row.plan === '') return null;
  if (typeof row.metric !== 'string' || row.metric === '') return null;
  return {
    plan: row.plan,
    metric: row.metric,
    monthlyValue: typeof row.monthlyValue === 'number' && Number.isFinite(row.monthlyValue) ? row.monthlyValue : 0,
    enabled: row.enabled !== false,
  };
}

function normalizePlanAllowances(raw: unknown): PlanAllowance[] {
  const body = recordValue(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(body?.data) ? body.data : Array.isArray(body?.allowances) ? body.allowances : [];
  return list.map(normalizePlanAllowance).filter((row): row is PlanAllowance => row !== null);
}

// ── Chat tool grants + catalog wire shapes (plan §5.4, Phase 6) ──────────────

/** POST /api/ai/chat-tool-grant response — one 10-minute grant per chat turn. */
export interface ChatToolGrant {
  grantToken: string;
  /** ISO-8601 expiry (server-side truth; the token itself is what the desktop presents). */
  expiresAt: string;
}

/** One entry of GET /api/ai/chat-tools/catalog (the v1 additive/read + guarded-write subset). */
export interface ChatToolDescriptor {
  name: string;
  description?: string;
  /** JSON-Schema-ish input description, passed through verbatim for display/future use. */
  inputSchema?: unknown;
}

function normalizeChatToolGrant(raw: unknown): ChatToolGrant | null {
  const body = recordValue(raw);
  const inner = recordValue(body?.data) ?? body;
  const grantToken = inner?.grantToken;
  const expiresAt = inner?.expiresAt;
  if (typeof grantToken !== 'string' || grantToken === '') return null;
  return { grantToken, expiresAt: typeof expiresAt === 'string' ? expiresAt : '' };
}

function normalizeChatToolCatalog(raw: unknown): ChatToolDescriptor[] {
  const body = recordValue(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(body?.tools) ? body.tools : Array.isArray(body?.data) ? body.data : [];
  const out: ChatToolDescriptor[] = [];
  for (const item of list) {
    const row = recordValue(item);
    if (!row || typeof row.name !== 'string' || row.name === '') continue;
    out.push({
      name: row.name,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(row.inputSchema !== undefined ? { inputSchema: row.inputSchema } : {}),
    });
  }
  return out;
}

// ── Flow execution location + desktop/cloud flow-run wire shapes (plan §5.7, Phase 5) ──

/** Where a flow is CONFIGURED to run (flow_definitions.execution_location). */
export type FlowExecutionLocation = 'auto' | 'desktop' | 'cloud';
/** Where a run actually EXECUTED (flow_run_logs.execution_location). */
export type FlowRunExecutedLocation = 'browser' | 'desktop' | 'cloud';

/** POST /api/desktop/flows/run body — routing plaintext + sealed envelope (plan §5.7/§5.1). */
export interface DesktopFlowRunEnqueueBody {
  targetInstanceId?: string;
  flowId: string;
  /** Browser per-run ephemeral X25519 public key (base64, 32 bytes) — never persisted. */
  ephPub: string;
  /** Base64 of the sealed frame blob (nonce || ct) — the backend relays it verbatim. */
  envelope: string;
  idempotencyKey?: string;
}

export interface DesktopFlowRunEnqueueResponse {
  requestId: string;
  status?: string;
  queuePos?: number;
  targetInstanceId?: string;
}

/** GET /api/desktop/flows/runs/{id} — queue position is computed at read time (plan §5.2). */
export interface DesktopFlowRunStatus {
  requestId: string;
  status: 'pending' | 'claimed' | 'running' | 'streaming' | 'done' | 'failed' | 'expired' | string;
  queuePos?: number;
  /** Sealed result frame (base64 nonce || ct), present once status is 'done'. */
  resultEnvelope?: string;
  /** Typed failure code (plan §5.8) when status is failed/expired. */
  code?: string;
  message?: string;
}

/** POST /api/flows/{id}/run — the synchronous cloud run outcome. */
export interface CloudFlowRunResult {
  runId?: string;
  status: 'done' | 'error' | 'timeout' | 'cancelled' | string;
  result?: unknown;
  error?: { code?: string; message?: string; nodeId?: string } | null;
  /** As-executed location — always 'cloud' from this endpoint, echoed for the run UI. */
  executionLocation?: string;
  nodesExecuted?: number;
}

/** runFlowCloud failure extras: cloud_unsupported_node names the offending nodes here. */
export interface CloudFlowRunFailureDetails {
  nodes?: string[];
}

export type CloudFlowRunApiResponse = DesktopAiApiResponse<CloudFlowRunResult> & {
  details?: CloudFlowRunFailureDetails;
};

function firstStringField(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function normalizeDesktopFlowRunEnqueue(inner: Record<string, unknown>): DesktopFlowRunEnqueueResponse {
  return {
    requestId: firstStringField(inner.requestId, inner.id) ?? '',
    ...(typeof inner.status === 'string' ? { status: inner.status } : {}),
    ...(typeof inner.queuePos === 'number' ? { queuePos: inner.queuePos } : {}),
    ...(typeof inner.targetInstanceId === 'string' ? { targetInstanceId: inner.targetInstanceId } : {}),
  };
}

function normalizeDesktopFlowRunStatus(inner: Record<string, unknown>): DesktopFlowRunStatus {
  return {
    requestId: firstStringField(inner.requestId, inner.id) ?? '',
    status: typeof inner.status === 'string' ? inner.status : 'pending',
    ...(typeof inner.queuePos === 'number' ? { queuePos: inner.queuePos } : {}),
    ...(typeof inner.resultEnvelope === 'string' ? { resultEnvelope: inner.resultEnvelope } : {}),
    ...(typeof inner.code === 'string' ? { code: inner.code } : {}),
    ...(typeof inner.message === 'string' ? { message: inner.message } : {}),
  };
}

function normalizeCloudFlowRunResult(inner: Record<string, unknown>): CloudFlowRunResult {
  const error = recordValue(inner.error);
  return {
    ...(firstStringField(inner.runId, inner.id) ? { runId: firstStringField(inner.runId, inner.id) } : {}),
    // A 2xx response without an explicit status word is a completed run.
    status: typeof inner.status === 'string' ? inner.status : 'done',
    ...('result' in inner ? { result: inner.result } : {}),
    ...(error
      ? {
          error: {
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
            ...(typeof error.message === 'string' ? { message: error.message } : {}),
            ...(typeof error.nodeId === 'string' ? { nodeId: error.nodeId } : {}),
          },
        }
      : {}),
    ...(typeof inner.executionLocation === 'string' ? { executionLocation: inner.executionLocation } : {}),
    ...(typeof inner.nodesExecuted === 'number' ? { nodesExecuted: inner.nodesExecuted } : {}),
  };
}

interface UploadedFileMetadata {
  id: string;
  originalFilename: string;
  storedFilename: string;
  size: number;
  mimeType: string;
  url: string;
  /**
   * One-time upload claim (FILE-PRIV-001): kept inside the answer item so submission
   * proves this browser performed the upload. The server verifies and STRIPS it before
   * persisting — it never appears in stored answers.
   */
  claimToken?: string;
}

// Export singleton instance
export const api = new ApiClient(API_BASE_URL);

/**
 * Resolve a server-stored file URL (always root-relative `/api/files/...`) against the
 * configured API base, so uploaded-file downloads work under split-origin deployments
 * (including the dev default where VITE_API_URL points at another port).
 */
export function resolveFileUrl(url?: string | null): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/')) return API_BASE_URL.replace(/\/$/, '') + url.slice(4);
  return url;
}

// Export types
export type { User, FormResponse, FormAnalytics, ApiResponse, AIStatus, AIGeneratedField, AIFormGenerationResult, AIScriptGenerationResult, FormField, LinkedRecord, RelatedRecordGroup, Webhook, WebhookDelivery, FormVersion, PackData, PackImportResult, PackInstallation, PackUninstallResult, PackDescribeResult, PackCapabilitySummary, ApplicationPackageImportResult, CsvParseResult, CsvImportResult, AuditVerifyResult, ApiKey, ApiKeyCreated, DesktopConnection, CatalogPack, PackScreenshot, PackVersionInfo, PackCatalogBrowseResult, PackFacet, PackFacets, PackRatingEntry, PackRatingsResult, UploadedFileMetadata };
