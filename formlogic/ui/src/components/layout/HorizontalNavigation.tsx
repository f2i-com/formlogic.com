import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, ChevronDown, CreditCard, FileText, LayoutDashboard, Plug, Plus, Settings, ShieldCheck, Workflow } from 'lucide-react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { AppTile } from '../apps/AppTile';
import { UserMenu } from '../auth/UserMenu';
import { LogoMark } from '../ui/Logo';
import { Sidebar } from './Sidebar';
import { workspaceTools } from './workspaceTools';
import { followAppLink, useScopedAppNavigation, type AppSidebarNavigation } from './useAppSectionSidebar';
import './horizontalNavigation.css';

type DockEdge = 'top' | 'bottom';
const workspaceLinks = [
  { to: '/apps', label: 'Apps', icon: Boxes },
  { to: '/forms', label: 'Forms', icon: FileText },
  { to: '/flows', label: 'Automations', icon: Workflow },
];

function NavigationDisclosure({ edge, scoped }: { edge: DockEdge; scoped: AppSidebarNavigation | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const menuLabel = scoped ? scoped.app.name + ' navigation menu' : 'Navigation menu';

  function focusDestination() {
    const target = panel.current?.querySelector<HTMLElement>('nav a[aria-current="page"]') ?? panel.current?.querySelector<HTMLElement>('nav a');
    target?.focus();
  }

  useLayoutEffect(() => {
    if (open && keyboardOpen.current) focusDestination();
    keyboardOpen.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: Event) {
      const target = event.target;
      if (!(target instanceof Element) || panel.current?.contains(target) || trigger.current?.contains(target)) return;
      // The desktop-connection dialog lives in a portal, outside the navigation DOM.
      if (!target.closest('[role="dialog"]')) setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
    };
  }, [open]);

  return <div className="fl-horizontal-menu" onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" aria-label={menuLabel} title={menuLabel}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key !== (edge === 'top' ? 'ArrowDown' : 'ArrowUp')) return;
        event.preventDefault();
        if (open) focusDestination();
        else { keyboardOpen.current = true; setOpen(true); }
      }}
      className="fl-horizontal-trigger text-slate-900 hover:bg-slate-100 aria-expanded:bg-slate-100 dark:text-white dark:hover:bg-slate-800 dark:aria-expanded:bg-slate-800">
      {scoped ? <AppTile app={scoped.app} size="sm" className="size-7 rounded-lg" /> : <LogoMark size={26} />}
      <span className="fl-horizontal-name">{scoped?.app.name ?? 'Menu'}</span>
      <ChevronDown aria-hidden="true" className={cn('size-3.5 shrink-0 text-slate-500 dark:text-slate-400', (edge === 'bottom') !== open && 'rotate-180')} />
    </button>
    <div id={id} ref={panel} role="region" aria-label={scoped ? 'App navigation menu' : 'Workspace navigation menu'} hidden={!open}
      className="fl-horizontal-panel border border-slate-200 bg-slate-50 shadow-xl dark:border-slate-700 dark:bg-slate-900">
      {open && <Sidebar floating />}
    </div>
  </div>;
}

export function HorizontalNavigation({ edge, controls }: { edge: DockEdge; controls: ReactNode }) {
  const { pathname, key } = useLocation();
  const isDemo = useAuthStore(state => !!state.user?.isDemo);
  const isAdmin = useAuthStore(state => !!state.user?.isAdmin);
  const scope = useScopedAppNavigation(pathname);
  const scoped = scope?.navigation ?? null;
  const section = scope?.section;
  const home = isDemo ? '/dashboard' : '/';
  const showCreate = !scoped && !matchPath('/apps', pathname) && !matchPath('/apps/new', pathname);
  const shortcuts = useRef<HTMLElement>(null);

  // The current secondary destination earns a place in the bar, including on a detail or deep link.
  const contextual = [
    ...workspaceTools(isDemo),
    { path: '/settings', label: 'Settings', icon: Settings },
    { path: '/billing', label: 'Billing', icon: CreditCard },
    { path: '/connect-ai', label: 'Connect AI', icon: Plug },
    ...(isAdmin ? [{ path: '/admin', label: 'Admin', icon: ShieldCheck }] : []),
  ].find(item => matchPath({ path: item.path, end: false }, pathname));
  const links = scoped
    ? scoped.items.map(item => ({ ...item, manage: item.group === 'Manage', current: item.value === section }))
    : [
      { to: home, label: 'Home', icon: LayoutDashboard }, ...workspaceLinks,
      ...(contextual ? [{ to: contextual.path, label: contextual.label, icon: contextual.icon }] : []),
    ].map(item => ({
      ...item, manage: false,
      current: !!matchPath({ path: item.to, end: item.to === home }, pathname)
        || (item.to === '/forms' && /^\/(analytics|responses)\//.test(pathname)),
    }));

  // Only scroll the shortcut strip. Navigating between app sections must leave the page's scroll policy intact.
  useLayoutEffect(() => {
    const strip = shortcuts.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !active) return;
    const reveal = () => {
      const bounds = strip.getBoundingClientRect(), link = active.getBoundingClientRect();
      if (link.left < bounds.left) strip.scrollLeft += link.left - bounds.left;
      else if (link.right > bounds.right) strip.scrollLeft += link.right - bounds.right;
    };
    reveal();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reveal) : null;
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [pathname, scoped, edge]);

  return <div data-edge={edge} className="fl-horizontal bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100">
    <NavigationDisclosure key={key + edge} edge={edge} scoped={scoped} />
    <nav ref={shortcuts} aria-label={scoped ? 'App shortcuts' : 'Workspace shortcuts'} className="fl-horizontal-links">
      {links.map(({ to, label, icon: Icon, current, manage }) => <Link key={to} to={to} aria-label={label} aria-current={current ? 'page' : undefined} title={label}
        onClick={event => followAppLink(event, to, pathname, scoped?.leave)}
        className={cn('fl-horizontal-link', manage && 'fl-horizontal-manage',
          current ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white')}>
        <Icon aria-hidden="true" className="size-4 shrink-0" /><span>{label}</span>
      </Link>)}
    </nav>
    <div className="fl-horizontal-actions border-slate-200 dark:border-slate-700">
      {showCreate && <Link to="/apps/new" className="fl-horizontal-create text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-200 dark:hover:bg-slate-800">
        <Plus className="size-4" aria-hidden="true" />Create app
      </Link>}
      {controls}
      <UserMenu key={key} dockEdge={edge} />
    </div>
  </div>;
}
