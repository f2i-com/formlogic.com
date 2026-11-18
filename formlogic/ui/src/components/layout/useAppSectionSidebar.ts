import { createContext, useContext, useLayoutEffect, useRef, type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction } from 'react';
import type { App } from '../../types/app';
import { appSectionAt, sectionForAppItems, type AppSectionItem } from './appSectionNavigation';

export interface AppSidebarNavigation {
  app: App;
  items: readonly AppSectionItem[];
  leave: (to: string) => void;
}

export const AppSectionNavigation = createContext<AppSidebarNavigation | null>(null);
export const SetAppSectionNavigation = createContext<Dispatch<SetStateAction<AppSidebarNavigation | null>> | null>(null);
export const AppManagementHeader = createContext<ReactNode>(null);

export function useScopedAppNavigation(pathname: string) {
  const registered = useContext(AppSectionNavigation);
  const location = appSectionAt(pathname);
  if (!registered || !location || registered.app.id !== location.appId) return null;
  const web = registered.items[0]?.value === 'overview';
  const mixed = registered.items.some(item => item.value === 'forms');
  return mixed || !!location.detail || (location.area === 'web') === web
    ? { navigation: registered, section: sectionForAppItems(registered.items, pathname) } : null;
}

/** A link inside the hosted project preserves its in-memory draft. Crossing workspaces
 * unmounts the editor. Let the current page run its existing save/discard flow. */
export function followAppLink(event: MouseEvent<HTMLAnchorElement>, to: string, pathname: string, leave?: (to: string) => void) {
  if (!leave || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const current = appSectionAt(pathname);
  const next = appSectionAt(to);
  if (current?.area === 'web' && next?.area === 'web' && current.appId === next.appId) return;
  event.preventDefault();
  if (to !== pathname) leave(to);
}

export const AppNavigationGuard = createContext<RefObject<((to: string) => void) | null> | null>(null);

/** A secondary management page can share its own unsaved-edit confirmation with the dock. */
export function useAppNavigationGuard(leave: (to: string) => void) {
  const guardRef = useContext(AppNavigationGuard);
  useLayoutEffect(() => {
    if (!guardRef) return;
    guardRef.current = leave;
    return () => { if (guardRef.current === leave) guardRef.current = null; };
  }, [guardRef, leave]);
}

/** The workspace already knows the installed project, draft capabilities and effective access.
 * Share those decisions with its shell. A standalone page keeps its own section navigation. */
export function useAppSectionSidebar(app: App | null | undefined, items: readonly AppSectionItem[] | null, leave: (to: string) => void) {
  const register = useContext(SetAppSectionNavigation);
  const leavePage = useRef(leave);
  useLayoutEffect(() => { leavePage.current = leave; }, [leave]);
  useLayoutEffect(() => {
    if (!register || !app || !items) return;
    const navigation = { app, items, leave: (to: string) => leavePage.current(to) };
    register(navigation);
    return () => register(current => current === navigation ? null : current);
  }, [app, items, register]);
  return register !== null;
}
