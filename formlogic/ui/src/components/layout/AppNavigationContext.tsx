import { useState, type ReactNode } from 'react';
import { AppSectionNavigation, SetAppSectionNavigation, type AppSidebarNavigation } from './useAppSectionSidebar';

export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const [navigation, setNavigation] = useState<AppSidebarNavigation | null>(null);
  return (
    <SetAppSectionNavigation.Provider value={setNavigation}>
      <AppSectionNavigation.Provider value={navigation}>{children}</AppSectionNavigation.Provider>
    </SetAppSectionNavigation.Provider>
  );
}
