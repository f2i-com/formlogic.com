// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// What StartupFailure sends while a migration runs past the 15 s a request waits for it.
const migrating = () => new Response(JSON.stringify({
  error: true,
  code: 'migration_in_progress',
  retryable: true,
  message: 'The site is finishing an update. Please try again in a moment.',
}), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } });
const answered = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('a page during a long migration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits and asks again, for as long as Retry-After says, and gets its answer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(migrating())
      .mockResolvedValueOnce(migrating())
      .mockResolvedValueOnce(answered({ user: { id: 'u1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = api.getMe();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect((await result).data).toEqual({ user: { id: 'u1' } });
  });

  it('leaves a write to the person: it says so once and sends nothing again', async () => {
    const fetchMock = vi.fn(async () => migrating());
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.updateProfile({ name: 'Ada' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 503, code: 'migration_in_progress', error: expect.stringContaining('finishing an update') });
  });

  it('gives up in the end, with what the server said', async () => {
    const fetchMock = vi.fn(async () => migrating());
    vi.stubGlobal('fetch', fetchMock);

    const result = api.getMe();
    await vi.advanceTimersByTimeAsync(31 * 5_000);

    expect(await result).toMatchObject({ status: 503, code: 'migration_in_progress' });
    expect(fetchMock).toHaveBeenCalledTimes(31);
  });

  it('does not wait for any other 503', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: true, code: 'database_unavailable', message: 'down' }), { status: 503, headers: { 'Retry-After': '30' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getMe();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.code).toBe('database_unavailable');
  });
});
