import { create } from 'zustand';
import { api } from '../lib/api';
import type { AppUser, AppUserGroup, AppInvitation } from '../types/app';

interface AppUserState {
  users: Record<string, AppUser[]>;
  groups: Record<string, AppUserGroup[]>;
  invitations: Record<string, AppInvitation[]>;
  isLoading: boolean;

  fetchUsers: (appId: string) => Promise<void>;
  updateUser: (appId: string, appUserId: string, data: Partial<AppUser>) => Promise<boolean>;
  removeUser: (appId: string, appUserId: string) => Promise<boolean>;

  fetchInvitations: (appId: string) => Promise<void>;
  inviteUser: (appId: string, email: string, roleId: string) => Promise<AppInvitation | null>;
  revokeInvitation: (appId: string, invitationId: string) => Promise<boolean>;
  acceptInvitation: (token: string) => Promise<void>;

  fetchGroups: (appId: string) => Promise<void>;
  createGroup: (appId: string, data: { name: string; description?: string }) => Promise<AppUserGroup | null>;
  updateGroup: (appId: string, groupId: string, data: Partial<AppUserGroup>) => Promise<boolean>;
  deleteGroup: (appId: string, groupId: string) => Promise<boolean>;
  addGroupMember: (appId: string, groupId: string, appUserId: string) => Promise<boolean>;
  removeGroupMember: (appId: string, groupId: string, appUserId: string) => Promise<boolean>;
}

export const useAppUserStore = create<AppUserState>()((set, get) => ({
  users: {},
  groups: {},
  invitations: {},
  isLoading: false,

  fetchUsers: async (appId) => {
    set({ isLoading: true });
    const result = await api.getAppUsers(appId);
    if (!result.error && result.data) {
      set((s) => ({
        users: { ...s.users, [appId]: result.data!.users as AppUser[] },
        isLoading: false,
      }));
    } else {
      set({ isLoading: false });
    }
  },

  updateUser: async (appId, appUserId, data) => {
    const result = await api.updateAppUser(appId, appUserId, data);
    if (result.error) return false;
    await get().fetchUsers(appId);
    return true;
  },

  removeUser: async (appId, appUserId) => {
    const result = await api.removeAppUser(appId, appUserId);
    if (result.error) return false;
    await get().fetchUsers(appId);
    return true;
  },

  fetchInvitations: async (appId) => {
    const result = await api.getAppInvitations(appId);
    if (!result.error && result.data) {
      set((s) => ({
        invitations: { ...s.invitations, [appId]: result.data!.invitations as AppInvitation[] },
      }));
    }
  },

  inviteUser: async (appId, email, roleId) => {
    const result = await api.createAppInvitation(appId, email, roleId);
    if (result.error) return null;
    await get().fetchInvitations(appId);
    return (result.data?.invitation as AppInvitation) ?? null;
  },

  revokeInvitation: async (appId, invitationId) => {
    const result = await api.revokeAppInvitation(appId, invitationId);
    if (result.error) return false;
    await get().fetchInvitations(appId);
    return true;
  },

  acceptInvitation: async (token) => {
    await api.acceptAppInvitation(token);
  },

  fetchGroups: async (appId) => {
    const result = await api.getAppGroups(appId);
    if (!result.error && result.data) {
      set((s) => ({
        groups: { ...s.groups, [appId]: result.data!.groups as AppUserGroup[] },
      }));
    }
  },

  createGroup: async (appId, data) => {
    const result = await api.createAppGroup(appId, data);
    if (result.error) return null;
    await get().fetchGroups(appId);
    return (result.data?.group as AppUserGroup) ?? null;
  },

  updateGroup: async (appId, groupId, data) => {
    const result = await api.updateAppGroup(appId, groupId, data);
    if (result.error) return false;
    await get().fetchGroups(appId);
    return true;
  },

  deleteGroup: async (appId, groupId) => {
    const result = await api.deleteAppGroup(appId, groupId);
    if (result.error) return false;
    await get().fetchGroups(appId);
    return true;
  },

  addGroupMember: async (appId, groupId, appUserId) => {
    const result = await api.addAppGroupMember(appId, groupId, appUserId);
    return !result.error;
  },

  removeGroupMember: async (appId, groupId, appUserId) => {
    const result = await api.removeAppGroupMember(appId, groupId, appUserId);
    return !result.error;
  },
}));
