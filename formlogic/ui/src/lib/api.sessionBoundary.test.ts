// @vitest-environment jsdom
// Actual API methods with deferred HTTP replies; no network or authenticated fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { bumpSessionGeneration } from './sessionGeneration';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const signedIn = { user: { id: 'account-a', email: 'a@example.test' } };
const expired = vi.fn();

beforeEach(() => {
  bumpSessionGeneration();
  api.setAuthenticated(true);
  api.setAdminActing(null);
  api.setDemoMode(false);
  expired.mockClear();
  api.onSessionExpired(expired);
  localStorage.clear();
});
afterEach(() => {
  api.removeSessionExpiredCallback(expired);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = () => new File(['synthetic'], 'fixture.txt');
const requests: Array<[string, () => Promise<unknown>]> = [
  ['ordinary JSON request', () => api.getMfaStatus()],
  ['metadata request', () => api.submitEncryptedResponse('f1', { v: 1 } as never, 'key')],
  ['account data export', () => api.downloadMyData()],
  ['app responses export', () => api.exportAppResponses('app', 'f1', 'fixture')],
  ['account backup export', () => api.exportAccountBackup()],
  ['account backup import', () => api.importAccountBackup(file())],
  ['responses export', () => api.exportResponses('f1')],
  ['sqlite download', () => api.downloadSqlite('f1', 'fixture')],
  ['JSON download', () => api.downloadJson('f1', 'fixture')],
  ['deep health', () => api.getDeepHealth()],
  ['file generation', () => api.generateFormFromFile(file())],
  ['package description', () => api.describePackArchive(file())],
  ['package export', () => api.exportAppPackageArchive('app')],
  ['app data export', () => api.exportAppData('app', 'sqlite')],
  ['application package import', () => api.importApplicationPackage(file(), [])],
  ['pack upload', () => api.uploadPackZip(file())],
  ['form file upload', () => api.uploadFile('f1', file())],
  ['app file upload', () => api.uploadAppFile('app', 'f1', file())],
  ['CSV parse', () => api.parseImportCsv('f1', file())],
  ['CSV import', () => api.importCsv('f1', file(), {})],
  ['upgrade upload', () => api.adminUpgradeUpload(file())],
];

describe('an expired reply belongs to the generation that sent it', () => {
  it.each(requests)('%s: old A denial cannot expire B', async (_name, request) => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = request().catch(error => error);
    // Same boundary used when this tab changes account or accepts a cross-tab transition.
    bumpSessionGeneration();
    api.setAuthenticated(true);
    response.resolve(reply({ message: 'Session expired' }, 401));
    await pending;
    expect(api.isAuthenticated()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it.each(requests)('%s: current denial still expires the session', async (_name, request) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'Session expired' }, 401)));
    await request().catch(error => error);
    expect(api.isAuthenticated()).toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a non-JSON old 401 cannot expire B', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = api.getMfaStatus();
    bumpSessionGeneration();
    response.resolve(new Response('expired', { status: 401 }));
    expect((await pending).status).toBe(401);
    expect(api.isAuthenticated()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it('a boundary while JSON is being read also fences the denial', async () => {
    const body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: () => body.promise })));
    const pending = api.getMfaStatus();
    await Promise.resolve();
    bumpSessionGeneration();
    body.resolve({ message: 'Session expired' });
    await pending;
    expect(api.isAuthenticated()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });
});

const authRequests: Array<[string, () => Promise<{ data?: unknown; error?: string }>]> = [
  ['login', () => api.login('a@example.test', 'synthetic')],
  ['registration', () => api.register('a@example.test', 'synthetic')],
  ['MFA verification', () => api.verifyMfa('synthetic', '123456', false)],
  ['demo sign-in', () => api.startDemo()],
  ['session restoration', () => api.getMe()],
];

describe('auth continuations cannot adopt an abandoned reply', () => {
  it.each(authRequests)('%s success after logout stays signed out and returns no old user', async (_name, request) => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = request();
    bumpSessionGeneration();
    api.setAuthenticated(false);
    response.resolve(reply(signedIn));
    const result = await pending;
    expect(api.isAuthenticated()).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it.each(authRequests)('%s current success still authenticates', async (_name, request) => {
    api.setAuthenticated(false);
    vi.stubGlobal('fetch', vi.fn(async () => reply(signedIn)));
    const result = await request();
    expect(result.data).toEqual(signedIn);
    expect(api.isAuthenticated()).toBe(true);
  });

  it.each([
    ['logout', () => api.logout()],
    ['account deletion', () => api.deleteAccount('synthetic')],
    ['session restoration without a user', () => api.getMe()],
  ] as const)('%s cannot clear B after an old request resolves', async (_name, request) => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = request();
    bumpSessionGeneration();
    api.setAuthenticated(true);
    response.resolve(reply({ message: 'Done' }));
    const result = await pending;
    expect(api.isAuthenticated()).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('old restoration transport failure cannot clear B', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = api.getMe();
    bumpSessionGeneration();
    api.setAuthenticated(true);
    response.reject(new Error('Synthetic offline failure'));
    expect((await pending).error).toBeTruthy();
    expect(api.isAuthenticated()).toBe(true);
  });

  it('old MFA challenge is not offered to the next session', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = api.login('a@example.test', 'synthetic');
    bumpSessionGeneration();
    response.resolve(reply({ mfaRequired: true, mfaToken: 'abandoned' }));
    expect((await pending).data).toBeUndefined();
  });

  it('current logout still clears the auth hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'Signed out' })));
    expect((await api.logout()).error).toBeUndefined();
    expect(api.isAuthenticated()).toBe(false);
  });

  it('an application-owned successful response keeps its existing contract across a boundary', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const pending = api.runNativeRequest('public-app', { path: '/health' });
    bumpSessionGeneration();
    const result = { result: { status: 200, body: { ok: true } } };
    response.resolve(reply(result));
    expect((await pending).data).toEqual(result);
  });
});
