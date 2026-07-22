import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM_SETTINGS, normalizeFormSettings, type FormSettings } from './form';

// Regression: 246/247 stored forms lack a `notifications` key (and one had settings
// literally `[]`), so opening builder Settings → Notifications crashed dereferencing
// `editedSettings.notifications.emailNotifications`. The settings edit buffer is now
// seeded over the defaults.
describe('normalizeFormSettings', () => {
  it('fills in notifications when the stored settings lack the key', () => {
    const legacy = {
      presentationMode: 'both',
      showProgressBar: true,
      submitButtonText: 'Send',
    } as unknown as FormSettings;
    const seeded = normalizeFormSettings(legacy);
    expect(seeded.notifications.emailNotifications).toBe(false);
    expect(seeded.submitButtonText).toBe('Send');
    expect(seeded.isClosed).toBe(DEFAULT_FORM_SETTINGS.isClosed);
  });

  it('survives a non-object settings payload (stored `[]`)', () => {
    const seeded = normalizeFormSettings([] as unknown as FormSettings);
    expect(seeded).toEqual(DEFAULT_FORM_SETTINGS);
  });

  it('preserves stored notifications values', () => {
    const seeded = normalizeFormSettings({
      ...DEFAULT_FORM_SETTINGS,
      notifications: { emailNotifications: true, notificationEmail: 'ops@example.com' },
    });
    expect(seeded.notifications).toEqual({ emailNotifications: true, notificationEmail: 'ops@example.com' });
  });
});
