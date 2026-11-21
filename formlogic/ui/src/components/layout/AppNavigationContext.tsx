import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { appSectionAt } from './appSectionNavigation';
import {
  AppNavigationControl,
  AppSectionNavigation,
  SetAppSectionNavigation,
  type AppSidebarNavigation,
} from './useAppSectionSidebar';

export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const [navigation, setNavigation] = useState<AppSidebarNavigation | null>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const pathnameRef = useRef(pathname);
  const navigateRef = useRef(navigate);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
    navigateRef.current = navigate;
  }, [pathname, navigate]);

  const loc = appSectionAt(pathname);
  const activeNavigation = navigation && loc && loc.appId === navigation.app.id ? navigation : null;

  const control = useMemo(() => ({
    register(next: AppSidebarNavigation) {
      setNavigation(next);
    },
    clear(prev: AppSidebarNavigation) {
      setNavigation((current) => (current === prev ? null : current));
    },
    releaseOnUnmount(prev: AppSidebarNavigation) {
      setNavigation((current) => {
        if (current !== prev) return current;
        // Keep the app's sidebar menu persistent across intra-app route transitions
        // (e.g. Studio ↔ Records ↔ Settings ↔ Web) while the incoming lazy page loads,
        // replacing the unmounted page's leave guard with plain navigation.
        const currentLoc = appSectionAt(pathnameRef.current);
        if (currentLoc && currentLoc.appId === prev.app.id) {
          return {
            app: prev.app,
            items: prev.items,
            leave: (to: string) => navigateRef.current(to),
          };
        }
        return null;
      });
    },
  }), []);

  return (
    <AppNavigationControl.Provider value={control}>
      <SetAppSectionNavigation.Provider value={setNavigation}>
        <AppSectionNavigation.Provider value={activeNavigation}>{children}</AppSectionNavigation.Provider>
      </SetAppSectionNavigation.Provider>
    </AppNavigationControl.Provider>
  );
}
