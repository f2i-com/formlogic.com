import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import {
  User,
  LogOut,
  Settings,
  ChevronDown,
  Cloud,
  CloudOff,
  RefreshCw,
  Database,
  Stethoscope,
} from 'lucide-react';

interface UserMenuProps {
  onOpenAuth: () => void;
}

export function UserMenu({ onOpenAuth }: UserMenuProps) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const { user, logout } = useAuthStore();
  const { storageMode, setStorageMode, syncToApi, setSyncConflicts } = useFormStore();

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleLogout = async () => {
    setIsOpen(false);
    await logout();
    // Return to the home/landing page. Without this the URL stays on an authed-only
    // route (e.g. /forms), which no longer exists in the logged-out route table and
    // renders the 404 page. (AuthRedirector is a safety net for session expiry.)
    navigate('/', { replace: true });
    // Storage mode preference is preserved so it restores on next login
  };

  const handleToggleStorageMode = async () => {
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
      // api -> local keeps the currently-loaded forms (persist writes them back to
      // localStorage in local mode), so there's no data-loss risk this direction.
      setStorageMode('local');
      toast.success('Local storage enabled', 'Your forms are now stored on this device.');
      setIsOpen(false);
    }
  };

  const handleSyncToCloud = async () => {
    if (!user) {
      onOpenAuth();
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

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label="User menu"
        aria-expanded={isOpen}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg transition-all duration-150 cursor-pointer',
          'hover:bg-gray-100 dark:hover:bg-slate-800',
          isOpen && 'bg-gray-100 dark:bg-slate-800'
        )}
      >
        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-primary-foreground text-sm font-medium shadow-sm">
          {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
        </div>
        <span className="max-w-[120px] truncate hidden lg:block font-medium text-gray-700 dark:text-slate-300">
          {user.name || user.email.split('@')[0]}
        </span>
        <ChevronDown className={cn(
          'h-4 w-4 text-gray-400 dark:text-slate-500 transition-transform duration-200',
          isOpen && 'rotate-180'
        )} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-gray-200/80 dark:border-slate-800 py-1 z-50 animate-scale-in">
          {/* User info */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-800">
            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {user.name || 'User'}
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400 truncate mt-0.5">{user.email}</p>
          </div>

          {/* Storage mode indicator */}
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/50">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-slate-400">Storage Mode</span>
              <span className={cn(
                'text-xs font-medium flex items-center gap-1.5 px-2 py-0.5 rounded-full',
                storageMode === 'api'
                  ? 'text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-500/10'
                  : 'text-gray-600 dark:text-slate-300 bg-gray-200 dark:bg-slate-700'
              )}>
                {storageMode === 'api' ? (
                  <>
                    <Cloud className="h-3 w-3" />
                    Cloud
                  </>
                ) : (
                  <>
                    <Database className="h-3 w-3" />
                    Local
                  </>
                )}
              </span>
            </div>
          </div>

          {/* Menu items */}
          <div className="py-1">
            <button
              onClick={handleToggleStorageMode}
              disabled={isSyncing}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSyncing && storageMode === 'local' ? (
                <>
                  <RefreshCw className="h-4 w-4 text-gray-400 dark:text-slate-500 animate-spin" />
                  Switching to Cloud…
                </>
              ) : storageMode === 'api' ? (
                <>
                  <CloudOff className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                  Switch to Local Storage
                </>
              ) : (
                <>
                  <Cloud className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                  Switch to Cloud Storage
                </>
              )}
            </button>

            {storageMode === 'local' && (
              <button
                onClick={handleSyncToCloud}
                disabled={isSyncing}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              >
                <RefreshCw className={cn('h-4 w-4 text-gray-400 dark:text-slate-500', isSyncing && 'animate-spin')} />
                {isSyncing ? 'Syncing...' : 'Sync to Cloud'}
              </button>
            )}

            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/settings');
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Settings className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Settings
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/billing');
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Cloud className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Cloud &amp; billing
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/doctor');
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Stethoscope className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Doctor
            </button>
          </div>

          {/* Logout */}
          <div className="border-t border-gray-100 dark:border-slate-800 py-1">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
