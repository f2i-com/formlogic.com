// Pure view-model helpers for the Desktop Connection popover — kept component-free so
// DesktopConnectionPopover.tsx stays a components-only export (react-refresh/only-export-components;
// same split as components/flows/runHistoryChip.ts). Unit-tested without rendering.
import type { DesktopClientResult } from '../../client-runtime/desktop/desktopTypes';
import {
  type DesktopOpName,
  type DesktopOpOutcome,
} from '../../client-runtime/desktop/desktopOps';
import {
  describeFlowsLastSeen,
  type FlowsDesktopPresence,
} from '../flows/useFlowsDesktopPresence';
import { api } from '../../lib/api';

export type DesktopConnectionKind = 'local' | 'remote' | 'none' | 'demo';

export interface DesktopConnectionView {
  kind: DesktopConnectionKind;
  /** Trigger label next to the presence dot. */
  label: string;
  /** Secondary line shown inside the popover. */
  detail: string;
}

export function deriveConnectionView(presence: FlowsDesktopPresence, isDemo: boolean, now?: number): DesktopConnectionView {
  if (isDemo) {
    return {
      kind: 'demo',
      label: 'Demo bridge',
      detail: 'The demo simulates desktop hardware — nothing here touches a real machine.',
    };
  }
  if (presence.kind === 'local') {
    return { kind: 'local', label: 'Desktop — this device', detail: 'FormLogic Desktop is running on this machine.' };
  }
  if (presence.kind === 'remote') {
    const seen = describeFlowsLastSeen(presence.lastSeenMs, now);
    return {
      kind: 'remote',
      label: `Desktop — ${presence.label}`,
      detail: seen ? `Linked desktop · last seen ${seen}` : 'Linked desktop',
    };
  }
  return {
    kind: 'none',
    label: 'No desktop',
    detail: 'Link FormLogic Desktop to run its services and plugins from the browser.',
  };
}

export function connectionDotClass(kind: DesktopConnectionKind): string {
  switch (kind) {
    case 'local':
    case 'remote':
      return 'bg-emerald-500';
    case 'demo':
      return 'bg-amber-400';
    case 'none':
      return 'bg-gray-400 dark:bg-slate-500';
  }
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'repair';
export type PluginAction = 'start' | 'stop' | 'restart';

export function serviceOpName(action: ServiceAction): DesktopOpName {
  return `desktop.services.${action}` as DesktopOpName;
}

export function pluginOpName(action: PluginAction): DesktopOpName {
  return `desktop.plugins.${action}` as DesktopOpName;
}

export type OpFeedbackTone = 'success' | 'warning' | 'error';

export interface OpFeedback {
  tone: OpFeedbackTone;
  text: string;
}

/** Relay-outcome copy — 'uncertain' is always named, never dressed up as a failure. */
export function describeOpOutcome(action: string, outcome: DesktopOpOutcome): OpFeedback {
  switch (outcome.status) {
    case 'done':
      return { tone: 'success', text: `${action} completed.` };
    case 'failed':
      return { tone: 'error', text: `${action} failed: ${outcome.error ?? 'the desktop reported an error.'}` };
    case 'expired':
      return { tone: 'error', text: `${action} could not be confirmed — no desktop picked it up in time.` };
    case 'uncertain':
      return {
        tone: 'warning',
        text: `${action} was picked up but the desktop did not report back — it may have completed (outcome uncertain).`,
      };
  }
}

/** Loopback call copy (DesktopClientResult — a typed desktop refusal reads as-is). */
export function describeClientResult(action: string, res: DesktopClientResult<unknown>): OpFeedback {
  if (res.ok) return { tone: 'success', text: `${action} completed.` };
  return { tone: 'error', text: `${action} failed: ${res.error.message}` };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull a list out of a relay op's result payload, tolerating the loopback route's
 * body shape ({services:[…]} / {plugins:[…]}), a bare array, or a nested {data:{…}}.
 */
export function extractListResult<T>(result: unknown, key: string): T[] {
  if (Array.isArray(result)) return result as T[];
  const rec = asRecord(result);
  if (Array.isArray(rec?.[key])) return rec[key] as T[];
  const data = asRecord(rec?.data);
  if (Array.isArray(data?.[key])) return data[key] as T[];
  return [];
}

// ---------------------------------------------------------------------------
// AI-source quick-switch (Wave-2 preferences contract; gracefully degrades).
// ---------------------------------------------------------------------------

export type AiSource = 'site' | 'desktop' | 'custom';

export interface AiPreferences {
  aiSource?: AiSource;
  desktopProviderId?: string | null;
  desktopModel?: string | null;
  customProviderId?: string | null;
  [key: string]: unknown;
}

interface AiPreferencesApiShape {
  getAiPreferences?: () => Promise<{ data?: AiPreferences; error?: string }>;
  putAiPreferences?: (prefs: Partial<AiPreferences>) => Promise<{ data?: AiPreferences; error?: string }>;
}

export const AI_SOURCE_OPTIONS: Array<{ value: AiSource; label: string; hint: string }> = [
  { value: 'site', label: 'Site AI', hint: 'Hosted by FormLogic' },
  { value: 'desktop', label: 'Desktop AI', hint: 'ChatGPT/Codex on your desktop' },
  { value: 'custom', label: 'Custom', hint: 'Your own AI service' },
];

// TODO(final integration pass): WEB-B codes against the Wave-2 lib/api.ts contract
// getAiPreferences/putAiPreferences ({aiSource:'site'|'desktop'|'custom',…}) — that file
// is owned by another agent this round. If the method names differ at integration time
// this lookup returns null and the quick-switch hides itself; reconcile the names here.
export function aiPreferencesApi(): Required<AiPreferencesApiShape> | null {
  const candidate = api as unknown as AiPreferencesApiShape;
  return typeof candidate.getAiPreferences === 'function' && typeof candidate.putAiPreferences === 'function'
    ? (candidate as Required<AiPreferencesApiShape>)
    : null;
}
