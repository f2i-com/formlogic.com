// App → member-form grouping, shared by the Dashboard (app badges on form rows)
// and My Forms (the apps rail). Fetching this means one request per app, so the
// result is cached per user (see uiCache) and both pages hydrate instantly from
// the previous visit while a background refresh runs.
import { api } from './api';
import { loadUiCache, saveUiCache } from './uiCache';

export interface AppGroup {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  logoUrl: string | null;
  icon: string | null;
  accent: string | null;
  formIds: string[];
}

const CACHE_KEY = 'app-groups';

export function loadAppGroupsCache(userId: string | null | undefined): AppGroup[] | null {
  return loadUiCache<AppGroup[]>(CACHE_KEY, userId)?.data ?? null;
}

/** Fetch every app's identity + member form ids, refreshing the per-user cache. */
export async function fetchAppGroups(userId: string | null | undefined): Promise<AppGroup[]> {
  const res = await api.getApps();
  if (res.error) throw new Error(res.error);
  const apps = (res.data?.apps || []) as Array<{
    id: string;
    name: string;
    slug?: string | null;
    description?: string | null;
    logoUrl?: string | null;
    settings?: { icon?: string | null; softnApp?: boolean } | null;
    theme?: { primaryColor?: string | null } | null;
    /** How many forms the app holds, from the list itself; absent from an older server. */
    formCount?: number;
  }>;
  // A hosted SoftN app is not a place for forms: with none it is no group here, where it used to
  // stand on the Forms page as "0 forms" beside the apps that do hold forms. (One given forms in
  // its App Studio is still listed.) And an app the list says holds no form is not asked for its
  // forms: an owner of eleven SoftN apps paid eleven requests for eleven empty answers.
  const holders = apps.filter((a) => a.settings?.softnApp !== true || (a.formCount ?? 0) > 0);
  const groups: AppGroup[] = await Promise.all(holders.map(async (a) => {
    const fr = a.formCount === 0 ? null : await api.getAppForms(a.id);
    const formIds = ((fr?.data?.forms || []) as Array<{ formId: string }>).map((f) => f.formId);
    return {
      id: a.id,
      name: a.name,
      slug: a.slug ?? null,
      description: a.description ?? null,
      logoUrl: a.logoUrl ?? null,
      icon: a.settings?.icon ?? null,
      accent: a.theme?.primaryColor ?? null,
      formIds,
    };
  }));
  saveUiCache(CACHE_KEY, userId, groups);
  return groups;
}
