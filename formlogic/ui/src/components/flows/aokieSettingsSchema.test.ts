// Shared Aokie settings-schema conformance (audit AOK-CONFIG-002).
//
// docs/contracts/aokie-settings-schema.v1.json is the cross-repo settings
// contract (the plugin's SETTING_SPECS table is the authority, test-locked in
// the aokie repo). This side checks that the settings UIs in THIS repo only
// write values the plugin will actually accept.
//
// SIBLING SURFACE NOTE: this suite used to also import the desktop's compiled
// Configure-receptionist panel (formlogic/desktop/src/aokie/aokieSettings.ts)
// and lock its defaults/enum offerings + AOK-SAFE-001 patch behaviors against
// the fixture. That compiled desktop UI is GONE — the Aokie plugin now ships
// its own desktop settings screen inside its pack (aokie repo,
// ui/receptionist/tabs/settings.js), so that surface's conformance is owned by
// the aokie repo's tests and maintained by convention. The web console's
// engine picker (src/data/packs/aokie-receptionist/receptionistVoice.tsx)
// lives HERE, so its offered engines stay fixture-locked below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINES } from '../../data/packs/aokie-receptionist/receptionistVoice';

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

const spec = (key: string) => fixture.settings.find((s) => s.key === key);

describe('aokie settings schema conformance', () => {
  it('fixture is v1 and covers the operational keys', () => {
    expect(fixture.settingsSchemaVersion).toBe(1);
    for (const key of ['autoAnswer', 'bargeSensitivity', 'sttEndpointMs', 'hfpCodec', 'persona', 'aiEndpoint']) {
      expect(spec(key), key).toBeTruthy();
    }
  });

  it('the engine-aware voice keys exist and the console offers accepted values', () => {
    // The console's engine select statically writes '' (pocket) and 'sherpa'
    // (catalog-reported ids come from the plugin itself); both plus 'pocket'
    // must be plugin-accepted enum values.
    const engine = spec('ttsEngine');
    expect(engine?.type).toBe('enum');
    for (const v of ['', 'pocket', 'sherpa']) expect(engine?.options).toContain(v);
    // Every fallback engine the console can OFFER writes a plugin-accepted
    // value (the select stores '' for pocket, the raw id otherwise) — adding
    // an engine to DEFAULT_ENGINES without the plugin enum knowing it must
    // fail this conformance check.
    for (const e of DEFAULT_ENGINES) {
      const written = e.id === 'pocket' ? '' : e.id;
      expect(engine?.options, `DEFAULT_ENGINES offers '${e.id}'`).toContain(written);
    }
    expect(spec('ttsModelDir')?.type).toBe('string');
  });
});
