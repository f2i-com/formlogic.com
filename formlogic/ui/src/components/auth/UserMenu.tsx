import { useState, useRef, useEffect, useId } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { useUIStore } from '../../stores/uiStore';
import { workspaceTools } from '../layout/workspaceTools';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { useSignOutWithUnsentCheck } from './useSignOutWithUnsentCheck';
import {
  User,
  LogOut,
  Settings,
  ChevronDown,
  Cloud,
  CloudOff,
  RefreshCw,
  Menu,
  Sun,
  Moon,
  ShieldCheck,
} from 'lucide-react';

interface UserMenuProps {
  onOpenAuth?: () => void;
  dockEdge?: 'top' | 'bottom';
}

export function UserMenu({ onOpenAuth, dockEdge }: UserMenuProps) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);

  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const theme = useUIStore(state => state.theme);
  const toggleTheme = useUIStore(state => state.toggleTheme);
  const { user } = useAuthStore();
  const { storageMode, setStorageMode, syncToApi, setSyncConflicts, loadAllFullForms } = useFormStore();

  useEffect(() => {
    if (!isOpen) return;
    function handlePointerDown(event: PointerEvent) {
      pointerInside.current = !!menuRef.current?.contains(event.target as Node);
      if (!pointerInside.current) setIsOpen(false);
    }

    function clearPointer() {
      pointerInside.current = false;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
        trigger.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', clearPointer, true);
    document.addEventListener('pointercancel', clearPointer, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      clearPointer();
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', clearPointer, true);
      document.removeEventListener('pointercancel', clearPointer, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // Return to the home/landing page after signing out. Without this the URL stays on an
  // authed-only route (e.g. /forms), which no longer exists in the logged-out route table
  // and renders the 404 page. (AuthRedirector is a safety net for session expiry.)
  const signOut = useSignOutWithUnsentCheck(() => navigate('/', { replace: true }));
  const handleLogout = async () => {
    setIsOpen(false);
    await signOut.requestSignOut();
  };

  const handleToggleStorageMode = async () => {
    // This changes where every future form is stored, and it sat as the FIRST item in the
    // account menu — one click from the avatar — with no confirmation and a name
    // ("Switch to Local Storage") that says the mechanism rather than the consequence.
    const toLocal = storageMode === 'api';
    const question = toLocal
      ? 'Keep new forms on this device only?\n\nThey will not be available on your other devices or to anyone you invite, and they are lost if you clear this browser’s data.'
      : 'Move the forms on this device into your account?\n\nThey will sync to the cloud and become available on your other devices.';
    if (!window.confirm(question)) return;
    if (storageMode === 'local') {
      // CRITICAL: push local forms to the server BEFORE switching. The persist
      // layer only keeps `forms` in localStorage while in local mode, so flipping
      // to 'api' immediately zeroes the local snapshot — any form created locally
      // but never synced would be lost for good. Sync first; only switch on success.
      setIsSyncing(true);
      try {
        const result = await syncToApi();
        if (!result.success) {
          toast.error(
            'Switch to Cloud failed',
            `Some forms could not be synced, so cloud storage was not enabled: ${result.errors.join(', ')}`
          );
          return;
        }
        // Conflicts (changed offline AND in the cloud) → let the user choose; the dialog finishes
        // the switch to cloud once resolved. Don't switch yet.
        if (result.conflicts.length > 0) {
          setSyncConflicts(result.conflicts, true);
          setIsOpen(false);
          return;
        }
        setStorageMode('api');
        const parts: string[] = [];
        if (result.synced > 0) parts.push(`${result.synced} synced`);
        if (result.deleted > 0) parts.push(`${result.deleted} removed`);
        if (result.unchanged > 0) parts.push(`${result.unchanged} already up to date`);
        toast.success(
          'Cloud storage enabled',
          parts.length ? `${parts.join(', ')}.` : 'Your forms are now stored in your account.'
        );
      } catch {
        toast.error('Switch to Cloud failed', 'Could not sync your forms. Cloud storage was not enabled.');
        return;
      } finally {
        setIsSyncing(false);
        setIsOpen(false);
      }
    } else {
      // api -> local keeps the forms in the store (persist writes them back to localStorage in
      // local mode), and local mode takes those as the whole form. In cloud mode most are rows of
      // the forms list with no fields, so every form is loaded first, and a form that can't be
      // keeps the account where it is. Stored as rows, they opened empty here, and whatever was
      // built on that went over the real fields at the next sync.
      setIsSyncing(true);
      try {
        if (!(await loadAllFullForms())) {
          toast.error('Could not keep forms on this device', 'Some forms could not be loaded, so your forms stay in your account. Try again in a moment.');
          return;
        }
        setStorageMode('local');
        toast.success('Local storage enabled', 'Your forms are now stored on this device.');
      } catch {
        // Whole forms are far larger than list rows, and this browser's storage can run out.
        setStorageMode('api');
        toast.error('Could not keep forms on this device', 'They do not fit in this browser’s storage, so your forms stay in your account.');
      } finally {
        setIsSyncing(false);
        setIsOpen(false);
      }
    }
  };

  const handleSyncToCloud = async () => {
    if (!user) {
      onOpenAuth?.();
      setIsOpen(false);
      return;
    }

    setIsSyncing(true);
    try {
      const result = await syncToApi();
      if (result.success) {
        if (result.conflicts.length > 0) {
          // Staying in local mode — resolve conflicts without switching.
          setSyncConflicts(result.conflicts, false);
          setIsOpen(false);
          return;
        }
        const parts: string[] = [];
        if (result.synced > 0) parts.push(`${result.synced} synced`);
        if (result.deleted > 0) parts.push(`${result.deleted} removed`);
        if (result.unchanged > 0) parts.push(`${result.unchanged} unchanged`);
        toast.success('Sync Complete', parts.length ? parts.join(', ') : 'Everything is already up to date');
      } else {
        toast.warning('Sync Completed with Errors', result.errors.join(', '));
      }
    } catch {
      toast.error('Sync Failed', 'Failed to sync to cloud');
    } finally {
      setIsSyncing(false);
      setIsOpen(false);
    }
  };

  if (!user) {
    if (!onOpenAuth) return null;
    return (
      <button
        onClick={onOpenAuth}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary-600 rounded-lg hover:bg-primary-700 shadow-sm hover:shadow transition-all duration-150 active:scale-[0.98] cursor-pointer"
      >
        <User className="h-4 w-4" />
        Sign In
      </button>
    );
  }

  const row = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/5';
  const navRow = ({ isActive }: { isActive: boolean }) => cn(row, isActive && 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300');
  const close = () => setIsOpen(false);
  const accountLinks = [
    { path: '/settings', icon: Settings, label: 'Settings' },
    { path: '/billing', icon: Cloud, label: 'Cloud & billing' },
    ...(user.isAdmin ? [{ path: '/admin', icon: ShieldCheck, label: 'Admin' }] : []),
  ];

  return (
    <div className="relative" ref={menuRef} onBlur={event => {
      // WebKit can focus the page during a press on a link. Let its click reach the link.
      if (!pointerInside.current && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
    }}>
      <button type="button" ref={trigger} onClick={() => setIsOpen(open => !open)}
        aria-label="User menu" aria-expanded={isOpen} aria-controls={isOpen ? menuId : undefined}
        title="Workspace and account menu"
        className={cn('flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg text-sm transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:bg-slate-800 md:px-2',
          isOpen && 'bg-gray-100 dark:bg-slate-800')}>
        <Menu className="size-5 text-slate-700 dark:text-slate-200 md:hidden" aria-hidden="true" />
        <span className="hidden size-8 items-center justify-center rounded-full bg-primary-600 font-semibold text-primary-foreground md:flex" aria-hidden="true">
          {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
        </span>
        {!dockEdge && <span className="hidden max-w-[120px] truncate font-medium text-gray-700 dark:text-slate-300 lg:block">{user.name || user.email.split('@')[0]}</span>}
        <ChevronDown className={cn('hidden size-4 text-slate-500 motion-safe:transition-transform md:block', (dockEdge === 'bottom') !== isOpen && 'rotate-180')} aria-hidden="true" />
      </button>
      {isOpen && (
        <div id={menuId} role="region" aria-label="Workspace and account" className={cn('absolute right-0 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900',
          dockEdge === 'bottom' ? 'bottom-full mb-2' : 'top-full mt-2',
          dockEdge ? 'max-h-[calc(100dvh-var(--fl-nav-height)-var(--fl-system-top,0px)-1rem)]' : 'max-h-[calc(100dvh-10rem-var(--fl-demo-banner-h,0px)-env(safe-area-inset-bottom))] md:max-h-[calc(100dvh-7rem-var(--fl-demo-banner-h,0px))]')}>
          <div className="flex items-center gap-3 border-b border-slate-200 px-2 pb-3 pt-1.5 dark:border-slate-700">
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-sm font-semibold text-primary-800 dark:bg-primary-500/15 dark:text-primary-300">
              {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">{user.name || 'User'}</p>
              <p className="truncate text-xs text-slate-600 dark:text-slate-400">{user.email}</p>
            </div>
          </div>

          <nav aria-label="More tools" className="border-b border-slate-200 py-1.5 dark:border-slate-700 md:hidden">
            {workspaceTools(!!user.isDemo).map(({ path, icon: Icon, label }) =>
              <NavLink key={path} to={path} className={navRow} onClick={close}><Icon className="size-4" aria-hidden="true" />{label}</NavLink>)}
          </nav>
          <nav aria-label="Account" className="py-1.5">
            {accountLinks.map(({ path, icon: Icon, label }) =>
              <NavLink key={path} to={path} className={navRow} onClick={close}><Icon className="size-4" aria-hidden="true" />{label}</NavLink>)}
          </nav>
          <button type="button" onClick={toggleTheme} className={cn(row, !dockEdge && 'md:hidden')}>
            {theme === 'dark' ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
            {theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          </button>

          <div className="mt-1 border-y border-slate-200 py-1.5 dark:border-slate-700">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">
              <span>Form storage</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{storageMode === 'api' ? 'Cloud' : 'This device'}</span>
            </div>
            <button type="button" onClick={handleToggleStorageMode} disabled={isSyncing} className={row}>
              {isSyncing ? <RefreshCw className="size-4 motion-safe:animate-spin" /> : storageMode === 'api' ? <CloudOff className="size-4" /> : <Cloud className="size-4" />}
              {isSyncing
                ? (storageMode === 'local' ? 'Moving forms to your account…' : 'Copying forms to this device…')
                : (storageMode === 'api' ? 'Keep new forms on this device' : 'Save my forms to my account')}
            </button>
            {storageMode === 'local' && <button type="button" onClick={handleSyncToCloud} disabled={isSyncing} className={row}>
              <RefreshCw className={cn('size-4', isSyncing && 'motion-safe:animate-spin')} />{isSyncing ? 'Syncing…' : 'Sync to Cloud'}
            </button>}
          </div>
          <button type="button" onClick={handleLogout} className={cn(row, 'mt-1 text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10')}>
            <LogOut className="size-4" aria-hidden="true" />Sign Out
          </button>
        </div>
      )}
      {signOut.dialog}
    </div>
  );
}
