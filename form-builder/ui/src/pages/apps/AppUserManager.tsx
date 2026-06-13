import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, UserPlus, Trash2, Pencil } from 'lucide-react';
import { useAppUserStore } from '../../stores/appUserStore';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { cn } from '../../lib/utils';
import type { AppUser, AppInvitation, AppRole } from '../../types/app';

export function AppUserManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const { users, invitations, groups, fetchUsers, fetchInvitations, fetchGroups, inviteUser, revokeInvitation, removeUser, updateUser, createGroup, deleteGroup } = useAppUserStore();
  const { fetchRoles } = useAppStore();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'removeUser' | 'deleteGroup'; id: string; label: string } | null>(null);
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);
  const [editRoleId, setEditRoleId] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'suspended'>('active');
  const [editSaving, setEditSaving] = useState(false);

  const openEditUser = (user: AppUser) => {
    setEditingUser(user);
    setEditRoleId(user.roleId);
    setEditStatus(user.status === 'suspended' ? 'suspended' : 'active');
  };

  const handleSaveUser = async () => {
    if (!appId || !editingUser) return;
    setEditSaving(true);
    const ok = await updateUser(appId, editingUser.id, { roleId: editRoleId, status: editStatus });
    setEditSaving(false);
    if (ok) {
      toast.success('Member updated', 'Role and status saved.');
      setEditingUser(null);
    }
  };

  useEffect(() => {
    if (!appId) return;
    Promise.allSettled([
      fetchUsers(appId),
      fetchInvitations(appId),
      fetchGroups(appId),
      fetchRoles(appId).then(setRoles),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        toast.error('Load error', 'Some data could not be loaded. Please refresh the page.');
      }
    }).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const appUsers = users[appId!] || [];
  const appInvitations = invitations[appId!] || [];
  const appGroups = groups[appId!] || [];

  const userColumns: Column<AppUser>[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'email', label: 'Email', sortable: true },
    { key: 'roleName', label: 'Role', sortable: true },
    { key: 'status', label: 'Status', sortable: true, render: (u) => (
      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium',
        u.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' :
        u.status === 'pending' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400' :
        'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
      )}>{u.status}</span>
    )},
  ];

  const handleInvite = async () => {
    if (!appId || !inviteEmail || !inviteRoleId) return;
    setInviteLoading(true);
    setInviteError(null);
    const success = await inviteUser(appId, inviteEmail, inviteRoleId);
    setInviteLoading(false);
    if (success) {
      setShowInviteModal(false);
      setInviteEmail('');
      setInviteRoleId('');
    } else {
      setInviteError('Failed to send invitation. Please check the email and try again.');
    }
  };

  const handleCreateGroup = async () => {
    if (!appId || !newGroupName.trim()) return;
    await createGroup(appId, { name: newGroupName.trim() });
    setNewGroupName('');
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Users & Access"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
              Back
            </Button>
            <Button size="sm" onClick={() => setShowInviteModal(true)} leftIcon={<UserPlus className="h-4 w-4" />}>Invite User</Button>
          </>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">

      <Tabs defaultValue="users">
        <TabsList variant="underline" aria-label="User management sections" className="mb-6">
          <TabsTrigger value="users" variant="underline">Users ({appUsers.length})</TabsTrigger>
          <TabsTrigger value="invitations" variant="underline">Invitations ({appInvitations.length})</TabsTrigger>
          <TabsTrigger value="groups" variant="underline">Groups ({appGroups.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <DataTable
            data={appUsers as unknown as Record<string, unknown>[]}
            columns={userColumns as unknown as Column<Record<string, unknown>>[]}
            searchable
            isLoading={loading}
            searchPlaceholder="Search users..."
            actions={(user) => (
              <div className="flex items-center justify-end gap-1">
                <button onClick={() => openEditUser(user as unknown as AppUser)}
                  className="p-1.5 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors cursor-pointer" aria-label="Edit member role and status"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => setConfirmAction({ type: 'removeUser', id: (user as unknown as AppUser).id, label: String((user as unknown as AppUser).name || (user as unknown as AppUser).email) })}
                  className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Remove user"><Trash2 className="h-4 w-4" /></button>
              </div>
            )}
          />
        </TabsContent>

        <TabsContent value="invitations">
          <DataTable
            data={appInvitations as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'email', label: 'Email', sortable: true },
              { key: 'roleName', label: 'Role', sortable: true },
              { key: 'status', label: 'Status', sortable: true },
              { key: 'expiresAt', label: 'Expires', sortable: true, render: (inv) => new Date(String((inv as unknown as AppInvitation).expiresAt)).toLocaleDateString() },
            ] as Column<Record<string, unknown>>[]}
            searchable
            isLoading={loading}
            actions={(inv) => (
              (inv as unknown as AppInvitation).status === 'pending' ? (
                <button onClick={() => revokeInvitation(appId!, String(inv.id))} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Revoke invitation"><Trash2 className="h-4 w-4" /></button>
              ) : null
            )}
          />
        </TabsContent>

        <TabsContent value="groups">
          <div className="flex gap-2 mb-4">
            <input type="text" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="New group name"
              className="flex-1 max-w-xs px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm transition-all duration-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
            <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create Group</Button>
          </div>
          <DataTable
            data={appGroups as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'name', label: 'Name', sortable: true },
              { key: 'description', label: 'Description' },
              { key: 'memberCount', label: 'Members', sortable: true },
            ] as Column<Record<string, unknown>>[]}
            isLoading={loading}
            actions={(group) => (
              <button onClick={() => setConfirmAction({ type: 'deleteGroup', id: String(group.id), label: String((group as Record<string, unknown>).name || 'this group') })}
                className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Delete group"><Trash2 className="h-4 w-4" /></button>
            )}
          />
        </TabsContent>
      </Tabs>

    </div>
    </div>

      <Modal isOpen={showInviteModal} onClose={() => { setShowInviteModal(false); setInviteError(null); }} title="Invite User" size="sm">
        <div className="p-6 space-y-4">
          {inviteError && (
            <div className="flex items-center gap-2 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg border border-red-200 dark:border-red-500/20">
              <span>{inviteError}</span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Email</label>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com"
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Role</label>
            <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
              <option value="">Select role...</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => { setShowInviteModal(false); setInviteError(null); }}>Cancel</Button>
            <Button onClick={handleInvite} disabled={!inviteEmail || !inviteRoleId || inviteLoading} isLoading={inviteLoading}>Send Invitation</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={editingUser !== null} onClose={() => setEditingUser(null)} title="Edit Member" size="sm">
        <div className="p-6 space-y-4">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">{editingUser?.name || editingUser?.email}</p>
            {editingUser?.status === 'pending' && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">This member is pending — set status to Active to approve them.</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Role</label>
            <select value={editRoleId} onChange={(e) => setEditRoleId(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Status</label>
            <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as 'active' | 'suspended')}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setEditingUser(null)}>Cancel</Button>
            <Button onClick={handleSaveUser} disabled={!editRoleId || editSaving} isLoading={editSaving}>Save</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (!confirmAction || !appId) return;
          let success = false;
          if (confirmAction.type === 'removeUser') {
            success = await removeUser(appId, confirmAction.id);
            if (!success) toast.error('Remove failed', 'Could not remove the user. Please try again.');
          } else if (confirmAction.type === 'deleteGroup') {
            success = await deleteGroup(appId, confirmAction.id);
            if (!success) toast.error('Delete failed', 'Could not delete the group. Please try again.');
          }
          setConfirmAction(null);
        }}
        title={confirmAction?.type === 'removeUser' ? 'Remove User' : 'Delete Group'}
        message={confirmAction?.type === 'removeUser'
          ? `Are you sure you want to remove "${confirmAction?.label}" from this app?`
          : `Are you sure you want to delete the group "${confirmAction?.label}"?`}
        confirmLabel={confirmAction?.type === 'removeUser' ? 'Remove' : 'Delete'}
        variant="danger"
      />
    </div>
  );
}
