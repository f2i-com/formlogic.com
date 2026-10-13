// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { admitHostedActor, captureHostedRequest, copyHostedActor, isHostedAdmissionCurrent, sameHostedActor } from './hostedActor';
import { bumpSessionGeneration, setSessionOwner } from './sessionGeneration';

const actor = { version: 1 as const, appId: 'app-a', userId: 'alice', roleId: 'member', isOwner: false, sessionId: 'a'.repeat(64) };
beforeEach(() => { setSessionOwner('alice'); bumpSessionGeneration(); api.setAdminActing(null); });
afterEach(() => { vi.unstubAllGlobals(); });
it.each([undefined, null, {}, [], { ...actor, version: 2 }, { ...actor, appId: '' }, { ...actor, appId: 'app/path' }, { ...actor, appId: 'a'.repeat(101) }, { ...actor, userId: 'a\nb' }, { ...actor, userId: 'é' }, { ...actor, userId: 'a'.repeat(201) }, { ...actor, roleId: 'role"' }, { ...actor, roleId: null }, { ...actor, isOwner: true }, { ...actor, sessionId: 'token' }, { ...actor, extra: true }])('refuses malformed actor %#', value => {
  expect(copyHostedActor(value)).toBeNull();
  expect(admitHostedActor(value, captureHostedRequest(), 'app')).toBeNull();
});
it('copies and freezes server identity independently of later response mutation', () => {
  const original = { ...actor }; const admission = admitHostedActor(original, captureHostedRequest(), 'app')!;
  original.userId = 'bob'; expect(admission.actor.userId).toBe('alice'); expect(Object.isFrozen(admission.actor)).toBe(true); expect(Object.isFrozen(admission)).toBe(true);
});
it.each([{ userId: 'bob' }, { appId: 'app-b' }, { roleId: 'other' }, { sessionId: 'b'.repeat(64) }, { isOwner: true, roleId: null }])('all authority dimensions must match %j', change => {
  expect(sameHostedActor(actor, { ...actor, ...change })).toBe(false);
});
it('refuses runtime admission captured before same-user session replacement', () => {
  const request = captureHostedRequest(); bumpSessionGeneration(); expect(admitHostedActor(actor, request, 'app')).toBeNull();
});
it('refuses a different response user and a wrong management app', () => {
  expect(admitHostedActor({ ...actor, userId: 'bob' }, captureHostedRequest(), 'app')).toBeNull();
  expect(admitHostedActor(actor, captureHostedRequest(), 'app', 'app-b')).toBeNull();
});
it('stale admission cannot become current after changing client props or slug', () => {
  const admission = admitHostedActor(actor, captureHostedRequest(), 'app')!;
  expect(isHostedAdmissionCurrent(admission, 'other')).toBe(false); bumpSessionGeneration(); expect(isHostedAdmissionCurrent(admission, 'app')).toBe(false);
});
it('copies the initiating actor into the reserved header, independently of guest identity claims', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ result: 'saved', actor }))); vi.stubGlobal('fetch', fetcher);
  const input = { actor: { ...actor, userId: 'bob' }, requestId: 'same-retry' };
  for (let retry = 0; retry < 2; retry++) await api.runHostedAction('app', 'save', input, undefined, 'zipp-web;r1', actor);
  const options = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(options).toHaveLength(2);
  for (const [, value] of options) {
    const headers = value.headers as Record<string, string>;
    expect(JSON.parse(headers['X-FormLogic-Hosted-Actor'])).toEqual(actor);
    expect(headers['X-FormLogic-Client-Engine']).toBe('zipp-web;r1'); expect(JSON.parse(value.body as string)).toEqual(input);
  }
});
it('missing initiating actor fails before any transport', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect((await api.runHostedAction('app', 'save', { actor })).code).toBe('actor_context_required'); expect(fetcher).not.toHaveBeenCalled();
});
it('preserves trusted error actor outside the failure message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: true, message: 'Denied', code: 'actor_changed', actor }), { status: 409 })));
  expect(await api.runHostedAction('app', 'save', {}, undefined, undefined, actor)).toEqual({ error: 'Denied', status: 409, code: 'actor_changed', actor });
});
