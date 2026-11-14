import { describe, expect, it } from 'vitest';
import { holdsSignInSettings } from './signInCodes';

describe('holdsSignInSettings', () => {
  const imports = { account: 'sms.ACCOUNT', token: 'sms.TOKEN' };

  it('finds every setting the plugin takes, where it says', () => {
    expect(holdsSignInSettings({ keyHex: 'a', sms: { ACCOUNT: 'AC1234', TOKEN: 'tok', OTHER: 'x' } }, imports)).toBe(true);
  });

  it('wants every one of them, as text that is not empty', () => {
    expect(holdsSignInSettings({ sms: { ACCOUNT: 'AC1234', TOKEN: '' } }, imports)).toBe(false);
    expect(holdsSignInSettings({ sms: { ACCOUNT: 'AC1234', TOKEN: 7 } }, imports)).toBe(false);
    expect(holdsSignInSettings({ sms: { ACCOUNT: 'AC1234' } }, imports)).toBe(false);
    expect(holdsSignInSettings({ sms: 'AC1234' }, imports)).toBe(false);
    expect(holdsSignInSettings({ sms: [{ ACCOUNT: 'x' }] }, { account: 'sms.0' })).toBe(false);
    expect(holdsSignInSettings(null, imports)).toBe(false);
  });

  it('holds nothing for a plugin that takes nothing from such a file', () => {
    expect(holdsSignInSettings({ sms: { ACCOUNT: 'AC1234' } }, {})).toBe(false);
  });
});
