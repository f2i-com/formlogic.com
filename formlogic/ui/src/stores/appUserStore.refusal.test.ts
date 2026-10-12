// @vitest-environment jsdom
// When the server refuses a change to a member (a delegated manager acting on a member with an
// app-level role, or handing out such a role), the person sees the server's own sentence, not a
// generic failure. Through the real api layer: a 400 with the standard error envelope.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('./toastStore', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useAppUserStore } from './appUserStore';

const MEMBER = 'Only the app owner can change a member whose role has app-level permissions';
const ASSIGN = 'Only the app owner can assign roles with app-level permissions';
const refuse = (message: string) => new Response(JSON.stringify({ error: true, message }), { status: 400, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => toastError.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('a member change the server refuses', () => {
  it('shows the refusal when changing a role or status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse(MEMBER)));
    expect(await useAppUserStore.getState().updateUser('app1', 'm1', { status: 'suspended' })).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Update failed', MEMBER);
  });

  it('shows the refusal when removing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse(MEMBER)));
    expect(await useAppUserStore.getState().removeUser('app1', 'm1')).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Remove failed', MEMBER);
  });

  it('shows the refusal when giving a member, or an invitee, an app-level role', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refuse(ASSIGN)));
    expect(await useAppUserStore.getState().updateUser('app1', 'm1', { roleId: 'r-admin' })).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Update failed', ASSIGN);
    expect(await useAppUserStore.getState().inviteUser('app1', 'new@example.test', 'r-admin')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('Invite failed', ASSIGN);
  });
});
