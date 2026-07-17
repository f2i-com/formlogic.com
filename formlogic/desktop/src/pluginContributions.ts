import type { PluginSnapshot } from './api';

/**
 * PLG-203 — pure helpers for rendering a plugin's declarative UI contributions.
 *
 * A plugin's manifest `ui` section describes nav entries, Overview cards, status
 * cards, and action buttons entirely as DATA. The host renders them generically:
 * bindings resolve against the plugin snapshot (or a polled command response)
 * with a safe JSON-pointer-like grammar — there is NO executable expression
 * syntax, and unknown/oversized values fall back to a placeholder.
 */

/** A plugin section id: `plugin:<pluginId>:<navId>`. */
export function pluginSectionId(pluginId: string, navId: string): string {
  return `plugin:${pluginId}:${navId}`;
}

export function parsePluginSection(
  section: string,
): { pluginId: string; navId: string } | null {
  const parts = section.split(':');
  if (parts.length === 3 && parts[0] === 'plugin') {
    return { pluginId: parts[1], navId: parts[2] };
  }
  return null;
}

/** A plugin is eligible to contribute UI only while installed + not disabled. */
export function contributingPlugins(plugins: PluginSnapshot[]): PluginSnapshot[] {
  return plugins.filter((p) => p.state !== 'disabled' && !!p.ui);
}

/** Every nav entry a plugin contributes, as { pluginId, navId, label, icon, badge }. */
export interface PluginNavEntry {
  pluginId: string;
  navId: string;
  label: string;
  icon?: string;
  badge?: string;
}

export function pluginNavEntries(plugins: PluginSnapshot[]): PluginNavEntry[] {
  const out: PluginNavEntry[] = [];
  for (const p of contributingPlugins(plugins)) {
    for (const n of p.ui?.nav ?? []) {
      out.push({ pluginId: p.id, navId: n.id, label: n.label, icon: n.icon, badge: n.badge });
    }
  }
  return out;
}

/**
 * Resolve a binding path against a source object. A `$`-prefixed path reads
 * from the snapshot root (e.g. `$health.status` → snapshot.lastHealth?.status
 * via the `health` alias); a bare path reads from a command-response `data`.
 * Only dotted alphanumeric/underscore segments + numeric indices are honored;
 * anything else yields undefined (the manifest validator already refuses unsafe
 * paths, so this is defense in depth).
 */
export function resolvePath(source: unknown, rawPath: string): unknown {
  const path = rawPath.startsWith('$') ? rawPath.slice(1) : rawPath;
  if (!path) return undefined;
  const segs = path.split('.');
  let cur: unknown = source;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!/^[A-Za-z0-9_]+$/.test(seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The binding source for an OVERVIEW card / snapshot-bound field: exposes
 * `state`, `health` (the last health report), `reason`, and identity — the
 * generic inputs a manifest card can reference with `$health.status` etc.
 */
export function snapshotBindingSource(p: PluginSnapshot): Record<string, unknown> {
  return {
    state: p.state,
    reason: p.reason ?? null,
    name: p.name,
    version: p.version,
    health: p.lastHealth
      ? { status: p.lastHealth.status, ok: p.lastHealth.ok, detail: p.lastHealth.detail ?? null }
      : { status: 'unknown', ok: false, detail: null },
  };
}

/**
 * Map a status-like bound string ("ok", "degraded", "error"…) to a
 * desktop-status-pill tone. Non-status strings return null and render as a
 * plain headline instead of a pill.
 */
export type StatusTone = 'is-ok' | 'is-warn' | 'is-live' | 'is-neutral';

const STATUS_TONES: Record<string, StatusTone> = {
  ok: 'is-ok',
  ready: 'is-ok',
  running: 'is-ok',
  healthy: 'is-ok',
  connected: 'is-ok',
  online: 'is-ok',
  degraded: 'is-warn',
  warning: 'is-warn',
  unhealthy: 'is-warn',
  starting: 'is-warn',
  reconnecting: 'is-warn',
  error: 'is-live',
  failed: 'is-live',
  offline: 'is-live',
  stopped: 'is-neutral',
  disabled: 'is-neutral',
  installed: 'is-neutral',
  unknown: 'is-neutral',
};

export function statusTone(value: unknown): StatusTone | null {
  if (typeof value !== 'string') return null;
  return STATUS_TONES[value.trim().toLowerCase()] ?? null;
}

/** Stringify a resolved binding value for display (safe, bounded). */
export function displayValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Allow-listed icon name → a token the sidebar/cards understand. An unknown
 * icon falls back to the generic puzzle-piece. Kept small and explicit; a
 * plugin can only pick from these, never inject markup.
 */
export const PLUGIN_ICON_ALLOWLIST = [
  'phone',
  'plug',
  'server',
  'database',
  'gear',
  'link',
  'grid',
  'terminal',
  'puzzle',
] as const;

export type PluginIconName = (typeof PLUGIN_ICON_ALLOWLIST)[number];

export function normalizeIcon(icon?: string): PluginIconName {
  return (PLUGIN_ICON_ALLOWLIST as readonly string[]).includes(icon ?? '')
    ? (icon as PluginIconName)
    : 'puzzle';
}

/** Host-clamped poll interval floor so a plugin can't hammer the command bus. */
export function clampPollMs(ms?: number): number {
  const v = ms ?? 5000;
  return Math.max(2000, Math.min(60000, v));
}
