import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReturnTo, type ReturnToState } from '../../hooks/useReturnTo';
import { Plus, Trash2, Shield, X, Pencil, Check } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useResourcePaths } from '../../components/admin/AdminActingContext';
import { Header } from '../../components/layout/Header';
import { PageBody } from '../../components/layout/PageBody';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { PermissionMatrix } from '../../components/ui/PermissionMatrix';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { toast } from '../../stores/toastStore';
import type { AppRole, AppForm, PermissionAction } from '../../types/app';
import { useViewerOwnsApp } from '../../hooks/useViewerOwnsApp';

export function AppRoleEditor() {
  const { appId } = useParams<{ appId: string }>();
  return <AppRoleEditorContent key={appId} />;
}

function AppRoleEditorContent() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const paths = useResourcePaths();
  // Origin-relative Back: opened from the App Studio this returns to its step.
  const backTo = useReturnTo(paths.appSub(`${appId}`, 'settings?tab=access'));
  const { fetchRoles, createRole, deleteRole, updateRole, fetchAppForms, getApp } = useAppStore();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [permissions, setPermissions] = useState<Array<{ formId: string | null; permission: PermissionAction }>>([]);
  /** True only after a SUCCESSFUL read — gates rendering and saving the matrix. */
  const [permsLoaded, setPermsLoaded] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);
  const [permsReloadToken, setPermsReloadToken] = useState(0);
  const [newRoleName, setNewRoleName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [deleteRoleId, setDeleteRoleId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<{ to: string; state?: ReturnToState } | null>(null);
  const nextPermissionKey = `${appId ?? ''}/${selectedRoleId ?? ''}/${permsReloadToken}`;
  const [permissionKey, setPermissionKey] = useState(nextPermissionKey);
  if (permissionKey !== nextPermissionKey) {
    setPermissionKey(nextPermissionKey);
    setPermissions([]);
    setPermsLoaded(false);
    setPermsError(null);
    setDirty(false);
  }

  const navGuarded = (to: string, state?: ReturnToState) => {
    if (dirty) setPendingNav({ to, state }); else navigate(to, { state });
  };

  const loadData = async (isCancelled: () => boolean = () => false) => {
    if (!appId) return;
    try {
      const [r, f] = await Promise.all([fetchRoles(appId), fetchAppForms(appId)]);
      if (isCancelled()) return;
      setRoles(r);
      setAppForms(f);
      // Select the first role on (re)load; the route key resets selection when switching apps.
      if (r.length > 0) setSelectedRoleId(r[0].id);
    } catch {
      if (!isCancelled()) toast.error('Load failed', 'Could not load roles. Please refresh the page.');
    }
  };

  useEffect(() => {
    let cancelled = false;
    const cancelStart = deferEffect(() => { void loadData(() => cancelled); });
    return () => { cancelled = true; cancelStart(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on appId change; loadData is recreated every render so including it would re-fetch on each render (fetch storm)
  }, [appId]);

  useEffect(() => {
    if (!appId || !selectedRoleId) return;
    let cancelled = false;
    // api.request NEVER throws — it returns { error } — so the error branch has to be
    // read here. Rendering an unread set as an empty matrix looked exactly like a
    // correctly-loaded empty role: ticking one box to enable Save then replaced the
    // role's ENTIRE real permission set with that single row, and every member holding
    // the role silently lost access.
    api.getAppRolePermissions(appId, selectedRoleId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setPermsError(typeof result.error === 'string' ? result.error : 'Could not read this role.');
        return;
      }
      setPermissions(((result.data?.permissions ?? []) as Array<{ formId: string | null; permission: PermissionAction }>).map((p) => ({
        formId: (p as Record<string, unknown>).formId as string | null,
        permission: (p as Record<string, unknown>).permission as PermissionAction,
      })));
      setPermsLoaded(true);
    }).catch(() => {
      if (!cancelled) setPermsError('Could not read this role.');
    });
    return () => { cancelled = true; };
  }, [appId, selectedRoleId, permsReloadToken]);

  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  // The immutable Owner role is identified by identity (system role named Owner),
  // not the display string alone — a custom role literally named "Owner" must
  // remain editable.
  const isOwnerRole = !!selectedRole?.isSystem && selectedRole?.name === 'Owner';
  // App-level permission grants are owner-only on the backend, so their toggles are locked for
  // anyone known not to be the owner. The owner is known from the apps list (canManage / ownerId),
  // or from the app itself when the list does not hold it: a draft or archived app is not listed
  // to a member, and taking a missing row as the owner's offered a delegated manager the toggles
  // and then a refusal, while taking it as someone else's locked an owner whose list was late or
  // had failed to load, and a platform admin acting for the owner (see useViewerOwnsApp).
  const app = appId ? getApp(appId) : undefined;
  const viewerIsNotOwner = useViewerOwnsApp(appId, app) === false;

  const startRenameRole = (role: AppRole) => {
    setEditingRoleId(role.id);
    setEditRoleName(role.name);
  };

  const saveRenameRole = async (roleId: string) => {
    if (!appId) return;
    const name = editRoleName.trim();
    setEditingRoleId(null);
    if (!name) return;
    // Only apply the optimistic rename if the server accepted it.
    const ok = await updateRole(appId, roleId, { name });
    if (ok) {
      setRoles((prev) => prev.map((r) => (r.id === roleId ? { ...r, name } : r)));
    } else {
      loadData();
    }
  };

  const handleSavePermissions = async () => {
    // Never POST over a set that was never read — that is the write which destroys grants.
    if (!appId || !selectedRoleId || !permsLoaded) return;
    setSaving(true);
    setSaveSuccess(false);
    setRoleError(null);
    try {
      const result = await api.setAppRolePermissions(appId, selectedRoleId, permissions);
      if (result.error) {
        toast.error('Save failed', result.error);
      } else {
        setSaveSuccess(true);
        setDirty(false);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      toast.error('Save failed', 'Could not save permissions. Please try again.');
    }
    setSaving(false);
  };

  const handleCreateRole = async () => {
    if (!appId || !newRoleName.trim()) return;
    // Creating a role SWITCHES the selection, which discards an unsaved matrix — the
    // same loss the role buttons already confirm before causing.
    if (dirty && !window.confirm('You have unsaved permission changes. Create the role and discard them?')) return;
    const role = await createRole(appId, { name: newRoleName.trim() });
    if (role) {
      setRoles((prev) => [...prev, role]);
      setDirty(false);
      setSelectedRoleId(role.id);
      setNewRoleName('');
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    if (!appId) return;
    setRoleError(null);
    // deleteRole resolves (never throws) and returns false on backend rejection,
    // so only remove the role from the UI when the delete actually succeeded.
    const ok = await deleteRole(appId, roleId);
    if (!ok) {
      setRoleError('Cannot delete this role. It may still have users assigned.');
      return;
    }
    setRoles((prev) => {
      const updated = prev.filter((r) => r.id !== roleId);
      if (selectedRoleId === roleId) setSelectedRoleId(updated[0]?.id ?? null);
      return updated;
    });
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Roles & permissions"
        back={{ onClick: () => navGuarded(backTo.path, backTo.state), label: backTo.label ? `Back to ${backTo.label}` : 'Back to app settings' }}
      />
      {/* Left-aligned and as wide as the page: the roles at the left, the open role's
          permissions taking the rest. On a narrow screen one stands under the other. */}
      <PageBody className="@container/roles">

      {roleError && (
        <div role="alert" className="mb-4 flex items-center justify-between rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          <span>{roleError}</span>
          <button onClick={() => setRoleError(null)} className="ml-2 inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-red-400 hover:text-red-600 max-sm:h-11 max-sm:w-11 dark:hover:text-red-300" aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 @3xl/roles:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @6xl/roles:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* Role list */}
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h2 className="mb-2 px-1 text-sm font-semibold text-gray-900 dark:text-white">Roles</h2>
          <div className="mb-3 space-y-0.5">
            {roles.map((role) => (
              <div key={role.id} className={cn('flex min-h-9 cursor-pointer items-center justify-between rounded-lg px-2 transition-colors max-sm:min-h-11',
                selectedRoleId === role.id ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-400' : 'hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300'
              )}>
                {editingRoleId === role.id ? (
                  <input
                    autoFocus
                    value={editRoleName}
                    onChange={(e) => setEditRoleName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRenameRole(role.id); if (e.key === 'Escape') setEditingRoleId(null); }}
                    onBlur={() => saveRenameRole(role.id)}
                    aria-label="Role name"
                    className="flex-1 min-w-0 text-sm px-2 py-1 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:outline-none"
                  />
                ) : (
                  <button
                    onClick={() => { if (dirty && role.id !== selectedRoleId) setPendingRoleId(role.id); else setSelectedRoleId(role.id); }}
                    // Selection was conveyed by background colour only, so a screen-reader
                    // user could not tell which role the matrix on the right belonged to.
                    aria-current={role.id === selectedRoleId ? 'true' : undefined}
                    className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm max-sm:min-h-11"
                  >
                    <Shield className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{role.name}</span>
                    {role.isSystem && <span className="text-xs text-gray-400 flex-shrink-0">(system)</span>}
                  </button>
                )}
                {/* The row's actions at a size a pointer, and on a phone a finger, can hit: they
                    were 20px squares. */}
                {!role.isSystem && editingRoleId !== role.id && (
                  <button onClick={() => startRenameRole(role)} title="Rename role"
                    className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-primary-50 hover:text-primary-600 max-sm:h-11 max-sm:w-11 dark:hover:bg-primary-500/10 dark:hover:text-primary-400" aria-label="Rename role"><Pencil className="h-3.5 w-3.5" /></button>
                )}
                {!role.isSystem && editingRoleId === role.id && (
                  <button onMouseDown={(e) => { e.preventDefault(); saveRenameRole(role.id); }} title="Save role name"
                    className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-green-600 transition-colors hover:bg-gray-100 max-sm:h-11 max-sm:w-11 dark:hover:bg-slate-700" aria-label="Save role name"><Check className="h-3.5 w-3.5" /></button>
                )}
                {!role.isSystem && (
                  <button onClick={() => setDeleteRoleId(role.id)} title="Delete role"
                    className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 max-sm:h-11 max-sm:w-11 dark:hover:bg-red-500/10 dark:hover:text-red-400" aria-label="Delete role"><Trash2 className="h-3.5 w-3.5" /></button>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="New role" aria-label="New role name"
              onKeyDown={(e) => { if (e.key === 'Enter' && newRoleName.trim()) handleCreateRole(); }}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 transition-all duration-200 focus:border-transparent focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 max-sm:text-base dark:border-slate-600 dark:bg-slate-800 dark:text-white" />
            <button onClick={handleCreateRole} disabled={!newRoleName.trim()} title="Create role" className="inline-flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-lg text-primary-600 transition-colors hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50 max-sm:h-11 max-sm:w-11 dark:hover:bg-primary-500/10" aria-label="Create role">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Permission matrix */}
        <div className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {selectedRole ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Permissions for "{selectedRole.name}"</h2>
                <Button size="sm" onClick={handleSavePermissions} disabled={saving || isOwnerRole || !dirty || !permsLoaded}>
                  {saving ? 'Saving...' : saveSuccess ? 'Saved!' : 'Save permissions'}
                </Button>
              </div>
              {isOwnerRole ? (
                <p className="text-sm text-gray-500 dark:text-slate-400">The Owner role has all permissions and cannot be modified.</p>
              ) : permsError ? (
                /* Nothing is shown or editable until the real set loads — saving over an
                   unknown set would revoke every grant the role actually holds. */
                <div className="flex flex-col items-start gap-2 py-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Couldn't read this role's permissions</p>
                  <p className="max-w-2xl text-sm text-gray-500 dark:text-slate-400">{permsError}</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => setPermsReloadToken((t) => t + 1)}>
                    Try again
                  </Button>
                </div>
              ) : !permsLoaded ? (
                <div className="flex items-center gap-3 py-4 text-sm text-gray-500 dark:text-slate-400">
                  <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600" role="status" aria-label="Loading permissions" />
                  Loading permissions…
                </div>
              ) : (
                <PermissionMatrix
                  permissions={permissions}
                  forms={appForms.map((f) => ({ formId: f.formId, displayName: f.displayName }))}
                  onChange={(p) => { setPermissions(p); setDirty(true); }}
                  appLevelDisabled={viewerIsNotOwner}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500 dark:text-slate-400">Select a role to edit permissions</p>
          )}
        </div>
      </div>
      </PageBody>

      <ConfirmDialog
        isOpen={deleteRoleId !== null}
        onClose={() => setDeleteRoleId(null)}
        onConfirm={() => { if (deleteRoleId) { handleDeleteRole(deleteRoleId); setDeleteRoleId(null); } }}
        title="Delete role"
        message={`Are you sure you want to delete the role "${roles.find((r) => r.id === deleteRoleId)?.name}"? Users with this role will need to be reassigned.`}
        confirmLabel="Delete role"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={pendingRoleId !== null}
        onClose={() => setPendingRoleId(null)}
        onConfirm={() => { if (pendingRoleId) { setSelectedRoleId(pendingRoleId); setDirty(false); } setPendingRoleId(null); }}
        title="Discard unsaved changes?"
        message="You have unsaved permission changes for this role. Switch roles and discard them?"
        confirmLabel="Discard changes"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        onConfirm={() => { const target = pendingNav; setPendingNav(null); setDirty(false); if (target) navigate(target.to, { state: target.state }); }}
        title="Discard unsaved changes?"
        message="You have unsaved permission changes. If you leave now, they'll be lost."
        confirmLabel="Discard changes"
        variant="danger"
      />
    </div>
  );
}
