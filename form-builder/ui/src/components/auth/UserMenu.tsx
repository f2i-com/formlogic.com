import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
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

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = () => {
    logout();
    setIsOpen(false);
    // Switch to local storage mode on logout
    if (storageMode === 'api') {
      setStorageMode('local');
    }
  };

  const handleToggleStorageMode = async () => {
    if (storageMode === 'local') {
      // Switch to API mode
      setStorageMode('api');
    } else {
      // Switch to local mode
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
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
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
        className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
      >
        <div className="h-7 w-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-medium">
          {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
        </div>
        <span className="max-w-[120px] truncate hidden sm:block">
          {user.name || user.email}
        </span>
        <ChevronDown className="h-4 w-4 text-gray-500" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {/* User info */}
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900 truncate">
              {user.name || 'User'}
            </p>
            <p className="text-xs text-gray-500 truncate">{user.email}</p>
          </div>

          {/* Storage mode indicator */}
          <div className="px-4 py-2 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Storage Mode</span>
              <span className={`text-xs font-medium flex items-center gap-1 ${
                storageMode === 'api' ? 'text-green-600' : 'text-gray-600'
              }`}>
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
              className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              {storageMode === 'api' ? (
                <>
                  <CloudOff className="h-4 w-4 text-gray-400" />
                  Switch to Local Storage
                </>
              ) : (
                <>
                  <Cloud className="h-4 w-4 text-gray-400" />
                  Switch to Cloud Storage
                </>
              )}
            </button>

            {storageMode === 'local' && (
              <button
                onClick={handleSyncToCloud}
                disabled={isSyncing}
                className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 text-gray-400 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Syncing...' : 'Sync to Cloud'}
              </button>
            )}

            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/settings');
              }}
              className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Settings className="h-4 w-4 text-gray-400" />
              Settings
            </button>
          </div>

          {/* Logout */}
          <div className="border-t border-gray-100 py-1">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
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
