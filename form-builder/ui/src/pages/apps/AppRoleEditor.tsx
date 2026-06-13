import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Shield, X, Pencil, Check } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { PermissionMatrix } from '../../components/ui/PermissionMatrix';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { AppRole, AppForm, PermissionAction } from '../../types/app';

export function AppRoleEditor() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { fetchRoles, createRole, deleteRole, updateRole, fetchAppForms } = useAppStore();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [permissions, setPermissions] = useState<Array<{ formId: string | null; permission: PermissionAction }>>([]);
  const [newRoleName, setNewRoleName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [deleteRoleId, setDeleteRoleId] = useState<string | null>(null);

  const loadData = async () => {
    if (!appId) return;
    try {
      const [r, f] = await Promise.all([fetchRoles(appId), fetchAppForms(appId)]);
      setRoles(r);
      setAppForms(f);
      // The [appId] effect resets selectedRoleId to null before this runs, but
      // that reset isn't visible in this closure — always select the first role
      // on (re)load so switching apps doesn't leave nothing selected.
      if (r.length > 0) setSelectedRoleId(r[0].id);
    } catch {
      toast.error('Load failed', 'Could not load roles. Please refresh the page.');
    }
  };

  useEffect(() => {
    setSelectedRoleId(null);
    setPermissions([]);
    loadData();
  }, [appId]);

  useEffect(() => {
    if (!appId || !selectedRoleId) return;
    setPermissions([]); // Clear previous role's permissions immediately
    let cancelled = false;
    api.getAppRolePermissions(appId, selectedRoleId).then((result) => {
      if (cancelled) return;
      if (result.data?.permissions) {
        setPermissions((result.data.permissions as Array<{ formId: string | null; permission: PermissionAction }>).map((p) => ({
          formId: (p as Record<string, unknown>).formId as string | null,
          permission: (p as Record<string, unknown>).permission as PermissionAction,
        })));
      }
    }).catch(() => {
      if (!cancelled) {
        setPermissions([]);
        toast.error('Load failed', 'Could not load permissions for this role');
      }
    });
    return () => { cancelled = true; };
  }, [appId, selectedRoleId]);

  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  // The immutable Owner role is identified by identity (system role named Owner),
  // not the display string alone — a custom role literally named "Owner" must
  // remain editable.
  const isOwnerRole = !!selectedRole?.isSystem && selectedRole?.name === 'Owner';

  const startRenameRole = (role: AppRole) => {
    setEditingRoleId(role.id);
    setEditRoleName(role.name);
  };

  const saveRenameRole = async (roleId: string) => {
    if (!appId) return;
    const name = editRoleName.trim();
    setEditingRoleId(null);
    if (!name) return;
    await updateRole(appId, roleId, { name });
    setRoles((prev) => prev.map((r) => (r.id === roleId ? { ...r, name } : r)));
  };

  const handleSavePermissions = async () => {
    if (!appId || !selectedRoleId) return;
    setSaving(true);
    setSaveSuccess(false);
    setRoleError(null);
    try {
      const result = await api.setAppRolePermissions(appId, selectedRoleId, permissions);
      if (result.error) {
        toast.error('Save failed', result.error);
      } else {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      toast.error('Save failed', 'Could not save permissions. Please try again.');
    }
    setSaving(false);
  };

  const handleCreateRole = async () => {
    if (!appId || !newRoleName.trim()) return;
    const role = await createRole(appId, { name: newRoleName.trim() });
    if (role) {
      setRoles((prev) => [...prev, role]);
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
        title="Roles & Permissions"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto">

      {roleError && (
        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-4 py-3 rounded-lg mb-4 border border-red-100 dark:border-red-500/20">
          <span>{roleError}</span>
          <button onClick={() => setRoleError(null)} className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300" aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Role list */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4 overflow-hidden">
          <h3 className="font-medium text-gray-900 dark:text-white mb-3 tracking-tight">Roles</h3>
          <div className="space-y-1 mb-4">
            {roles.map((role) => (
              <div key={role.id} className={cn('flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors',
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
                  <button onClick={() => setSelectedRoleId(role.id)} className="flex items-center gap-2 flex-1 text-left text-sm min-w-0">
                    <Shield className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{role.name}</span>
                    {role.isSystem && <span className="text-xs text-gray-400 flex-shrink-0">(system)</span>}
                  </button>
                )}
                {!role.isSystem && editingRoleId !== role.id && (
                  <button onClick={() => startRenameRole(role)}
                    className="p-1 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors cursor-pointer" aria-label="Rename role"><Pencil className="h-3 w-3" /></button>
                )}
                {!role.isSystem && editingRoleId === role.id && (
                  <button onMouseDown={(e) => { e.preventDefault(); saveRenameRole(role.id); }}
                    className="p-1 text-green-600 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors cursor-pointer" aria-label="Save role name"><Check className="h-3 w-3" /></button>
                )}
                {!role.isSystem && (
                  <button onClick={() => setDeleteRoleId(role.id)}
                    className="p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Delete role"><Trash2 className="h-3 w-3" /></button>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="New role"
              className="flex-1 min-w-0 px-2.5 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-all duration-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
            <button onClick={handleCreateRole} disabled={!newRoleName.trim()} className="p-1.5 text-primary-600 hover:text-primary-700 disabled:opacity-50 cursor-pointer rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors" aria-label="Create role">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Permission matrix */}
        <div className="lg:col-span-3 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
          {selectedRole ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Permissions for "{selectedRole.name}"</h3>
                <Button size="sm" onClick={handleSavePermissions} disabled={saving || isOwnerRole}>
                  {saving ? 'Saving...' : saveSuccess ? 'Saved!' : 'Save Permissions'}
                </Button>
              </div>
              {isOwnerRole ? (
                <p className="text-sm text-gray-500 dark:text-slate-400">The Owner role has all permissions and cannot be modified.</p>
              ) : (
                <PermissionMatrix
                  permissions={permissions}
                  forms={appForms.map((f) => ({ formId: f.formId, displayName: f.displayName }))}
                  onChange={setPermissions}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-8">Select a role to edit permissions</p>
          )}
        </div>
      </div>
    </div>
    </div>

      <ConfirmDialog
        isOpen={deleteRoleId !== null}
        onClose={() => setDeleteRoleId(null)}
        onConfirm={() => { if (deleteRoleId) { handleDeleteRole(deleteRoleId); setDeleteRoleId(null); } }}
        title="Delete Role"
        message={`Are you sure you want to delete the role "${roles.find((r) => r.id === deleteRoleId)?.name}"? Users with this role will need to be reassigned.`}
        confirmLabel="Delete Role"
        variant="danger"
      />
    </div>
  );
}
