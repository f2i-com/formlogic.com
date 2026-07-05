// FormLogic SDK — components.
//
// Drop-in building blocks for custom screens (spec §28). They compose the SDK
// hooks so an AI-generated or hand-written screen can show connector status,
// sync state, permission-gated actions, and recent records without wiring up
// the runtime store directly. Neutral, theme-aware styling.
import { useEffect, useState, type ReactNode } from 'react';
import { useConnector, useOfflineQueue, usePermissions, useResponses } from './hooks';
import type { ConnectorStatusInfo } from '../client-runtime/connectors/connectorTypes';
import type { PermissionAction } from '../types/app';

/** Live status pill for a connector (green = connected, grey = unavailable). */
export function ConnectorStatus({ connector }: { connector: string }) {
  const c = useConnector(connector);
  const [status, setStatus] = useState<ConnectorStatusInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(c.status()).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [c]);
  const available = status?.available ?? false;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${available ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-slate-600'}`} />
      <span className="font-medium text-gray-900 dark:text-white">{status?.label ?? connector}</span>
      <span className="min-w-0 truncate text-gray-500 dark:text-slate-400">
        {status?.detail ?? (available ? 'Connected' : 'Unavailable')}
      </span>
    </div>
  );
}

/** Online/offline sync indicator. */
export function SyncStatus() {
  const { enabled: offline } = useOfflineQueue();
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${offline ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      <span className="text-gray-500 dark:text-slate-400">
        {offline ? 'Offline — changes sync when you reconnect' : 'Online — all changes saved'}
      </span>
    </div>
  );
}

/** Render children only when the user holds `permission` (optionally for `form`). */
export function PermissionGate({
  permission,
  form,
  children,
  fallback = null,
}: {
  permission: PermissionAction;
  form?: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = usePermissions();
  return <>{can(permission, form) ? children : fallback}</>;
}

/** A friendly empty-state block. */
export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 dark:border-slate-700 p-6 text-center">
      <p className="font-semibold text-gray-900 dark:text-white">{title}</p>
      {message && <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A compact recent-records list for a form. */
export function ResponseList({
  form,
  limit = 10,
  titleField,
  subtitleField,
  emptyMessage = 'No records yet.',
}: {
  form: string;
  limit?: number;
  titleField?: string;
  subtitleField?: string;
  emptyMessage?: string;
}) {
  const { rows, loading, error } = useResponses(form, { limit });

  if (loading) {
    return <div className="text-sm text-gray-400 dark:text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-600 dark:text-red-400">{error}</div>;
  }
  if (rows.length === 0) {
    return <EmptyState title={emptyMessage} />;
  }

  const pick = (answers: Record<string, unknown>, field?: string): string | null => {
    if (field && answers[field] != null) return String(answers[field]);
    return null;
  };

  return (
    <ul className="divide-y divide-gray-100 dark:divide-slate-800">
      {rows.map((r) => {
        const title = pick(r.answers, titleField) ?? r.id;
        const subtitle = pick(r.answers, subtitleField);
        return (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{title}</p>
              {subtitle && <p className="truncate text-xs text-gray-500 dark:text-slate-400">{subtitle}</p>}
            </div>
            {r.submittedAt && (
              <time className="shrink-0 text-xs text-gray-400 dark:text-slate-500">
                {new Date(r.submittedAt).toLocaleDateString()}
              </time>
            )}
          </li>
        );
      })}
    </ul>
  );
}
