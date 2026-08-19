import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Eye,
  FileInput,
  Link2,
  LockKeyhole,
  RotateCcw,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Switch } from '../../ui/Switch';
import { LoadFailure } from '../../ui/LoadFailure';
import { PermissionMatrix } from '../../ui/PermissionMatrix';
import { api } from '../../../lib/api';
import { isDemoLocalId } from '../../../lib/demoLocal';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useAppUserStore } from '../../../stores/appUserStore';
import { returnToState } from '../../../hooks/useReturnTo';
import { trackStudioSave } from '../studioSaveState';
import { cn, copyToClipboard, formatRelativeTime } from '../../../lib/utils';
import { APP_LEVEL_PERMISSIONS, APP_PERMISSION_LABELS } from '../../../types/app';
import type { App, AppForm, AppRole, PermissionAction } from '../../../types/app';
import type { Form } from '../../../types/form';

type AccessTab = 'roles' | 'people' | 'signup';
type RolePermission = { formId: string | null; permission: PermissionAction };
type RolePermissionsState = {
  permissions: RolePermission[];
  /** Last complete server snapshot — permission undo restores this whole set. */
  savedPermissions: RolePermission[];
  dirty: boolean;
};

// Stable fallbacks for store selectors: `s.users[id] ?? []` would mint a NEW
// array every snapshot while the slice is unset, which useSyncExternalStore
// treats as an endless store change (React #185 update-depth crash).
const NO_USERS: never[] = [];
const NO_INVITATIONS: never[] = [];

const TABS = [
  { id: 'roles', label: 'Roles', mobileLabel: 'Roles', icon: Shield },
  { id: 'people', label: 'People & invites', mobileLabel: 'People', icon: Users },
  { id: 'signup', label: 'Sign-up', mobileLabel: 'Sign-up', icon: UserPlus },
] as const;

/**
 * Users & roles: real roles with a live permission matrix, members + invitations,
 * and portal sign-up settings. Everything writes through the existing app RBAC APIs.
 */
export function AccessStep({
  app,
  roles,
  appForms,
  formsById,
  onReloadRoles,
  onReloadApp,
}: {
  app: App;
  roles: AppRole[];
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadRoles: () => Promise<void>;
  onReloadApp: () => Promise<void>;
}) {
  const [tab, setTab] = useState<AccessTab>('roles');

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-gray-200/80 bg-white p-3 shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50 sm:flex-row sm:items-center">
        <div className="grid w-full grid-cols-3 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05] sm:flex sm:w-auto" role="tablist" aria-label="Access sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`access-tab-${item.id}`}
              aria-controls={`access-panel-${item.id}`}
              aria-selected={tab === item.id}
              aria-label={item.label}
              onClick={() => setTab(item.id)}
              className={cn(
                'flex h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition max-sm:h-11 sm:gap-2 sm:px-3',
                tab === item.id
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate sm:hidden">{item.mobileLabel}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
        <Badge variant="success" size="sm" className="self-start max-sm:hidden sm:self-auto">
          <Check className="mr-1 inline h-3 w-3" /> {roles.length} {roles.length === 1 ? 'role' : 'roles'} configured
        </Badge>
      </div>

      <div id={`access-panel-${tab}`} role="tabpanel" aria-labelledby={`access-tab-${tab}`}>
        {tab === 'roles' && <RolesView app={app} roles={roles} appForms={appForms} formsById={formsById} onReloadRoles={onReloadRoles} />}
        {tab === 'people' && <PeopleView app={app} roles={roles} />}
        {tab === 'signup' && <SignupView app={app} roles={roles} onReloadApp={onReloadApp} />}
      </div>
    </div>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────

function RolesView({
  app,
  roles,
  appForms,
  formsById,
  onReloadRoles,
}: {
  app: App;
  roles: AppRole[];
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadRoles: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const createRole = useAppStore((s) => s.createRole);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  // Drafts are kept PER ROLE: clicking another role to compare must not throw
  // away a matrix the user has been editing.
  const [draftsByRole, setDraftsByRole] = useState<Record<string, RolePermissionsState>>({});
  const [loadError, setLoadError] = useState<Record<string, string>>({});
  // Retry is scoped PER ROLE. A single global counter stayed non-zero forever after the
  // first retry, which permanently disabled the draft guard below and silently discarded
  // unsaved matrix edits on the next role switch.
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({});
  /** roleId → retry token already fetched, so a role is loaded exactly once per retry. */
  const loadedTokens = useRef<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [showNewRole, setShowNewRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [creatingRole, setCreatingRole] = useState(false);

  const selected = roles.find((r) => r.id === selectedRoleId) ?? roles[0] ?? null;
  const isOwnerRole = selected?.isSystem === true && selected?.name === 'Owner';
  const selectedId = selected?.id ?? null;
  const draft = selectedId ? draftsByRole[selectedId] ?? null : null;
  const error = selectedId ? loadError[selectedId] ?? null : null;
  const permsLoaded = draft !== null;
  const permissions = useMemo<RolePermission[]>(() => draft?.permissions ?? [], [draft]);
  const dirty = draft?.dirty ?? false;

  const retryToken = selectedId ? retryTokens[selectedId] ?? 0 : 0;

  useEffect(() => {
    if (!selectedId) return;
    // Already loaded this role at this retry token — keep the draft, unsaved edits and all.
    if (loadedTokens.current[selectedId] === retryToken) return;
    loadedTokens.current[selectedId] = retryToken;
    let cancelled = false;
    api.getAppRolePermissions(app.id, selectedId).then(
      (res) => {
        if (cancelled) return;
        if (res.error) {
          // An unread permission set must NOT render as "this role has nothing":
          // saving over that view would revoke every grant the role really holds.
          setLoadError((s) => ({ ...s, [selectedId]: typeof res.error === 'string' ? res.error : 'Could not read this role.' }));
          return;
        }
        const loaded = ((res.data?.permissions ?? []) as RolePermission[]).map((p) => ({ formId: p.formId, permission: p.permission }));
        setLoadError((s) => {
          if (!(selectedId in s)) return s;
          const next = { ...s };
          delete next[selectedId];
          return next;
        });
        setDraftsByRole((s) => ({
          ...s,
          [selectedId]: { permissions: loaded, savedPermissions: loaded.map((p) => ({ ...p })), dirty: false },
        }));
      },
      () => {
        if (!cancelled) setLoadError((s) => ({ ...s, [selectedId]: 'Could not read this role.' }));
      }
    );
    return () => { cancelled = true; };
  }, [app.id, selectedId, retryToken]);

  const matrixForms = useMemo(
    () => appForms.map((af) => ({ formId: af.formId, displayName: af.displayName || formsById[af.formId]?.title || 'Untitled' })),
    [appForms, formsById]
  );

  const savePermissions = async () => {
    if (!selected || saving || !draft) return;
    const roleId = selected.id;
    const previous = draft.savedPermissions.map((p) => ({ ...p }));
    const next = draft.permissions.map((p) => ({ ...p }));
    const applySnapshot = async (snapshot: RolePermission[]) => {
      const result = await api.setAppRolePermissions(app.id, roleId, snapshot);
      if (!result.error) {
        const saved = snapshot.map((p) => ({ ...p }));
        setDraftsByRole((s) => ({
          ...s,
          [roleId]: { permissions: saved, savedPermissions: saved.map((p) => ({ ...p })), dirty: false },
        }));
      }
      return result;
    };
    setSaving(true);
    const res = await trackStudioSave(`${selected.name} permissions`, () => applySnapshot(next), (r) => !r.error);
    setSaving(false);
    if (res.error) {
      toast.error('Could not save permissions', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.undo(`${selected.name} permissions saved`, () => {
      void trackStudioSave(`${selected.name} permissions`, () => applySnapshot(previous), (result) => !result.error);
    });
  };

  const addRole = async () => {
    const name = newRoleName.trim();
    if (!name || creatingRole) return;
    setCreatingRole(true);
    const role = await trackStudioSave(`Role "${name}" created`, createRole(app.id, { name }), (r) => !!r);
    setCreatingRole(false);
    if (role) {
      toast.success('Role created', `"${name}" is ready — set its permissions below.`);
      setShowNewRole(false);
      setNewRoleName('');
      await onReloadRoles();
      setSelectedRoleId(role.id);
    }
  };

  /** Plain-language summary of the REAL permission rows, app-wide grants included. */
  const summary = useMemo(() => {
    if (isOwnerRole) {
      return {
        view: 'Everything in this app',
        create: 'Any record',
        edit: 'Everything, plus app settings',
        visibility: 'All records',
        admin: ['Full control of the app'],
        destructive: ['Delete and export everywhere'],
      };
    }
    // A row with formId === null is an APP-WIDE grant: reading it as "0 forms"
    // told owners a role with blanket access held nothing.
    const appWide = (perm: PermissionAction) => permissions.some((p) => p.formId === null && p.permission === perm);
    const forms = (perm: PermissionAction) => new Set(permissions.filter((p) => p.permission === perm && p.formId).map((p) => p.formId)).size;
    const scope = (perm: PermissionAction) => {
      if (appWide(perm)) return 'every form';
      const n = forms(perm);
      return n > 0 ? `${n} ${n === 1 ? 'form' : 'forms'}` : null;
    };
    const viewAll = scope('view_all_responses');
    const viewOwn = scope('view_own_responses');
    const submit = scope('submit_responses');
    const edit = scope('edit_responses');
    const admin = APP_LEVEL_PERMISSIONS.filter((perm) => appWide(perm)).map((perm) => APP_PERMISSION_LABELS[perm]);
    // Delete and Export are togglable in the matrix directly below, and both take
    // data out of the owner's control — a summary that lists View/Create/Edit and
    // silently omits them describes a role as safer than it is.
    const remove = scope('delete_responses');
    const takeOut = scope('export_responses');
    const destructive = [
      remove ? `Delete records on ${remove}` : null,
      takeOut ? `Export records from ${takeOut}` : null,
    ].filter((v): v is string => v !== null);
    return {
      view: viewAll ? `All records on ${viewAll}` : viewOwn ? `Their own records on ${viewOwn}` : 'Nothing yet',
      create: submit ? `Submit on ${submit}` : 'Nothing yet',
      edit: edit ? `Edit on ${edit}` : 'No editing',
      visibility: viewAll ? 'All records' : viewOwn ? 'Only their own records' : 'No record access',
      admin,
      destructive,
    };
  }, [permissions, isOwnerRole]);

  return (
    <div className="grid gap-4 @2xl/studio:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @5xl/studio:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className="h-fit overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App roles</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/apps/${app.id}/roles`, { state: returnToState(location.pathname, 'App Studio') })}
            title="Rename, describe or delete roles"
          >
            Manage
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 p-2.5 @xl/studio:grid-cols-2 @2xl/studio:grid-cols-1">
          {roles.map((role) => {
            const roleDirty = draftsByRole[role.id]?.dirty === true;
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => setSelectedRoleId(role.id)}
                aria-current={selected?.id === role.id ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                  selected?.id === role.id
                    ? 'bg-primary-50 ring-1 ring-inset ring-primary-200 dark:bg-primary-500/[0.08] dark:ring-primary-500/20'
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
                    {roleDirty && <Badge variant="warning" size="sm">Unsaved</Badge>}
                  </span>
                  {role.description && (
                    <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-gray-500 dark:text-slate-400">{role.description}</span>
                  )}
                </span>
                <ChevronRight className={cn('h-4 w-4', selected?.id === role.id ? 'text-primary-500' : 'text-gray-400 dark:text-slate-500')} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowNewRole(true)}
            className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 text-xs font-bold text-gray-600 hover:border-primary-400 hover:text-primary-700 dark:border-white/15 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
          >
            <UserPlus className="h-4 w-4" /> Add another role
          </button>
        </div>
      </section>

      {selected && (
        <section className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
          <div className="flex flex-col gap-3 border-b border-gray-200/80 p-5 dark:border-white/[0.06] sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-xs font-bold text-primary-foreground">
                {selected.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{selected.name}</h3>
                  {selected.isSystem && <Badge variant="primary" size="sm">System</Badge>}
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  {selected.description || 'What this role can do, per data type.'}
                </p>
              </div>
            </div>
          </div>

          {error ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <AlertTriangle className="h-7 w-7 text-amber-500" />
              <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">Couldn't read this role's permissions</p>
              <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
                {error} Nothing is shown or editable until they load — saving over an unknown set would revoke it.
              </p>
              <Button
                className="mt-4"
                onClick={() => selectedId && setRetryTokens((s) => ({ ...s, [selectedId]: (s[selectedId] ?? 0) + 1 }))}
                leftIcon={<RotateCcw className="h-4 w-4" />}
              >
                Try again
              </Button>
            </div>
          ) : !permsLoaded ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary-600" role="status" aria-label="Loading permissions" />
            </div>
          ) : (
            <>
              <div className="grid gap-3 border-b border-gray-200/80 p-4 dark:border-white/[0.06] sm:p-5 @2xl/studio:grid-cols-2">
                <PermissionCard icon={Eye} title="Can view" body={summary.view} tone="primary" />
                <PermissionCard icon={FileInput} title="Can create" body={summary.create} tone="sky" />
                <PermissionCard icon={Settings2} title="Can edit" body={summary.edit} tone="amber" />
                <PermissionCard icon={LockKeyhole} title="Record visibility" body={summary.visibility} tone="emerald" />
                {summary.destructive.length > 0 && (
                  <div className="@2xl/studio:col-span-2">
                    <PermissionCard icon={Trash2} title="Can remove or take data out" body={summary.destructive.join(' · ')} tone="rose" />
                  </div>
                )}
                {summary.admin.length > 0 && (
                  <div className="@2xl/studio:col-span-2">
                    <PermissionCard icon={ShieldCheck} title="Admin abilities" body={summary.admin.join(' · ')} tone="rose" />
                  </div>
                )}
              </div>

              <div className="p-4 sm:p-5">
                {isOwnerRole ? (
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    The Owner role always has every permission and cannot be modified.
                  </p>
                ) : (
                  <>
                    {/* The matrix IS this screen — it used to sit behind a collapsed
                        disclosure below four cards that mostly read "Nothing yet". */}
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Permissions</h4>
                      <div className="flex items-center gap-2">
                        {dirty && <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-300">Unsaved changes</span>}
                        <Button size="sm" onClick={savePermissions} isLoading={saving} disabled={!dirty}>
                          {dirty ? 'Save permissions' : 'Saved'}
                        </Button>
                      </div>
                    </div>
                    <PermissionMatrix
                      permissions={permissions}
                      forms={matrixForms}
                      onChange={(next) => {
                        setDraftsByRole((s) => {
                          const current = s[selected.id];
                          if (!current) return s;
                          return { ...s, [selected.id]: { ...current, permissions: next, dirty: true } };
                        });
                      }}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <Modal isOpen={showNewRole} onClose={() => setShowNewRole(false)} title="Add a role" size="sm">
        <div className="space-y-4 p-4 sm:p-5">
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
  tone: 'primary' | 'sky' | 'amber' | 'emerald' | 'rose';
}) {
  const tones = {
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300',
    sky: 'bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-300',
    amber: 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-300',
    emerald: 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-300',
    rose: 'bg-rose-50 dark:bg-rose-400/10 text-rose-600 dark:text-rose-300',
  };
  return (
    <div className="flex min-h-16 items-start gap-3 rounded-xl border border-gray-200 p-3 text-left dark:border-white/10">
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', tones[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-bold text-gray-900 dark:text-white">{title}</span>
        <span className="mt-1 block text-[11px] leading-4 text-gray-600 dark:text-slate-300">{body}</span>
      </span>
    </div>
  );
}

// ── People & invites ─────────────────────────────────────────────────────────

function PeopleView({ app, roles }: { app: App; roles: AppRole[] }) {
  // The server refuses to invite into, or assign, the Owner role
  // ("Cannot invite users to the Owner role" / "Cannot assign the Owner role"), so
  // offering it here is a choice that can only ever fail.
  const assignableRoles = roles.filter((r) => !(r.isSystem && r.name === 'Owner'));
  const navigate = useNavigate();
  const location = useLocation();
  const { fetchUsers, fetchInvitations, inviteUser, revokeInvitation, removeUser, updateUser } = useAppUserStore();
  // Store slices are keyed by appId; fall back to STABLE empties (see NO_USERS).
  const users = useAppUserStore((s) => s.users[app.id] ?? NO_USERS);
  const invitations = useAppUserStore((s) => s.invitations[app.id] ?? NO_INVITATIONS);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'member'; id: string; label: string }
    | { kind: 'invite'; id: string; label: string }
    | null
  >(null);
  const browserOnlyDemo = isDemoLocalId(app.id);

  // A failed read is not "no members". The store slice stays undefined on failure,
  // so `users.length` was 0 and the panel confidently reported an empty app — with an
  // invitation to add the people who are already there.
  const [membersFailed, setMembersFailed] = useState(false);
  const [membersReloadToken, setMembersReloadToken] = useState(0);
  useEffect(() => {
    // The store methods throw on API failure (for Promise.allSettled consumers) —
    // record it here instead of leaving an unhandled rejection. setState inside the
    // async callback, not the effect body, keeps react-hooks happy.
    Promise.allSettled([fetchUsers(app.id), fetchInvitations(app.id)]).then((results) => {
      const failed = results.some((r) => r.status === 'rejected');
      setMembersFailed(failed);
      if (failed) toast.error('Some member data could not be loaded');
    });
  }, [app.id, fetchUsers, fetchInvitations, membersReloadToken]);

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
      // The one-time accept link is the ONLY way in on a deployment without mail
      // delivery — dropping it stranded the invitee behind a cheerful "sent".
      if (invitation.token) {
        setInviteLink(`${window.location.origin}/accept-invite?token=${invitation.token}`);
        toast.success('Invitation created', `Send ${email} the link below if they don't get the email.`);
      } else {
        toast.success('Invitation sent', `${email} can now join ${app.name}.`);
        setShowInvite(false);
      }
      setInviteEmail('');
      void fetchInvitations(app.id);
    }
  };

  const approve = async (memberId: string, name: string) => {
    setBusyId(memberId);
    const ok = await trackStudioSave(`${name} approved`, updateUser(app.id, memberId, { status: 'active' }), (r) => r);
    setBusyId(null);
    if (ok) toast.success('Member approved', `${name} now has access to ${app.name}.`);
  };

  const changeRole = async (memberId: string, roleId: string, name: string) => {
    setBusyId(memberId);
    await trackStudioSave(`${name}'s role`, updateUser(app.id, memberId, { roleId }), (r) => r);
    setBusyId(null);
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    if (target.kind === 'member') {
      if (await removeUser(app.id, target.id)) toast.success('Member removed', `${target.label} no longer has access.`);
    } else if (await revokeInvitation(app.id, target.id)) {
      toast.success('Invitation revoked', `${target.label} can no longer use that link.`);
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    // See copyToClipboard: the async Clipboard API needs a secure context, and
    // this deployment is plain HTTP.
    if (await copyToClipboard(inviteLink)) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } else {
      toast.error('Copy failed', 'Select the link and copy it manually.');
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
      <div className="flex flex-col gap-3 border-b border-gray-200/80 p-4 dark:border-white/[0.06] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">People with access</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
            {membersFailed ? 'Members not loaded' : `${users.length} ${users.length === 1 ? 'member' : 'members'}`}
            {pendingInvites.length > 0 ? ` · ${pendingInvites.length} pending ${pendingInvites.length === 1 ? 'invite' : 'invites'}` : ''}
          </p>
        </div>
        {browserOnlyDemo ? (
          <Badge variant="primary" size="sm">Browser-only demo</Badge>
        ) : (
          <div className="flex items-center gap-2">
            {/* Suspending a member (a reversible cut-off, as opposed to Remove) only
                exists on the members page — without a pointer, the likely outcome here
                is a permanent Remove where a pause was intended. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/apps/${app.id}/users`, { state: returnToState(location.pathname, 'App Studio') })}
              title="Suspend members, search the full list and review invitation expiry"
            >
              Advanced
            </Button>
            <Button
              size="sm"
              onClick={() => { setInviteRoleId(defaultInviteRole?.id ?? ''); setInviteLink(null); setShowInvite(true); }}
              leftIcon={<UserPlus className="h-4 w-4" />}
            >
              Invite people
            </Button>
          </div>
        )}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
        {users.map((member) => {
          const name = member.name || member.email || 'This member';
          return (
            <div key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-xs font-bold text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
                {(member.name || member.email || '?').slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-gray-900 dark:text-white">{name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-gray-500 dark:text-slate-400">
                  {member.email && member.name ? member.email : member.roleName ?? 'Member'}
                </span>
              </span>
              {/* Role is changed here rather than only in a separate manager page. */}
              {roles.length > 0 && !browserOnlyDemo ? (
                <select
                  value={roles.some((r) => r.id === member.roleId) ? member.roleId : ''}
                  onChange={(e) => void changeRole(member.id, e.target.value, name)}
                  disabled={busyId === member.id}
                  aria-label={`Role for ${name}`}
                  className="h-8 min-w-0 max-w-[9rem] cursor-pointer rounded-lg border border-gray-200 bg-white px-2 text-[11px] font-semibold text-gray-700 outline-none max-sm:h-11 max-sm:max-w-none max-sm:flex-1 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
                >
                  {/* A role the studio can't see (e.g. still loading) stays selected rather
                      than silently re-assigning the member to the first one in the list. */}
                  {!assignableRoles.some((r) => r.id === member.roleId) && (
                    <option value="">{member.roleName ?? 'No role'}</option>
                  )}
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              ) : (
                <Badge size="sm">{member.roleName ?? 'Member'}</Badge>
              )}
              {member.status === 'pending' ? (
                <Button size="sm" variant="secondary" onClick={() => void approve(member.id, name)} isLoading={busyId === member.id}>
                  Approve
                </Button>
              ) : (
                <Badge variant={member.status === 'active' ? 'success' : 'default'} size="sm" className="capitalize">
                  {member.status}
                </Badge>
              )}
              <button
                type="button"
                onClick={() => setConfirm({ kind: 'member', id: member.id, label: name })}
                aria-label={`Remove ${name}`}
                title="Remove from app"
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 max-sm:ml-auto max-sm:h-11 max-sm:w-11 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
        {pendingInvites.map((invite) => (
          <div key={invite.id} className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-xs font-bold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              {invite.email.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold text-gray-900 dark:text-white">{invite.email}</span>
              <span className="mt-0.5 block text-[10px] text-gray-500 dark:text-slate-400">
                Invited {formatRelativeTime(invite.createdAt)}{invite.roleName ? ` · ${invite.roleName}` : ''}
              </span>
            </span>
            <Badge variant="warning" size="sm">Invited</Badge>
            <button
              type="button"
              onClick={() => setConfirm({ kind: 'invite', id: invite.id, label: invite.email })}
              aria-label={`Revoke invitation for ${invite.email}`}
              title="Revoke invitation"
              className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {membersFailed ? (
          <div className="p-4">
            <LoadFailure
              title="Couldn't load this app's members"
              message="The request failed. This does not mean the app has none — nothing has been changed."
              onRetry={() => setMembersReloadToken((n) => n + 1)}
            />
          </div>
        ) : users.length === 0 && pendingInvites.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-slate-400">
            {browserOnlyDemo
              ? 'This app is private to this browser. Sign up free when you are ready to invite real people.'
              : 'No members yet — invite people or share the app link.'}
          </p>
        ) : null}
      </div>

      <Modal isOpen={showInvite} onClose={() => setShowInvite(false)} title="Invite people" size="sm">
        <div className="space-y-4 p-4 sm:p-5">
          {inviteLink ? (
            <>
              <p className="text-sm text-gray-600 dark:text-slate-300">
                Send this one-time link to the person you invited. If email delivery is set up on this
                deployment they also received it by email.
              </p>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-1.5 dark:border-white/10 dark:bg-white/[0.04]">
                <span className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-gray-600 dark:text-slate-300">{inviteLink}</span>
                <Button variant="secondary" size="sm" onClick={copyInviteLink} leftIcon={linkCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
                  {linkCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setInviteLink(null)}>Invite someone else</Button>
                <Button onClick={() => { setInviteLink(null); setShowInvite(false); }}>Done</Button>
              </div>
            </>
          ) : (
            <>
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
                <label htmlFor="studio-invite-role" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">Role</label>
                <select
                  id="studio-invite-role"
                  value={inviteRoleId}
                  onChange={(e) => setInviteRoleId(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                >
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-gray-500 dark:text-slate-400">
                  Ownership isn&apos;t transferred from here.
                </p>
              </div>
              <div className="flex justify-end">
                <Button onClick={sendInvite} isLoading={inviting} disabled={!inviteEmail.trim()}>
                  Send invitation
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={runConfirm}
        title={confirm?.kind === 'invite' ? 'Revoke this invitation?' : 'Remove this member?'}
        message={
          confirm?.kind === 'invite'
            ? `${confirm.label} will not be able to use their invitation link. You can invite them again at any time.`
            : `${confirm?.label ?? 'This member'} loses access to ${app.name} straight away, including their role. Records they submitted are kept.`
        }
        confirmLabel={confirm?.kind === 'invite' ? 'Revoke invitation' : 'Remove member'}
        variant="danger"
      />
    </section>
  );
}

// ── Sign-up ──────────────────────────────────────────────────────────────────

function SignupView({ app, roles, onReloadApp }: { app: App; roles: AppRole[]; onReloadApp: () => Promise<void> }) {
  const updateApp = useAppStore((s) => s.updateApp);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const appUrl = `${window.location.origin}/app/${app.slug}`;

  /**
   * Writes merge onto the CURRENT settings read at click time. Sending a snapshot
   * captured at render (and replaying it on undo) reverted whatever else had been
   * saved in between — from another studio section, a second tab or a chat tool.
   */
  const applySettings = async (patch: Partial<App['settings']>) => {
    const current = useAppStore.getState().getApp(app.id)?.settings ?? app.settings;
    const saved = await updateApp(app.id, { settings: { ...current, ...patch } });
    if (saved) await onReloadApp();
    return saved;
  };

  const saveSettings = async (patch: Partial<App['settings']>) => {
    // Undo restores ONLY the keys this write touched, read from the current record —
    // replaying a whole settings snapshot reverted unrelated saves made since.
    const current = (useAppStore.getState().getApp(app.id)?.settings ?? app.settings) as unknown as Record<string, unknown> | undefined;
    const previous = Object.fromEntries(
      Object.keys(patch).map((key) => [key, current?.[key]])
    ) as Partial<App['settings']>;
    setSaving(true);
    const ok = await trackStudioSave('Sign-up settings', () => applySettings(patch), (saved) => !!saved);
    setSaving(false);
    if (ok) {
      toast.undo('Sign-up settings saved', () => {
        void trackStudioSave('Sign-up settings', () => applySettings(previous), (saved) => !!saved);
      });
    }
  };

  const copyLink = async () => {
    // copyToClipboard, not navigator.clipboard: the async Clipboard API is a
    // secure-context API, so on a plain-HTTP deployment the hand-rolled call
    // rejected and the button did nothing but flash an error.
    if (await copyToClipboard(appUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed', 'Select the link and copy it manually.');
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 @3xl/studio:grid-cols-2">
      <section className="min-w-0 rounded-xl border border-gray-200/80 bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
            <UserPlus className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Member sign-up</h3>
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-slate-400">How people join {app.name}</p>
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
            description={
              app.settings?.allowSelfRegistration === true
                ? "New members wait as 'pending' until you approve them in People & invites"
                : 'Applies once self-registration is on — invited people never need approval'
            }
            checked={app.settings?.requireApproval === true}
            onChange={(v) => void saveSettings({ requireApproval: v })}
            disabled={saving}
          />
          <div>
            <label htmlFor="studio-default-role" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
              Default role for new members
            </label>
            <select
              id="studio-default-role"
              value={app.settings?.defaultRoleId ?? ''}
              onChange={(e) => void saveSettings({ defaultRoleId: e.target.value || undefined })}
              disabled={saving}
              className="mt-1.5 h-11 w-full min-w-0 cursor-pointer rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm font-semibold text-gray-700 outline-none focus:border-primary-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
            >
              <option value="">Lowest-privilege role (automatic)</option>
              {roles.filter((r) => r.name !== 'Owner').map((role) => (
                <option key={role.id} value={role.id}>{role.name}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="min-w-0 rounded-xl border border-gray-200/80 bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300">
            <Link2 className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App link</h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Share with staff or customers</p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <span className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-gray-600 dark:text-slate-300">{appUrl}</span>
          <Button variant="secondary" size="sm" onClick={copyLink} leftIcon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {/* Self-registration is the gate: "Require approval" only qualifies it. Reading
            approval first told invite-only apps that anyone with the link could join. */}
        {app.settings?.allowSelfRegistration === true && app.settings?.requireApproval === true ? (
          <div className="mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
            <span className="font-bold">Approval is on.</span> People who join with this link wait in
            People &amp; invites until you approve them.
          </div>
        ) : app.settings?.allowSelfRegistration === true ? (
          <div className="mt-4 rounded-xl bg-emerald-50 p-3 text-xs leading-5 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
            <span className="font-bold">Open sign-up.</span> Anyone with this link can join immediately with the default role.
          </div>
        ) : (
          /* Self-registration is off, so nobody joins by link whatever "Require approval" says. */
          <div className="mt-4 rounded-xl bg-gray-50 p-3 text-xs leading-5 text-gray-600 dark:bg-white/[0.04] dark:text-slate-300">
            <span className="font-bold">Invite-only.</span> Only people you invite (People &amp; invites) can access the app.
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
