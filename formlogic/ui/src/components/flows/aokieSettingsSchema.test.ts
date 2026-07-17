// Shared Aokie settings-schema conformance (audit AOK-CONFIG-002).
//
// docs/contracts/aokie-settings-schema.v1.json is the cross-repo settings
// contract (the plugin's SETTING_SPECS table is the authority, test-locked in
// the aokie repo). This side checks the Desktop GUI panel renders values the
// plugin will actually accept — the drift this catches is real: the panel
// offered hfpCodec 'auto' while an earlier validator only allowed cvsd|wbs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AOKIE_SETTINGS_DEFAULTS,
  DEFAULT_ENGINES,
  settingsPatch,
  withAokieDefaults,
} from '../../../../desktop/src/aokie/aokieSettings';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../../../docs/contracts/aokie-settings-schema.v1.json'), 'utf8')
) as {
  settingsSchemaVersion: number;
  settings: Array<{
    key: string;
    type: string;
    min?: number;
    max?: number;
    maxChars?: number;
    options?: string[];
    appliesLive: boolean;
  }>;
};

const panelSource = readFileSync(
  // The panel's pure settings logic (defaults, parsing, dirty-field patch)
  // was extracted from AokieCard.tsx for AOK-SAFE-001 so it is importable
  // and testable here.
  join(__dirname, '../../../../desktop/src/aokie/aokieSettings.ts'),
  'utf8'
);

const spec = (key: string) => fixture.settings.find((s) => s.key === key);

describe('aokie settings schema conformance', () => {
  it('fixture is v1 and covers the operational keys', () => {
    expect(fixture.settingsSchemaVersion).toBe(1);
    for (const key of ['autoAnswer', 'bargeSensitivity', 'sttEndpointMs', 'hfpCodec', 'persona', 'aiEndpoint']) {
      expect(spec(key), key).toBeTruthy();
    }
  });

  it('the Desktop panel offers only hfpCodec values the plugin accepts', () => {
    const union = panelSource.match(/hfpCodec:\s*((?:'[a-z]+'\s*\|\s*)+'[a-z]+')/);
    expect(union, 'AokieCard hfpCodec union type').toBeTruthy();
    const offered = [...union![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const allowed = spec('hfpCodec')?.options ?? [];
    for (const value of offered) {
      expect(allowed, `panel offers hfpCodec '${value}'`).toContain(value);
    }
  });

  it('the Desktop panel defaults sit inside the plugin bounds', () => {
    for (const key of ['sttEndpointMs', 'bargeSensitivity'] as const) {
      const def = AOKIE_SETTINGS_DEFAULTS[key];
      const s = spec(key)!;
      expect(def, `${key} default ${def} within [${s.min}, ${s.max}]`).toBeGreaterThanOrEqual(s.min!);
      expect(def).toBeLessThanOrEqual(s.max!);
    }
  });

  it('the engine-aware voice keys exist and the panel defaults are accepted values', () => {
    // The panel's engine select statically writes '' (pocket) and 'sherpa'
    // (catalog-reported ids come from the plugin itself); both plus 'pocket'
    // must be plugin-accepted enum values.
    const engine = spec('ttsEngine');
    expect(engine?.type).toBe('enum');
    for (const v of ['', 'pocket', 'sherpa']) expect(engine?.options).toContain(v);
    // Every fallback engine the panel can OFFER writes a plugin-accepted value
    // (the select stores '' for pocket, the raw id otherwise) — adding an
    // engine to DEFAULT_ENGINES without the plugin enum knowing it must fail.
    for (const e of DEFAULT_ENGINES) {
      const written = e.id === 'pocket' ? '' : e.id;
      expect(engine?.options, `DEFAULT_ENGINES offers '${e.id}'`).toContain(written);
    }
    expect(spec('ttsModelDir')?.type).toBe('string');
    expect(AOKIE_SETTINGS_DEFAULTS.ttsEngine).toBe('');
    expect(AOKIE_SETTINGS_DEFAULTS.ttsModelDir).toBe('');
  });
});

// AOK-SAFE-001 regressions: auto-answer can never default on, and an
// unrelated settings edit can never write it.
describe('aokie settings safety (AOK-SAFE-001)', () => {
  it('auto-answer defaults OFF; missing and malformed keys read as off', () => {
    expect(AOKIE_SETTINGS_DEFAULTS.autoAnswer).toBe(false);
    expect(withAokieDefaults(undefined).autoAnswer).toBe(false);
    expect(withAokieDefaults({}).autoAnswer).toBe(false);
    expect(withAokieDefaults({ autoAnswer: 'yes' }).autoAnswer).toBe(false);
    expect(withAokieDefaults({ autoAnswer: 1 }).autoAnswer).toBe(false);
    expect(withAokieDefaults({ autoAnswer: null }).autoAnswer).toBe(false);
  });

  it('legacy string booleans display the way the plugin treats them', () => {
    // The plugin arms on "true" (shipped settings.json files hold string
    // bools) — the panel must not show "off" for an effectively armed key.
    expect(withAokieDefaults({ autoAnswer: 'true' }).autoAnswer).toBe(true);
    expect(withAokieDefaults({ autoAnswer: 'false' }).autoAnswer).toBe(false);
    expect(withAokieDefaults({ autoAnswer: true }).autoAnswer).toBe(true);
  });

  it('saves patch only dirty fields — an unrelated edit never carries autoAnswer', () => {
    const baseline = withAokieDefaults({ autoAnswer: true, greeting: 'Hello' });
    const edited = { ...baseline, persona: 'Friendly booking assistant' };
    const patch = settingsPatch(baseline, edited);
    expect(patch).toEqual({ persona: 'Friendly booking assistant' });
    expect('autoAnswer' in patch).toBe(false);
  });

  it('an explicit auto-answer change is the only time the key is written', () => {
    const baseline = withAokieDefaults({});
    const armed = { ...baseline, autoAnswer: true };
    expect(settingsPatch(baseline, armed)).toEqual({ autoAnswer: true });
    expect(settingsPatch(baseline, { ...baseline })).toEqual({});
  });
});
