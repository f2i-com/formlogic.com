// FormLogic SDK — components.
//
// Drop-in building blocks for custom screens (spec §28). They compose the SDK
// hooks so an AI-generated or hand-written screen can show connector status,
// sync state, permission-gated actions, and recent records without wiring up
// the runtime store directly. Neutral, theme-aware styling.
import { useEffect, useState, type ReactNode } from 'react';
import {
  useAppNavigation,
  useConnector,
  useConnectorPermission,
  useForm,
  useNativeRuntime,
  useOfflineQueue,
  usePermissions,
  useResponse,
  useResponses,
  useSubmitResponse,
} from './hooks';
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
  const { offline } = useOfflineQueue();
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

/** A button styled with the app's primary accent (theme-aware via --app-primary). */
export function AppButton({
  children,
  onClick,
  type = 'button',
  disabled = false,
  variant = 'primary',
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none';
  const styles = variant === 'primary'
    ? 'bg-[var(--app-primary,#6366f1)] text-white hover:opacity-90'
    : 'border border-gray-300 dark:border-slate-600 text-gray-800 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

/** A submit button bound to a form via useSubmitResponse (handles the async submit + busy state). */
export function SubmitButton({
  form,
  answers,
  children = 'Submit',
  onDone,
  onError,
}: {
  form: string;
  answers: Record<string, unknown>;
  children?: ReactNode;
  onDone?: (result: unknown) => void;
  onError?: (error: Error) => void;
}) {
  const submit = useSubmitResponse(form);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone?.(await submit(answers));
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  return <AppButton onClick={go} disabled={busy}>{busy ? 'Submitting…' : children}</AppButton>;
}

/** All answers of one response as label/value rows. */
export function ResponseDetail({ form, id }: { form: string; id: string }) {
  const row = useResponse(form, id);
  if (!row) return <EmptyState title="Record not found" />;
  const entries = Object.entries(row.answers);
  if (entries.length === 0) return <EmptyState title="No data in this record" />;
  return (
    <dl className="divide-y divide-gray-100 dark:divide-slate-800">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-2">
          <dt className="text-sm text-gray-500 dark:text-slate-400">{k}</dt>
          <dd className="min-w-0 truncate text-right text-sm font-medium text-gray-900 dark:text-white">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A card that opens a form in the app runtime. (A full host-rendered form belongs to the SDK screen
 * runtime; this is the SDK's lightweight launcher building block.)
 */
export function FormView({ form, label }: { form: string; label?: string }) {
  const f = useForm(form);
  const nav = useAppNavigation();
  if (!f) return <EmptyState title="Form unavailable" message="You may not have access to this form." />;
  const title = label ?? (f as { displayName?: string }).displayName ?? f.formId;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
      <p className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</p>
      <AppButton onClick={() => nav.goToForm(form, { new: true })}>Open</AppButton>
    </div>
  );
}

/** Renders children only when the app has been granted the connector command. */
export function ConnectorPermissionGate({
  connector,
  command,
  children,
  fallback = null,
}: {
  connector: string;
  command: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useConnectorPermission(connector);
  return <>{can(command) ? children : fallback}</>;
}

/** A notice shown when a screen needs the native runtime but it isn't present. */
export function NativeRequiredNotice({ message }: { message?: string }) {
  const { available } = useNativeRuntime();
  if (available) return null;
  return (
    <EmptyState
      title="Native app required"
      message={message ?? 'Install the FormLogic app to use this feature on your device.'}
    />
  );
}

/** Compact offline-queue status (pending/failed/syncing) with a flush action when supported. */
export function OfflineQueuePanel() {
  const q = useOfflineQueue();
  const pending = q.pending ?? 0;
  const failed = (q as { failed?: number }).failed ?? 0;
  const syncing = (q as { syncing?: boolean }).syncing ?? false;
  const flush = (q as { flush?: () => void }).flush;
  return (
    <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <SyncStatus />
        {flush && pending > 0 && <AppButton variant="secondary" onClick={() => flush()}>Sync now</AppButton>}
      </div>
      {(pending > 0 || failed > 0) && (
        <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">
          {pending} pending{failed ? `, ${failed} failed` : ''}{syncing ? ' · syncing…' : ''}
        </p>
      )}
    </div>
  );
}
