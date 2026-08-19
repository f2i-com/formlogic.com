import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { App, AppForm, AppRole, AppVersion } from '../../types/app';
import type { AppDomain } from '../../lib/api';
import type { Form } from '../../types/form';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import type { Blueprint } from '../../types/blueprints';

/** Stable empties so consumers never see a fresh array identity per render. */
const NO_FORM_IDS: string[] = [];

export interface StudioData {
  app: App | null;
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
  const [app, setApp] = useState<App | null>(null);
  const [appLoaded, setAppLoaded] = useState(false);
  const [appError, setAppError] = useState<{ kind: 'notFound' | 'error'; message: string } | null>(null);
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [formsById, setFormsById] = useState<Record<string, Form>>({});
  const [unreadableFormIds, setUnreadableFormIds] = useState<string[]>(NO_FORM_IDS);
  const [formsResolving, setFormsResolving] = useState(true);
  const [formsFailed, setFormsFailed] = useState(false);
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [bindings, setBindings] = useState<FlowBinding[]>([]);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [domains, setDomains] = useState<AppDomain[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [auxFailed, setAuxFailed] = useState(false);
  const [versionsFailed, setVersionsFailed] = useState(false);
  const [domainsFailed, setDomainsFailed] = useState(false);
  const [membersFailed, setMembersFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const reloadApp = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const res = await api.getApp(appId);
    if (token !== loadToken.current) return;
    if (res.error || !res.data?.app) {
      const message = typeof res.error === 'string' ? res.error : 'Could not load this app.';
      // Only a definitive 404/403 from the server may claim the app is gone; `status` is
      // undefined on transport failures, which are retryable (lib/api.ts ApiResponse).
      const missing = res.status === 404 || res.status === 403;
      setAppError({ kind: missing ? 'notFound' : 'error', message });
      setAppLoaded(true);
      return;
    }
    setAppError(null);
    setApp(res.data.app as App);
    setAppLoaded(true);
  }, [appId]);

  const reloadForms = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    setFormsResolving(true);
    try {
      const res = await api.getAppForms(appId);
      if (token !== loadToken.current) return;
      if (res.error || !res.data) {
        // Unknown, not zero: committing [] here made the studio claim the app was
        // empty and disabled Publish behind a "No data types yet" blocking check.
        setFormsFailed(true);
        return;
      }
      setFormsFailed(false);
      const attachments = (res.data.forms ?? []) as AppForm[];
      setAppForms(attachments);
      // Full form records for field lists — fetched individually (the owner forms list may be
      // stale or lack this form when it came from a pack install). One failure must not take
      // the others down, and must not masquerade as "this app has no data types".
      const full = await Promise.all(
        attachments.map(async (af) => {
          try {
            const one = await api.getForm(af.formId);
            return one.data?.form ?? null;
          } catch {
            return null;
          }
        })
      );
      if (token !== loadToken.current) return;
      const map: Record<string, Form> = {};
      const unreadable: string[] = [];
      attachments.forEach((af, index) => {
        const form = full[index];
        if (form) map[form.id] = form;
        else unreadable.push(af.formId);
      });
      setFormsById(map);
      setUnreadableFormIds(unreadable.length > 0 ? unreadable : NO_FORM_IDS);
    } finally {
      if (token === loadToken.current) setFormsResolving(false);
    }
  }, [appId]);

  const reloadFlows = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const [flowsRes, bindingsRes] = await Promise.all([
      api.listFlows(appId),
      api.listFlowBindings(appId),
    ]);
    if (token !== loadToken.current) return;
    if (!flowsRes.error) setFlows((flowsRes.data?.flows ?? []) as FlowDefinition[]);
    if (!bindingsRes.error) setBindings((bindingsRes.data?.bindings ?? []) as FlowBinding[]);
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
    if (next) setRoles(next);
    else setAuxFailed(true);
  }, [readRoles]);

  const reloadAux = useCallback(async () => {
    if (!appId) return;
    const token = loadToken.current;
    const [rolesList, blueprintsRes, versionsRes, domainsRes, usersRes] = await Promise.all([
      readRoles(),
      api.listBlueprints(),
      api.listAppVersions(appId),
      api.getAppDomains(appId),
      api.getAppUsers(appId),
    ]);
    if (token !== loadToken.current) return;

    // A failed supporting fetch keeps the previous value and raises auxFailed — writing 0 here
    // is what makes a twenty-member app advertise "Invite your first member".
    let failed = false;
    if (rolesList) setRoles(rolesList);
    else failed = true;
    if (!blueprintsRes.error) {
      setBlueprint((blueprintsRes.data?.blueprints ?? []).find((b) => b.appId === appId) ?? null);
    }
    // Tracked separately: one coarse flag meant a dropped VERSIONS request surfaced
    // to the user as "Members not loaded", and an empty release log looked like a
    // fact rather than a failure.
    setVersionsFailed(!!versionsRes.error);
    setDomainsFailed(!!domainsRes.error);
    setMembersFailed(!!usersRes.error);
    if (versionsRes.error) failed = true;
    else setVersions(versionsRes.data?.versions ?? []);
    if (domainsRes.error) failed = true;
    else setDomains(domainsRes.data?.domains ?? []);
    if (usersRes.error) {
      failed = true;
    } else {
      const users = (usersRes.data?.users ?? []) as Array<{ status?: string }>;
      setMemberCount(users.filter((u) => u.status !== 'suspended').length);
    }
    setAuxFailed(failed);
  }, [appId, readRoles]);

  const reload = useCallback(async () => {
    const token = loadToken.current;
    setLoading(true);
    try {
      await Promise.all([reloadApp(), reloadForms(), reloadFlows(), reloadAux()]);
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [reloadApp, reloadForms, reloadFlows, reloadAux]);

  useEffect(() => {
    // A new app invalidates every request already in flight for the previous one.
    loadToken.current += 1;
    setApp(null);
    setAppLoaded(false);
    setAppError(null);
    setAppForms([]);
    setFormsById({});
    setUnreadableFormIds(NO_FORM_IDS);
    setFormsResolving(true);
    setFormsFailed(false);
    setFlows([]);
    setBindings([]);
    setRoles([]);
    setBlueprint(null);
    setVersions([]);
    setDomains([]);
    setMemberCount(0);
    setAuxFailed(false);
    void reload();
  }, [reload]);

  return useMemo(
    () => ({
      app,
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
    [app, appLoaded, appError, appForms, formsById, unreadableFormIds, formsResolving, formsFailed, flows, bindings, roles, blueprint, versions, domains, memberCount, auxFailed, versionsFailed, domainsFailed, membersFailed, loading, reload, reloadFlows, reloadForms, reloadApp, reloadRoles]
  );
}
