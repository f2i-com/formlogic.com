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
  type SdkFailedSubmission,
  type SdkOfflineQueue,
  type SdkRetryOutcome,
} from './hooks';
import { FAILED_RETENTION_MS } from '../client-runtime/offlineQueue';
import type { ConnectorStatusInfo } from '../client-runtime/connectors/connectorTypes';
import type { PermissionAction } from '../types/app';
import { parseServerDate } from '../lib/utils';

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

/**
 * Online/offline sync indicator. "Online" is not "saved": a submission can wait on the device
 * while the browser is online (a Wi-Fi sign-in page answered, the server is in maintenance mode),
 * so "all changes saved" is said only when nothing waits and nothing failed.
 */
export function SyncStatus() {
  const q = useOfflineQueue();
  const [reviewing, setReviewing] = useState(false);
  const failedItems = q.failedItems ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SyncStatusLine offline={q.offline} pending={q.pending} failed={q.failed} />
        {/* Kept while open, so what came of the last one can still be closed. */}
        {(failedItems.length > 0 || reviewing) && (
          <button
            type="button"
            onClick={() => setReviewing((open) => !open)}
            aria-expanded={reviewing}
            className="text-sm font-medium text-[var(--app-primary,#6366f1)] underline-offset-2 hover:underline"
          >
            {reviewing ? 'Hide' : 'Review'}
          </button>
        )}
      </div>
      {reviewing && <FailedSubmissionList queue={q} />}
    </div>
  );
}

/** How a failed submission is named: its form, or the app it came from when that is not this one. */
function failedItemTitle(item: SdkFailedSubmission): string {
  return item.formName ?? `A form in ${item.appSlug}`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Said of a submission whose sending was answered by something other than FormLogic. */
const UNRECOGNISED_TEXT = 'The server answered in a way FormLogic does not recognise (a Wi-Fi sign-in page or a proxy can do this).';

const RETRY_RESULT: Record<SdkRetryOutcome, string> = {
  sent: 'Sent.',
  waiting: 'The server could not be reached. It is waiting to send again, by itself, when it can.',
  unrecognised: `${UNRECOGNISED_TEXT} It is waiting to send again.`,
  failed: 'It still could not be sent.',
  conflict: 'The server already holds a different submission under this one’s reference.',
  missing: 'It is no longer on this device.',
};

/**
 * The submissions that could not be sent, each with "Send again" and "Discard". Shows which form
 * and when, and a short reason in plain words; never the answers, and never the server's raw
 * message (it can quote an answer, and "Failed to fetch" means nothing to the person). Stays
 * mounted with an empty list, so what came of the last one sent again or discarded is still said
 * after it has left the list; renders nothing when there is neither.
 */
function FailedSubmissionList({ queue }: { queue: SdkOfflineQueue }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const items = queue.failedItems ?? [];
  const sendAgain = async (item: SdkFailedSubmission) => {
    setBusy(item.key);
    setResult(null);
    try {
      setResult(`${failedItemTitle(item)}: ${RETRY_RESULT[await queue.retry(item)]}`);
    } catch {
      setResult(`${failedItemTitle(item)}: ${RETRY_RESULT.failed}`);
    } finally {
      setBusy(null);
    }
  };
  const discard = async (item: SdkFailedSubmission) => {
    setBusy(item.key);
    setResult(null);
    try {
      const done = await queue.discard(item);
      setResult(done ? `${failedItemTitle(item)}: discarded.` : `${failedItemTitle(item)}: ${RETRY_RESULT.missing}`);
    } finally {
      setConfirming(null);
      setBusy(null);
    }
  };
  if (items.length === 0 && !result) return null;
  return (
    <div className="mt-2">
      <ul className="divide-y divide-gray-100 dark:divide-slate-800">
        {items.map((item) => (
          <li key={item.key} className="py-2.5">
            <p className="text-sm font-medium text-gray-900 dark:text-white [overflow-wrap:anywhere]">{failedItemTitle(item)}</p>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Submitted <time dateTime={new Date(item.createdAt).toISOString()}>{formatWhen(item.createdAt)}</time>
              {item.failedAt !== null && <> · kept on this device until {formatDay(item.failedAt + FAILED_RETENTION_MS)}</>}
            </p>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-slate-300">
              {item.conflict
                ? 'The server already holds a different submission under this one’s reference, so it cannot be sent.'
                : item.unrecognised
                  ? UNRECOGNISED_TEXT
                  : 'It could not be sent after several tries.'}
            </p>
            {confirming === item.key ? (
              <div role="group" aria-label="Confirm discard" className="mt-2 rounded-lg bg-red-50 dark:bg-red-500/10 p-2.5">
                <p className="text-xs text-red-700 dark:text-red-300">
                  Discard this submission? Its answers will be lost: they are not on the server, and this removes them from this device.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy === item.key}
                    onClick={() => void discard(item)}
                    className="inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                  >
                    Discard answers
                  </button>
                  <AppButton variant="secondary" onClick={() => setConfirming(null)}>Keep it</AppButton>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {!item.conflict && (
                  <AppButton variant="secondary" disabled={busy !== null} onClick={() => void sendAgain(item)}>
                    {busy === item.key ? 'Sending…' : 'Send again'}
                  </AppButton>
                )}
                <AppButton variant="secondary" disabled={busy !== null} onClick={() => setConfirming(item.key)}>Discard</AppButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      {result && <p role="status" className="mt-1 text-xs text-gray-600 dark:text-slate-300">{result}</p>}
    </div>
  );
}

/** The indicator itself, for a caller that already holds the queue's state (OfflineQueuePanel). */
function SyncStatusLine({ offline, pending, failed }: { offline: boolean; pending: number; failed: number }) {
  const count = (n: number) => `${n} submission${n === 1 ? '' : 's'}`;
  const waiting = !offline && (pending > 0 || failed > 0);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${offline || waiting ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      <span className="text-gray-500 dark:text-slate-400">
        {offline
          ? 'Offline — changes sync when you reconnect'
          : pending > 0
            ? `Online — ${count(pending)} waiting to send`
            : failed > 0
              ? `Online — ${count(failed)} could not be sent`
              : 'Online — all changes saved'}
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
                {parseServerDate(r.submittedAt).toLocaleDateString()}
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

/**
 * Compact offline-queue status with a flush action. Counts merge the browser IndexedDB queue AND the
 * native runtime's persistent queue (via useOfflineQueue). `pending` items are retryable; `failed`
 * items (an idempotency key reused with a different submission, or out of attempts) are no longer
 * sent by themselves and are listed below, each to send again or discard. "Sync now" flushes both
 * queues.
 */
export function OfflineQueuePanel() {
  const q = useOfflineQueue();
  const pending = q.pending ?? 0;
  const failed = (q as { failed?: number }).failed ?? 0;
  const syncing = (q as { syncing?: boolean }).syncing ?? false;
  const lastError = (q as { lastError?: string | null }).lastError ?? null;
  const flush = (q as { flush?: () => void }).flush;
  return (
    <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* From this panel's own reading of the queue, so the line and the counts below it agree. */}
        <SyncStatusLine offline={q.offline} pending={pending} failed={failed} />
        {flush && pending > 0 && <AppButton variant="secondary" onClick={() => flush()}>Sync now</AppButton>}
      </div>
      {(pending > 0 || failed > 0) && (
        <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">
          {pending} pending{failed ? `, ${failed} failed` : ''}{syncing ? ' · syncing…' : ''}
        </p>
      )}
      {/* A failure is an error; a "Sync now" that could send nothing yet is only news. */}
      {lastError && (pending > 0 || failed > 0) && (
        <p className={`mt-1 text-xs ${failed > 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>{lastError}</p>
      )}
      <FailedSubmissionList queue={q} />
    </div>
  );
}
