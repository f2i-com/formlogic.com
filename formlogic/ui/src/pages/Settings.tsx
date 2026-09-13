import { useState, useEffect } from 'react';
import { deferEffect } from '../lib/deferredEffect';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
import { LocalRuntimePanel } from '../components/desktop/LocalRuntimePanel';
import { ConnectorRoutingPanel } from '../components/desktop/ConnectorRoutingPanel';
import { DataNodesPanel } from '../components/desktop/DataNodesPanel';
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
  Sparkles,
  Sun,
  Moon,
} from 'lucide-react';
import { useUIStore, type ThemeColor } from '../stores/uiStore';
import { api } from '../lib/api';
import type { AuditVerifyResult, ApiKey, ApiKeyCreated, DesktopConnection, AccountBackupImportResult } from '../lib/api';
import { ConnectAiModal } from '../components/mcp/ConnectAiModal';
import { MfaPanel } from '../components/settings/MfaPanel';
import { VaultPanel } from '../components/vault/VaultPanel';
import { AiSourceCard } from '../components/settings/AiSourceCard';
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

// Keep section hashes stable for links from setup wizards and other pages.
const SETTINGS_TABS = [
  { id: 'account', label: 'Account', icon: User, description: 'Your profile, timezone and notification preferences.', sections: ['profile', 'notifications'] },
  { id: 'workspace', label: 'Workspace', icon: Palette, description: 'Make FormLogic comfortable to use and choose defaults for new forms.', sections: ['appearance', 'form-defaults'] },
  { id: 'connections', label: 'AI & devices', icon: Plug, description: 'Choose your AI, connect OAIY and manage access for external assistants.', sections: ['ai', 'local-runtime', 'linked-desktops', 'mcp'] },
  { id: 'security', label: 'Security', icon: Shield, description: 'Protect your account, manage API keys and check your audit trail.', sections: ['security', 'api-keys', 'audit'] },
  { id: 'data', label: 'Your data', icon: Archive, description: 'Download your data, restore a backup or recover deleted items.', sections: ['your-data', 'backup', 'trash', 'danger'] },
];
const SECTION_LABELS: Record<string, string> = {
  profile: 'Profile', notifications: 'Notifications', appearance: 'Appearance', 'form-defaults': 'Form defaults',
  ai: 'AI assistant', 'local-runtime': 'OAIY connection', 'linked-desktops': 'Linked desktops', mcp: 'External AI access',
  security: 'Account protection', 'api-keys': 'API keys', audit: 'Audit trail',
  'your-data': 'Export a copy', backup: 'Backup & restore', trash: 'Recycle bin', danger: 'Delete account',
};

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
    <div className="mb-5 flex items-start gap-3 border-b border-gray-100 pb-5 dark:border-white/[0.06]">
      <div className={`shrink-0 rounded-xl p-2.5 ${iconBg}`}>
        <Icon className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white tracking-tight sm:text-lg">{title}</h3>
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
  // Deep links like /settings#ai (Connect-AI wizard): SPA navigation doesn't fire
  // the browser's native fragment scroll, so address the card ourselves.
  const { hash } = useLocation();
  const requestedSection = hash.slice(1);
  const activeTab = SETTINGS_TABS.find(tab => tab.sections.includes(requestedSection)) ?? SETTINGS_TABS[0];
  const activeSection = activeTab.sections.includes(requestedSection) ? requestedSection : activeTab.sections[0];
  useEffect(() => {
    if (!hash) { window.scrollTo(0, 0); return; }
    const target = !requestedSection || requestedSection === activeTab.sections[0] ? 'settings-navigation' : activeSection;
    document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }, [hash, requestedSection, activeSection, activeTab]);
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);

  // Profile form state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [timezone, setTimezone] = useState(user?.timezone || '');
  const [profilePassword, setProfilePassword] = useState('');
  const hasProfileChanges = name !== (user?.name || '') || email !== (user?.email || '') || timezone !== (user?.timezone || '');
  const now = useCurrentTime(15_000);

  // Theme
  const themeColor = useUIStore((state) => state.themeColor);
  const currentTheme = useUIStore((state) => state.theme);

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
  const [profileUser, setProfileUser] = useState(user);
  if (profileUser !== user) {
    setProfileUser(user);
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
      setTimezone(user.timezone || '');
    }
  }

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
    const deletedUserId = user?.id ?? null;
    const result = await api.deleteAccount(deletePassword);
    if (result.error) {
      setIsDeletingAccount(false);
      toast.error('Failed to Delete Account', result.error);
      return;
    }
    // Account gone — AWAIT the full client teardown (audit FL-10: chats, attachments,
    // queued offline submissions, caches, persisted stores) BEFORE navigating;
    // navigation alone never cleared IndexedDB or Cache Storage.
    const { teardownUserSession } = await import('../stores/authStore');
    await teardownUserSession(deletedUserId, 'account-deleted');
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
  useEffect(() => deferEffect(() => {
    loadApiKeys();
  }), []);

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
  useEffect(() => deferEffect(() => {
    loadDesktopConnections();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadDesktopConnections(true);
    }, 45_000);
    return () => clearInterval(timer);
  }), []);

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
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <Header title="Settings" />

      <div className="@container/settings mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6 lg:p-8">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm sm:p-6 dark:border-white/[0.08] dark:bg-slate-900/60">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400">Your FormLogic workspace</p>
          <h2 className="mt-2 text-xl font-semibold text-gray-900 sm:text-2xl dark:text-white">Make it yours</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-slate-400">Manage your account, appearance, AI connections and data in one place.</p>
        </div>
        <div id="settings-navigation" role="tablist" aria-label="Settings categories" className="grid scroll-mt-24 grid-cols-3 gap-2 rounded-2xl border border-gray-200/80 bg-white p-2 shadow-sm @3xl/settings:grid-cols-5 dark:border-white/[0.08] dark:bg-slate-900/60">
          {SETTINGS_TABS.map((tab, index) => (
            <button key={tab.id} id={`settings-tab-${tab.id}`} type="button" role="tab" aria-controls={`settings-panel-${tab.id}`} aria-selected={activeTab.id === tab.id} tabIndex={activeTab.id === tab.id ? 0 : -1}
              onClick={() => navigate(`#${tab.sections[0]}`)}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
                const destination = SETTINGS_TABS[next];
                navigate(`#${destination.sections[0]}`);
                document.getElementById(`settings-tab-${destination.id}`)?.focus();
              }}
              className={`flex min-h-16 min-w-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl px-2 py-3 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-primary-500 @3xl/settings:flex-row @3xl/settings:text-sm ${activeTab.id === tab.id ? 'bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-200 dark:bg-primary-500/15 dark:text-primary-300 dark:ring-primary-500/30' : 'text-gray-600 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-white/[0.04]'}`}>
              <tab.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="px-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{activeTab.label}</h2>
          <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-slate-400">{activeTab.description}</p>
          <nav aria-label="Settings sections" className="mt-3 flex flex-wrap gap-2">
            {activeTab.sections.map(section => <Link key={section} to={`#${section}`} aria-current={activeSection === section ? 'location' : undefined} className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary-500 ${activeSection === section ? 'border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300' : 'border-gray-200 bg-white text-gray-600 hover:border-primary-300 dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-300'}`}>{SECTION_LABELS[section]}</Link>)}
          </nav>
        </div>
        <div id="settings-panel-account" role="tabpanel" aria-labelledby="settings-tab-account" hidden={activeTab.id !== 'account'} className="space-y-5" tabIndex={0}>
        <Card id="profile" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={User}
              title="Profile"
              description="Manage your personal information"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 min-w-0">
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
              <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4 dark:border-white/[0.06]">
                <Button
                  onClick={handleSaveProfile}
                  disabled={!hasProfileChanges || isSavingProfile}
                  isLoading={isSavingProfile}
                >
                  Save profile
                </Button>
                <p role="status" className="text-xs text-gray-500 dark:text-slate-400">{hasProfileChanges ? 'You have unsaved profile changes.' : 'Your profile is up to date.'}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card id="notifications" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Bell}
              title="Notifications"
              description="Configure how you receive updates"
              iconBg="bg-blue-50 dark:bg-blue-500/10"
              iconColor="text-blue-600 dark:text-blue-400"
            />
            <div className="min-w-0">
              <div className="flex items-start gap-3 py-3 text-sm">
                <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg shrink-0">
                  <Mail className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                </div>
                <p className="text-gray-500 dark:text-slate-400">
                  Response emails are set per form, so they live with the form itself. Open{' '}
                  <Link to="/forms" className="font-medium text-primary-600 hover:underline dark:text-primary-400">Forms</Link>,
                  pick a form, then{' '}
                  <span className="font-medium text-gray-700 dark:text-slate-300">Settings → Notifications</span>{' '}
                  to choose who gets an email when someone replies.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
        <div id="settings-panel-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" hidden={activeTab.id !== 'workspace'} className="space-y-5" tabIndex={0}>
        <Card id="appearance" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Palette}
              title="Appearance"
              description="Customize the look and feel of your workspace"
              iconBg="bg-pink-50 dark:bg-pink-500/10"
              iconColor="text-pink-600 dark:text-pink-400"
            />
            <div className="space-y-4 min-w-0">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Display mode</p>
                <div className="mt-3 grid grid-cols-2 gap-3" role="group" aria-label="Display mode">
                  {([{ id: 'light', label: 'Light', icon: Sun }, { id: 'dark', label: 'Dark', icon: Moon }] as const).map(mode => (
                    <button key={mode.id} type="button" aria-pressed={currentTheme === mode.id} onClick={() => useUIStore.getState().setTheme(mode.id)} className={`flex min-h-16 cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary-500 ${currentTheme === mode.id ? 'border-primary-400 bg-primary-50 text-primary-700 dark:border-primary-500/50 dark:bg-primary-500/10 dark:text-primary-300' : 'border-gray-200 text-gray-600 dark:border-white/10 dark:text-slate-300'}`}>
                      <mode.icon className="h-5 w-5" aria-hidden="true" />{mode.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">Appearance changes are saved automatically in this browser.</p>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2 block">
                  Accent Color
                </label>
                <p className="text-xs text-gray-500 dark:text-slate-400 -mt-1 mb-3">
                  Default adapts automatically — Indigo in light mode, Lime in dark mode.
                </p>
                <div className="grid grid-cols-3 @2xl/settings:grid-cols-4 @4xl/settings:grid-cols-7 gap-3">
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

        <Card id="form-defaults" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Settings2}
              title="Default Form Settings"
              description="Set defaults for new forms you create"
              iconBg="bg-green-50 dark:bg-green-500/10"
              iconColor="text-green-600 dark:text-green-400"
            />
            <div className="space-y-1 min-w-0">
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
                  ariaLabel="Show progress bar on forms by default"
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
                  ariaLabel="Allow respondents to go back to previous questions"
                />
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
        <div id="settings-panel-connections" role="tabpanel" aria-labelledby="settings-tab-connections" hidden={activeTab.id !== 'connections'} className="space-y-5" tabIndex={0}>
        <Card id="ai" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Sparkles}
              title="AI assistant"
              description="Choose which AI answers your chats and automations"
              iconBg="bg-indigo-50 dark:bg-indigo-500/10"
              iconColor="text-indigo-600 dark:text-indigo-400"
            />
            <div className="min-w-0">
              <Link to="/connect-ai" className="mb-5 inline-flex min-h-11 items-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground">Start guided AI setup</Link>
              <AiSourceCard />
            </div>
          </CardContent>
        </Card>

        <section id="local-runtime" className="scroll-mt-24" aria-label="Local desktop connection"><LocalRuntimePanel /></section>

        <Card id="linked-desktops" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Laptop}
              title="Linked Desktops"
              description="FormLogic Desktop installs linked to your account. Each one can run your flows and relay live commands (like the Aokie phone bridge) even when you're not at that computer."
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 min-w-0">
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
                    const isOnline = conn.lastSeenAt !== null && now - parseServerDate(conn.lastSeenAt).getTime() < 90_000;
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
              {/* ROUTE-001: pick which machine services each connector's remote commands. */}
              {!isLoadingDesktops && !desktopLoadError && desktopConnections.length > 0 && (
                <ConnectorRoutingPanel />
              )}
              {/* Encrypted data nodes (docs/FORMLOGIC_DATA_NODES.md §11): enrolment roster +
                  owner approval. Hides itself while the DATA_NODES flag is off. */}
              <DataNodesPanel />
            </div>
          </CardContent>
        </Card>

        <Card id="mcp" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Plug}
              title="External AI access"
              description="Let an AI app you use elsewhere (Claude, Cursor, …) build and edit your apps"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="min-w-0">
              <Button variant="outline" onClick={() => setShowMcp(true)} leftIcon={<Plug className="h-4 w-4" />}>
                Manage AI connections
              </Button>
            </div>
          </CardContent>
        </Card>
        </div>
        <div id="settings-panel-security" role="tabpanel" aria-labelledby="settings-tab-security" hidden={activeTab.id !== 'security'} className="space-y-5" tabIndex={0}>
        <Card id="security" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Shield}
              title="Security"
              description="Manage your account security"
              iconBg="bg-purple-50 dark:bg-purple-500/10"
              iconColor="text-purple-600 dark:text-purple-400"
            />
            <div className="space-y-4 min-w-0">
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

              {/* Two-factor authentication (TOTP): enrollment, recovery codes,
                  remembered browsers. Optional; hidden for the shared demo. */}
              <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
                <MfaPanel />
              </div>

              {/* E2EE encryption vault (Private forms): create/unlock/lock +
                  passphrase change. Hidden for the shared demo. */}
              <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
                <VaultPanel />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card id="api-keys" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Key}
              title="API Keys"
              description="Manage API keys for external integrations"
              iconBg="bg-primary-50 dark:bg-primary-500/10"
              iconColor="text-primary-600 dark:text-primary-400"
            />
            <div className="space-y-4 min-w-0">
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

        <Card id="audit" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Shield}
              title="Audit trail"
              description="Verify the integrity of your audit trail"
              iconBg="bg-emerald-50 dark:bg-emerald-500/10"
              iconColor="text-emerald-600 dark:text-emerald-400"
            />
            <div className="space-y-4 min-w-0">
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
        </div>
        <div id="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data" hidden={activeTab.id !== 'data'} className="space-y-5" tabIndex={0}>
        <Card id="your-data" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Download}
              title="Your data"
              description="A readable copy for your own records — not a restorable backup"
              iconBg="bg-sky-50 dark:bg-sky-500/10"
              iconColor="text-sky-600 dark:text-sky-400"
            />
            <div className="min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Download my data</p>
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    Profile, forms, apps, and API-key metadata as JSON — for reading, or for taking elsewhere.
                    It cannot be restored back into FormLogic; use <span className="font-medium">Backup &amp; restore</span> below for that.
                    Records export from each form separately; secrets are never included.
                  </p>
                </div>
                <Button variant="outline" onClick={handleExportData} isLoading={isExportingData} leftIcon={<Download className="h-4 w-4" />}>
                  Export
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card id="backup" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Archive}
              title="Backup & restore"
              description="A file you can restore later — this is the one to keep"
              iconBg="bg-indigo-50 dark:bg-indigo-500/10"
              iconColor="text-indigo-600 dark:text-indigo-400"
            />
            <div className="min-w-0 space-y-3">
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

        <Card id="trash" className="overflow-hidden rounded-2xl scroll-mt-24">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={Recycle}
              title="Recycle bin"
              description="Deleted forms, apps and flows stay restorable for 30 days"
              iconBg="bg-emerald-50 dark:bg-emerald-500/10"
              iconColor="text-emerald-600 dark:text-emerald-400"
            />
            <div className="min-w-0">
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

        <Card id="danger" className="overflow-hidden rounded-2xl scroll-mt-24 border-red-200/70 dark:border-red-500/30">
          <CardContent className="p-5 sm:p-6">
            <SectionHeader
              icon={AlertTriangle}
              title="Delete account"
              description="Permanently delete your account and everything in it"
              iconBg="bg-red-50 dark:bg-red-500/10"
              iconColor="text-red-600 dark:text-red-400"
            />
            <div className="min-w-0">
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
