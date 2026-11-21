import { Suspense, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { viewerOwnsApp } from '../../types/app';
import { AppSectionBar } from '../apps/AppSectionBar';
import { appSectionAt, sectionForAppItems } from './appSectionNavigation';
import { useFormsWorkspaceNavigation } from './useFormsWorkspaceNavigation';
import { AppManagementHeader, AppNavigationGuard, useAppSectionSidebar } from './useAppSectionSidebar';

/** Standalone management tools share the app dock and the section picker underneath their header. */
export function AppManagementPages() {
  const { appId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const guard = useRef<((to: string) => void) | null>(null);
  const app = useAppStore(state => state.apps.find(item => item.id === appId));
  const userId = useAuthStore(state => state.user?.id);
  const location = appSectionAt(pathname);
  useEffect(() => {
    // The sidebar and some tools already refresh the app list. A direct mobile or horizontal
    // dock entry also needs an identity when neither of those has requested it.
    const state = useAppStore.getState();
    if (appId && !state.isLoading && !state.apps.some(item => item.id === appId)) void state.fetchApps();
  }, [appId]);

  const manages = viewerOwnsApp(app, userId);
  const hasWebApp = app?.settings?.softnApp === true;
  const items = useFormsWorkspaceNavigation(appId, { hasWebApp, canManage: manages, hasForms: app?.formCount !== 0 });
  const leave = (to: string) => { if (guard.current) guard.current(to); else navigate(to); };
  const hasSidebar = useAppSectionSidebar(app, items.length ? items : null, leave);
  const section = sectionForAppItems(items, pathname);
  const parent = items.find(item => item.value === section);
  const trail = items.length && location?.detail && app
    ? [
      { label: app.name, to: items[0].to },
      ...(parent && parent.to !== pathname && parent.label !== location.detail ? [{ label: parent.label, to: parent.to }] : []),
      { label: parent?.to === pathname ? parent.label : location.detail },
    ] : [];
  const bar = location && trail.length > 0 ? (
    <div className="px-4 pt-3 sm:px-6">
      <AppSectionBar items={items} section={section} trail={trail} hasSidebar={hasSidebar} onLeave={leave} />
    </div>
  ) : null;

  return <AppNavigationGuard.Provider value={guard}>
    <AppManagementHeader.Provider value={bar}>
      <Suspense fallback={
        <div className="flex items-center justify-center py-32" role="status" aria-label="Loading">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-600" />
        </div>
      }>
        <Outlet />
      </Suspense>
    </AppManagementHeader.Provider>
  </AppNavigationGuard.Provider>;
}
