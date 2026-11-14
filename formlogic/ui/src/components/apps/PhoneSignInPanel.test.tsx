// @vitest-environment jsdom
/**
 * The owner's Phone sign-in codes panel: it says which plugin on this site sends the app's codes, or
 * that none does and whom to ask; it shows whatever settings that plugin asks for, a secret as a
 * password field that says it is kept (never its value); it sends a secret only when one is typed,
 * so an empty one keeps the one kept; and it says when the administrator has turned the plugin off.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSignInCodes } from '../../lib/api';

const mocks = vi.hoisted(() => ({ getAppSignInCodes: vi.fn(), saveAppSignInCodes: vi.fn(), clearAppSignInCodes: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const { PhoneSignInPanel } = await import('./PhoneSignInPanel');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const plugin = { id: 'formlogic.twilio-verify', name: 'Sign-in codes by text (Twilio Verify)', label: 'By text message, through Twilio Verify', enabled: true };
const fields: AppSignInCodes['fields'] = [
  { key: 'accountSid', label: 'Account SID', help: 'From the Twilio console.', type: 'text', placeholder: 'AC…' },
  { key: 'authToken', label: 'Auth token', help: '', type: 'secret', placeholder: 'From the Twilio console', sendTo: ['verify.twilio.com'] },
  { key: 'channel', label: 'Channel', help: '', type: 'choice', options: [{ value: 'sms', label: 'Text' }, { value: 'call', label: 'Call' }], default: 'sms' },
  { key: 'loud', label: 'Say it twice', help: '', type: 'boolean', default: false },
];
const state = (over: Partial<AppSignInCodes> = {}): AppSignInCodes => ({
  provider: 'twilio-verify', asked: true, plugin, fields, values: { accountSid: '', channel: 'sms', loud: false }, kept: { authToken: false }, imports: {}, configured: false, ...over,
});

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

async function mount(answer: AppSignInCodes) {
  mocks.getAppSignInCodes.mockResolvedValue({ data: answer });
  await act(async () => root.render(<PhoneSignInPanel appId="app-1" version={3} />));
  await act(async () => {});
}
const input = (label: string) => container.querySelector<HTMLInputElement>(`#signin-app-1-${label}`)!;
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PhoneSignInPanel', () => {
  it('offers to forget details kept for no plugin that sends the codes now', async () => {
    await mount(state({ plugin: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: true }));
    expect(container.textContent).toContain('still kept on this site, though nothing uses them now');
    mocks.clearAppSignInCodes.mockResolvedValue({ data: state({ plugin: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: false }) });
    await act(async () => button('Forget the kept details')!.click());
    expect(mocks.clearAppSignInCodes).toHaveBeenCalledWith('app-1');
    expect(button('Forget the kept details')).toBeUndefined();
    expect(container.textContent).not.toContain('still kept on this site');
  });

  it('says an app that names no provider now sends no codes, and tells the page once what was kept is forgotten', async () => {
    const onForgotten = vi.fn();
    mocks.getAppSignInCodes.mockResolvedValue({ data: state({ provider: null, plugin: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: true }) });
    await act(async () => root.render(<PhoneSignInPanel appId="app-1" version={3} onForgotten={onForgotten} />));
    await act(async () => {});
    expect(container.textContent).toContain('This app no longer signs people in with a code sent to their phone.');
    expect(container.textContent).not.toContain('through “”');
    mocks.clearAppSignInCodes.mockResolvedValue({ data: state({ provider: null, plugin: null, fields: [], values: {}, kept: {}, keptWithoutPlugin: false }) });
    await act(async () => button('Forget the kept details')!.click());
    expect(onForgotten).toHaveBeenCalledTimes(1);
  });

  it('says that no plugin here sends the codes the app asks for, and whom to ask', async () => {
    await mount(state({ plugin: null, fields: [], values: {}, kept: {} }));
    expect(button('Forget the kept details')).toBeUndefined();
    expect(container.textContent).toContain('no plugin here sends them for “twilio-verify”');
    expect(container.textContent).toContain('Admin → Platform → Plugins');
    expect(container.querySelector('input')).toBeNull();
  });

  it('shows the plugin that sends them and the settings it asks for, a secret as a password', async () => {
    await mount(state());
    expect(container.textContent).toContain('Sign-in codes by text (Twilio Verify)');
    expect(container.textContent).toContain('Off: visitors are told sign-in messaging is not set up yet.');
    expect(input('accountSid').placeholder).toBe('AC…');
    expect(input('authToken').type).toBe('password');
    expect(input('authToken').autocomplete).toBe('new-password');
    expect(container.textContent).toContain('Sent only to verify.twilio.com, by this site itself.');
    expect(container.querySelector<HTMLSelectElement>('#signin-app-1-channel')!.value).toBe('sms');
    expect(input('loud').type).toBe('checkbox');
    // Nothing to send until every required setting is there.
    expect(button('Save')!.disabled).toBe(true);
    await act(async () => type(input('accountSid'), 'AC-one'));
    expect(button('Save')!.disabled).toBe(true);
    await act(async () => type(input('authToken'), ' new-token '));
    expect(button('Save')!.disabled).toBe(false);

    mocks.saveAppSignInCodes.mockResolvedValue({ data: state({ values: { accountSid: 'AC-one', channel: 'sms', loud: false }, kept: { authToken: true }, configured: true }) });
    await act(async () => button('Save')!.click());
    expect(mocks.saveAppSignInCodes).toHaveBeenCalledWith('app-1', { accountSid: 'AC-one', authToken: 'new-token', channel: 'sms', loud: false });
    expect(container.textContent).toContain('On: codes are sent.');
    expect(input('authToken').value, 'a secret is never shown again').toBe('');
    expect(input('authToken').placeholder).toBe('Kept. Enter a new one to replace it.');
    expect(container.textContent).toContain('Kept');
  });

  it('keeps a kept secret when it is left empty', async () => {
    await mount(state({ values: { accountSid: 'AC-one', channel: 'call', loud: true }, kept: { authToken: true }, configured: true }));
    expect(button('Save')!.disabled).toBe(false);
    await act(async () => type(input('accountSid'), 'AC-two'));
    mocks.saveAppSignInCodes.mockResolvedValue({ data: state({ values: { accountSid: 'AC-two', channel: 'call', loud: true }, kept: { authToken: true }, configured: true }) });
    await act(async () => button('Save')!.click());
    expect(mocks.saveAppSignInCodes).toHaveBeenCalledWith('app-1', { accountSid: 'AC-two', channel: 'call', loud: true });

    mocks.clearAppSignInCodes.mockResolvedValue({ data: state() });
    await act(async () => button('Turn off')!.click());
    expect(mocks.clearAppSignInCodes).toHaveBeenCalledWith('app-1');
    expect(container.textContent).toContain('Off: visitors are told');
  });

  it('shows the plugin\'s own refusal, and says when the administrator has turned it off', async () => {
    await mount(state({ plugin: { ...plugin, enabled: false }, values: { accountSid: 'AC-one', channel: 'sms', loud: false }, kept: { authToken: true }, configured: true }));
    expect(container.textContent).toContain('The site\'s administrator has turned this plugin off.');
    expect(container.textContent).toContain('Off: visitors are told');
    mocks.saveAppSignInCodes.mockResolvedValue({ error: 'Enter the Twilio account SID: AC followed by 32 letters and digits, from the Twilio console.' });
    await act(async () => button('Save')!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Enter the Twilio account SID');
  });
});
