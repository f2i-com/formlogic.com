// @vitest-environment jsdom
/**
 * Admin → Plugins says in words what installing a plugin grants it, before anything is installed:
 * the sign-in codes it would send, the hosts this site would reach for it (and, on an update, the
 * ones it adds), and what it would ask each app's owner for, a secret said to be one. An installed
 * plugin lists the same under it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailablePlugin, InstalledPlugin } from '../../types/app';

const mocks = vi.hoisted(() => ({ adminGetPlugins: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./AdminCameraCheckCard', () => ({ AdminCameraCheckCard: () => null }));
const { AdminPluginsCard } = await import('./AdminPluginsCard');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const granted = {
  network: ['verify.twilio.com'],
  signInCodes: { provider: 'twilio-verify', label: 'By text message, through Twilio Verify' },
  appSettings: [
    { key: 'accountSid', label: 'Account SID', type: 'text' as const, importFrom: 'sms.TWILIO_SID' },
    { key: 'serviceSid', label: 'Verify service SID', type: 'text' as const },
    { key: 'authToken', label: 'Auth token', type: 'secret' as const, sendTo: ['verify.twilio.com'], importFrom: 'sms.TWILIO_TOKEN' },
  ],
};
const available: AvailablePlugin = {
  id: 'formlogic.twilio-verify', name: 'Sign-in codes by text (Twilio Verify)', description: 'Sends sign-in codes.',
  version: '1.0.0', passes: [], uses: [], settings: [], sandbox: [], networkAdded: [], ...granted,
};
const installed: InstalledPlugin = {
  id: 'p1', manifestId: 'example.codes', scope: 'site', source: 'upload', appId: 'a1', name: 'Example codes', version: '1.0.0', enabled: true,
  grants: [], uses: [], settingsSchema: [], settings: {}, installedAt: '2026-11-14 00:00:00', network: ['api.sms.example'], signInCodes: null, appSettings: [],
  update: { version: '1.1.0', passes: [], uses: [], settings: [], sandbox: [], network: ['api.sms.example', 'api2.sms.example'], networkAdded: ['api2.sms.example'], signInCodes: null, appSettings: [] },
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('AdminPluginsCard', () => {
  it('says what a plugin that ships would be granted before it is installed', async () => {
    mocks.adminGetPlugins.mockResolvedValue({ data: { installed: [installed], available: [available], sandbox: {} } });
    await act(async () => root.render(<AdminPluginsCard />));
    await act(async () => {});
    const text = container.textContent ?? '';
    expect(text).toContain('Send the sign-in codes of apps that ask for “twilio-verify” (By text message, through Twilio Verify)');
    expect(text).toContain('Reach verify.twilio.com over HTTPS, through this site');
    expect(text).toContain('Ask each app\'s owner for: Account SID, Verify service SID and Auth token.');
    expect(text).toContain('Auth token: a secret, sent only to verify.twilio.com. Kept on this site and filled in by the site itself, never given to its code.');
    expect(text).toContain('Take from the key file of an app\'s earlier SoftN host, when its owner brings the app\'s data and says so: Account SID (sms.TWILIO_SID) and Auth token (sms.TWILIO_TOKEN). Nothing else of that file.');
    // An installed one lists the hosts it reaches, and an update says the ones it adds.
    expect(text).toContain('Reach api.sms.example over HTTPS');
    expect(text).toContain('New in this version: it would also reach api2.sms.example.');
  });
});
