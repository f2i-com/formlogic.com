import { useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { User, ArrowLeftFromLine, Shield, Mail, Clock, Check } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { TimezoneSelect } from '../ui/TimezoneSelect';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { toast } from '../../stores/toastStore';

export function AppUserProfile() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const { config, roleName: storeRoleName } = useAppRuntimeStore();

  const roleName = storeRoleName || 'Member';
  const appTz = config?.app?.settings?.timezone;
  const [tz, setTz] = useState(user?.timezone || '');
  const [savingTz, setSavingTz] = useState(false);
  const tzChanged = tz !== (user?.timezone || '');

  const saveTimezone = async () => {
    setSavingTz(true);
    try {
      const res = await updateProfile({ timezone: tz });
      if (res.success) toast.success('Timezone saved', 'Record times now show in your timezone.');
      else toast.error('Could not save', res.error || 'Please try again.');
    } finally {
      setSavingTz(false);
    }
  };

  // History-aware back: return to wherever the user came from; fall back to the
  // app home on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}`);
  };

  return (
    <div className="max-w-md mx-auto">
      <PageHeader
        title="Profile"
        subtitle="Your details in this app"
        onBack={goBack}
        backLabel="Back to app"
      />

      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden shadow-sm">
        {/* Profile header with gradient accent */}
        <div className="h-20 app-bg-primary-light relative">
          <div className="absolute -bottom-10 left-1/2 -translate-x-1/2">
            <div className="w-20 h-20 rounded-2xl bg-white dark:bg-slate-800 border-4 border-white dark:border-slate-900 flex items-center justify-center shadow-sm">
              <User className="h-9 w-9 app-text-primary" />
            </div>
          </div>
        </div>

        <div className="pt-14 pb-6 px-6 text-center">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">{user?.name || 'User'}</h2>

          {user?.email && (
            <div className="flex items-center justify-center gap-1.5 mt-1.5 text-sm text-gray-500 dark:text-slate-400 min-w-0">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{user.email}</span>
            </div>
          )}

          <div className="mt-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium app-bg-primary-light app-text-primary">
              <Shield className="h-3 w-3" />
              {roleName}
            </span>
          </div>
        </div>

        {config && (
          <div className="mx-6 py-4 border-t border-gray-100 dark:border-slate-700/50">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-400 dark:text-slate-500 shrink-0">App</span>
              <span className="font-medium text-gray-700 dark:text-slate-300 truncate">{config.app.name}</span>
            </div>
          </div>
        )}

        {/* Per-member timezone: record times show in this zone across every app. */}
        <div className="mx-6 py-4 border-t border-gray-100 dark:border-slate-700/50">
          <label htmlFor="member-timezone" className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0" /> Your timezone
          </label>
          <div className="flex items-center gap-2">
            <TimezoneSelect
              id="member-timezone"
              value={tz}
              onChange={setTz}
              disabled={savingTz}
              emptyLabel={appTz ? `Use this app's timezone (${appTz})` : 'Use the app default (UTC)'}
              className="flex-1 min-w-0 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 app-ring-primary focus:border-transparent"
            />
            {tzChanged && (
              <button
                type="button"
                onClick={saveTimezone}
                disabled={savingTz}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-xl app-bg-primary text-white disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <Check className="h-4 w-4" /> Save
              </button>
            )}
          </div>
          <p className="mt-1.5 text-xs text-gray-400 dark:text-slate-500">Record times (call logs, submissions) display in this zone.</p>
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={async () => { await useAuthStore.getState().logout(); navigate('/'); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-slate-300 border border-gray-200/80 dark:border-slate-600 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-500 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
          >
            <ArrowLeftFromLine className="h-4 w-4" /> Sign out
          </button>
          <p className="mt-2 text-center text-xs text-gray-400 dark:text-slate-500">Ends your session on this device. Use “Back” to return to the app.</p>
        </div>
      </div>
    </div>
  );
}
