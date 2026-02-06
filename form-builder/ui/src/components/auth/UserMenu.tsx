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
  const { storageMode, setStorageMode, syncToApi } = useFormStore();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && isOpen) {
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

  const handleLogout = () => {
    logout();
    setIsOpen(false);
    if (storageMode === 'api') {
      setStorageMode('local');
    }
  };

  const handleToggleStorageMode = async () => {
    if (storageMode === 'local') {
      setStorageMode('api');
    } else {
      setStorageMode('local');
    }
    setIsOpen(false);
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
        toast.success('Sync Complete', `Successfully synced ${result.synced} forms to cloud`);
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
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 shadow-sm hover:shadow transition-all duration-150 active:scale-[0.98]"
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
          'flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg transition-all duration-150',
          'hover:bg-gray-100 dark:hover:bg-slate-800',
          isOpen && 'bg-gray-100 dark:bg-slate-800'
        )}
      >
        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-white text-sm font-medium shadow-sm">
          {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
        </div>
        <span className="max-w-[120px] truncate hidden sm:block font-medium text-gray-700 dark:text-slate-300">
          {user.name || user.email.split('@')[0]}
        </span>
        <ChevronDown className={cn(
          'h-4 w-4 text-gray-400 dark:text-slate-500 transition-transform duration-200',
          isOpen && 'rotate-180'
        )} />
      </button>

      {isOpen && (
        <div role="menu" className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-gray-200/80 dark:border-slate-800 py-1 z-50 animate-scale-in">
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
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
            >
              {storageMode === 'api' ? (
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
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
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
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
            >
              <Settings className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Settings
            </button>
          </div>

          {/* Logout */}
          <div className="border-t border-gray-100 dark:border-slate-800 py-1">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
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
