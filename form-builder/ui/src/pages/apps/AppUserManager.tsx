import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, UserPlus, Trash2, Pencil, Users, Check, Copy } from 'lucide-react';
import { useAppUserStore } from '../../stores/appUserStore';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { statusBadgeVariant, formatStatusLabel } from '../../lib/utils';
import { Badge } from '../../components/ui/Badge';
import type { AppUser, AppInvitation, AppRole, AppUserGroup } from '../../types/app';

// User groups have full CRUD but group membership is not yet consumed by permission
// resolution, so the tab is hidden until group-based authorization ships (flip to
// re-enable). Keeps the UI honest without dropping the built-out group code.
const GROUPS_ENABLED = false;

export function AppUserManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const { users, invitations, groups, fetchUsers, fetchInvitations, fetchGroups, inviteUser, revokeInvitation, removeUser, updateUser, createGroup, deleteGroup, addGroupMember, removeGroupMember } = useAppUserStore();
  const { fetchRoles } = useAppStore();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'removeUser' | 'deleteGroup' | 'revokeInvitation'; id: string; label: string } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
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

  // Group membership management
  const [managingGroup, setManagingGroup] = useState<AppUserGroup | null>(null);
  const [groupMemberIds, setGroupMemberIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(false);

  const openManageMembers = async (group: AppUserGroup) => {
    setManagingGroup(group);
    setMembersLoading(true);
    setGroupMemberIds(new Set());
    if (appId) {
      const result = await api.getAppGroupMembers(appId, group.id);
      if (result.data?.members) {
        setGroupMemberIds(new Set(result.data.members.map((m) => m.appUserId)));
      } else if (result.error) {
        toast.error('Failed to load members', typeof result.error === 'string' ? result.error : 'Please try again.');
      }
    }
    setMembersLoading(false);
  };

  const toggleMember = async (appUserId: string, inGroup: boolean) => {
    if (!appId || !managingGroup) return;
    // Optimistic update
    setGroupMemberIds((prev) => {
      const next = new Set(prev);
      if (inGroup) next.delete(appUserId); else next.add(appUserId);
      return next;
    });
    const ok = inGroup
      ? await removeGroupMember(appId, managingGroup.id, appUserId)
      : await addGroupMember(appId, managingGroup.id, appUserId);
    if (!ok) {
      // Roll back on failure
      setGroupMemberIds((prev) => {
        const next = new Set(prev);
        if (inGroup) next.add(appUserId); else next.delete(appUserId);
        return next;
      });
      toast.error('Update failed', 'Could not update group membership. Please try again.');
    } else {
      fetchGroups(appId).catch(() => {});
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
      <Badge variant={statusBadgeVariant(u.status)} className="rounded-full">{formatStatusLabel(u.status)}</Badge>
    )},
  ];

  const closeInviteModal = () => {
    setShowInviteModal(false);
    setInviteError(null);
    setInviteLink(null);
    setLinkCopied(false);
    setInviteEmail('');
    setInviteRoleId('');
  };

  const handleApprove = async (user: AppUser) => {
    if (!appId) return;
    const ok = await updateUser(appId, user.id, { status: 'active' });
    if (ok) toast.success('Member approved', `${user.name || user.email} is now active.`);
  };

  const handleInvite = async () => {
    if (!appId || !inviteEmail || !inviteRoleId) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      setInviteError('Please enter a valid email address.');
      return;
    }
    setInviteLoading(true);
    setInviteError(null);
    const invitation = await inviteUser(appId, inviteEmail, inviteRoleId);
    setInviteLoading(false);
    if (invitation) {
      // Surface the one-time token as a shareable accept link so the invitee can
      // be onboarded even when no email service is configured. (If the backend
      // also emails it, the link is still a convenient fallback to copy.)
      if (invitation.token) {
        setInviteLink(`${window.location.origin}/accept-invite?token=${invitation.token}`);
      } else {
        closeInviteModal();
        toast.success('Invitation sent', 'An invite email has been sent to the user.');
      }
    } else {
      setInviteError('Failed to send invitation. Please check the email and try again.');
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error('Copy failed', 'Select and copy the link manually.');
    }
  };

  const handleCreateGroup = async () => {
    if (!appId || !newGroupName.trim() || creatingGroup) return;
    setCreatingGroup(true);
    try {
      await createGroup(appId, { name: newGroupName.trim() });
      setNewGroupName('');
    } finally {
      setCreatingGroup(false);
    }
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
          {GROUPS_ENABLED && <TabsTrigger value="groups" variant="underline">Groups ({appGroups.length})</TabsTrigger>}
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
                {(user as unknown as AppUser).status === 'pending' && (
                  <button onClick={() => handleApprove(user as unknown as AppUser)}
                    className="p-1.5 text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer" aria-label="Approve member"><Check className="h-4 w-4" /></button>
                )}
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
              { key: 'status', label: 'Status', sortable: true, render: (inv) => { const s = String((inv as unknown as AppInvitation).status); return <Badge variant={statusBadgeVariant(s)} size="sm">{formatStatusLabel(s)}</Badge>; } },
              { key: 'expiresAt', label: 'Expires', sortable: true, render: (inv) => new Date(String((inv as unknown as AppInvitation).expiresAt)).toLocaleDateString() },
            ] as Column<Record<string, unknown>>[]}
            searchable
            isLoading={loading}
            emptyMessage="No invitations yet — invite a user to get started."
            actions={(inv) => (
              (inv as unknown as AppInvitation).status === 'pending' ? (
                <button onClick={() => setConfirmAction({ type: 'revokeInvitation', id: String(inv.id), label: String((inv as unknown as AppInvitation).email) })} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Revoke invitation"><Trash2 className="h-4 w-4" /></button>
              ) : null
            )}
          />
        </TabsContent>

        {GROUPS_ENABLED && <TabsContent value="groups">
          <div className="flex gap-2 mb-4">
            <input type="text" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="New group name"
              className="flex-1 max-w-xs px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm transition-all duration-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
            <Button size="sm" onClick={handleCreateGroup} isLoading={creatingGroup} disabled={!newGroupName.trim() || creatingGroup}>Create Group</Button>
          </div>
          <DataTable
            data={appGroups as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'name', label: 'Name', sortable: true },
              { key: 'description', label: 'Description' },
              { key: 'memberCount', label: 'Members', sortable: true },
            ] as Column<Record<string, unknown>>[]}
            isLoading={loading}
            emptyMessage="No groups yet — create one above to organize members."
            actions={(group) => (
              <div className="flex items-center justify-end gap-1">
                <button onClick={() => openManageMembers(group as unknown as AppUserGroup)}
                  className="p-1.5 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors cursor-pointer" aria-label="Manage group members"><Users className="h-4 w-4" /></button>
                <button onClick={() => setConfirmAction({ type: 'deleteGroup', id: String(group.id), label: String((group as Record<string, unknown>).name || 'this group') })}
                  className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" aria-label="Delete group"><Trash2 className="h-4 w-4" /></button>
              </div>
            )}
          />
        </TabsContent>}
      </Tabs>

    </div>
    </div>

      <Modal isOpen={showInviteModal} onClose={closeInviteModal} title="Invite User" size="sm">
        {inviteLink ? (
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-2 p-3 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-500/10 rounded-lg border border-green-200 dark:border-green-500/20">
              <Check className="h-4 w-4 flex-shrink-0" />
              <span>Invitation created. Share this link with the user to let them join.</span>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Invite link</label>
              <div className="flex gap-2">
                <input type="text" readOnly value={inviteLink} onFocus={(e) => e.target.select()} aria-label="Invite link"
                  className="flex-1 min-w-0 px-3 py-2.5 border border-gray-200/80 dark:border-slate-700/60 rounded-xl bg-gray-50 dark:bg-slate-800 text-gray-700 dark:text-slate-300 text-xs font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" />
                <Button variant="outline" size="sm" onClick={copyInviteLink} leftIcon={linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
                  {linkCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">The user must sign in (or sign up) with the invited email to accept.</p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => { setInviteLink(null); setLinkCopied(false); }}>Invite another</Button>
              <Button onClick={closeInviteModal}>Done</Button>
            </div>
          </div>
        ) : (
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
            <Button variant="ghost" onClick={closeInviteModal}>Cancel</Button>
            <Button onClick={handleInvite} disabled={!inviteEmail || !inviteRoleId || inviteLoading} isLoading={inviteLoading}>Send Invitation</Button>
          </div>
        </div>
        )}
      </Modal>

      <Modal isOpen={managingGroup !== null} onClose={() => setManagingGroup(null)} title={managingGroup ? `Members of "${managingGroup.name}"` : 'Members'} size="sm">
        <div className="p-6">
          {membersLoading ? (
            <p className="text-sm text-gray-500 dark:text-slate-400 py-4">Loading members…</p>
          ) : appUsers.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-slate-400 py-4">No members in this app yet. Invite users first.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800">
              {appUsers.map((u) => {
                const inGroup = groupMemberIds.has(u.id);
                return (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{u.name || u.email}</p>
                      {u.name && <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{u.email}</p>}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="text-xs text-gray-500 dark:text-slate-400">{inGroup ? 'Member' : 'Add'}</span>
                      <input
                        type="checkbox"
                        checked={inGroup}
                        onChange={() => toggleMember(u.id, inGroup)}
                        aria-label={`${inGroup ? 'Remove' : 'Add'} ${u.name || u.email} ${inGroup ? 'from' : 'to'} group`}
                        className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 accent-primary-600 focus:ring-primary-500 cursor-pointer"
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end pt-4">
            <Button variant="ghost" onClick={() => setManagingGroup(null)}>Done</Button>
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
            <Button onClick={handleSaveUser} disabled={!editRoleId || editSaving} isLoading={editSaving}>
              {editingUser?.status === 'pending' && editStatus === 'active' ? 'Approve member' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmAction !== null}
        onClose={() => { if (!confirmLoading) setConfirmAction(null); }}
        onConfirm={async () => {
          if (!confirmAction || !appId || confirmLoading) return;
          setConfirmLoading(true);
          try {
            // The store surfaces a specific error toast on failure, so don't add a
            // second generic one here.
            if (confirmAction.type === 'removeUser') {
              await removeUser(appId, confirmAction.id);
            } else if (confirmAction.type === 'deleteGroup') {
              await deleteGroup(appId, confirmAction.id);
            } else if (confirmAction.type === 'revokeInvitation') {
              await revokeInvitation(appId, confirmAction.id);
            }
          } finally {
            setConfirmLoading(false);
            setConfirmAction(null);
          }
        }}
        title={confirmAction?.type === 'removeUser' ? 'Remove user' : confirmAction?.type === 'deleteGroup' ? 'Delete group' : 'Revoke invitation'}
        message={confirmAction?.type === 'removeUser'
          ? `Remove "${confirmAction?.label}" from this app? They'll lose access immediately.`
          : confirmAction?.type === 'deleteGroup'
            ? `Delete the group "${confirmAction?.label}"? This can't be undone.`
            : `Revoke the invitation for "${confirmAction?.label}"? The invite link will stop working.`}
        confirmLabel={confirmAction?.type === 'removeUser' ? 'Remove' : confirmAction?.type === 'deleteGroup' ? 'Delete' : 'Revoke'}
        variant="danger"
        isLoading={confirmLoading}
      />
    </div>
  );
}
