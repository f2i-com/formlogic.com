import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import type { App, AppForm, AppRole, AppVersion } from '../../types/app';
import type { AppDomain } from '../../lib/api';
import type { Form } from '../../types/form';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import type { Blueprint } from '../../types/blueprints';

export interface StudioData {
  app: App | null;
  /** True once the app fetch settled (distinguishes "loading" from "not found"). */
  appLoaded: boolean;
  appForms: AppForm[];
  /** Full form records (fields included) keyed by formId; absent while loading. */
  formsById: Record<string, Form>;
  flows: FlowDefinition[];
  bindings: FlowBinding[];
  roles: AppRole[];
  blueprint: Blueprint | null;
  versions: AppVersion[];
  domains: AppDomain[];
  memberCount: number;
  loading: boolean;
  reload: () => Promise<void>;
  reloadFlows: () => Promise<void>;
  reloadForms: () => Promise<void>;
  reloadApp: () => Promise<void>;
}

/**
 * One data hub for the App Studio: the app record plus everything the six steps
 * summarize (forms with fields, flows + bindings, roles, the linked diagram,
 * publish history, domains, member count). Fetches run in parallel and each
 * section exposes a targeted reload so steps can refresh what they changed.
 */
export function useStudioData(appId: string | undefined): StudioData {
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const [app, setApp] = useState<App | null>(null);
  const [appLoaded, setAppLoaded] = useState(false);
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [formsById, setFormsById] = useState<Record<string, Form>>({});
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [bindings, setBindings] = useState<FlowBinding[]>([]);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [domains, setDomains] = useState<AppDomain[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const reloadApp = useCallback(async () => {
    if (!appId) return;
    const res = await api.getApp(appId);
    setApp((res.data?.app as App) ?? null);
    setAppLoaded(true);
  }, [appId]);

  const reloadForms = useCallback(async () => {
    if (!appId) return;
    const res = await api.getAppForms(appId);
    const attachments = (res.data?.forms ?? []) as AppForm[];
    setAppForms(attachments);
    // Full form records for field lists — fetched individually (the owner forms
    // list may be stale or lack this form when it came from a pack install).
    const full = await Promise.all(
      attachments.map(async (af) => (await api.getForm(af.formId)).data?.form ?? null)
    );
    const map: Record<string, Form> = {};
    for (const form of full) {
      if (form) map[form.id] = form;
    }
    setFormsById(map);
  }, [appId]);

  const reloadFlows = useCallback(async () => {
    if (!appId) return;
    const [flowsRes, bindingsRes] = await Promise.all([
      api.listFlows(appId),
      api.listFlowBindings(appId),
    ]);
    setFlows((flowsRes.data?.flows ?? []) as FlowDefinition[]);
    setBindings((bindingsRes.data?.bindings ?? []) as FlowBinding[]);
  }, [appId]);

  const reloadAux = useCallback(async () => {
    if (!appId) return;
    const [rolesList, blueprintsRes, versionsRes, domainsRes, usersRes] = await Promise.all([
      fetchRoles(appId),
      api.listBlueprints(),
      api.listAppVersions(appId),
      api.getAppDomains(appId),
      api.getAppUsers(appId),
    ]);
    setRoles(rolesList);
    const linked = (blueprintsRes.data?.blueprints ?? []).find((b) => b.appId === appId) ?? null;
    setBlueprint(linked);
    setVersions(versionsRes.data?.versions ?? []);
    setDomains(domainsRes.data?.domains ?? []);
    const users = (usersRes.data?.users ?? []) as Array<{ status?: string }>;
    setMemberCount(users.filter((u) => u.status !== 'suspended').length);
  }, [appId, fetchRoles]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([reloadApp(), reloadForms(), reloadFlows(), reloadAux()]);
    } finally {
      setLoading(false);
    }
  }, [reloadApp, reloadForms, reloadFlows, reloadAux]);

  useEffect(() => {
    setApp(null);
    setAppLoaded(false);
    setAppForms([]);
    setFormsById({});
    setFlows([]);
    setBindings([]);
    setRoles([]);
    setBlueprint(null);
    setVersions([]);
    setDomains([]);
    setMemberCount(0);
    void reload();
  }, [reload]);

  return useMemo(
    () => ({
      app,
      appLoaded,
      appForms,
      formsById,
      flows,
      bindings,
      roles,
      blueprint,
      versions,
      domains,
      memberCount,
      loading,
      reload,
      reloadFlows,
      reloadForms,
      reloadApp,
    }),
    [app, appLoaded, appForms, formsById, flows, bindings, roles, blueprint, versions, domains, memberCount, loading, reload, reloadFlows, reloadForms, reloadApp]
  );
}
