import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FileInput,
  KeyRound,
  Link2,
  LockKeyhole,
  Settings2,
  Shield,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import { Switch } from '../../ui/Switch';
import { PermissionMatrix } from '../../ui/PermissionMatrix';
import { api } from '../../../lib/api';
import { isDemoLocalId } from '../../../lib/demoLocal';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useAppUserStore } from '../../../stores/appUserStore';
import { trackStudioSave } from '../studioSaveState';
import { cn, formatRelativeTime } from '../../../lib/utils';
import type { App, AppForm, AppRole, PermissionAction } from '../../../types/app';
import type { Form } from '../../../types/form';

type AccessTab = 'roles' | 'people' | 'signup';
type RolePermission = { formId: string | null; permission: PermissionAction };

// Stable fallbacks for store selectors: `s.users[id] ?? []` would mint a NEW
// array every snapshot while the slice is unset, which useSyncExternalStore
// treats as an endless store change (React #185 update-depth crash).
const NO_USERS: never[] = [];
const NO_INVITATIONS: never[] = [];

/**
 * Studio step 5 — Users & roles: real roles with a live permission matrix,
 * members + invitations, and portal sign-up settings. Everything writes
 * through the existing app RBAC APIs.
 */
export function AccessStep({
  app,
  roles,
  appForms,
  formsById,
  onReloadAux,
  onReloadApp,
}: {
  app: App;
  roles: AppRole[];
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadAux: () => Promise<void>;
  onReloadApp: () => Promise<void>;
}) {
  const [tab, setTab] = useState<AccessTab>('roles');

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-3 shadow-sm sm:flex-row sm:items-center">
        <div className="flex rounded-xl bg-gray-100 dark:bg-white/[0.05] p-1">
          {([
            { id: 'roles', label: 'Roles', icon: Shield },
            { id: 'people', label: 'People & invites', icon: Users },
            { id: 'signup', label: 'Sign-up', icon: UserPlus },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-label={item.label}
              aria-pressed={tab === item.id}
              className={cn(
                'flex h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-xs font-bold transition',
                tab === item.id
                  ? 'bg-white dark:bg-slate-800 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200'
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
        <Badge variant="success" size="sm" className="self-start sm:self-auto">
          <Check className="h-3 w-3 mr-1 inline" /> {roles.length} roles configured
        </Badge>
      </div>

      {tab === 'roles' && <RolesView app={app} roles={roles} appForms={appForms} formsById={formsById} onReloadAux={onReloadAux} />}
      {tab === 'people' && <PeopleView app={app} roles={roles} />}
      {tab === 'signup' && <SignupView app={app} roles={roles} onReloadApp={onReloadApp} />}
    </div>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────

function RolesView({
  app,
  roles,
  appForms,
  formsById,
  onReloadAux,
}: {
  app: App;
  roles: AppRole[];
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadAux: () => Promise<void>;
}) {
  const createRole = useAppStore((s) => s.createRole);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  // Loaded permissions are keyed by role so switching roles derives a fresh
  // "loading" state instead of resetting it inside the effect.
  const [permsState, setPermsState] = useState<{ roleId: string; permissions: RolePermission[]; dirty: boolean } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNewRole, setShowNewRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [creatingRole, setCreatingRole] = useState(false);

  const selected = roles.find((r) => r.id === selectedRoleId) ?? roles[0] ?? null;
  const isOwnerRole = selected?.isSystem === true && selected?.name === 'Owner';
  // Both sides can be null/undefined while roles + permissions load — the match
  // must require a real permsState (undefined === undefined would read as loaded).
  const permsLoaded = permsState !== null && selected !== null && permsState.roleId === selected.id;
  const permissions = useMemo<RolePermission[]>(
    () => (permsState && permsState.roleId === selected?.id ? permsState.permissions : []),
    [permsState, selected?.id]
  );
  const dirty = permsLoaded ? permsState.dirty : false;

  useEffect(() => {
    const roleId = selected?.id;
    if (!roleId) return;
    let cancelled = false;
    api.getAppRolePermissions(app.id, roleId).then((res) => {
      if (cancelled) return;
      setPermsState({
        roleId,
        permissions: ((res.data?.permissions ?? []) as RolePermission[]).map((p) => ({ formId: p.formId, permission: p.permission })),
        dirty: false,
      });
    });
    return () => { cancelled = true; };
  }, [app.id, selected?.id]);

  const matrixForms = useMemo(
    () => appForms.map((af) => ({ formId: af.formId, displayName: af.displayName || formsById[af.formId]?.title || 'Untitled' })),
    [appForms, formsById]
  );

  const savePermissions = async () => {
    if (!selected || saving || !permsLoaded) return;
    setSaving(true);
    const res = await trackStudioSave(
      `${selected.name} permissions saved`,
      api.setAppRolePermissions(app.id, selected.id, permissions),
      (r) => !r.error
    );
    setSaving(false);
    if (res.error) {
      toast.error('Could not save permissions', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    setPermsState((s) => (s && s.roleId === selected.id ? { ...s, dirty: false } : s));
    toast.success('Permissions saved', `${selected.name} was updated.`);
  };

  const addRole = async () => {
    const name = newRoleName.trim();
    if (!name || creatingRole) return;
    setCreatingRole(true);
    const role = await trackStudioSave(`Role "${name}" created`, createRole(app.id, { name }), (r) => !!r);
    setCreatingRole(false);
    if (role) {
      toast.success('Role created', `"${name}" is ready — grant it permissions below.`);
      setShowNewRole(false);
      setNewRoleName('');
      await onReloadAux();
      setSelectedRoleId(role.id);
    }
  };

  // Plain-language summaries derived from the REAL permission rows.
  const summary = useMemo(() => {
    const has = (perm: PermissionAction) => permissions.some((p) => p.permission === perm);
    const formCount = (perm: PermissionAction) => new Set(permissions.filter((p) => p.permission === perm && p.formId).map((p) => p.formId)).size;
    if (isOwnerRole) {
      return {
        view: 'Everything in this app',
        create: 'Any record',
        edit: 'Everything, plus app settings',
        visibility: 'All records',
      };
    }
    const viewAll = formCount('view_all_responses');
    const viewOwn = formCount('view_own_responses');
    return {
      view: viewAll > 0 ? `All records on ${viewAll} ${viewAll === 1 ? 'form' : 'forms'}` : viewOwn > 0 ? 'Their own records' : 'Nothing yet',
      create: has('submit_responses') ? `Submit on ${formCount('submit_responses')} ${formCount('submit_responses') === 1 ? 'form' : 'forms'}` : 'Nothing yet',
      edit: has('edit_responses') ? `Edit on ${formCount('edit_responses')} ${formCount('edit_responses') === 1 ? 'form' : 'forms'}` : 'No editing',
      visibility: viewAll > 0 ? 'All records' : viewOwn > 0 ? 'Only their own records' : 'No record access',
    };
  }, [permissions, isOwnerRole]);

  return (
    <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm h-fit">
        <div className="border-b border-gray-200/80 dark:border-white/[0.06] p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App roles</h3>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">Start simple, refine permissions when needed.</p>
        </div>
        <div className="space-y-2 p-2.5">
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => setSelectedRoleId(role.id)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                selected?.id === role.id
                  ? 'bg-primary-50 dark:bg-primary-500/[0.08] ring-1 ring-inset ring-primary-200 dark:ring-primary-500/20'
                  : 'hover:bg-gray-50 dark:hover:bg-white/[0.03]'
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-xs font-bold text-primary-foreground">
                {role.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-xs font-bold text-gray-900 dark:text-white">{role.name}</span>
                  {role.isSystem && <Badge variant="primary" size="sm">System</Badge>}
                </span>
                {role.description && (
                  <span className="mt-1 block text-[10px] leading-4 text-gray-500 dark:text-slate-400 line-clamp-2">{role.description}</span>
                )}
              </span>
              <ChevronRight className={cn('h-4 w-4', selected?.id === role.id ? 'text-primary-500' : 'text-gray-300 dark:text-slate-600')} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowNewRole(true)}
            className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 dark:border-white/15 text-xs font-bold text-gray-500 dark:text-slate-400 hover:border-primary-400 hover:text-primary-700 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
          >
            <UserPlus className="h-4 w-4" /> Add another role
          </button>
        </div>
      </section>

      {selected && (
        <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-xs font-bold text-primary-foreground">
                {selected.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{selected.name}</h3>
                  {selected.isSystem && <Badge variant="primary" size="sm">System</Badge>}
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  {selected.description || 'Grant this role access per data type below.'}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
            <PermissionCard icon={Eye} title="Can view" body={summary.view} tone="primary" />
            <PermissionCard icon={FileInput} title="Can create" body={summary.create} tone="sky" />
            <PermissionCard icon={Settings2} title="Can edit" body={summary.edit} tone="amber" />
            <PermissionCard icon={LockKeyhole} title="Record visibility" body={summary.visibility} tone="emerald" />
          </div>

          <div className="border-t border-gray-200/80 dark:border-white/[0.06] p-4 sm:p-5">
            {isOwnerRole ? (
              <p className="text-sm text-gray-500 dark:text-slate-400">
                The Owner role always has every permission and cannot be modified.
              </p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  aria-expanded={advanced}
                  className="flex min-h-10 w-full cursor-pointer items-center justify-between rounded-xl bg-gray-50 dark:bg-white/[0.035] px-3 text-xs font-bold text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                >
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-primary-600 dark:text-primary-400" /> Permission matrix
                  </span>
                  <ChevronDown className={cn('h-4 w-4 transition-transform', advanced && 'rotate-180')} />
                </button>
                {advanced && (
                  <div className="mt-3">
                    {!permsLoaded ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600" role="status" aria-label="Loading permissions" />
                      </div>
                    ) : (
                      <>
                        <PermissionMatrix
                          permissions={permissions}
                          forms={matrixForms}
                          onChange={(next) => {
                            const roleId = selected?.id;
                            if (roleId) setPermsState({ roleId, permissions: next, dirty: true });
                          }}
                        />
                        <div className="mt-3 flex justify-end">
                          <Button size="sm" onClick={savePermissions} isLoading={saving} disabled={!dirty}>
                            {dirty ? 'Save permissions' : 'Saved'}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      <Modal isOpen={showNewRole} onClose={() => setShowNewRole(false)} title="Add a role" size="sm">
        <div className="p-4 sm:p-5 space-y-4">
          <Input
            value={newRoleName}
            onChange={(e) => setNewRoleName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addRole(); }}
            placeholder="e.g. Technician, Customer"
            aria-label="Role name"
            autoFocus
          />
          <div className="flex justify-end">
            <Button onClick={addRole} isLoading={creatingRole} disabled={!newRoleName.trim()}>
              Create role
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PermissionCard({
  icon: Icon,
  title,
  body,
  tone,
}: {
  icon: typeof Eye;
  title: string;
  body: string;
  tone: 'primary' | 'sky' | 'amber' | 'emerald';
}) {
  const tones = {
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300',
    sky: 'bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-300',
    amber: 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-300',
    emerald: 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-300',
  };
  return (
    <div className="flex min-h-20 items-start gap-3 rounded-xl border border-gray-200 dark:border-white/10 p-3 text-left">
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', tones[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <span>
        <span className="block text-xs font-bold text-gray-900 dark:text-white">{title}</span>
        <span className="mt-1 block text-[11px] leading-4 text-gray-500 dark:text-slate-400">{body}</span>
      </span>
    </div>
  );
}

// ── People & invites ─────────────────────────────────────────────────────────

function PeopleView({ app, roles }: { app: App; roles: AppRole[] }) {
  const { fetchUsers, fetchInvitations, inviteUser, revokeInvitation, removeUser } = useAppUserStore();
  // Store slices are keyed by appId; fall back to STABLE empties (see NO_USERS).
  const users = useAppUserStore((s) => s.users[app.id] ?? NO_USERS);
  const invitations = useAppUserStore((s) => s.invitations[app.id] ?? NO_INVITATIONS);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [inviting, setInviting] = useState(false);
  const browserOnlyDemo = isDemoLocalId(app.id);

  useEffect(() => {
    // The store methods throw on API failure (for Promise.allSettled consumers) —
    // surface that as a toast here instead of an unhandled rejection.
    Promise.allSettled([fetchUsers(app.id), fetchInvitations(app.id)]).then((results) => {
      if (results.some((r) => r.status === 'rejected')) {
        toast.error('Some member data could not be loaded');
      }
    });
  }, [app.id, fetchUsers, fetchInvitations]);

  const pendingInvites = invitations.filter((i) => i.status === 'pending');
  const defaultInviteRole = roles.find((r) => !r.isSystem) ?? roles.find((r) => r.name !== 'Owner') ?? roles[0];

  const sendInvite = async () => {
    const email = inviteEmail.trim();
    const roleId = inviteRoleId || defaultInviteRole?.id;
    if (!email || !roleId || inviting) return;
    setInviting(true);
    const invitation = await inviteUser(app.id, email, roleId);
    setInviting(false);
    if (invitation) {
      toast.success('Invitation sent', `${email} can now join ${app.name}.`);
      setShowInvite(false);
      setInviteEmail('');
      void fetchInvitations(app.id);
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">People with access</h3>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
            {users.length} {users.length === 1 ? 'member' : 'members'}
            {pendingInvites.length > 0 ? ` · ${pendingInvites.length} pending ${pendingInvites.length === 1 ? 'invite' : 'invites'}` : ''}
          </p>
        </div>
        {browserOnlyDemo ? (
          <Badge variant="primary" size="sm">Browser-only demo</Badge>
        ) : (
          <Button size="sm" onClick={() => { setInviteRoleId(defaultInviteRole?.id ?? ''); setShowInvite(true); }} leftIcon={<UserPlus className="h-4 w-4" />}>
            Invite people
          </Button>
        )}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
        {users.map((member) => (
          <div key={member.id} className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-100 dark:bg-primary-500/10 text-xs font-bold text-primary-700 dark:text-primary-300">
              {(member.name || member.email || '?').slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold text-gray-900 dark:text-white">{member.name || member.email}</span>
              <span className="mt-0.5 block truncate text-[10px] text-gray-400 dark:text-slate-500">
                {member.roleName ?? 'Member'}{member.email && member.name ? ` · ${member.email}` : ''}
              </span>
            </span>
            <Badge variant={member.status === 'active' ? 'success' : member.status === 'pending' ? 'warning' : 'default'} size="sm" className="capitalize">
              {member.status}
            </Badge>
            <button
              type="button"
              onClick={async () => {
                if (await removeUser(app.id, member.id)) toast.success('Member removed');
              }}
              aria-label={`Remove ${member.name || member.email}`}
              title="Remove from app"
              className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {pendingInvites.map((invite) => (
          <div key={invite.id} className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/10 text-xs font-bold text-amber-700 dark:text-amber-300">
              {invite.email.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold text-gray-900 dark:text-white">{invite.email}</span>
              <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500">
                Invited {formatRelativeTime(invite.createdAt)}{invite.roleName ? ` · ${invite.roleName}` : ''}
              </span>
            </span>
            <Badge variant="warning" size="sm">Invited</Badge>
            <button
              type="button"
              onClick={async () => {
                if (await revokeInvitation(app.id, invite.id)) toast.success('Invitation revoked');
              }}
              aria-label={`Revoke invitation for ${invite.email}`}
              title="Revoke invitation"
              className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {users.length === 0 && pendingInvites.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
            {browserOnlyDemo
              ? 'This app is private to this browser. Sign up free when you are ready to invite real people.'
              : 'No members yet — invite people or share the app link.'}
          </p>
        )}
      </div>

      <Modal isOpen={showInvite} onClose={() => setShowInvite(false)} title="Invite people" size="sm">
        <div className="p-4 sm:p-5 space-y-4">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendInvite(); }}
            placeholder="name@example.com"
            aria-label="Email address"
            autoFocus
          />
          <div>
            <label htmlFor="studio-invite-role" className="block text-xs font-semibold text-gray-600 dark:text-slate-300 mb-1.5">Role</label>
            <select
              id="studio-invite-role"
              value={inviteRoleId}
              onChange={(e) => setInviteRoleId(e.target.value)}
              className="h-10 w-full cursor-pointer rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>{role.name}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end">
            <Button onClick={sendInvite} isLoading={inviting} disabled={!inviteEmail.trim()}>
              Send invitation
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

// ── Sign-up ──────────────────────────────────────────────────────────────────

function SignupView({ app, roles, onReloadApp }: { app: App; roles: AppRole[]; onReloadApp: () => Promise<void> }) {
  const updateApp = useAppStore((s) => s.updateApp);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const appUrl = `${window.location.origin}/app/${app.slug}`;

  const saveSettings = async (patch: Partial<App['settings']>) => {
    setSaving(true);
    const ok = await trackStudioSave('Sign-up settings saved', updateApp(app.id, { settings: { ...app.settings, ...patch } }), (saved) => !!saved);
    if (ok) await onReloadApp();
    setSaving(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed', 'Could not copy to clipboard');
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
            <UserPlus className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Member sign-up</h3>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">How people join {app.name}</p>
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <Switch
            label="Allow self-registration"
            description="Anyone with the link can create their own account in this app"
            checked={app.settings?.allowSelfRegistration === true}
            onChange={(v) => void saveSettings({ allowSelfRegistration: v })}
            disabled={saving}
          />
          <Switch
            label="Require approval"
            description="A member with user-management access approves new accounts first"
            checked={app.settings?.requireApproval === true}
            onChange={(v) => void saveSettings({ requireApproval: v })}
            disabled={saving}
          />
          <div>
            <label htmlFor="studio-default-role" className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
              Default role for new members
            </label>
            <select
              id="studio-default-role"
              value={app.settings?.defaultRoleId ?? ''}
              onChange={(e) => void saveSettings({ defaultRoleId: e.target.value || undefined })}
              disabled={saving}
              className="mt-1.5 h-11 w-full cursor-pointer rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] px-3 text-sm font-semibold text-gray-700 dark:text-slate-200 outline-none focus:border-primary-400"
            >
              <option value="">Pick a role…</option>
              {roles.filter((r) => r.name !== 'Owner').map((role) => (
                <option key={role.id} value={role.id}>{role.name}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-300">
            <Link2 className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App link</h3>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">Share with staff or customers</p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] p-1.5">
          <span className="min-w-0 flex-1 truncate px-2 text-xs font-mono text-gray-500 dark:text-slate-400">{appUrl}</span>
          <Button variant="secondary" size="sm" onClick={copyLink} leftIcon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {app.settings?.requireApproval === true ? (
          <div className="mt-4 rounded-xl bg-amber-50 dark:bg-amber-400/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
            <span className="font-bold">Approval is on.</span> People who join with this link wait for approval before they get access.
          </div>
        ) : app.settings?.allowSelfRegistration === true ? (
          <div className="mt-4 rounded-xl bg-emerald-50 dark:bg-emerald-400/10 p-3 text-xs leading-5 text-emerald-800 dark:text-emerald-200">
            <span className="font-bold">Open sign-up.</span> Anyone with this link can join immediately with the default role.
          </div>
        ) : (
          <div className="mt-4 rounded-xl bg-gray-50 dark:bg-white/[0.04] p-3 text-xs leading-5 text-gray-600 dark:text-slate-300">
            <span className="font-bold">Invite-only.</span> Only people you invite (People & invites) can access the app.
          </div>
        )}
        {app.status !== 'published' && (
          <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-300">
            The app is still a draft — publish it before sharing the link.
          </p>
        )}
      </section>
    </div>
  );
}
