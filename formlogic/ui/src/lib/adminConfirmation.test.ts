// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAdminConfirmationForTests, adminConfirmationHeaders, askForAdminConfirmation, rememberAdminConfirmation, setAdminConfirmationPrompt } from './adminConfirmation';
import { api } from './api';

const refused = () => new Response(JSON.stringify({ error: true, code: 'admin_confirmation_required', message: 'Confirm your password to continue' }), { status: 403 });
const ok = () => new Response(JSON.stringify({ success: true, payments: [] }), { status: 200 });

beforeEach(() => __resetAdminConfirmationForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('holding a confirmation', () => {
  it('sends it until it lapses', () => {
    vi.useFakeTimers();
    expect(adminConfirmationHeaders()).toEqual({});
    rememberAdminConfirmation('proof', 900);
    expect(adminConfirmationHeaders()).toEqual({ 'X-Admin-Confirmation': 'proof' });
    vi.advanceTimersByTime(900_000);
    expect(adminConfirmationHeaders()).toEqual({});
  });

  it('asks once for requests refused together', async () => {
    let answer: (confirmed: boolean) => void = () => {};
    const prompt = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    setAdminConfirmationPrompt(prompt);
    const asks = [askForAdminConfirmation(), askForAdminConfirmation()];
    answer(true);
    await expect(Promise.all(asks)).resolves.toEqual([true, true]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('is a no when nothing can ask', async () => {
    await expect(askForAdminConfirmation()).resolves.toBe(false);
  });
});

describe('a refused request', () => {
  it('asks, then goes again with the proof', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refused()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    setAdminConfirmationPrompt(async () => {
      rememberAdminConfirmation('proof', 900);
      return true;
    });
    const result = await api.adminResetPassword('user-1');
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('X-Admin-Confirmation')).toBe('proof');
  });

  it('reports the refusal when the administrator cancels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(refused());
    vi.stubGlobal('fetch', fetchMock);
    setAdminConfirmationPrompt(async () => false);
    const result = await api.adminResetPassword('user-1');
    expect(result.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks only once, however the second try goes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => refused());
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn(async () => true);
    setAdminConfirmationPrompt(prompt);
    await api.adminResetPassword('user-1');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never sends the proof anywhere but the admin routes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    rememberAdminConfirmation('proof', 900);
    await api.getSupportAccess();
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Admin-Confirmation')).toBeNull();
  });
});
