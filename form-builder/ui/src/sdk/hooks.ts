// FormLogic SDK — hooks.
//
// A thin, permission-aware wrapper over the app runtime store (and auth store)
// so custom screens / AI-generated UI can read app data and act on it without
// touching raw API endpoints, the runtime store internals, or the native bridge
// (spec §27). Permission-aware: submit + connector calls are gated (role permissions for submits,
// the app's declared connector grants for connector calls) before they reach the transport; the
// server and native bridge remain the real trust boundary. These are the same capabilities the
// sandboxed custom-screen SDK exposes, made available to host-rendered React screens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { getConnectorClient } from '../client-runtime/connectors/nativeConnectorClient';
import { isPermissionGranted } from '../client-runtime/logic/appLogicPermissions';
import { collectConnectorGrants } from '../client-runtime/connectors/connectorGrants';
import { isFlushing, queueCounts, subscribeQueue } from '../client-runtime/offlineQueue';
import { flushAllQueues, nativeQueueCounts } from '../client-runtime/nativeOfflineQueue';
import { detectRuntimeEnvironment, type RuntimeEnvironment } from '../client-runtime/detectEnvironment';
import type { ConnectorStatusInfo, ConnectorSummary, NativeRuntimeInfo } from '../client-runtime/connectors/connectorTypes';
import type { App, AppRuntimeForm, PermissionAction } from '../types/app';
import { api } from '../lib/api';

const EMPTY_FORMS: AppRuntimeForm[] = [];
const EMPTY_OBJ: Record<string, unknown> = {};

/** The current app (theme/name/slug/settings), or null before the runtime loads. */
export function useCurrentApp(): App | null {
  return useAppRuntimeStore((s) => s.config?.app ?? null);
}

export interface SdkUser {
  id: string;
  email: string;
  name?: string;
  /** App-scoped role name (e.g. "Owner", "Member"), or null. */
  role: string | null;
  isDemo: boolean;
}

/** The signed-in user combined with their app-scoped role. */
export function useCurrentUser(): SdkUser | null {
  const user = useAuthStore((s) => s.user);
  const role = useAppRuntimeStore((s) => s.roleName);
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, role, isDemo: !!user.isDemo };
}

/** The current user's app role name. */
export function useRole(): string | null {
  return useAppRuntimeStore((s) => s.roleName);
}

export interface SdkPermissions {
  appLevel: PermissionAction[];
  formLevel: Record<string, PermissionAction[]>;
  /** True if the user has `action` app-wide, or for the given form. */
  can: (action: PermissionAction, formId?: string) => boolean;
}

/** Permission checks mirroring the runtime store's canXxx selectors. */
export function usePermissions(): SdkPermissions {
  const permissions = useAppRuntimeStore((s) => s.permissions);
  const appLevel = permissions?.appLevel ?? [];
  const formLevel = permissions?.formLevel ?? {};
  const can = (action: PermissionAction, formId?: string): boolean =>
    appLevel.includes(action) || (!!formId && (formLevel[formId]?.includes(action) ?? false));
  return { appLevel, formLevel, can };
}

/** All forms the current user may see (already permission-filtered by the server). */
export function useForms(): AppRuntimeForm[] {
  return useAppRuntimeStore((s) => s.config?.forms ?? EMPTY_FORMS);
}

/** A single form by its key (formId), or null. */
export function useForm(formKey: string): AppRuntimeForm | null {
  return useAppRuntimeStore((s) => s.config?.forms.find((f) => f.formId === formKey) ?? null);
}

export interface SdkResponseRow {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
}
export interface UseResponsesResult {
  rows: SdkResponseRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Recent responses for a form (newest first). Demo-aware; resolves to [] if the user
 * can't view (the store's fetchRecentRows swallows a 403 and returns []).
 */
export function useResponses(formKey: string, options?: { limit?: number }): UseResponsesResult {
  const fetchRecentRows = useAppRuntimeStore((s) => s.fetchRecentRows);
  const limit = options?.limit ?? 20;
  const [rows, setRows] = useState<SdkResponseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // All state updates happen inside the async callbacks (never synchronously in the
    // effect body) so we don't trigger cascading renders.
    fetchRecentRows(formKey, limit)
      .then((r) => { if (!cancelled) { setRows(r); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [fetchRecentRows, formKey, limit, nonce]);

  return { rows, loading, error, reload: () => setNonce((n) => n + 1) };
}

/** A submit function for a form; rejects if the user lacks submit permission. */
export function useSubmitResponse(formKey: string): (answers: Record<string, unknown>) => Promise<unknown> {
  const createResponse = useAppRuntimeStore((s) => s.createResponse);
  const canSubmit = useAppRuntimeStore((s) => s.canSubmit);
  return useCallback(
    (answers: Record<string, unknown>) => {
      if (!canSubmit(formKey)) {
        return Promise.reject(new Error('You do not have permission to submit this form.'));
      }
      return createResponse(formKey, answers);
    },
    [createResponse, canSubmit, formKey]
  );
}

export interface SdkConnector {
  id: string;
  request: (command: string, payload?: unknown) => Promise<unknown>;
  status: () => Promise<ConnectorStatusInfo>;
}

/**
 * A connector handle (native bridge when available, else the browser mock). `request` is gated on the
 * app's declared connector grants (bundle- + script-level `connector.<id>.<command>` permissions, the
 * same set published in the signed client manifest): a command the app hasn't been granted is rejected
 * before it reaches the transport, mirroring the QuickJS app-logic host. Advisory only — the native
 * bridge and server stay the real trust boundary.
 */
export function useConnector(connectorId: string, options?: { formId?: string }): SdkConnector {
  // Select the whole config (stable identity between store updates) and memoize the resolved grant
  // set; the grant union covers app-level customLogic AND form-level customLogic (contract FU-1).
  const config = useAppRuntimeStore((s) => s.config);
  const formId = options?.formId;
  return useMemo(() => {
    const client = getConnectorClient();
    const grants = collectConnectorGrants(config, formId != null ? { formId } : undefined);
    const ensureGranted = (command: string): Promise<never> | null => {
      const required = `connector.${connectorId}.${command}`;
      return isPermissionGranted(required, grants)
        ? null
        : Promise.reject(new Error(`This app has not been granted the "${required}" connector permission.`));
    };
    return {
      id: connectorId,
      request: (command, payload) => ensureGranted(command) ?? client.request(connectorId, command, payload),
      status: () => client.status(connectorId),
    };
  }, [connectorId, config, formId]);
}

export interface SdkConnectors {
  list: () => Promise<ConnectorSummary[]>;
  nativeAvailable: boolean;
}

/** All available connectors + whether the native runtime bridge is present. */
export function useConnectors(): SdkConnectors {
  return useMemo(() => {
    const client = getConnectorClient();
    return { list: () => client.list(), nativeAvailable: client.isNativeAvailable() };
  }, []);
}

/** Toast helpers (success/error/warning/info). */
export function useToast() {
  return toast;
}

export interface SdkNavigation {
  goHome: () => void;
  goToForm: (formId: string, options?: { new?: boolean }) => void;
}

/** Navigation within the app runtime (mounted at /app/:slug). */
export function useAppNavigation(): SdkNavigation {
  const navigate = useNavigate();
  const slug = useAppRuntimeStore((s) => s.appSlug);
  return useMemo(
    () => ({
      goHome: () => navigate(`/app/${slug}`),
      goToForm: (formId, options) => navigate(`/app/${slug}/form/${formId}${options?.new ? '?new=1' : ''}`),
    }),
    [navigate, slug]
  );
}

/** The runtime surface (platform / custom-domain / native) + native availability. */
export function useRuntimeEnvironment(): RuntimeEnvironment {
  // Detect once per mount; the host mode does not change during a session.
  const [env] = useState<RuntimeEnvironment>(() => detectRuntimeEnvironment());
  return env;
}

export interface SdkOfflineQueue {
  /** Items waiting to sync (not yet failed). */
  pending: number;
  /** Items that failed to sync and are kept for retry. */
  failed: number;
  /** A flush is in progress. */
  syncing: boolean;
  /** Last flush error, if any. */
  lastError: string | null;
  /** The device is currently offline. */
  offline: boolean;
  /** True when there is queued work OR the device is offline (something to show the user). */
  enabled: boolean;
  /** Attempt to deliver all queued submissions now. */
  flush: () => Promise<void>;
}

/**
 * Real offline submission queue status. Reports the browser IndexedDB queue (populated when a submit is
 * made offline — see appRuntimeStore.createResponse), merged with the native runtime's persistent queue
 * when the bridge is present, plus a flush() action. Auto-flushes on reconnect.
 */
export function useOfflineQueue(): SdkOfflineQueue {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [counts, setCounts] = useState<{ pending: number; failed: number }>({ pending: 0, failed: 0 });
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // Keep the latest refresh fn so flush() can re-read counts after it finishes.
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setSyncing(isFlushing());
      // Merge the browser IndexedDB queue with the native runtime's persistent queue (both
      // pending AND failed) so the SDK surface reflects everything waiting to sync.
      Promise.all([queueCounts(), nativeQueueCounts()])
        .then(([browser, native]) => {
          if (cancelled) return;
          setCounts({
            pending: browser.pending + native.pending,
            failed: browser.failed + native.failed,
          });
        })
        .catch(() => {});
    };
    refreshRef.current = refresh;
    const unsub = subscribeQueue(refresh);
    refresh();
    const on = () => { setOnline(true); refresh(); };
    const off = () => { setOnline(false); refresh(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const flush = useCallback(async () => {
    setLastError(null);
    // Flush BOTH the browser and native queues in one action (contract FU-3/#9).
    const r = await flushAllQueues();
    const failed = r.browser.failed + r.native.failed;
    if (failed > 0) {
      setLastError(`${failed} submission${failed === 1 ? '' : 's'} failed to sync`);
    } else if (r.lastError) {
      setLastError(r.lastError);
    }
    refreshRef.current();
  }, []);

  return {
    pending: counts.pending,
    failed: counts.failed,
    syncing,
    lastError,
    offline: !online,
    enabled: counts.pending > 0 || counts.failed > 0 || !online,
    flush,
  };
}

/** The current app's settings object (empty object before load). */
export function useSettings(): Record<string, unknown> {
  return useAppRuntimeStore((s) => (s.config?.app.settings as Record<string, unknown> | undefined) ?? EMPTY_OBJ);
}
/** Alias of useSettings (app-scoped settings). */
export const useAppSettings = useSettings;

/** The current app's theme object (colors) for screens that want to match the app. */
export function useAppTheme(): Record<string, unknown> {
  return useAppRuntimeStore((s) => (s.config?.app.theme as Record<string, unknown> | undefined) ?? EMPTY_OBJ);
}

/** A single response by id (from the recent set for `formKey`), or null. */
export function useResponse(formKey: string, id: string): SdkResponseRow | null {
  const { rows } = useResponses(formKey, { limit: 100 });
  return rows.find((r) => r.id === id) ?? null;
}

/** Live status for a connector (fetched once on mount / when the connector changes). */
export function useConnectorStatus(connectorId: string): ConnectorStatusInfo | null {
  const connector = useConnector(connectorId);
  const [status, setStatus] = useState<ConnectorStatusInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(connector.status()).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [connector]);
  return status;
}

export interface SdkConnectorPermission {
  /** True when the `command` passed to the hook is granted. */
  granted: boolean;
  /** Check an arbitrary command against the app's declared connector grants. */
  can: (command: string) => boolean;
}
/** Whether the app has been granted a connector command (mirrors the useConnector gate). */
export function useConnectorPermission(
  connectorId: string,
  command?: string,
  options?: { formId?: string }
): SdkConnectorPermission {
  const config = useAppRuntimeStore((s) => s.config);
  const formId = options?.formId;
  return useMemo(() => {
    const grants = collectConnectorGrants(config, formId != null ? { formId } : undefined);
    const can = (cmd: string) => isPermissionGranted(`connector.${connectorId}.${cmd}`, grants);
    return { granted: command ? can(command) : false, can };
  }, [config, connectorId, command, formId]);
}

export interface SdkNativeRuntime {
  available: boolean;
  info: NativeRuntimeInfo | null;
  environment: RuntimeEnvironment;
}
/** Native runtime presence + info (info is null in a plain browser). */
export function useNativeRuntime(): SdkNativeRuntime {
  const environment = useRuntimeEnvironment();
  const [info, setInfo] = useState<NativeRuntimeInfo | null>(null);
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.FormLogicNative : undefined;
    if (!bridge?.available) return;
    let cancelled = false;
    bridge.runtime.getInfo().then((i) => { if (!cancelled) setInfo(i); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return { available: getConnectorClient().isNativeAvailable(), info, environment };
}

export interface SdkManifest {
  payload: Record<string, unknown>;
  signature: string;
  alg: string;
  keyId: string;
}
export interface UseAppManifestResult {
  manifest: SdkManifest | null;
  loading: boolean;
  error: string | null;
}
/** The app's signed client manifest (display/native/offline capabilities). */
export function useAppManifest(): UseAppManifestResult {
  const slug = useAppRuntimeStore((s) => s.appSlug);
  const [manifest, setManifest] = useState<SdkManifest | null>(null);
  // Init from slug presence so we never setState synchronously in the effect (no slug → not loading).
  const [loading, setLoading] = useState<boolean>(!!slug);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!slug) return () => { cancelled = true; };
    const apply = (res: { data?: unknown; error?: string }) => {
      if (cancelled) return;
      if (res.data) setManifest(res.data as SdkManifest);
      else setError(typeof res.error === 'string' ? res.error : 'Failed to load manifest');
      setLoading(false);
    };
    const loadBySlug = () =>
      api.getClientManifest(slug)
        .then(apply)
        .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed'); setLoading(false); } });
    // On a CUSTOM domain, prefer the same-origin /.well-known/formlogic-app.json discovery
    // manifest: it is domain-bound (source/install links point at THIS origin) rather than the
    // platform-origin slug manifest. Fall back to the slug route when the well-known fetch
    // 404s/fails (e.g. a split deploy without the root rewrite). Platform + native hosts keep
    // the slug route unchanged.
    if (detectRuntimeEnvironment().hostMode === 'custom-domain') {
      api.getWellKnownManifest()
        .then((res) => {
          if (cancelled) return;
          // The well-known manifest is DOMAIN-bound (the app connected to this custom domain). Only
          // apply it when it describes the app THIS runtime is actually running — under /app/{other}
          // on the same domain the domain app's manifest would be the wrong app's identity/capabilities.
          const wkPayload = (res.data as SdkManifest | undefined)?.payload as { appSlug?: unknown } | undefined;
          if (res.data && wkPayload?.appSlug === slug) apply(res);
          else void loadBySlug();
        })
        .catch(() => { if (!cancelled) void loadBySlug(); });
    } else {
      void loadBySlug();
    }
    return () => { cancelled = true; };
  }, [slug]);
  return { manifest, loading, error };
}
