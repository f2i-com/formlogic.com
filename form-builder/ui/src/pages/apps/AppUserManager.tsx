import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, UserPlus, Trash2 } from 'lucide-react';
import { useAppUserStore } from '../../stores/appUserStore';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { cn } from '../../lib/utils';
import type { AppUser, AppInvitation, AppRole } from '../../types/app';

export function AppUserManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(0);
  const { users, invitations, groups, fetchUsers, fetchInvitations, fetchGroups, inviteUser, revokeInvitation, removeUser, createGroup, deleteGroup } = useAppUserStore();
  const { fetchRoles } = useAppStore();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');

  useEffect(() => {
    if (!appId) return;
    fetchUsers(appId);
    fetchInvitations(appId);
    fetchGroups(appId);
    fetchRoles(appId).then(setRoles);
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
    await inviteUser(appId, inviteEmail, inviteRoleId);
    setShowInviteModal(false);
    setInviteEmail('');
    setInviteRoleId('');
  };

  const handleCreateGroup = async () => {
    if (!appId || !newGroupName.trim()) return;
    await createGroup(appId, { name: newGroupName.trim() });
    setNewGroupName('');
  };

  const tabs = ['Users', 'Invitations', 'Groups'];

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

      <div className="flex border-b border-gray-200 dark:border-slate-700 mb-6">
        {tabs.map((tab, i) => (
          <button key={tab} onClick={() => setActiveTab(i)}
            className={cn('px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              i === activeTab ? 'border-primary-600 text-primary-600 dark:text-primary-400' : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
            )}>{tab} ({i === 0 ? appUsers.length : i === 1 ? appInvitations.length : appGroups.length})</button>
        ))}
      </div>

      {activeTab === 0 && (
        <DataTable
          data={appUsers as unknown as Record<string, unknown>[]}
          columns={userColumns as unknown as Column<Record<string, unknown>>[]}
          searchable
          searchPlaceholder="Search users..."
          actions={(user) => (
            <button onClick={() => { if (confirm('Remove this user?')) removeUser(appId!, (user as unknown as AppUser).id); }}
              className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
          )}
        />
      )}

      {activeTab === 1 && (
        <DataTable
          data={appInvitations as unknown as Record<string, unknown>[]}
          columns={[
            { key: 'email', label: 'Email', sortable: true },
            { key: 'roleName', label: 'Role', sortable: true },
            { key: 'status', label: 'Status', sortable: true },
            { key: 'expiresAt', label: 'Expires', sortable: true, render: (inv) => new Date(String((inv as unknown as AppInvitation).expiresAt)).toLocaleDateString() },
          ] as Column<Record<string, unknown>>[]}
          searchable
          actions={(inv) => (
            (inv as unknown as AppInvitation).status === 'pending' ? (
              <button onClick={() => revokeInvitation(appId!, String(inv.id))} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
            ) : null
          )}
        />
      )}

      {activeTab === 2 && (
        <div>
          <div className="flex gap-2 mb-4">
            <input type="text" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="New group name"
              className="flex-1 max-w-xs px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm" />
            <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create Group</Button>
          </div>
          <DataTable
            data={appGroups as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'name', label: 'Name', sortable: true },
              { key: 'description', label: 'Description' },
              { key: 'memberCount', label: 'Members', sortable: true },
            ] as Column<Record<string, unknown>>[]}
            actions={(group) => (
              <button onClick={() => { if (confirm('Delete this group?')) deleteGroup(appId!, String(group.id)); }}
                className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
            )}
          />
        </div>
      )}

    </div>
    </div>

      {/* Invite Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Invite User</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Email</label>
                <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Role</label>
                <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white">
                  <option value="">Select role...</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button variant="ghost" onClick={() => setShowInviteModal(false)}>Cancel</Button>
              <Button onClick={handleInvite} disabled={!inviteEmail || !inviteRoleId}>Send Invitation</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
