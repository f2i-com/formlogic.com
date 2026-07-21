import { afterEach, describe, expect, it } from 'vitest';
import {
  WEBSITE_AI_ROUTE_MATRIX,
  cacheAiPreferences,
  clearCachedAiPreferences,
  resolveDefaultAiSource,
  resolveWebsiteAiRoute,
  type WebsiteAiOperation,
} from './websiteAiRouting';
import type { AiPreferencesState } from './api';

const EXPECTED_OPERATIONS: WebsiteAiOperation[] = [
  'form.create.text',
  'form.edit.text',
  'form.create.photo',
  'form.create.document',
  'app.plan',
  'app.form.generate',
  'screen.generate',
  'script.generate',
  'script.improve',
];

function prefs(patch: Partial<AiPreferencesState>): AiPreferencesState {
  return {
    aiSource: 'site',
    desktopProviderId: null,
    desktopModel: null,
    customProviderId: null,
    chatToolMode: 'auto',
    ...patch,
  };
}

afterEach(() => clearCachedAiPreferences());

describe('website AI routing audit', () => {
  it('keeps the reviewed generation surface exhaustive and hosted-capable', () => {
    expect(Object.keys(WEBSITE_AI_ROUTE_MATRIX)).toEqual(EXPECTED_OPERATIONS);
    for (const operation of EXPECTED_OPERATIONS) {
      expect(resolveWebsiteAiRoute(operation, 'hosted')).toBe('hosted');
    }
  });

  it('routes only new text forms to a selected Desktop provider and never silently falls back', () => {
    expect(resolveWebsiteAiRoute('form.create.text', 'desktop-provider')).toBe('desktop-provider');
    for (const operation of EXPECTED_OPERATIONS.filter((item) => item !== 'form.create.text')) {
      expect(resolveWebsiteAiRoute(operation, 'desktop-provider')).toBe('unsupported');
    }
  });
});

describe('resolveDefaultAiSource', () => {
  it('fails closed when nothing was cached yet', () => {
    expect(resolveDefaultAiSource()).toEqual({ ok: false, reason: 'no_cached_preferences' });
  });

  it('treats a cleared cache as unresolved', () => {
    cacheAiPreferences(null);
    expect(resolveDefaultAiSource()).toEqual({ ok: false, reason: 'no_cached_preferences' });
  });

  it('resolves the hosted Site AI source without a provider', () => {
    cacheAiPreferences(prefs({ aiSource: 'site' }));
    expect(resolveDefaultAiSource()).toEqual({
      ok: true,
      source: { source: 'site', providerId: null, model: null },
    });
  });

  it('resolves the desktop source with its provider + model', () => {
    cacheAiPreferences(prefs({ aiSource: 'desktop', desktopProviderId: 'codex', desktopModel: 'gpt-5-codex' }));
    expect(resolveDefaultAiSource()).toEqual({
      ok: true,
      source: { source: 'desktop', providerId: 'codex', model: 'gpt-5-codex' },
    });
  });

  it('keeps a null desktop model (the provider default applies)', () => {
    cacheAiPreferences(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }));
    expect(resolveDefaultAiSource()).toEqual({
      ok: true,
      source: { source: 'desktop', providerId: 'codex', model: null },
    });
  });

  it('fails closed when the desktop source has no provider picked', () => {
    cacheAiPreferences(prefs({ aiSource: 'desktop' }));
    expect(resolveDefaultAiSource()).toEqual({ ok: false, reason: 'desktop_provider_missing' });
  });

  it('resolves the browser-local custom source with its provider', () => {
    cacheAiPreferences(prefs({ aiSource: 'custom', customProviderId: 'ai_123' }));
    expect(resolveDefaultAiSource()).toEqual({
      ok: true,
      source: { source: 'custom', providerId: 'ai_123', model: null },
    });
  });

  it('fails closed when the custom source has no provider picked', () => {
    cacheAiPreferences(prefs({ aiSource: 'custom' }));
    expect(resolveDefaultAiSource()).toEqual({ ok: false, reason: 'custom_provider_missing' });
  });
});
