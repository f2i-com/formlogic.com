import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { currentSessionGeneration, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { useAuthStore } from '../../stores/authStore';
import { formsNavigationItems } from './appSectionNavigation';
import { softnNavigationItems, type WorkspaceAccess } from './softnNavigation';

type ProjectCapabilities = Pick<WorkspaceAccess, 'backend' | 'liveBackend' | 'managesMembers'>;
type SavedCapabilities = { appId: string; userId: string; generation: number; checkedAt: number; value: ProjectCapabilities | null };

// Held in memory for transitions between the two editors. A session change drops the
// entire map; it contains only capability flags, never project files or responses.
const recent = new Map<string, SavedCapabilities>();
subscribeSessionGeneration(() => recent.clear());
const REFRESH_AFTER_MS = 60_000;

export function useHostedWorkspaceNavigation(appId: string, access: WorkspaceAccess, ready: boolean) {
  const userId = useAuthStore(state => state.user?.id);
  const { backend, liveBackend, isOwner, managesMembers, hasForms } = access;
  useEffect(() => {
    if (ready && isOwner && userId) recent.set(appId, {
      appId, userId, generation: currentSessionGeneration(), checkedAt: Date.now(),
      // Crossing to another editor discards draft-only source changes.
      value: { backend: liveBackend, liveBackend, managesMembers },
    });
  }, [appId, ready, isOwner, userId, liveBackend, managesMembers]);
  return useMemo(() => softnNavigationItems(appId, { backend, liveBackend, isOwner, managesMembers, hasForms }),
    [appId, backend, liveBackend, isOwner, managesMembers, hasForms]);
}

export function useFormsWorkspaceNavigation(appId: string | undefined, { hasWebApp, canManage, hasForms = true }: { hasWebApp: boolean; canManage: boolean; hasForms?: boolean }) {
  const userId = useAuthStore(state => state.user?.id);
  const demo = useAuthStore(state => !!state.user?.isDemo);
  const generation = currentSessionGeneration();
  const [loaded, setLoaded] = useState<SavedCapabilities | null>(null);
  const eligible = !!appId && !!userId && hasWebApp && canManage && !demo;

  useEffect(() => {
    if (!eligible) return;
    const cached = recent.get(appId);
    if (cached?.userId === userId && cached.generation === generation && Date.now() - cached.checkedAt < REFRESH_AFTER_MS) return;
    const stop = new AbortController();
    void api.getAppsSummary(stop.signal).then(result => {
      if (stop.signal.aborted || !isSessionGenerationCurrent(generation)) return;
      const app = result.data?.apps?.[appId];
      if (result.error || !result.data) return;
      const saved: SavedCapabilities = {
        appId, userId, generation, checkedAt: Date.now(),
        value: app?.installed ? { backend: app.backend, liveBackend: app.backend, managesMembers: true } : null,
      };
      recent.set(appId, saved);
      setLoaded(saved);
    }).catch(() => { /* A legacy or unavailable summary leaves the known tools usable. */ });
    return () => stop.abort();
  }, [appId, userId, eligible, generation]);

  const candidate = loaded && loaded.appId === appId && loaded.userId === userId && loaded.generation === generation ? loaded : recent.get(appId ?? '');
  const value = eligible && candidate?.userId === userId && candidate?.generation === generation ? candidate.value : undefined;
  return useMemo(() => {
    if (!appId || !canManage) return [];
    if (value) return softnNavigationItems(appId, { ...value, isOwner: true, hasForms });
    return formsNavigationItems(appId, { hasWebApp });
  }, [appId, canManage, value, hasWebApp, hasForms]);
}
