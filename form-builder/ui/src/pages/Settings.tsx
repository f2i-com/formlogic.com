import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { Switch } from '../components/ui/Switch';
import { TimezoneSelect } from '../components/ui/TimezoneSelect';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { parseServerDate, formatRelativeTime } from '../lib/utils';
import {
  User,
  Bell,
  Settings2,
  Mail,
  LayoutGrid,
  ArrowLeft,
  Shield,
  Plug,
  ShieldCheck,
  Palette,
  Check,
  Lock,
  Key,
  Laptop,
  Copy,
  Trash2,
  Plus,
  AlertTriangle,
  Download,
  Archive,
  UploadCloud,
  Recycle,
} from 'lucide-react';
import { useUIStore, type ThemeColor } from '../stores/uiStore';
import { api } from '../lib/api';
import type { AuditVerifyResult, ApiKey, ApiKeyCreated, DesktopConnection, AccountBackupImportResult } from '../lib/api';
import { ConnectAiModal } from '../components/mcp/ConnectAiModal';
import { passwordError as getPasswordError } from '../lib/passwordPolicy';

// Local preferences stored in localStorage
interface UserPreferences {
  showProgressBar: boolean;
  allowBackNavigation: boolean;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  showProgressBar: true,
  allowBackNavigation: true,
};

function getStoredPreferences(): UserPreferences {
  try {
    const stored = localStorage.getItem('formlogic_user_preferences');
    if (stored) {
      return { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_PREFERENCES;
}

function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem('formlogic_user_preferences', JSON.stringify(prefs));
}

// In-page anchor rail sections (order mirrors the cards below)
const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'form-defaults', label: 'Form defaults' },
  { id: 'security', label: 'Security' },
  { id: 'api-keys', label: 'API keys' },
  { id: 'linked-desktops', label: 'Linked desktops' },
  { id: 'mcp', label: 'MCP' },
  { id: 'audit', label: 'Audit' },
  { id: 'your-data', label: 'Your data' },
  { id: 'backup', label: 'Backup & restore' },
  { id: 'trash', label: 'Recycle bin' },
  { id: 'danger', label: 'Danger zone' },
] as const;

// API-key expiry choices (days; 'never' = no expiresAt sent)
const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '365 days' },
] as const;

// Section Header Component
function SectionHeader({
  icon: Icon,
  title,
  description,
  iconBg = 'bg-gray-100 dark:bg-slate-800',
  iconColor = 'text-gray-500 dark:text-slate-400',
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  iconBg?: string;
  iconColor?: string;
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className={`p-2.5 rounded-lg ${iconBg}`}>
        <Icon className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">{description}</p>
        )}
      </div>
    </div>
  );
}

export function Settings() {
  useDocumentTitle('Settings');
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);

  // Profile form state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [timezone, setTimezone] = useState(user?.timezone || '');
  const [profilePassword, setProfilePassword] = useState('');
  const [hasProfileChanges, setHasProfileChanges] = useState(false);

  // Theme
  const themeColor = useUIStore((state) => state.themeColor);

  // Preferences state
  const [preferences, setPreferences] = useState<UserPreferences>(getStoredPreferences);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  // Dedicated flag for the profile save so it doesn't share the global auth
  // `isLoading` with the password change (which spun/disabled the unrelated
  // Profile button while a password change was in flight).
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Audit verification state
  const [isVerifyingAudit, setIsVerifyingAudit] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditVerifyResult | null>(null);

  // API key state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keyLoadError, setKeyLoadError] = useState<string | null>(null);
  const [isLoadingKeys, setIsLoadingKeys] = useState(true);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>([]);
  const [newKeyExpiry, setNewKeyExpiry] = useState<string>('never');
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // Linked FormLogic Desktop installs
  const [desktopConnections, setDesktopConnections] = useState<DesktopConnection[]>([]);
  const [isLoadingDesktops, setIsLoadingDesktops] = useState(true);
  const [desktopLoadError, setDesktopLoadError] = useState<string | null>(null);
  const [revokeDesktopTarget, setRevokeDesktopTarget] = useState<{ id: string; name: string } | null>(null);
  const [isRevokingDesktop, setIsRevokingDesktop] = useState(false);

  // Update form when user changes
  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
      setTimezone(user.timezone || '');
    }
  }, [user]);

  // Track profile changes
  useEffect(() => {
    const nameChanged = name !== (user?.name || '');
    const emailChanged = email !== (user?.email || '');
    const tzChanged = timezone !== (user?.timezone || '');
    setHasProfileChanges(nameChanged || emailChanged || tzChanged);
  }, [name, email, timezone, user]);

  const emailChanged = email.trim().toLowerCase() !== (user?.email || '').toLowerCase();

  // Client-side validation for the Change Password button below — surfaced as a disabled
  // button rather than only after the user clicks Submit and gets a server error.
  const newPasswordError = newPassword ? getPasswordError(newPassword) : null;
  const confirmPasswordMismatch = confirmPassword !== '' && newPassword !== confirmPassword;

  const handleSaveProfile = async () => {
    // Changing the email requires the current password (the backend rejects it
    // otherwise). Surface that requirement instead of letting the save fail.
    if (emailChanged && !profilePassword) {
      toast.error('Password Required', 'Enter your current password to change your email.');
      return;
    }
    setIsSavingProfile(true);
    try {
      const base = { name, email, timezone };
      const payload = emailChanged ? { ...base, currentPassword: profilePassword } : base;
      const result = await updateProfile(payload as Parameters<typeof updateProfile>[0]);
      if (result.success) {
        toast.success('Profile Updated', 'Your profile has been saved successfully.');
        setHasProfileChanges(false);
        setProfilePassword('');
      } else {
        toast.error('Update Failed', result.error || 'Could not update your profile.');
      }
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePreferenceChange = (key: keyof UserPreferences, value: boolean) => {
    const newPrefs = { ...preferences, [key]: value };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
    toast.success('Preference Saved', 'Your preference has been updated.');
  };

  const handleChangePassword = async () => {
    if (!currentPassword) {
      toast.error('Current Password Required', 'Enter your current password.');
      return;
    }
    if (newPasswordError) {
      toast.error('Invalid Password', newPasswordError);
      return;
    }
    if (confirmPasswordMismatch) {
      toast.error('Passwords Do Not Match', 'The new password and confirmation must match.');
      return;
    }

    setIsChangingPassword(true);
    const result = await updateProfile({ currentPassword, password: newPassword } as Parameters<typeof updateProfile>[0]);
    setIsChangingPassword(false);

    if (result.success) {
      toast.success('Password Changed', 'Your password has been updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      toast.error('Failed to Change Password', result.error || 'Failed to change password');
    }
  };

  const [isExportingData, setIsExportingData] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  const handleExportData = async () => {
    setIsExportingData(true);
    try {
      await api.downloadMyData();
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : 'Could not export your data.');
    } finally {
      setIsExportingData(false);
    }
  };

  // ── Backup & restore (full-workspace zip: structure + records + files) ──
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [isImportingBackup, setIsImportingBackup] = useState(false);
  const [pendingBackupFile, setPendingBackupFile] = useState<File | null>(null);
  const [backupResult, setBackupResult] = useState<AccountBackupImportResult | null>(null);

  // ── Recycle bin (count for the card; the /trash page is the real surface) ──
  const [trashCount, setTrashCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    api.listTrash().then((r) => {
      if (active && r.data) setTrashCount(r.data.items.length);
    });
    return () => { active = false; };
  }, []);

  const handleExportBackup = async () => {
    setIsExportingBackup(true);
    try {
      await api.exportAccountBackup();
      toast.success('Backup downloaded', 'Apps, forms, flows, records and files — all in one zip.');
    } catch (e) {
      toast.error('Backup failed', e instanceof Error ? e.message : 'Could not build the backup.');
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleImportBackupConfirmed = async () => {
    const file = pendingBackupFile;
    setPendingBackupFile(null);
    if (!file) return;
    setIsImportingBackup(true);
    setBackupResult(null);
    try {
      const r = await api.importAccountBackup(file);
      if (r.error || !r.data) {
        toast.error('Restore failed', typeof r.error === 'string' ? r.error : 'Could not import the backup.');
        return;
      }
      setBackupResult(r.data);
      toast.success(
        'Backup restored',
        `Created ${r.data.apps.length} app${r.data.apps.length === 1 ? '' : 's'}, ${r.data.forms.length} form${r.data.forms.length === 1 ? '' : 's'}, ${r.data.responses.toLocaleString()} records and ${r.data.files} file${r.data.files === 1 ? '' : 's'}.`
      );
    } finally {
      setIsImportingBackup(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) { toast.error('Password Required', 'Enter your password to confirm.'); return; }
    setIsDeletingAccount(true);
    const result = await api.deleteAccount(deletePassword);
    if (result.error) {
      setIsDeletingAccount(false);
      toast.error('Failed to Delete Account', result.error);
      return;
    }
    // Account gone — hard-redirect home to clear all client state.
    window.location.href = '/';
  };

  const handleVerifyAudit = async () => {
    setIsVerifyingAudit(true);
    setAuditResult(null);
    try {
      const result = await api.verifyAuditIntegrity();
      if (result.data) {
        setAuditResult(result.data);
      } else {
        toast.error('Verification Failed', result.error || 'Could not verify audit integrity.');
      }
    } catch {
      toast.error('Verification Failed', 'An unexpected error occurred.');
    } finally {
      setIsVerifyingAudit(false);
    }
  };

  const loadApiKeys = async () => {
    setIsLoadingKeys(true);
    setKeyLoadError(null);
    try {
      const result = await api.getApiKeys();
      if (result.data) {
        setApiKeys(result.data.keys);
      } else {
        setKeyLoadError(typeof result.error === 'string' ? result.error : 'Could not load API keys');
      }
    } catch {
      setKeyLoadError('Could not load API keys');
    } finally {
      setIsLoadingKeys(false);
    }
  };

  // Load API keys on mount
  useEffect(() => {
    loadApiKeys();
  }, []);

  // `silent`: used by the background poll below so a periodic refresh doesn't blank the
  // already-rendered list behind a loading spinner (or an error state) — same convention
  // as FormResponses' reloadResponses/isRefreshing split. The mount-time call still shows
  // the spinner since there's nothing on screen yet.
  const loadDesktopConnections = async (silent = false) => {
    if (!silent) {
      setIsLoadingDesktops(true);
      setDesktopLoadError(null);
    }
    try {
      const result = await api.getDesktopConnections();
      if (result.data) {
        setDesktopConnections(result.data.connections);
        if (silent) setDesktopLoadError(null);
      } else if (!silent) {
        setDesktopLoadError(typeof result.error === 'string' ? result.error : 'Could not load linked desktops');
      }
      // Silent failures keep whatever is currently on screen rather than replacing it
      // with an error state on a transient background hiccup.
    } catch {
      if (!silent) setDesktopLoadError('Could not load linked desktops');
    } finally {
      if (!silent) setIsLoadingDesktops(false);
    }
  };

  // Load linked desktops on mount, then keep polling while this tab is visible so the
  // "Online now" badge (derived from a freshness window) reflects a desktop that
  // disconnects while Settings stays open, instead of only refreshing on next visit.
  useEffect(() => {
    loadDesktopConnections();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadDesktopConnections(true);
    }, 45_000);
    return () => clearInterval(timer);
  }, []);

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim() || newKeyScopes.length === 0) return;

    setIsCreatingKey(true);
    try {
      const expiresAt = newKeyExpiry === 'never'
        ? undefined
        : new Date(Date.now() + Number(newKeyExpiry) * 24 * 60 * 60 * 1000).toISOString();
      const result = await api.createApiKey({ name: newKeyName.trim(), scopes: newKeyScopes, ...(expiresAt ? { expiresAt } : {}) });
      if (result.data) {
        setCreatedKey(result.data.key);
        setShowCreateKey(false);
        setNewKeyName('');
        setNewKeyScopes([]);
        setNewKeyExpiry('never');
        loadApiKeys();
      } else {
        toast.error('Failed to create API key', result.error || 'Unknown error');
      }
    } catch {
      toast.error('Failed to create API key', 'An unexpected error occurred');
    } finally {
      setIsCreatingKey(false);
    }
  };

  const confirmRevokeApiKey = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    try {
      const result = await api.revokeApiKey(revokeTarget.id);
      if (result.data) {
        toast.success('API Key Revoked', `"${revokeTarget.name}" has been revoked.`);
        loadApiKeys();
        setRevokeTarget(null);
      } else {
        toast.error('Failed to revoke key', result.error || 'Unknown error');
      }
    } finally {
      setIsRevoking(false);
    }
  };

  const confirmRevokeDesktop = async () => {
    if (!revokeDesktopTarget) return;
    setIsRevokingDesktop(true);
    try {
      const result = await api.revokeDesktopConnection(revokeDesktopTarget.id);
      if (result.data) {
        toast.success('Desktop unlinked', `"${revokeDesktopTarget.name}" has been unlinked.`);
        loadDesktopConnections();
        setRevokeDesktopTarget(null);
      } else {
        toast.error('Failed to unlink desktop', result.error || 'Unknown error');
      }
    } finally {
      setIsRevokingDesktop(false);
    }
  };

  const handleCopyKey = async (key: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(key);
      } else {
        const ta = document.createElement('textarea');
        ta.value = key;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('copy command rejected');
      }
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      toast.error('Copy failed', 'Select the key and copy it manually.');
    }
  };

  const toggleScope = (scope: string) => {
    setNewKeyScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  };

  const AVAILABLE_SCOPES = [
    { id: 'forms:read', label: 'Forms: Read', description: 'List forms, get metadata and fields' },
    { id: 'responses:read', label: 'Responses: Read', description: 'List and fetch responses, analytics' },
    { id: 'responses:write', label: 'Responses: Write', description: 'Submit new responses' },
    { id: 'responses:manage', label: 'Responses: Manage', description: 'Update and delete responses' },
    { id: 'webhooks:read', label: 'Webhooks: Read', description: 'List webhooks' },
    { id: 'webhooks:write', label: 'Webhooks: Write', description: 'Create, update, delete webhooks' },
    // FormLogic Desktop / Flows headless runtime. The "Connect account" flow in FormLogic Desktop
    // mints a key with these automatically; offered here for anyone who prefers to paste one manually.
    { id: 'flows:read', label: 'Flows: Read', description: 'Read flows, bindings, runs and KV (FormLogic Desktop)' },
    { id: 'flows:write', label: 'Flows: Write', description: 'Claim and complete flow runs, write KV (FormLogic Desktop)' },
    { id: 'connector:relay', label: 'Connector: Relay', description: 'Act as a desktop runtime for relayed connector commands (FormLogic Desktop)' },
  ];

  return (
    <div className="min-h-screen">
      <Header title="Settings" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
        <div className="lg:flex lg:items-start lg:gap-8">
        <div className="min-w-0 flex-1 space-y-6">
        {/* Profile Settings */}
        <Card id="profile" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={User}
              title="Profile"
              description="Manage your personal information"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <Input
                label="Name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSavingProfile}
              />
              <Input
                label="Email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSavingProfile}
              />
              {emailChanged && (
                <PasswordInput
                  label="Current password"
                  placeholder="Required to change your email"
                  value={profilePassword}
                  onChange={(e) => setProfilePassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={isSavingProfile}
                />
              )}
              <div>
                <label htmlFor="account-timezone" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Timezone</label>
                <TimezoneSelect
                  id="account-timezone"
                  value={timezone}
                  onChange={setTimezone}
                  disabled={isSavingProfile}
                  emptyLabel="Use each app's timezone"
                  className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Record times (call logs, submissions) show in this zone across every app you use. Leave unset to follow each app's own timezone.</p>
              </div>
              <div className="pt-2">
                <Button
                  onClick={handleSaveProfile}
                  disabled={!hasProfileChanges || isSavingProfile}
                  isLoading={isSavingProfile}
                >
                  {hasProfileChanges ? 'Save Changes' : 'No Changes'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card id="notifications" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Bell}
              title="Notifications"
              description="Configure how you receive updates"
              iconBg="bg-blue-50 dark:bg-blue-500/10"
              iconColor="text-blue-600 dark:text-blue-400"
            />
            <div className="ml-0 sm:ml-14">
              <div className="flex items-start gap-3 py-3 text-sm">
                <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg shrink-0">
                  <Mail className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                </div>
                <p className="text-gray-500 dark:text-slate-400">
                  Response emails are configured per form. Open a form's{' '}
                  <span className="font-medium text-gray-700 dark:text-slate-300">Settings → Notifications</span>{' '}
                  tab to set the recipient address and turn emails on for that form.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Appearance Settings */}
        <Card id="appearance" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Palette}
              title="Appearance"
              description="Customize the look and feel of your workspace"
              iconBg="bg-pink-50 dark:bg-pink-500/10"
              iconColor="text-pink-600 dark:text-pink-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2 block">
                  Accent Color
                </label>
                <p className="text-xs text-gray-500 dark:text-slate-400 -mt-1 mb-3">
                  Default adapts automatically — Indigo in light mode, Lime in dark mode.
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-7 gap-3">
                  {[
                    { id: 'default', color: 'bg-gradient-to-br from-indigo-500 to-lime-400', label: 'Default', check: 'text-gray-900' },
                    { id: 'indigo', color: 'bg-indigo-500', label: 'Indigo', check: 'text-white' },
                    { id: 'lime', color: 'bg-lime-500', label: 'Lime', check: 'text-gray-900' },
                    { id: 'rose', color: 'bg-rose-500', label: 'Rose', check: 'text-white' },
                    { id: 'orange', color: 'bg-orange-500', label: 'Orange', check: 'text-gray-900' },
                    { id: 'cyan', color: 'bg-cyan-500', label: 'Cyan', check: 'text-gray-900' },
                    { id: 'violet', color: 'bg-violet-500', label: 'Violet', check: 'text-white' },
                  ].map((theme) => {
                    const isSelected = themeColor === theme.id;
                    return (
                      <button
                        key={theme.id}
                        aria-label={`Select ${theme.label} accent color`}
                        aria-pressed={isSelected}
                        onClick={() => {
                          useUIStore.getState().setThemeColor(theme.id as ThemeColor);
                          toast.success('Theme Updated', `Accent color changed to ${theme.label}`);
                        }}
                        className={`group relative flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-200 cursor-pointer ${isSelected
                          ? 'border-primary-500 bg-primary-500/5 ring-1 ring-primary-500/50'
                          : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                          }`}
                      >
                        <div className={`w-8 h-8 rounded-full ${theme.color} shadow-sm flex items-center justify-center`}>
                          {isSelected && <Check className={`w-4 h-4 ${theme.check}`} />}
                        </div>
                        <span className={`text-xs font-medium ${isSelected ? 'text-primary-600 dark:text-primary-400' : 'text-gray-600 dark:text-slate-400'
                          }`}>
                          {theme.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Default Form Settings */}
        <Card id="form-defaults" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Settings2}
              title="Default Form Settings"
              description="Set defaults for new forms you create"
              iconBg="bg-green-50 dark:bg-green-500/10"
              iconColor="text-green-600 dark:text-green-400"
            />
            <div className="space-y-1 ml-0 sm:ml-14">
              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <LayoutGrid className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Show progress bar</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400">Display progress bar on forms by default</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.showProgressBar}
                  onChange={(checked) => handlePreferenceChange('showProgressBar', checked)}
                />
              </div>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <ArrowLeft className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Allow back navigation</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400">Allow respondents to go back to previous questions</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.allowBackNavigation}
                  onChange={(checked) => handlePreferenceChange('allowBackNavigation', checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security Section */}
        <Card id="security" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Shield}
              title="Security"
              description="Manage your account security"
              iconBg="bg-purple-50 dark:bg-purple-500/10"
              iconColor="text-purple-600 dark:text-purple-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <div className="flex items-center gap-2 mb-2">
                <Lock className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                <h3 className="font-medium text-gray-900 dark:text-white">Change Password</h3>
              </div>
              <PasswordInput
                label="Current Password"
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                disabled={isChangingPassword}
              />
              <PasswordInput
                label="New Password"
                placeholder="Enter new password (min 10 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                error={newPassword ? newPasswordError || undefined : undefined}
                disabled={isChangingPassword}
              />
              <PasswordInput
                label="Confirm New Password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                error={confirmPasswordMismatch ? 'Passwords do not match' : undefined}
                disabled={isChangingPassword}
              />
              <div className="pt-2">
                <Button
                  onClick={handleChangePassword}
                  disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword || !!newPasswordError || confirmPasswordMismatch}
                  isLoading={isChangingPassword}
                >
                  Change Password
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Keys Section */}
        <Card id="api-keys" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Key}
              title="API Keys"
              description="Manage API keys for external integrations"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              {/* Created key display (one-time) */}
              {createdKey && (
                <div className="p-4 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10">
                  <div className="flex items-start gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      Copy your API key now. It won't be shown again.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <code className="flex-1 text-xs bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-600/30 rounded px-3 py-2 font-mono text-gray-900 dark:text-white break-all">
                      {createdKey.key}
                    </code>
                    <button
                      onClick={() => handleCopyKey(createdKey.key)}
                      className="flex-shrink-0 p-2 rounded-lg border border-amber-200 dark:border-amber-600/30 bg-white dark:bg-slate-900 hover:bg-amber-50 dark:hover:bg-slate-800 transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedKey ? (
                        <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      )}
                    </button>
                  </div>
                  <button
                    onClick={() => setCreatedKey(null)}
                    className="mt-2 text-xs text-amber-700 dark:text-amber-400 hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Create key form */}
              {showCreateKey ? (
                <div className="p-4 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 space-y-4">
                  <Input
                    label="Key Name"
                    placeholder="e.g., CRM Integration"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                  />
                  <div>
                    <label className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2 block">
                      Scopes
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {AVAILABLE_SCOPES.map((scope) => (
                        <label
                          key={scope.id}
                          className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                            newKeyScopes.includes(scope.id)
                              ? 'border-primary-400 dark:border-primary-500/50 bg-primary-50 dark:bg-primary-500/10'
                              : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={newKeyScopes.includes(scope.id)}
                            onChange={() => toggleScope(scope.id)}
                            className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-primary-600 accent-primary-600 focus:ring-primary-500"
                          />
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{scope.label}</p>
                            <p className="text-xs text-gray-500 dark:text-slate-400">{scope.description}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label htmlFor="api-key-expiry" className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5 block">
                      Expiration
                    </label>
                    <select
                      id="api-key-expiry"
                      value={newKeyExpiry}
                      onChange={(e) => setNewKeyExpiry(e.target.value)}
                      className="block w-full sm:max-w-xs rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all"
                    >
                      {EXPIRY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleCreateApiKey}
                      disabled={!newKeyName.trim() || newKeyScopes.length === 0 || isCreatingKey}
                      isLoading={isCreatingKey}
                    >
                      Create Key
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => { setShowCreateKey(false); setNewKeyName(''); setNewKeyScopes([]); setNewKeyExpiry('never'); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => setShowCreateKey(true)}
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Create API Key
                </Button>
              )}

              {/* Key list */}
              {isLoadingKeys ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400 py-4">
                  <Spinner size="sm" /> <span>Loading keys…</span>
                </div>
              ) : keyLoadError ? (
                <div className="py-6 text-center text-sm">
                  <p className="text-gray-600 dark:text-slate-300">{keyLoadError}</p>
                  <button type="button" onClick={loadApiKeys} className="mt-2 text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">Try again</button>
                </div>
              ) : apiKeys.length === 0 ? (
                <EmptyState
                  icon={Key}
                  title="No API keys yet"
                  description="Create a key to integrate with the FormLogic API."
                  className="py-8"
                />
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((key) => (
                    <div
                      key={key.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{key.name}</p>
                          <code className="text-xs bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 px-1.5 py-0.5 rounded font-mono">
                            {key.keyPrefix}...
                          </code>
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {key.scopes.map((scope) => (
                            <span
                              key={scope}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 font-medium"
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                          {key.lastUsedAt
                            ? `Last used ${parseServerDate(key.lastUsedAt).toLocaleDateString()}${key.lastUsedIp ? ` from ${key.lastUsedIp}` : ''}`
                            : 'Never used'}
                          {' · '}Created {parseServerDate(key.createdAt).toLocaleDateString()}
                          {' · '}{key.expiresAt
                            ? `Expires ${parseServerDate(key.expiresAt).toLocaleDateString()}`
                            : 'Never expires'}
                          {' · '}{key.formIds && key.formIds.length > 0
                            ? `${key.formIds.length} ${key.formIds.length === 1 ? 'form' : 'forms'}`
                            : 'All forms'}
                        </p>
                      </div>
                      <button
                        onClick={() => setRevokeTarget({ id: key.id, name: key.name })}
                        className="flex-shrink-0 p-2 rounded-lg text-gray-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors ml-2"
                        title="Revoke key"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Linked Desktops Section */}
        <Card id="linked-desktops" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Laptop}
              title="Linked Desktops"
              description="FormLogic Desktop installs linked to your account. Each one can run your flows and relay live commands (like the Aokie phone bridge) even when you're not at that computer."
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              {isLoadingDesktops ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400 py-4">
                  <Spinner size="sm" /> <span>Loading linked desktops…</span>
                </div>
              ) : desktopLoadError ? (
                <div className="py-6 text-center text-sm">
                  <p className="text-gray-600 dark:text-slate-300">{desktopLoadError}</p>
                  <button type="button" onClick={() => loadDesktopConnections()} className="mt-2 text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">Try again</button>
                </div>
              ) : desktopConnections.length === 0 ? (
                <EmptyState
                  icon={Laptop}
                  title="No desktops linked yet"
                  description='Open FormLogic Desktop, go to Settings, and click "Link FormLogic account" to connect it here.'
                  className="py-8"
                />
              ) : (
                <div className="space-y-2">
                  {desktopConnections.map((conn) => {
                    const isOnline = conn.lastSeenAt !== null && Date.now() - parseServerDate(conn.lastSeenAt).getTime() < 90_000;
                    return (
                      <div
                        key={conn.id}
                        className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{conn.deviceName}</p>
                            {isOnline && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300 font-medium">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                Online now
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                            {!isOnline && (
                              <>
                                {conn.lastSeenAt ? `Last seen ${formatRelativeTime(conn.lastSeenAt)}` : 'Never connected'}
                                {' · '}
                              </>
                            )}
                            Linked {formatRelativeTime(conn.createdAt)}
                          </p>
                        </div>
                        <button
                          onClick={() => setRevokeDesktopTarget({ id: conn.id, name: conn.deviceName })}
                          className="flex-shrink-0 p-2 rounded-lg text-gray-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors ml-2"
                          title="Unlink desktop"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Connect an AI (MCP) Section */}
        <Card id="mcp" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Plug}
              title="Connect an AI"
              description="Let an external AI (Claude, Cursor, …) build and edit your apps over MCP"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="ml-0 sm:ml-14">
              <Button variant="outline" onClick={() => setShowMcp(true)} leftIcon={<Plug className="h-4 w-4" />}>
                Manage AI connections
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Audit & Compliance Section */}
        <Card id="audit" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Shield}
              title="Audit & Compliance"
              description="Verify the integrity of your audit trail"
              iconBg="bg-emerald-50 dark:bg-emerald-500/10"
              iconColor="text-emerald-600 dark:text-emerald-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <p className="text-sm text-gray-500 dark:text-slate-500">
                The audit log uses cryptographic hash chaining to ensure entries cannot be tampered with.
                Run a verification to confirm the chain is intact.
              </p>
              <Button
                onClick={handleVerifyAudit}
                disabled={isVerifyingAudit}
                isLoading={isVerifyingAudit}
              >
                Verify Audit Integrity
              </Button>
              {auditResult && (
                <div role="status" className={`flex items-start gap-3 p-4 rounded-lg border ${
                  auditResult.intact
                    ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30'
                    : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'
                }`}>
                  <ShieldCheck className={`h-5 w-5 mt-0.5 flex-shrink-0 ${
                    auditResult.intact
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }`} />
                  <div>
                    {auditResult.intact ? (
                      <p className="text-sm font-medium text-green-700 dark:text-green-300">
                        Chain intact: {auditResult.verified} entries verified
                      </p>
                    ) : (
                      <p className="text-sm font-medium text-red-700 dark:text-red-300">
                        Chain broken at entry #{auditResult.brokenAt?.sequenceNumber}
                        {auditResult.brokenAt && (
                          <span className="block text-xs font-normal mt-1 text-red-600 dark:text-red-400">
                            Action: {auditResult.brokenAt.action} | Date: {auditResult.brokenAt.createdAt}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Your Data */}
        <Card id="your-data" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Download}
              title="Your data"
              description="Download a copy of your account data"
              iconBg="bg-sky-50 dark:bg-sky-500/10"
              iconColor="text-sky-600 dark:text-sky-400"
            />
            <div className="ml-0 sm:ml-14">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Download my data</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Profile, forms, apps, and API-key metadata as JSON. Per-form responses export from each form; secrets are never included.</p>
                </div>
                <Button variant="outline" onClick={handleExportData} isLoading={isExportingData} leftIcon={<Download className="h-4 w-4" />}>
                  Export
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Backup & restore */}
        <Card id="backup" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Archive}
              title="Backup & restore"
              description="Download a full backup of your workspace, or restore one as new copies"
              iconBg="bg-indigo-50 dark:bg-indigo-500/10"
              iconColor="text-indigo-600 dark:text-indigo-400"
            />
            <div className="ml-0 sm:ml-14 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Download full backup</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    Everything in one zip: apps, forms and flows (schemas), every form&apos;s record database, and uploaded files.
                    Webhook secrets, members and API keys are not included.
                  </p>
                </div>
                <Button variant="outline" onClick={handleExportBackup} isLoading={isExportingBackup} leftIcon={<Archive className="h-4 w-4" />}>
                  Download backup
                </Button>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Restore from backup</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    Creates new copies of everything in the backup — nothing is overwritten. Re-importing the same backup creates duplicates.
                  </p>
                </div>
                <label className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-slate-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 shrink-0">
                  <UploadCloud className="h-4 w-4" />
                  {isImportingBackup ? 'Restoring…' : 'Restore backup'}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    disabled={isImportingBackup}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) setPendingBackupFile(f); e.target.value = ''; }}
                  />
                </label>
              </div>
              {backupResult && (
                <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-500/10 text-sm space-y-1">
                  <p className="font-medium text-gray-900 dark:text-white">Restore complete</p>
                  <p className="text-gray-600 dark:text-slate-300">
                    {backupResult.apps.length} apps · {backupResult.forms.length} forms · {backupResult.flows} flows · {backupResult.bindings} bindings · {backupResult.responses.toLocaleString()} records · {backupResult.files} files
                  </p>
                  {(backupResult.warnings ?? []).map((w, i) => (
                    <p key={i} className="text-amber-700 dark:text-amber-400 text-xs">{w}</p>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recycle bin */}
        <Card id="trash" className="overflow-hidden scroll-mt-24">
          <CardContent className="p-6">
            <SectionHeader
              icon={Recycle}
              title="Recycle bin"
              description="Deleted forms, apps and flows stay restorable for 30 days"
              iconBg="bg-emerald-50 dark:bg-emerald-500/10"
              iconColor="text-emerald-600 dark:text-emerald-400"
            />
            <div className="ml-0 sm:ml-14">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">
                    {trashCount === null ? 'Recycle bin' : trashCount === 0 ? 'The recycle bin is empty' : `${trashCount} item${trashCount === 1 ? '' : 's'} in the recycle bin`}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    Deleting a form, app or flow keeps a snapshot (records and files included) for 30 days — restore it anytime before then.
                  </p>
                </div>
                <Button variant="outline" onClick={() => navigate('/trash')} leftIcon={<Recycle className="h-4 w-4" />}>
                  Open recycle bin
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card id="danger" className="overflow-hidden scroll-mt-24 border-red-200/70 dark:border-red-500/30">
          <CardContent className="p-6">
            <SectionHeader
              icon={AlertTriangle}
              title="Danger Zone"
              description="Permanently delete your account and its data"
              iconBg="bg-red-50 dark:bg-red-500/10"
              iconColor="text-red-600 dark:text-red-400"
            />
            <div className="ml-0 sm:ml-14">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-red-200/70 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/5">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Delete account</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Permanently deletes your account, forms, and responses. This can't be undone.</p>
                </div>
                <Button variant="danger" onClick={() => { setDeleteAccountOpen(true); setDeletePassword(''); }} leftIcon={<Trash2 className="h-4 w-4" />}>
                  Delete account
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        </div>

        {/* Sticky anchor rail (lg+) */}
        <nav aria-label="Settings sections" className="hidden lg:block w-44 shrink-0 sticky top-24">
          <ul className="space-y-0.5 text-sm">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block px-3 py-1.5 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        </div>
      </div>

      <ConfirmDialog
        isOpen={pendingBackupFile !== null}
        onClose={() => setPendingBackupFile(null)}
        onConfirm={handleImportBackupConfirmed}
        title="Restore this backup?"
        message={`"${pendingBackupFile?.name ?? ''}" will be restored as NEW apps and forms alongside your existing ones — nothing is overwritten. Large backups can take a minute.`}
        confirmLabel="Restore backup"
      />

      <Modal isOpen={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} title="Delete account" size="sm">
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg border border-red-200 dark:border-red-500/20">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>This permanently deletes your account and all forms, responses, and apps you own. This cannot be undone.</span>
          </div>
          <PasswordInput
            label="Confirm your password"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
            placeholder="Your current password"
            autoComplete="current-password"
            disabled={isDeletingAccount}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setDeleteAccountOpen(false)} disabled={isDeletingAccount}>Cancel</Button>
            <Button variant="danger" onClick={handleDeleteAccount} isLoading={isDeletingAccount} disabled={!deletePassword}>Delete my account</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevokeApiKey}
        variant="danger"
        title="Revoke API key"
        message={`Revoke API key "${revokeTarget?.name ?? ''}"? Applications using it will stop working immediately. This cannot be undone.`}
        confirmLabel="Revoke key"
        isLoading={isRevoking}
      />

      <ConfirmDialog
        isOpen={revokeDesktopTarget !== null}
        onClose={() => setRevokeDesktopTarget(null)}
        onConfirm={confirmRevokeDesktop}
        variant="danger"
        title="Unlink desktop"
        message={`Unlink "${revokeDesktopTarget?.name ?? ''}"? It will need to link again from FormLogic Desktop's Settings to reconnect.`}
        confirmLabel="Unlink"
        isLoading={isRevokingDesktop}
      />

      <ConnectAiModal isOpen={showMcp} onClose={() => setShowMcp(false)} />
    </div>
  );
}
