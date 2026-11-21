import { deferEffect } from '../../lib/deferredEffect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { currentSessionGeneration, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { useAppStore } from '../../stores/appStore';
import type { App, AppForm, AppRole, AppVersion } from '../../types/app';
import type { AppDomain } from '../../lib/api';
import type { Form } from '../../types/form';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import type { Blueprint } from '../../types/blueprints';

/** Stable empties so consumers never see a fresh array identity per render. */
const NO_FORM_IDS: string[] = [];

interface StudioCacheEntry {
  generation: number;
  updatedAt: number;
  app: App | null;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  unreadableFormIds: string[];
  flows: FlowDefinition[];
  bindings: FlowBinding[];
  roles: AppRole[];
  blueprint: Blueprint | null;
  versions: AppVersion[];
  domains: AppDomain[];
  memberCount: number;
}

const STUDIO_CACHE_FRESH_MS = 30_000;
const STUDIO_CACHE_MAX = 16;
const studioCache = new Map<string, StudioCacheEntry>();
subscribeSessionGeneration(() => studioCache.clear());

function readStudioCache(appId: string | undefined): StudioCacheEntry | null {
  if (!appId) return null;
  const entry = studioCache.get(appId);
  if (!entry || entry.generation !== currentSessionGeneration()) return null;
  return entry;
}

function patchStudioCache(appId: string | undefined, patch: Partial<StudioCacheEntry>): void {
  if (!appId) return;
  const gen = currentSessionGeneration();
  const prev = readStudioCache(appId);
  const next: StudioCacheEntry = {
    generation: gen,
    updatedAt: Date.now(),
    app: prev?.app ?? null,
    appForms: prev?.appForms ?? [],
    formsById: prev?.formsById ?? {},
    unreadableFormIds: prev?.unreadableFormIds ?? NO_FORM_IDS,
    flows: prev?.flows ?? [],
    bindings: prev?.bindings ?? [],
    roles: prev?.roles ?? [],
    blueprint: prev?.blueprint ?? null,
    versions: prev?.versions ?? [],
    domains: prev?.domains ?? [],
    memberCount: prev?.memberCount ?? 0,
    ...patch,
  };
  studioCache.delete(appId);
  studioCache.set(appId, next);
  if (studioCache.size > STUDIO_CACHE_MAX) {
    const oldestKey = studioCache.keys().next().value;
    if (oldestKey) studioCache.delete(oldestKey);
  }
}

export function getCachedStudioAppForms(appId: string | undefined): { forms: AppForm[]; fresh: boolean } | null {
  const entry = readStudioCache(appId);
  if (!entry || entry.appForms.length === 0) return null;
  return { forms: entry.appForms, fresh: Date.now() - entry.updatedAt < STUDIO_CACHE_FRESH_MS };
}

export function setCachedStudioAppForms(appId: string | undefined, forms: AppForm[]): void {
  patchStudioCache(appId, { appForms: forms });
}

export function getCachedStudioRoles(appId: string | undefined): { roles: AppRole[]; fresh: boolean } | null {
  const entry = readStudioCache(appId);
  if (!entry || entry.roles.length === 0) return null;
  return { roles: entry.roles, fresh: Date.now() - entry.updatedAt < STUDIO_CACHE_FRESH_MS };
}

export interface StudioData {
  app: App | null;
  /** True until this app’s initial parallel load settles; later refreshes keep editors mounted. */
  initialLoading: boolean;
  /** True once the app fetch settled (distinguishes "loading" from a resolved outcome). */
  appLoaded: boolean;
  /**
   * Why the app could not be loaded. `notFound` means the server said so; `error` is a
   * transport/server failure that a retry may fix. Rendering the two the same way tells
   * an owner with a flaky connection that their app was deleted.
   */
  appError: { kind: 'notFound' | 'error'; message: string } | null;
  appForms: AppForm[];
  /** Full form records (fields included) keyed by formId; absent while loading. */
  formsById: Record<string, Form>;
  /** Attached forms whose record could not be loaded — they are NOT silently dropped. */
  unreadableFormIds: string[];
  /** True while the per-form records for the current attachments are still resolving. */
  formsResolving: boolean;
  /**
   * True when the attachment list itself could not be read. The app's data types are
   * then UNKNOWN, not zero — an empty list would otherwise make the studio assert the
   * app has no forms and block publish behind a bogus blocking check.
   */
  formsFailed: boolean;
  flows: FlowDefinition[];
  bindings: FlowBinding[];
  roles: AppRole[];
  blueprint: Blueprint | null;
  versions: AppVersion[];
  domains: AppDomain[];
  memberCount: number;
  /**
   * True when a supporting fetch (members / versions / domains) failed, so counts derived
   * from them are unknown rather than zero. Steps say "not loaded" instead of asserting 0.
   */
  auxFailed: boolean;
  /** The release-log read failed — an empty list is unknown, not "no releases". */
  versionsFailed: boolean;
  /** The custom-domain read failed — absence is unknown, not "no domain". */
  domainsFailed: boolean;
  /** The member read failed — the count is unknown, not zero. */
  membersFailed: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  reloadFlows: () => Promise<void>;
  reloadForms: () => Promise<void>;
  reloadApp: () => Promise<void>;
  /** Roles only — creating a role should not re-fetch the entire studio. */
  reloadRoles: () => Promise<void>;
}

/**
 * One data hub for the App Studio: the app record plus everything the six sections summarize
 * (forms with fields, flows + bindings, roles, the linked diagram, publish history, domains,
 * member count). Fetches run in parallel and each section exposes a targeted reload.
 *
 * Failures are kept, never flattened into an empty value: a dropped request must not be able
 * to make the studio assert "0 members", "no releases" or "this app does not exist".
 */
export function useStudioData(appId: string | undefined): StudioData {
  // Every fetch captures the token current when it started and drops its writes if the
  // token has moved on. Without it, a slow fan-out for app A lands on top of app B's
  // state after the user switches apps, and B then shows A's forms under B's name.
  const loadToken = useRef(0);
  const initialCache = readStudioCache(appId);
  const storeApp = appId ? useAppStore.getState().apps.find((a) => a.id === appId) ?? null : null;
  const [app, setApp] = useState<App | null>(() => initialCache?.app ?? storeApp);
  const [appLoaded, setAppLoaded] = useState<boolean>(() => !!(initialCache?.app));
  const [appError, setAppError] = useState<{ kind: 'notFound' | 'error'; message: string } | null>(null);
  const [appForms, setAppForms] = useState<AppForm[]>(() => initialCache?.appForms ?? []);
  const [formsById, setFormsById] = useState<Record<string, Form>>(() => initialCache?.formsById ?? {});
  const [unreadableFormIds, setUnreadableFormIds] = useState<string[]>(() => initialCache?.unreadableFormIds ?? NO_FORM_IDS);
  const [formsResolving, setFormsResolving] = useState<boolean>(() => !initialCache?.app);
  const [formsFailed, setFormsFailed] = useState(false);
  const [flows, setFlows] = useState<FlowDefinition[]>(() => initialCache?.flows ?? []);
  const [bindings, setBindings] = useState<FlowBinding[]>(() => initialCache?.bindings ?? []);
  const [roles, setRoles] = useState<AppRole[]>(() => initialCache?.roles ?? []);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(() => initialCache?.blueprint ?? null);
  const [versions, setVersions] = useState<AppVersion[]>(() => initialCache?.versions ?? []);
  const [domains, setDomains] = useState<AppDomain[]>(() => initialCache?.domains ?? []);
  const [memberCount, setMemberCount] = useState<number>(() => initialCache?.memberCount ?? 0);
  const [auxFailed, setAuxFailed] = useState(false);
  const [versionsFailed, setVersionsFailed] = useState(false);
  const [domainsFailed, setDomainsFailed] = useState(false);
  const [membersFailed, setMembersFailed] = useState(false);
  const [loading, setLoading] = useState<boolean>(() => !initialCache?.app);
  const [initialLoading, setInitialLoading] = useState<boolean>(() => !initialCache?.app);

  const reloadApp = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const gen = currentSessionGeneration();
    const res = await api.getApp(appId);
    if (token !== loadToken.current || !isSessionGenerationCurrent(gen)) return;
    if (res.error || !res.data?.app) {
      const message = typeof res.error === 'string' ? res.error : 'Could not load this app.';
      // Only a definitive 404/403 from the server may claim the app is gone; `status` is
      // undefined on transport failures, which are retryable (lib/api.ts ApiResponse).
      const missing = res.status === 404 || res.status === 403;
      setAppError({ kind: missing ? 'notFound' : 'error', message });
      setAppLoaded(true);
      return;
    }
    const nextApp = res.data.app as App;
    setAppError(null);
    setApp(nextApp);
    setAppLoaded(true);
    patchStudioCache(appId, { app: nextApp });
  }, [appId]);

  const reloadForms = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const gen = currentSessionGeneration();
    setFormsResolving(true);
    try {
      const res = await api.getAppForms(appId, { includeForms: true });
      if (token !== loadToken.current || !isSessionGenerationCurrent(gen)) return;
      if (res.error || !res.data) {
        // Unknown, not zero: committing [] here made the studio claim the app was
        // empty and disabled Publish behind a "No data types yet" blocking check.
        setFormsFailed(true);
        return;
      }
      setFormsFailed(false);
      const rawAttachments = (res.data.forms ?? []) as (AppForm & { form?: Form })[];
      const attachments: AppForm[] = rawAttachments.map((item) => {
        if ('form' in item) {
          const rest = { ...item };
          delete rest.form;
          return rest;
        }
        return item;
      });
      setAppForms(attachments);
      // Prefer full form records batched inline by GET /api/apps/{id}/forms?includeForms=1,
      // falling back to per-form api.getForm() only when a server/mock omits inline forms.
      const map: Record<string, Form> = {};
      const missingIds: AppForm[] = [];
      for (const item of rawAttachments) {
        if (item.form && typeof item.form === 'object' && 'id' in item.form) {
          map[item.form.id] = item.form;
        } else {
          missingIds.push(item);
        }
      }
      const unreadable: string[] = [];
      if (missingIds.length > 0) {
        const full = await Promise.all(
          missingIds.map(async (af) => {
            try {
              const one = await api.getForm(af.formId);
              return one.data?.form ?? null;
            } catch {
              return null;
            }
          })
        );
        if (token !== loadToken.current || !isSessionGenerationCurrent(gen)) return;
        missingIds.forEach((af, index) => {
          const form = full[index];
          if (form) map[form.id] = form;
          else unreadable.push(af.formId);
        });
      }
      const nextUnreadable = unreadable.length > 0 ? unreadable : NO_FORM_IDS;
      setFormsById(map);
      setUnreadableFormIds(nextUnreadable);
      patchStudioCache(appId, { appForms: attachments, formsById: map, unreadableFormIds: nextUnreadable });
    } finally {
      if (token === loadToken.current) setFormsResolving(false);
    }
  }, [appId]);

  const reloadFlows = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const gen = currentSessionGeneration();
    const [flowsRes, bindingsRes] = await Promise.all([
      api.listFlows(appId),
      api.listFlowBindings(appId),
    ]);
    if (token !== loadToken.current || !isSessionGenerationCurrent(gen)) return;
    const nextFlows = !flowsRes.error ? ((flowsRes.data?.flows ?? []) as FlowDefinition[]) : undefined;
    const nextBindings = !bindingsRes.error ? ((bindingsRes.data?.bindings ?? []) as FlowBinding[]) : undefined;
    if (nextFlows) setFlows(nextFlows);
    if (nextBindings) setBindings(nextBindings);
    if (nextFlows || nextBindings) {
      patchStudioCache(appId, {
        ...(nextFlows ? { flows: nextFlows } : {}),
        ...(nextBindings ? { bindings: nextBindings } : {}),
      });
    }
  }, [appId]);

  /**
   * Roles, read directly rather than through the store helper: that helper flattens a
   * failure into `[]`, which empties the role rail, blanks the Screens role picker and
   * makes the Access header claim "0 roles configured" on an app that has four.
   */
  const readRoles = useCallback(async (): Promise<AppRole[] | null> => {
    if (!appId) return null;
    const res = await api.getAppRoles(appId);
    if (res.error) return null;
    return (res.data?.roles ?? []) as AppRole[];
  }, [appId]);

  const reloadRoles = useCallback(async () => {
    const token = loadToken.current;
    const next = await readRoles();
    if (token !== loadToken.current) return;
    if (next) {
      setRoles(next);
      patchStudioCache(appId, { roles: next });
    } else {
      setAuxFailed(true);
    }
  }, [appId, readRoles]);

  const reloadAux = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const gen = currentSessionGeneration();
    const [rolesList, blueprintsRes, versionsRes, domainsRes, usersRes] = await Promise.all([
      readRoles(),
      api.listBlueprints(),
      api.listAppVersions(appId),
      api.getAppDomains(appId),
      api.getAppUsers(appId),
    ]);
    if (token !== loadToken.current || !isSessionGenerationCurrent(gen)) return;

    // A failed supporting fetch keeps the previous value and raises auxFailed — writing 0 here
    // is what makes a twenty-member app advertise "Invite your first member".
    let failed = false;
    const patch: Partial<StudioCacheEntry> = {};
    if (rolesList) {
      setRoles(rolesList);
      patch.roles = rolesList;
    } else {
      failed = true;
    }
    if (!blueprintsRes.error) {
      const bp = (blueprintsRes.data?.blueprints ?? []).find((b) => b.appId === appId) ?? null;
      setBlueprint(bp);
      patch.blueprint = bp;
    }
    // Tracked separately: one coarse flag meant a dropped VERSIONS request surfaced
    // to the user as "Members not loaded", and an empty release log looked like a
    // fact rather than a failure.
    setVersionsFailed(!!versionsRes.error);
    setDomainsFailed(!!domainsRes.error);
    setMembersFailed(!!usersRes.error);
    if (versionsRes.error) failed = true;
    else {
      const v = versionsRes.data?.versions ?? [];
      setVersions(v);
      patch.versions = v;
    }
    if (domainsRes.error) failed = true;
    else {
      const d = domainsRes.data?.domains ?? [];
      setDomains(d);
      patch.domains = d;
    }
    if (usersRes.error) {
      failed = true;
    } else {
      const users = (usersRes.data?.users ?? []) as Array<{ status?: string }>;
      const count = users.filter((u) => u.status !== 'suspended').length;
      setMemberCount(count);
      patch.memberCount = count;
    }
    setAuxFailed(failed);
    if (Object.keys(patch).length > 0) patchStudioCache(appId, patch);
  }, [appId, readRoles]);

  const reload = useCallback(async () => {
    const token = loadToken.current;
    setLoading(true);
    try {
      const primary = Promise.all([reloadApp(), reloadForms()]).then(() => {
        if (token === loadToken.current) {
          setInitialLoading(false);
        }
      });
      await Promise.all([primary, reloadFlows(), reloadAux()]);
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }, [reloadApp, reloadForms, reloadFlows, reloadAux]);

  // Reset before the new app renders; old requests are invalidated by effect cleanup.
  const [loadedAppId, setLoadedAppId] = useState(appId);
  if (loadedAppId !== appId) {
    setLoadedAppId(appId);
    const cached = readStudioCache(appId);
    const fallbackApp = appId ? useAppStore.getState().apps.find((a) => a.id === appId) ?? null : null;
    setApp(cached?.app ?? fallbackApp);
    setAppLoaded(!!(cached?.app));
    setAppError(null);
    setAppForms(cached?.appForms ?? []);
    setFormsById(cached?.formsById ?? {});
    setUnreadableFormIds(cached?.unreadableFormIds ?? NO_FORM_IDS);
    setFormsResolving(!cached?.app);
    setFormsFailed(false);
    setFlows(cached?.flows ?? []);
    setBindings(cached?.bindings ?? []);
    setRoles(cached?.roles ?? []);
    setBlueprint(cached?.blueprint ?? null);
    setVersions(cached?.versions ?? []);
    setDomains(cached?.domains ?? []);
    setMemberCount(cached?.memberCount ?? 0);
    setAuxFailed(false);
    setVersionsFailed(false);
    setDomainsFailed(false);
    setMembersFailed(false);
    setLoading(!cached?.app);
    setInitialLoading(!cached?.app);
  }
  useEffect(() => {
    loadToken.current += 1;
    const cached = readStudioCache(appId);
    if (cached?.app && Date.now() - cached.updatedAt < STUDIO_CACHE_FRESH_MS) {
      return () => { loadToken.current += 1; };
    }
    const cancelStart = deferEffect(() => { void reload(); });
    return () => {
      cancelStart();
      loadToken.current += 1;
    };
  }, [appId, reload]);

  return useMemo(
    () => ({
      app,
      initialLoading,
      appLoaded,
      appError,
      appForms,
      formsById,
      unreadableFormIds,
      formsResolving,
      formsFailed,
      flows,
      bindings,
      roles,
      blueprint,
      versions,
      domains,
      memberCount,
      auxFailed,
      versionsFailed,
      domainsFailed,
      membersFailed,
      loading,
      reload,
      reloadFlows,
      reloadForms,
      reloadApp,
      reloadRoles,
    }),
    [app, initialLoading, appLoaded, appError, appForms, formsById, unreadableFormIds, formsResolving, formsFailed, flows, bindings, roles, blueprint, versions, domains, memberCount, auxFailed, versionsFailed, domainsFailed, membersFailed, loading, reload, reloadFlows, reloadForms, reloadApp, reloadRoles]
  );
}
