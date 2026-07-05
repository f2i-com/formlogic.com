// FormLogic SDK — hooks.
//
// A thin, permission-aware wrapper over the app runtime store (and auth store)
// so custom screens / AI-generated UI can read app data and act on it without
// touching raw API endpoints, the runtime store internals, or the native bridge
// (spec §27). Every hook respects the same permissions the runtime enforces; the
// server stays authoritative. These are the same capabilities the sandboxed
// custom-screen SDK exposes, made available to host-rendered React screens.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { getConnectorClient } from '../client-runtime/connectors/nativeConnectorClient';
import { detectRuntimeEnvironment, type RuntimeEnvironment } from '../client-runtime/detectEnvironment';
import type { ConnectorStatusInfo, ConnectorSummary } from '../client-runtime/connectors/connectorTypes';
import type { App, AppRuntimeForm, PermissionAction } from '../types/app';

const EMPTY_FORMS: AppRuntimeForm[] = [];

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

/** A connector handle (native bridge when available, else the browser mock). */
export function useConnector(connectorId: string): SdkConnector {
  return useMemo(() => {
    const client = getConnectorClient();
    return {
      id: connectorId,
      request: (command, payload) => client.request(connectorId, command, payload),
      status: () => client.status(connectorId),
    };
  }, [connectorId]);
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
  pending: number;
  enabled: boolean;
}

/**
 * Offline submission queue status. Full offline sync is a later milestone; today
 * this reports the browser's online state so screens can show an offline notice.
 */
export function useOfflineQueue(): SdkOfflineQueue {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return { pending: 0, enabled: !online };
}
