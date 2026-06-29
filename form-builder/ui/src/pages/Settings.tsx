import { useState, useEffect } from 'react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { Switch } from '../components/ui/Switch';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { parseServerDate } from '../lib/utils';
import {
  User,
  Bell,
  Settings2,
  Mail,
  LayoutGrid,
  ArrowLeft,
  Shield,
  ShieldCheck,
  Palette,
  Check,
  Lock,
  Key,
  Copy,
  Trash2,
  Plus,
  AlertTriangle,
  Download,
} from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { api } from '../lib/api';
import type { AuditVerifyResult, ApiKey, ApiKeyCreated } from '../lib/api';

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
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);

  // Profile form state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
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
  const [passwordError, setPasswordError] = useState('');
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
  const [isLoadingKeys, setIsLoadingKeys] = useState(true);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>([]);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // Update form when user changes
  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
    }
  }, [user]);

  // Track profile changes
  useEffect(() => {
    const nameChanged = name !== (user?.name || '');
    const emailChanged = email !== (user?.email || '');
    setHasProfileChanges(nameChanged || emailChanged);
  }, [name, email, user]);

  const emailChanged = email.trim().toLowerCase() !== (user?.email || '').toLowerCase();

  const handleSaveProfile = async () => {
    // Changing the email requires the current password (the backend rejects it
    // otherwise). Surface that requirement instead of letting the save fail.
    if (emailChanged && !profilePassword) {
      toast.error('Password Required', 'Enter your current password to change your email.');
      return;
    }
    setIsSavingProfile(true);
    try {
      const payload = emailChanged ? { name, email, currentPassword: profilePassword } : { name, email };
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
    setPasswordError('');

    if (!currentPassword) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setIsChangingPassword(true);
    const result = await updateProfile({ currentPassword, password: newPassword } as any);
    setIsChangingPassword(false);

    if (result.success) {
      toast.success('Password Changed', 'Your password has been updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setPasswordError(result.error || 'Failed to change password');
    }
  };

  const [isExportingData, setIsExportingData] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const handleDeleteAccount = async () => {
    if (!deletePassword) { setDeleteError('Enter your password to confirm.'); return; }
    setIsDeletingAccount(true);
    setDeleteError(null);
    const result = await api.deleteAccount(deletePassword);
    if (result.error) {
      setIsDeletingAccount(false);
      setDeleteError(result.error);
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
    try {
      const result = await api.getApiKeys();
      if (result.data) {
        setApiKeys(result.data.keys);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoadingKeys(false);
    }
  };

  // Load API keys on mount
  useEffect(() => {
    loadApiKeys();
  }, []);

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim() || newKeyScopes.length === 0) return;

    setIsCreatingKey(true);
    try {
      const result = await api.createApiKey({ name: newKeyName.trim(), scopes: newKeyScopes });
      if (result.data) {
        setCreatedKey(result.data.key);
        setShowCreateKey(false);
        setNewKeyName('');
        setNewKeyScopes([]);
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
  ];

  return (
    <div className="min-h-screen">
      <Header title="Settings" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        {/* Profile Settings */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={User}
              title="Profile"
              description="Manage your personal information"
              iconBg="bg-indigo-50 dark:bg-indigo-500/10"
              iconColor="text-indigo-600 dark:text-indigo-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <Input
                label="Name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label="Email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {emailChanged && (
                <Input
                  label="Current password"
                  type="password"
                  placeholder="Required to change your email"
                  value={profilePassword}
                  onChange={(e) => setProfilePassword(e.target.value)}
                  autoComplete="current-password"
                />
              )}
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
        <Card className="overflow-hidden">
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
        <Card className="overflow-hidden">
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
                          useUIStore.getState().setThemeColor(theme.id as any);
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
        <Card className="overflow-hidden">
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
        <Card className="overflow-hidden">
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
              <Input
                label="Current Password"
                type="password"
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(''); }}
              />
              <Input
                label="New Password"
                type="password"
                placeholder="Enter new password (min 8 characters)"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setPasswordError(''); }}
              />
              <Input
                label="Confirm New Password"
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(''); }}
              />
              {passwordError && (
                <p role="alert" className="text-sm text-red-500">{passwordError}</p>
              )}
              <div className="pt-2">
                <Button
                  onClick={handleChangePassword}
                  disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword}
                  isLoading={isChangingPassword}
                >
                  Change Password
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Keys Section */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={Key}
              title="API Keys"
              description="Manage API keys for external integrations"
              iconBg="bg-amber-50 dark:bg-amber-500/10"
              iconColor="text-amber-600 dark:text-amber-400"
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
                              ? 'border-amber-400 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10'
                              : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={newKeyScopes.includes(scope.id)}
                            onChange={() => toggleScope(scope.id)}
                            className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-amber-500 focus:ring-amber-500"
                          />
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{scope.label}</p>
                            <p className="text-xs text-gray-500 dark:text-slate-400">{scope.description}</p>
                          </div>
                        </label>
                      ))}
                    </div>
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
                      onClick={() => { setShowCreateKey(false); setNewKeyName(''); setNewKeyScopes([]); }}
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
                              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-medium"
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                          {key.lastUsedAt
                            ? `Last used ${parseServerDate(key.lastUsedAt).toLocaleDateString()}`
                            : 'Never used'}
                          {' · '}Created {parseServerDate(key.createdAt).toLocaleDateString()}
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

        {/* Audit & Compliance Section */}
        <Card className="overflow-hidden">
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

        {/* Danger Zone */}
        <Card className="overflow-hidden border-red-200/70 dark:border-red-500/30">
          <CardContent className="p-6">
            <SectionHeader
              icon={AlertTriangle}
              title="Danger Zone"
              description="Export or permanently delete your account data"
              iconBg="bg-red-50 dark:bg-red-500/10"
              iconColor="text-red-600 dark:text-red-400"
            />
            <div className="space-y-3 ml-0 sm:ml-14">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Download my data</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Export your profile and forms as a JSON file.</p>
                </div>
                <Button variant="outline" onClick={handleExportData} isLoading={isExportingData} leftIcon={<Download className="h-4 w-4" />}>
                  Export
                </Button>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-red-200/70 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/5">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Delete account</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Permanently deletes your account, forms, and responses. This can't be undone.</p>
                </div>
                <Button variant="danger" onClick={() => { setDeleteAccountOpen(true); setDeletePassword(''); setDeleteError(null); }} leftIcon={<Trash2 className="h-4 w-4" />}>
                  Delete account
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Modal isOpen={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} title="Delete account" size="sm">
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg border border-red-200 dark:border-red-500/20">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>This permanently deletes your account and all forms, responses, and apps you own. This cannot be undone.</span>
          </div>
          <Input
            label="Confirm your password"
            type="password"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
            placeholder="Your current password"
            autoComplete="current-password"
          />
          {deleteError && <p className="text-sm text-red-600 dark:text-red-400">{deleteError}</p>}
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
    </div>
  );
}
