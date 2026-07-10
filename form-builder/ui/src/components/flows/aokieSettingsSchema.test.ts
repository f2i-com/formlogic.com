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
  join(__dirname, '../../../../desktop/src/PluginsPanel.tsx'),
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
    expect(union, 'PluginsPanel hfpCodec union type').toBeTruthy();
    const offered = [...union![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const allowed = spec('hfpCodec')?.options ?? [];
    for (const value of offered) {
      expect(allowed, `panel offers hfpCodec '${value}'`).toContain(value);
    }
  });

  it('the Desktop panel defaults sit inside the plugin bounds', () => {
    for (const key of ['sttEndpointMs', 'bargeSensitivity'] as const) {
      const m = panelSource.match(new RegExp(`${key}:\\s*(\\d+)`));
      expect(m, `PluginsPanel default for ${key}`).toBeTruthy();
      const def = Number(m![1]);
      const s = spec(key)!;
      expect(def, `${key} default ${def} within [${s.min}, ${s.max}]`).toBeGreaterThanOrEqual(s.min!);
      expect(def).toBeLessThanOrEqual(s.max!);
    }
  });
});
