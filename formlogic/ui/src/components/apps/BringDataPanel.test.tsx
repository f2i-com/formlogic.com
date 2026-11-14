// @vitest-environment jsdom
/**
 * Bringing an app's data with its old host's key file: the file is offered for the app's sign-in
 * codes only when it holds what the plugin that sends them here takes from such a file (wherever
 * that plugin says it is kept), and only then, and only if the owner leaves it ticked, does the
 * import ask the server to use it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSignInCodes } from '../../lib/api';

const mocks = vi.hoisted(() => ({ getAppSignInCodes: vi.fn(), importNativeData: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
const { BringDataPanel } = await import('./BringDataPanel');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const codes: AppSignInCodes = {
  provider: 'example-sms', asked: true, plugin: { id: 'example.codes', name: 'Example codes', label: 'By text', enabled: true },
  fields: [
    { key: 'account', label: 'Account SID', help: '', type: 'text' },
    { key: 'channel', label: 'Channel', help: '', type: 'choice', options: [{ value: 'sms', label: 'Text' }], default: 'sms' },
    { key: 'token', label: 'Auth token', help: '', type: 'secret', sendTo: ['api.sms.example'] },
  ],
  values: {}, kept: {}, imports: { account: 'sms.ACCOUNT', token: 'sms.TOKEN' }, configured: false,
};
const keyFile = (extra: Record<string, unknown>) => new File([JSON.stringify({ keyHex: 'a'.repeat(64), cryptoDomains: { hmac: 'h', seal: 's' }, ...extra })], 'config.json', { type: 'application/json' });

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

async function choose(label: string, file: File) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => {});
}
const offer = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);

async function bring() {
  await act(async () => button('Bring this data')!.click());
  await act(async () => button('Replace its data')!.click());
}

describe('BringDataPanel', () => {
  it('offers a key file\'s sign-in details only where the plugin sending the codes takes them from', async () => {
    mocks.getAppSignInCodes.mockResolvedValue({ data: codes });
    mocks.importNativeData.mockResolvedValue({ data: { keyImported: true, verificationFound: true, verification: null } });
    const onImported = vi.fn();
    await act(async () => root.render(<BringDataPanel appId="app-1" onImported={onImported} />));
    await choose('Choose the app database', new File(['SQLite format 3'], 'application.sqlite'));
    const config = keyFile({ sms: { ACCOUNT: 'AC1234', TOKEN: 'tok' } });
    await choose('Choose the key file', config);
    expect(container.textContent).toContain('It also holds the details Example codes sends this app\'s sign-in codes with (Account SID and Auth token): use them.');
    expect(offer()!.checked).toBe(true);
    await bring();
    expect(mocks.importNativeData).toHaveBeenCalledWith('app-1', expect.any(File), config, true);
    expect(onImported).toHaveBeenCalled();
  });

  it('offers nothing for a file without them, or an app no plugin here sends codes for', async () => {
    mocks.importNativeData.mockResolvedValue({ data: { keyImported: true, verificationFound: false, verification: null } });
    await act(async () => root.render(<BringDataPanel appId="app-1" onImported={vi.fn()} />));
    await choose('Choose the app database', new File(['SQLite format 3'], 'application.sqlite'));
    mocks.getAppSignInCodes.mockResolvedValue({ data: codes });
    await choose('Choose the key file', keyFile({ sms: { ACCOUNT: 'AC1234' } }));
    expect(offer()).toBeNull();
    mocks.getAppSignInCodes.mockResolvedValue({ data: { ...codes, plugin: null, imports: {} } });
    const config = keyFile({ sms: { ACCOUNT: 'AC1234', TOKEN: 'tok' } });
    await choose('Choose the key file', config);
    expect(offer()).toBeNull();
    await bring();
    expect(mocks.importNativeData).toHaveBeenCalledWith('app-1', expect.any(File), config, false);
  });

  it('leaves them out when the owner says so', async () => {
    mocks.getAppSignInCodes.mockResolvedValue({ data: codes });
    mocks.importNativeData.mockResolvedValue({ data: { keyImported: true, verificationFound: true, verification: null } });
    await act(async () => root.render(<BringDataPanel appId="app-1" onImported={vi.fn()} />));
    await choose('Choose the app database', new File(['SQLite format 3'], 'application.sqlite'));
    await choose('Choose the key file', keyFile({ sms: { ACCOUNT: 'AC1234', TOKEN: 'tok' } }));
    await act(async () => offer()!.click());
    await bring();
    expect(mocks.importNativeData.mock.calls[0][3]).toBe(false);
  });
});
