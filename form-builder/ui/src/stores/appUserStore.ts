import { create } from 'zustand';
import { api } from '../lib/api';
import type { AppUser, AppUserGroup, AppInvitation } from '../types/app';

interface AppUserState {
  users: Record<string, AppUser[]>;
  groups: Record<string, AppUserGroup[]>;
  invitations: Record<string, AppInvitation[]>;
  isLoading: boolean;

  fetchUsers: (appId: string) => Promise<void>;
  updateUser: (appId: string, appUserId: string, data: Partial<AppUser>) => Promise<void>;
  removeUser: (appId: string, appUserId: string) => Promise<void>;

  fetchInvitations: (appId: string) => Promise<void>;
  inviteUser: (appId: string, email: string, roleId: string) => Promise<AppInvitation | null>;
  revokeInvitation: (appId: string, invitationId: string) => Promise<void>;
  acceptInvitation: (token: string) => Promise<void>;

  fetchGroups: (appId: string) => Promise<void>;
  createGroup: (appId: string, data: { name: string; description?: string }) => Promise<AppUserGroup | null>;
  updateGroup: (appId: string, groupId: string, data: Partial<AppUserGroup>) => Promise<void>;
  deleteGroup: (appId: string, groupId: string) => Promise<void>;
  addGroupMember: (appId: string, groupId: string, appUserId: string) => Promise<void>;
  removeGroupMember: (appId: string, groupId: string, appUserId: string) => Promise<void>;
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
    await api.updateAppUser(appId, appUserId, data);
    await get().fetchUsers(appId);
  },

  removeUser: async (appId, appUserId) => {
    await api.removeAppUser(appId, appUserId);
    await get().fetchUsers(appId);
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
    return result.data?.invitation as AppInvitation;
  },

  revokeInvitation: async (appId, invitationId) => {
    await api.revokeAppInvitation(appId, invitationId);
    await get().fetchInvitations(appId);
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
    return result.data?.group as AppUserGroup;
  },

  updateGroup: async (appId, groupId, data) => {
    await api.updateAppGroup(appId, groupId, data);
    await get().fetchGroups(appId);
  },

  deleteGroup: async (appId, groupId) => {
    await api.deleteAppGroup(appId, groupId);
    await get().fetchGroups(appId);
  },

  addGroupMember: async (appId, groupId, appUserId) => {
    await api.addAppGroupMember(appId, groupId, appUserId);
  },

  removeGroupMember: async (appId, groupId, appUserId) => {
    await api.removeAppGroupMember(appId, groupId, appUserId);
  },
}));
