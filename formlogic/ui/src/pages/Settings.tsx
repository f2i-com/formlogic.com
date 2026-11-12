import { useState, useEffect, type ReactNode } from 'react';
import { deferEffect } from '../lib/deferredEffect';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { PageBody } from '../components/layout/PageBody';
import { SectionNav } from '../components/ui/SectionNav';
import { Panel, PANEL_COLUMNS } from '../components/ui/Panel';
import { Modal } from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { TimezoneSelect } from '../components/ui/TimezoneSelect';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { LocalRuntimePanel } from '../components/desktop/LocalRuntimePanel';
import { ConnectorRoutingPanel } from '../components/desktop/ConnectorRoutingPanel';
import { DataNodesPanel } from '../components/desktop/DataNodesPanel';
import { ConnectOaiyServer } from '../components/desktop/ConnectOaiyServer';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { cn, parseServerDate } from '../lib/utils';
import {
  User,
  Bell,
  Settings2,
  Shield,
  Plug,
  ShieldCheck,
  Palette,
  Check,
  Lock,
  LockKeyhole,
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
  ScrollText,
  Sparkles,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore, type ThemeColor } from '../stores/uiStore';
import { api } from '../lib/api';
import type { AuditVerifyResult, ApiKey, ApiKeyCreated, DesktopConnection, AccountBackupImportResult } from '../lib/api';
import { ConnectAiModal } from '../components/mcp/ConnectAiModal';
import { MfaPanel } from '../components/settings/MfaPanel';
import { SupportAccessPanel } from '../components/settings/SupportAccessPanel';
import { PassesPanel } from '../components/settings/PassesPanel';
import { VaultPanel } from '../components/vault/VaultPanel';
import { AiSourceCard } from '../components/settings/AiSourceCard';
import { ApiKeysList } from '../components/settings/ApiKeysList';
import { LinkedDesktopsList } from '../components/settings/LinkedDesktopsList';
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

// The page's five sections and the panels each one holds, by the panel's id.
// The section is the address's `#hash`. A section's own address is the hash of its first panel,
// as it has been since these were tabs, so the links setup wizards and other pages hold
// (/settings#ai, #security, #your-data) keep landing. A hash that names a later panel
// (#local-runtime, #linked-desktops, #backup) opens its section and brings that panel into view.
interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  panels: readonly string[];
}
const SECTIONS: readonly SettingsSection[] = [
  { id: 'account', label: 'Account', icon: User, panels: ['profile', 'notifications'] },
  { id: 'workspace', label: 'Workspace', icon: Palette, panels: ['appearance', 'form-defaults'] },
  { id: 'connections', label: 'AI & devices', icon: Plug, panels: ['ai', 'local-runtime', 'linked-desktops', 'mcp'] },
  { id: 'security', label: 'Security', icon: Shield, panels: ['security', 'two-factor', 'support-access', 'passes', 'vault', 'audit', 'api-keys'] },
  { id: 'data', label: 'Your data', icon: Archive, panels: ['your-data', 'backup', 'trash', 'danger'] },
];
/** What a link to a panel is called. */
const PANEL_LABELS: Record<string, string> = {
  profile: 'Profile', notifications: 'Notifications', appearance: 'Appearance', 'form-defaults': 'Form defaults',
  ai: 'AI assistant', 'local-runtime': 'Local runtime', 'linked-desktops': 'Linked desktops', mcp: 'External AI access',
  security: 'Password', 'two-factor': 'Two-factor authentication', 'support-access': 'Support access', passes: 'Passes', vault: 'Encryption vault',
  audit: 'Audit trail', 'api-keys': 'API keys',
  'your-data': 'Export a copy', backup: 'Backup & restore', trash: 'Recycle bin', danger: 'Delete account',
};
/** What the shared demo account is not shown: it has no sign-in of its own to protect, and its route table has no /trash. */
const NOT_IN_THE_DEMO: readonly string[] = ['two-factor', 'support-access', 'passes', 'vault', 'trash'];

// API-key expiry choices (days; 'never' = no expiresAt sent)
const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '365 days' },
] as const;

// A line of help under a control, and a native select drawn as the text fields are.
const HELP = 'text-xs leading-5 text-gray-500 dark:text-slate-400';
const SELECT = 'block w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white max-sm:min-h-11';
const TEXT_LINK = 'cursor-pointer font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300';
// A section's address is its first panel's hash, and when a page loads the browser brings the
// element its hash names into view by itself. For those five panels that has to be the top of
// the page, with the row of sections in sight, so they ask for more room above them than there
// is: the page stays at its top.
const SECTION_TOP = 'scroll-mt-[100vh]';
/** What ends "keep the panel asked for in view": the person moving the page themselves. */
const OWN_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/** One of the page's sections: a line of links to its panels where it has more than two (it
    runs past a screen), then the panels. Every section stays mounted, as every tab did, so what
    is typed in one is still there after a look at another and nothing is fetched twice; only
    the open one shows. */
function Section({ section, open, links, children }: { section: SettingsSection; open: boolean; links: readonly string[]; children: ReactNode }) {
  return (
    <section aria-label={section.label} hidden={!open} data-settings-section={section.id} className="mt-4">
      {links.length > 2 && (
        <nav aria-label={`${section.label} on this page`} className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {links.map((id) => (
            <Link key={id} to={{ hash: `#${id}` }} replace className="inline-flex items-center font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 max-sm:min-h-11">{PANEL_LABELS[id]}</Link>
          ))}
        </nav>
      )}
      {children}
    </section>
  );
}

export function Settings() {
  useDocumentTitle('Settings');
  const navigate = useNavigate();
  const location = useLocation();
  const requested = location.hash.slice(1);
  const section = SECTIONS.find((candidate) => candidate.id === requested || candidate.panels.includes(requested)) ?? SECTIONS[0];
  // The first panel's hash is the section's own address: it opens the section from its top.
  const panel = section.panels.indexOf(requested) > 0 ? requested : null;
  // Deep links like /settings#linked-desktops: SPA navigation doesn't fire the browser's native
  // fragment scroll, so bring the panel into view ourselves. `location.key` is new on every
  // press of a link, so pressing the link of the panel already in the address returns to it.
  useEffect(() => {
    // No panel named, or one this account is not shown (the demo's recycle bin): the section from its top.
    const target = panel ? document.getElementById(panel) : null;
    if (!target) { window.scrollTo(0, 0); return; }
    const show = () => target.scrollIntoView?.({ block: 'start' });
    show();
    // The panels fetch what they show after the first paint, and one that grows moves those after
    // it, into another column even. Until that settles, or the person moves the page themselves,
    // the panel asked for is kept where it was put.
    const block = target.closest('[data-settings-section]');
    if (typeof ResizeObserver === 'undefined' || !block) return;
    const observer = new ResizeObserver(show);
    observer.observe(block);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      OWN_SCROLL.forEach((event) => window.removeEventListener(event, stop));
    };
    const timer = window.setTimeout(stop, 3000);
    OWN_SCROLL.forEach((event) => window.addEventListener(event, stop, { passive: true }));
    return stop;
  }, [location.key, panel]);
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const isDemo = !!user?.isDemo;
  const shown = (id: string) => !isDemo || !NOT_IN_THE_DEMO.includes(id);

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
  // "Online now" is a freshness window on when a computer was last heard from.
  const isDesktopOnline = (conn: DesktopConnection) => conn.lastSeenAt !== null && now - parseServerDate(conn.lastSeenAt).getTime() < 90_000;

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
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [backupResult, setBackupResult] = useState<AccountBackupImportResult | null>(null);

  // ── Recycle bin (count for the panel; the /trash page is the real surface) ──
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
      const restoreLimit = await api.exportAccountBackup(backupPassphrase || undefined);
      if (restoreLimit) {
        toast.warning('Backup downloaded, but it is too big to upload here', `This site takes back up to ${Math.round(restoreLimit / 1048576)} MB. Ask whoever runs it to raise BACKUP_MAX_ZIP_SIZE before you need this file.`);
      } else {
        toast.success('Backup downloaded', backupPassphrase ? 'Keep the passphrase safe. Nobody can open this file without it.' : 'Apps, forms, flows, records and files — all in one zip.');
      }
      setBackupPassphrase('');
    } catch (e) {
      toast.error('Backup failed', e instanceof Error ? e.message : 'Could not build the backup.');
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleImportBackupConfirmed = async () => {
    const file = pendingBackupFile;
    const passphrase = restorePassphrase;
    setPendingBackupFile(null);
    setRestorePassphrase('');
    if (!file) return;
    setIsImportingBackup(true);
    setBackupResult(null);
    try {
      const r = await api.importAccountBackup(file, passphrase || undefined);
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

  const sectionProps = (id: string) => {
    const found = SECTIONS.find((candidate) => candidate.id === id) ?? SECTIONS[0];
    return { section: found, open: section.id === found.id, links: found.panels.filter(shown) };
  };

  return (
    <div className="min-h-screen">
      <Header title="Settings" />

      {/* The sections are links under the header, and each one's panels start at the page's left
          and fill its width: one column on a phone, two on a laptop, three on a wide screen. */}
      <PageBody>
        <SectionNav label="Settings sections" current={section.id}
          // A section adds a step to the history, as an app page's sections do: Back returns to
          // the one before. (The links to a panel inside a section replace the step they are on.)
          items={SECTIONS.map(({ id, label, icon, panels }) => ({ value: id, label, icon, to: { hash: `#${panels[0]}` } }))} />

        <Section {...sectionProps('account')}>
          <div className={PANEL_COLUMNS}>
            <Panel id="profile" className={SECTION_TOP} title="Profile" icon={<User className="h-4 w-4" />}>
              <div className="space-y-3">
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
                  <label htmlFor="account-timezone" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-slate-300">Timezone</label>
                  <TimezoneSelect
                    id="account-timezone"
                    value={timezone}
                    onChange={setTimezone}
                    disabled={isSavingProfile}
                    emptyLabel="Use each app's timezone"
                    className={SELECT}
                  />
                  <p className={cn('mt-1', HELP)}>Record times (call logs, submissions) show in this zone across every app you use. Leave unset to follow each app's own timezone.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3 dark:border-white/[0.06]">
                  <Button
                    className="max-sm:min-h-11"
                    onClick={handleSaveProfile}
                    disabled={!hasProfileChanges || isSavingProfile}
                    isLoading={isSavingProfile}
                  >
                    Save profile
                  </Button>
                  <p role="status" className="text-xs text-gray-500 dark:text-slate-400">{hasProfileChanges ? 'You have unsaved profile changes.' : 'Your profile is up to date.'}</p>
                </div>
              </div>
            </Panel>

            <Panel id="notifications" title="Notifications" icon={<Bell className="h-4 w-4" />}>
              <p className="text-sm leading-6 text-gray-600 dark:text-slate-300">
                Response emails are set per form, so they live with the form itself. Open{' '}
                <Link to="/forms" className={TEXT_LINK}>Forms</Link>,
                pick a form, then{' '}
                <span className="font-medium text-gray-900 dark:text-white">Settings → Notifications</span>{' '}
                to choose who gets an email when someone replies.
              </p>
            </Panel>
          </div>
        </Section>

        <Section {...sectionProps('workspace')}>
          <div className={PANEL_COLUMNS}>
            <Panel id="appearance" className={SECTION_TOP} title="Appearance" icon={<Palette className="h-4 w-4" />} description="Saved automatically in this browser.">
              {/* The swatches follow the panel's width, which is a column's, not the screen's. */}
              <div className="@container space-y-4">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Display mode</p>
                  <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Display mode">
                    {([{ id: 'light', label: 'Light', icon: Sun }, { id: 'dark', label: 'Dark', icon: Moon }] as const).map(mode => (
                      <button key={mode.id} type="button" aria-pressed={currentTheme === mode.id} onClick={() => useUIStore.getState().setTheme(mode.id)} className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary-500 ${currentTheme === mode.id ? 'border-primary-400 bg-primary-50 text-primary-700 dark:border-primary-500/50 dark:bg-primary-500/10 dark:text-primary-300' : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600'}`}>
                        <mode.icon className="h-4 w-4" aria-hidden="true" />{mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Accent color</p>
                  <p className={cn('mt-0.5', HELP)}>
                    Default adapts automatically — Indigo in light mode, Lime in dark mode.
                  </p>
                  <div className="mt-2 grid grid-cols-4 gap-2 @md:grid-cols-7">
                    {[
                      // Swatches show the colour they offer, whatever the accent is now: these two name indigo.
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
                          type="button"
                          aria-label={`Select ${theme.label} accent color`}
                          aria-pressed={isSelected}
                          onClick={() => {
                            useUIStore.getState().setThemeColor(theme.id as ThemeColor);
                            toast.success('Theme Updated', `Accent color changed to ${theme.label}`);
                          }}
                          className={`flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg border px-1 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 ${isSelected
                            ? 'border-primary-500 bg-primary-500/5 ring-1 ring-primary-500/50'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800'
                            }`}
                        >
                          <span className={`flex h-7 w-7 items-center justify-center rounded-full shadow-sm ${theme.color}`}>
                            {isSelected && <Check className={`h-4 w-4 ${theme.check}`} />}
                          </span>
                          <span className={`max-w-full truncate text-xs font-medium ${isSelected ? 'text-primary-700 dark:text-primary-300' : 'text-gray-600 dark:text-slate-400'}`}>
                            {theme.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Panel>

            <Panel id="form-defaults" title="Form defaults" icon={<Settings2 className="h-4 w-4" />} description="Set defaults for new forms you create">
              <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                <div className="flex items-center justify-between gap-3 pb-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">Show progress bar</p>
                    <p className={HELP}>Display progress bar on forms by default</p>
                  </div>
                  <Switch
                    checked={preferences.showProgressBar}
                    onChange={(checked) => handlePreferenceChange('showProgressBar', checked)}
                    ariaLabel="Show progress bar on forms by default"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 pt-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">Allow back navigation</p>
                    <p className={HELP}>Allow respondents to go back to previous questions</p>
                  </div>
                  <Switch
                    checked={preferences.allowBackNavigation}
                    onChange={(checked) => handlePreferenceChange('allowBackNavigation', checked)}
                    ariaLabel="Allow respondents to go back to previous questions"
                  />
                </div>
              </div>
            </Panel>
          </div>
        </Section>

        <Section {...sectionProps('connections')}>
          <div className={PANEL_COLUMNS}>
            <Panel id="ai" className={SECTION_TOP} title="AI assistant" icon={<Sparkles className="h-4 w-4" />} description="Choose which AI answers your chats and automations">
              <Link to="/connect-ai" className="mb-4 inline-flex min-h-9 items-center rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700 dark:hover:bg-primary-500 max-sm:min-h-11">Start guided AI setup</Link>
              <AiSourceCard />
            </Panel>

            {/* This one draws its own box and heading (it is shared with the AI setup pages, where it
                stands alone). Here its box takes the measure of the panels beside it, so their
                edges and titles line up. */}
            <section id="local-runtime" aria-label="Local desktop connection"
              className="min-w-0 scroll-mt-[calc(6rem+var(--fl-demo-banner-h,0px))] [&>div]:border-gray-200 [&>div]:p-4 [&>div]:shadow-sm dark:[&>div]:border-slate-700 dark:[&>div]:bg-slate-900">
              <LocalRuntimePanel />
            </section>

            <Panel id="linked-desktops" title="Linked desktops" icon={<Laptop className="h-4 w-4" />}
              description="OAIY computers linked to your FormLogic account. Use their AI, plugins, and flows from another computer while OAIY stays running.">
              <div className="space-y-3">
                {isLoadingDesktops ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-slate-400">
                    <Spinner size="sm" /> <span>Loading linked desktops…</span>
                  </div>
                ) : desktopLoadError ? (
                  <p className="text-sm text-gray-600 dark:text-slate-300">
                    {desktopLoadError}{' '}
                    <button type="button" onClick={() => loadDesktopConnections()} className={cn(TEXT_LINK, 'max-sm:min-h-11')}>Try again</button>
                  </p>
                ) : desktopConnections.length === 0 ? (
                  <div>
                    <h3 className="text-sm font-medium text-gray-900 dark:text-white">No desktops linked yet</h3>
                    <p className={cn('mt-1', HELP)}>Link the account from the computer running OAIY. A local browser connection alone will not add a computer here.</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-gray-600 dark:text-slate-300">
                      <li>Open OAIY Desktop → Connections → Linked account.</li>
                      <li>Set the address to this FormLogic site and click <strong>Link account</strong>.</li>
                      <li>Approve in the browser on that computer, using the same FormLogic account you use here.</li>
                      <li>Return to OAIY and confirm it shows a linked account, then check again below.</li>
                    </ol>
                    <Button className="mt-3" size="sm" variant="outline" onClick={() => loadDesktopConnections()}>Check linked computers</Button>
                  </div>
                ) : (
                  <LinkedDesktopsList
                    connections={desktopConnections}
                    isOnline={isDesktopOnline}
                    onUnlink={(conn) => setRevokeDesktopTarget({ id: conn.id, name: conn.deviceName })}
                  />
                )}
                {/* An always-on OAIY server links with a one-time code (App AI contract §2). */}
                {!isLoadingDesktops && !desktopLoadError && <ConnectOaiyServer compact onLinked={() => void loadDesktopConnections(true)} />}
                {/* ROUTE-001: pick which machine services each connector's remote commands. */}
                {!isLoadingDesktops && !desktopLoadError && desktopConnections.length > 0 && (
                  <ConnectorRoutingPanel />
                )}
                {/* Encrypted data nodes (docs/FORMLOGIC_DATA_NODES.md §11): enrolment roster +
                    owner approval. Hides itself while the DATA_NODES flag is off. */}
                <DataNodesPanel
                  desktops={desktopConnections.filter((conn) => !conn.aiOnly).map((conn) => ({
                    id: conn.id,
                    deviceName: conn.deviceName,
                    online: isDesktopOnline(conn),
                  }))}
                />
              </div>
            </Panel>

            <Panel id="mcp" title="External AI access" icon={<Plug className="h-4 w-4" />} description="Let an AI app you use elsewhere (Claude, Cursor, …) build and edit your apps">
              <Button variant="outline" size="sm" onClick={() => setShowMcp(true)} leftIcon={<Plug className="h-4 w-4" />}>
                Manage AI connections
              </Button>
            </Panel>
          </div>
        </Section>

        <Section {...sectionProps('security')}>
          {/* Side by side, the tallest column ends flush with the block (a column's last margin
              is dropped), so the gap to the keys under it is the block's own; in one column the
              last panel's margin is that gap already. */}
          <div className={cn(PANEL_COLUMNS, 'lg:pb-4')}>
            <Panel id="security" className={SECTION_TOP} title="Password" icon={<Lock className="h-4 w-4" />}>
              <div className="space-y-3">
                <PasswordInput
                  label="Current password"
                  placeholder="Enter current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={isChangingPassword}
                />
                <PasswordInput
                  label="New password"
                  placeholder="Enter new password (min 10 characters)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  error={newPassword ? newPasswordError || undefined : undefined}
                  disabled={isChangingPassword}
                />
                <PasswordInput
                  label="Confirm new password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  error={confirmPasswordMismatch ? 'Passwords do not match' : undefined}
                  disabled={isChangingPassword}
                />
                <Button
                  className="max-sm:min-h-11"
                  onClick={handleChangePassword}
                  disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword || !!newPasswordError || confirmPasswordMismatch}
                  isLoading={isChangingPassword}
                >
                  Change password
                </Button>
              </div>
            </Panel>

            {/* Two-factor authentication (TOTP): enrollment, recovery codes,
                remembered browsers. Optional; hidden for the shared demo. */}
            <MfaPanel />

            {/* Whether administrators may edit this account's code, and what they've done here. */}
            <SupportAccessPanel />

            {/* Age checks made for apps with an age gate, each one withdrawable. */}
            {!isDemo && <PassesPanel />}

            {/* E2EE encryption vault (Private forms): create/unlock/lock + passphrase change.
                Hidden for the shared demo. The vault's own component (components/vault) opens with
                a heading of the same words; the panel's title stands for it, and that heading is
                put away only while it is still the first thing the component draws. */}
            {user && !isDemo && (
              <Panel id="vault" title="Encryption vault" icon={<LockKeyhole className="h-4 w-4" />}>
                <VaultPanel heading={false} />
              </Panel>
            )}

            <Panel id="audit" title="Audit trail" icon={<ScrollText className="h-4 w-4" />}>
              <p className={HELP}>
                The audit log uses cryptographic hash chaining to ensure entries cannot be tampered with.
                Run a verification to confirm the chain is intact.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={handleVerifyAudit}
                disabled={isVerifyingAudit}
                isLoading={isVerifyingAudit}
              >
                Verify audit integrity
              </Button>
              {auditResult && (
                <div role="status" className={`mt-3 flex items-start gap-3 rounded-xl border p-3 ${
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
            </Panel>
          </div>

          {/* The keys are a table: it takes the page's whole width, under the panels. */}
          <Panel id="api-keys" title="API keys" icon={<Key className="h-4 w-4" />} description="Manage API keys for external integrations"
            actions={!showCreateKey && (
              <Button size="sm" variant="secondary" onClick={() => setShowCreateKey(true)} leftIcon={<Plus className="h-4 w-4" />}>
                Create API key
              </Button>
            )}>
            <div className="@container space-y-3">
              {/* Created key display (one-time) */}
              {createdKey && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      Copy your API key now. It won't be shown again.
                    </p>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-lg border border-amber-200 bg-white px-3 py-2 font-mono text-xs text-gray-900 dark:border-amber-600/30 dark:bg-slate-900 dark:text-white">
                      {createdKey.key}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyKey(createdKey.key)}
                      className="inline-flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-amber-200 bg-white transition-colors hover:bg-amber-50 dark:border-amber-600/30 dark:bg-slate-900 dark:hover:bg-slate-800 max-sm:h-11 max-sm:w-11"
                      title="Copy to clipboard"
                      aria-label="Copy to clipboard"
                    >
                      {copiedKey ? (
                        <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreatedKey(null)}
                    className="mt-2 inline-flex cursor-pointer items-center text-xs text-amber-700 hover:underline dark:text-amber-400 max-sm:min-h-11"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Create key form */}
              {showCreateKey && (
                <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
                  <div className="max-w-sm">
                    <Input
                      label="Key name"
                      placeholder="e.g., CRM Integration"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                    />
                  </div>
                  <fieldset className="m-0 min-w-0 border-0 p-0">
                    <legend className="mb-1.5 block p-0 text-sm font-medium text-gray-700 dark:text-slate-300">
                      Scopes
                    </legend>
                    <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 @4xl:grid-cols-3">
                      {AVAILABLE_SCOPES.map((scope) => (
                        <label
                          key={scope.id}
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors ${
                            newKeyScopes.includes(scope.id)
                              ? 'border-primary-400 dark:border-primary-500/50 bg-primary-50 dark:bg-primary-500/10'
                              : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-slate-700 dark:bg-transparent dark:hover:bg-slate-800'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={newKeyScopes.includes(scope.id)}
                            onChange={() => toggleScope(scope.id)}
                            className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-primary-600 accent-primary-600 focus:ring-primary-500"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-gray-900 dark:text-white">{scope.label}</span>
                            <span className={cn('block', HELP)}>{scope.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="max-w-xs">
                    <label htmlFor="api-key-expiry" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-slate-300">
                      Expiration
                    </label>
                    <select
                      id="api-key-expiry"
                      value={newKeyExpiry}
                      onChange={(e) => setNewKeyExpiry(e.target.value)}
                      className={SELECT}
                    >
                      {EXPIRY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="max-sm:min-h-11"
                      onClick={handleCreateApiKey}
                      disabled={!newKeyName.trim() || newKeyScopes.length === 0 || isCreatingKey}
                      isLoading={isCreatingKey}
                    >
                      Create key
                    </Button>
                    <Button
                      className="max-sm:min-h-11"
                      variant="secondary"
                      onClick={() => { setShowCreateKey(false); setNewKeyName(''); setNewKeyScopes([]); setNewKeyExpiry('never'); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* Key list */}
              {isLoadingKeys ? (
                <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-slate-400">
                  <Spinner size="sm" /> <span>Loading keys…</span>
                </div>
              ) : keyLoadError ? (
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  {keyLoadError}{' '}
                  <button type="button" onClick={loadApiKeys} className={cn(TEXT_LINK, 'max-sm:min-h-11')}>Try again</button>
                </p>
              ) : apiKeys.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  <span className="font-medium text-gray-900 dark:text-white">No API keys yet.</span>{' '}
                  Create a key to integrate with the FormLogic API.
                </p>
              ) : (
                <ApiKeysList keys={apiKeys} onRevoke={(key) => setRevokeTarget({ id: key.id, name: key.name })} />
              )}
            </div>
          </Panel>
        </Section>

        <Section {...sectionProps('data')}>
          <div className={PANEL_COLUMNS}>
            <Panel id="your-data" className={SECTION_TOP} title="Export a copy" icon={<Download className="h-4 w-4" />} description="A readable copy for your own records — not a restorable backup">
              <p className={HELP}>
                Profile, forms, apps, and API-key metadata as JSON — for reading, or for taking elsewhere.
                It cannot be restored back into FormLogic; use <span className="font-medium text-gray-700 dark:text-slate-200">Backup &amp; restore</span> for that.
                Records export from each form separately; secrets are never included.
              </p>
              <Button className="mt-3" size="sm" variant="outline" onClick={handleExportData} isLoading={isExportingData} leftIcon={<Download className="h-4 w-4" />}>
                Export
              </Button>
            </Panel>

            <Panel id="backup" title="Backup & restore" icon={<Archive className="h-4 w-4" />} description="A file you can restore later — this is the one to keep">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">Download full backup</h3>
                  <p className={cn('mt-1', HELP)}>
                    Everything in one zip: apps, forms and flows (schemas), a consistent snapshot of every form&apos;s record database, uploaded files,
                    and each hosted native app&apos;s source, media and private database.
                    Webhook secrets, members, API keys and native app host keys are not included — a restore from this download re-issues native app keys.
                  </p>
                  <div className="mt-3 max-w-sm">
                    <PasswordInput
                      label="Passphrase (optional)"
                      value={backupPassphrase}
                      onChange={(e) => setBackupPassphrase(e.target.value)}
                      placeholder="At least 12 characters"
                      autoComplete="new-password"
                    />
                    <p className={cn('mt-1', HELP)}>
                      Encrypts the file. Without the passphrase nobody can open it, and we can&apos;t recover it for you.
                    </p>
                  </div>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={handleExportBackup}
                    isLoading={isExportingBackup}
                    disabled={backupPassphrase.length > 0 && backupPassphrase.length < 12}
                    leftIcon={<Archive className="h-4 w-4" />}
                  >
                    Download backup
                  </Button>
                </div>
                <div className="border-t border-gray-100 pt-4 dark:border-white/[0.06]">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">Restore from backup</h3>
                  <p className={cn('mt-1', HELP)}>
                    Creates new copies of everything in the backup — nothing is overwritten. Re-importing the same backup creates duplicates.
                  </p>
                  <label className="mt-3 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 max-sm:min-h-11">
                    <UploadCloud className="h-4 w-4" />
                    {isImportingBackup ? 'Restoring…' : 'Restore backup'}
                    <input
                      type="file"
                      accept=".zip,.flbk,application/zip"
                      className="hidden"
                      disabled={isImportingBackup}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) setPendingBackupFile(f); e.target.value = ''; }}
                    />
                  </label>
                </div>
                {backupResult && (
                  <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10">
                    <p className="font-medium text-gray-900 dark:text-white">Restore complete</p>
                    <p className="text-gray-600 dark:text-slate-300">
                      {backupResult.apps.length} apps · {backupResult.forms.length} forms · {backupResult.flows} flows · {backupResult.bindings} bindings · {backupResult.responses.toLocaleString()} records · {backupResult.files} files{(backupResult.nativeApps?.length ?? 0) > 0 ? ` · ${backupResult.nativeApps!.length} native apps` : ''}
                    </p>
                    {(backupResult.warnings ?? []).map((w, i) => (
                      <p key={i} className="text-amber-700 dark:text-amber-400 text-xs">{w}</p>
                    ))}
                  </div>
                )}
              </div>
            </Panel>

            {/* The demo's route table has no /trash, and the shared account has nothing of its own to restore. */}
            {!isDemo && (
              <Panel id="trash" title="Recycle bin" icon={<Recycle className="h-4 w-4" />} description="Deleted forms, apps and flows stay restorable for 30 days">
                {trashCount !== null && (
                  <p className="mb-1 text-sm font-medium text-gray-900 dark:text-white">
                    {trashCount === 0 ? 'The recycle bin is empty' : `${trashCount} item${trashCount === 1 ? '' : 's'} in the recycle bin`}
                  </p>
                )}
                <p className={HELP}>
                  Deleting a form, app or flow keeps a snapshot (records and files included) for 30 days — restore it anytime before then.
                </p>
                <Button className="mt-3" size="sm" variant="outline" onClick={() => navigate('/trash')} leftIcon={<Recycle className="h-4 w-4" />}>
                  Open recycle bin
                </Button>
              </Panel>
            )}

            <Panel id="danger" title="Delete account" icon={<AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />} className="border-red-200 dark:border-red-500/30">
              <p className={HELP}>Permanently deletes your account, forms, and responses. This can't be undone.</p>
              {/* The danger button's own red is short of readable on its tint at this size: a shade darker in the light theme, lighter in the dark one. */}
              <Button className="mt-3 text-red-700 dark:text-red-400" size="sm" variant="danger" onClick={() => { setDeleteAccountOpen(true); setDeletePassword(''); }} leftIcon={<Trash2 className="h-4 w-4" />}>
                Delete account
              </Button>
            </Panel>
          </div>
        </Section>
      </PageBody>

      <ConfirmDialog
        isOpen={pendingBackupFile !== null}
        onClose={() => { setPendingBackupFile(null); setRestorePassphrase(''); }}
        onConfirm={handleImportBackupConfirmed}
        title="Restore this backup?"
        message={`"${pendingBackupFile?.name ?? ''}" will be restored as NEW apps and forms alongside your existing ones — nothing is overwritten. Large backups can take a minute.`}
        confirmLabel="Restore backup"
        confirmDisabled={pendingBackupFile?.name.endsWith('.flbk') === true && !restorePassphrase}
      >
        {pendingBackupFile?.name.endsWith('.flbk') && (
          <PasswordInput
            label="Passphrase"
            value={restorePassphrase}
            onChange={(e) => setRestorePassphrase(e.target.value)}
            placeholder="The passphrase set when this backup was made"
            autoComplete="off"
          />
        )}
      </ConfirmDialog>

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
