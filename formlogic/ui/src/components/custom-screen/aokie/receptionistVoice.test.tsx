import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_BUNDLE_DIR,
  FALLBACK_POCKET_VOICES,
  VoiceEngineSection,
  bundleSelectionPatch,
  parseTtsVoiceCatalog,
  pocketVoiceOptions,
  prettifyBundleName,
  type EngineCfg,
  type TtsCatalogEngine,
} from './receptionistVoice';

// Engine-first voice selection for the Receptionist Settings console: the
// pickers render from the plugin's settings.get `ttsVoiceCatalog` side key
// when present, and degrade to the legacy hardcoded UI when absent (older
// plugins never return the key — AOKIE_PLUGIN_CONTRACT.md §2).

const CATALOG_RAW = {
  engines: [
    { id: 'pocket', label: 'Pocket-TTS', voices: ['jean', 'alba', 'marius', 'alba'] },
    {
      id: 'sherpa',
      label: 'Sherpa (Piper/VITS/Kokoro)',
      bundles: [
        {
          dir: 'C:\\Users\\Demo\\AppData\\Roaming\\com.aokie.app\\models\\tts\\vits-piper-en_GB-jenny_dioco-medium',
          name: 'vits-piper-en_GB-jenny_dioco-medium',
          kind: 'vits',
        },
        {
          dir: 'C:\\Users\\Demo\\AppData\\Roaming\\com.aokie.app\\models\\tts\\kokoro-en-v0_19',
          name: 'kokoro-en-v0_19',
          kind: 'kokoro',
        },
      ],
      scanRoot: 'C:\\Users\\Demo\\AppData\\Roaming\\com.aokie.app\\models\\tts',
    },
  ],
};

const catalog = parseTtsVoiceCatalog(CATALOG_RAW) as TtsCatalogEngine[];

function cfg(patch: Partial<EngineCfg> = {}): EngineCfg {
  return { loaded: true, engine: '', modelDir: '', customDir: false, ...patch };
}

function render(props: Partial<Parameters<typeof VoiceEngineSection>[0]> = {}): string {
  return renderToStaticMarkup(
    <VoiceEngineSection
      engineCfg={cfg()}
      onEngineCfg={vi.fn()}
      voice=""
      onVoice={vi.fn()}
      catalog={catalog}
      canManageEngine
      savingEngine={false}
      onSaveEngine={vi.fn()}
      {...props}
    />,
  );
}

describe('prettifyBundleName', () => {
  it('turns piper bundle folder names into a human voice label', () => {
    expect(prettifyBundleName('vits-piper-en_GB-jenny_dioco-medium')).toBe('Jenny Dioco (en_GB, medium)');
    expect(prettifyBundleName('vits-piper-en_US-lessac-medium')).toBe('Lessac (en_US, medium)');
    expect(prettifyBundleName('vits-piper-en_US-lessac-high')).toBe('Lessac (en_US, high)');
  });

  it('leaves names that do not follow the piper convention recognizable', () => {
    // kokoro-en-v0_19: no quality suffix — voice tokens survive.
    expect(prettifyBundleName('kokoro-en-v0_19')).toBe('V0 19 (en)');
    // Totally free-form names come back unchanged.
    expect(prettifyBundleName('myvoice')).toBe('Myvoice');
    expect(prettifyBundleName('vits')).toBe('vits');
  });
});

describe('parseTtsVoiceCatalog', () => {
  it('parses a well-formed catalog (voices, bundles, kinds, scanRoot)', () => {
    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({ id: 'pocket', voices: ['jean', 'alba', 'marius', 'alba'] });
    expect(catalog[1].bundles).toHaveLength(2);
    expect(catalog[1].bundles?.[1]).toMatchObject({ name: 'kokoro-en-v0_19', kind: 'kokoro' });
    expect(catalog[1].scanRoot).toContain('models\\tts');
  });

  it('degrades gracefully: absent or malformed catalogs are null', () => {
    expect(parseTtsVoiceCatalog(undefined)).toBeNull();
    expect(parseTtsVoiceCatalog(null)).toBeNull();
    expect(parseTtsVoiceCatalog('nope')).toBeNull();
    expect(parseTtsVoiceCatalog({})).toBeNull();
    expect(parseTtsVoiceCatalog({ engines: 'nope' })).toBeNull();
    expect(parseTtsVoiceCatalog({ engines: [] })).toBeNull();
    expect(parseTtsVoiceCatalog({ engines: [{ label: 'no id' }] })).toBeNull();
    // Junk bundles are dropped, the engine survives.
    const partial = parseTtsVoiceCatalog({
      engines: [{ id: 'sherpa', bundles: [{ name: 'no-dir' }, { dir: 'D:/v', name: 'v', kind: 'vits' }] }],
    });
    expect(partial?.[0].bundles).toEqual([{ dir: 'D:/v', name: 'v', kind: 'vits' }]);
  });
});

describe('pocketVoiceOptions', () => {
  it('renders the catalog pocket voices sorted and deduped with a Default entry', () => {
    expect(pocketVoiceOptions(catalog)).toEqual(['', 'alba', 'jean', 'marius']);
  });

  it('falls back to the legacy hardcoded list when the catalog is absent', () => {
    expect(pocketVoiceOptions(null)).toEqual(FALLBACK_POCKET_VOICES);
    expect(pocketVoiceOptions([{ id: 'sherpa', label: 'Sherpa' }])).toEqual(FALLBACK_POCKET_VOICES);
  });
});

describe('bundleSelectionPatch (sherpa bundle picker → ttsModelDir)', () => {
  it('a bundle pick writes ttsModelDir directly', () => {
    const dir = catalog[1].bundles![0].dir;
    expect(bundleSelectionPatch(dir)).toEqual({ modelDir: dir, customDir: false });
  });

  it('Automatic clears ttsModelDir; Custom only reveals the folder input', () => {
    expect(bundleSelectionPatch('')).toEqual({ modelDir: '', customDir: false });
    expect(bundleSelectionPatch(CUSTOM_BUNDLE_DIR)).toEqual({ customDir: true });
  });
});

describe('VoiceEngineSection', () => {
  it('pocket engine: voice select is catalog-driven (sorted, Default first)', () => {
    const html = render();
    // Engine select leads the card.
    expect(html.indexOf('rs-ttsengine')).toBeGreaterThan(-1);
    expect(html.indexOf('rs-ttsengine')).toBeLessThan(html.indexOf('rs-voice'));
    expect(html).toContain('Pocket-TTS (default)');
    expect(html).toContain('Sherpa — Piper/VITS voices (fast)');
    // Catalog voices — not the legacy 8 (cosette is NOT installed here).
    expect(html).toContain('>Alba<');
    expect(html).toContain('>Jean<');
    expect(html).toContain('>Marius<');
    expect(html).not.toContain('Cosette');
    // No sherpa controls while pocket is selected.
    expect(html).not.toContain('rs-ttsbundle');
    expect(html).not.toContain('rs-ttsmodeldir');
  });

  it('sherpa engine: the primary picker is the voice BUNDLE, the pocket voice select is hidden', () => {
    const jenny = catalog[1].bundles![0];
    const html = render({ engineCfg: cfg({ engine: 'sherpa', modelDir: jenny.dir }) });
    expect(html).toContain('rs-ttsbundle');
    expect(html).toContain('Automatic (first installed voice)');
    expect(html).toContain('Jenny Dioco (en_GB, medium)');
    expect(html).toContain('Custom folder…');
    // vits bundle = single voice: no pocket voice select, no speaker id.
    expect(html).not.toContain('rs-voice');
    expect(html).not.toContain('rs-kokoro-speaker');
    // Matching a catalog bundle keeps the free-text folder input hidden.
    expect(html).not.toContain('rs-ttsmodeldir');
  });

  it('sherpa + kokoro bundle: a numeric Speaker id input rides the record voice', () => {
    const kokoro = catalog[1].bundles![1];
    const html = render({ engineCfg: cfg({ engine: 'sherpa', modelDir: kokoro.dir }), voice: '3' });
    expect(html).toContain('rs-kokoro-speaker');
    expect(html).toContain('Speaker id');
    // The input is bound to the record draft's voice field.
    expect(html).toMatch(/id="rs-kokoro-speaker"[^>]*value="3"/);
    expect(html).not.toContain('rs-voice');
  });

  it('sherpa + a stored folder OUTSIDE the catalog renders as Custom with the input pre-filled', () => {
    const html = render({
      engineCfg: cfg({ engine: 'sherpa', modelDir: 'E:\\models\\piper\\vits-piper-en_GB-jenny_dioco-medium' }),
    });
    expect(html).toContain('rs-ttsbundle');
    expect(html).toContain('rs-ttsmodeldir');
    expect(html).toContain('E:\\models\\piper\\vits-piper-en_GB-jenny_dioco-medium');
  });

  it('no catalog: engine options fall back to the two hardcoded engines and the legacy voice list', () => {
    const html = render({ catalog: null });
    expect(html).toContain('Pocket-TTS (default)');
    expect(html).toContain('Sherpa — Piper/VITS voices (fast)');
    // Legacy hardcoded pocket voices.
    expect(html).toContain('>Cosette<');
    expect(html).toContain('>Eponine<');
  });

  it('no catalog + sherpa: degrades to the free-text voice model folder input', () => {
    const html = render({ catalog: null, engineCfg: cfg({ engine: 'sherpa', modelDir: 'E:\\models\\piper\\jenny' }) });
    expect(html).not.toContain('rs-ttsbundle');
    expect(html).toContain('rs-ttsmodeldir');
    expect(html).toContain('E:\\models\\piper\\jenny');
  });

  it('without settings.set permission the engine controls hide but the voice select stays', () => {
    const html = render({ canManageEngine: false });
    expect(html).not.toContain('rs-ttsengine');
    expect(html).not.toContain('Save speech engine');
    expect(html).toContain('rs-voice');
  });
});
