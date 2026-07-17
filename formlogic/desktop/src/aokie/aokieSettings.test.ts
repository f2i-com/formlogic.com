import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_GATEWAY_BASE,
  CUSTOM_BUNDLE_DIR,
  FALLBACK_POCKET_VOICES,
  LANE_PATHS,
  bundleSelectionUpdate,
  composeLaneUrl,
  inferLaneSource,
  parseTtsVoiceCatalog,
  pocketVoiceOptions,
  prettifyBundleName,
  withAokieDefaults,
  type AokieLaneSource,
  type TtsCatalogEngine,
} from './aokieSettings.ts';

// CON-301 desktop side: the Configure-receptionist source dropdowns compose
// the plugin's saved endpoint URLs (composeLaneUrl) and seed the selects from
// them (inferLaneSource). The rules mirror the console's laneUrl
// (formlogic/ui receptionistPayload.ts) with providerOk = the LLM lane only.

const SOURCES: AokieLaneSource[] = [
  { id: 'service:llama-cpp', kind: 'service', status: 'running', url: 'http://127.0.0.1:8080' },
  { id: 'service:aokie-stt', kind: 'service', status: 'running', url: 'http://127.0.0.1:17921' },
  { id: 'service:aokie-tts', kind: 'service', status: 'stopped', url: 'http://127.0.0.1:17922' },
  { id: 'provider:my-openai', kind: 'provider' },
];

test('blank and custom sources pass the custom URL through (trimmed)', () => {
  assert.equal(composeLaneUrl('', '  http://x/v1/chat/completions ', 'llm', SOURCES),
    'http://x/v1/chat/completions');
  assert.equal(composeLaneUrl('custom', 'http://y', 'stt', SOURCES), 'http://y');
  assert.equal(composeLaneUrl('', '', 'tts', SOURCES), '');
  // Unknown source shapes degrade to the custom URL (parity with laneUrl).
  assert.equal(composeLaneUrl('weird:thing', 'http://z', 'llm', SOURCES), 'http://z');
});

test('a RUNNING service composes its url + the lane path', () => {
  assert.equal(
    composeLaneUrl('service:llama-cpp', '', 'llm', SOURCES),
    'http://127.0.0.1:8080/v1/chat/completions',
  );
  assert.equal(
    composeLaneUrl('service:aokie-stt', 'ignored', 'stt', SOURCES),
    'http://127.0.0.1:17921/v1/audio/transcriptions',
  );
});

test('a stopped or unknown service composes "" (plugin built-in default)', () => {
  assert.equal(composeLaneUrl('service:aokie-tts', 'http://custom', 'tts', SOURCES), '');
  assert.equal(composeLaneUrl('service:vanished', 'http://custom', 'llm', SOURCES), '');
  assert.equal(composeLaneUrl('service:llama-cpp', '', 'llm', []), '');
});

test('provider picks compose the gateway URL on the LLM lane only', () => {
  assert.equal(
    composeLaneUrl('provider:my-openai', '', 'llm', SOURCES),
    `${AI_GATEWAY_BASE}my-openai/v1/chat/completions`,
  );
  // Gateway has no audio routes yet — speech lanes resolve to plugin default.
  assert.equal(composeLaneUrl('provider:my-openai', 'http://c', 'stt', SOURCES), '');
  assert.equal(composeLaneUrl('provider:my-openai', 'http://c', 'tts', SOURCES), '');
  // Provider ids are URL-encoded into the path segment.
  assert.equal(
    composeLaneUrl('provider:a b/c', '', 'llm', SOURCES),
    `${AI_GATEWAY_BASE}a%20b%2Fc/v1/chat/completions`,
  );
});

test('inferLaneSource: blank → automatic, service url+path → the service id', () => {
  assert.equal(inferLaneSource('', 'llm', SOURCES), '');
  assert.equal(inferLaneSource('   ', 'llm', SOURCES), '');
  assert.equal(
    inferLaneSource('http://127.0.0.1:8080/v1/chat/completions', 'llm', SOURCES),
    'service:llama-cpp',
  );
  // Status is ignored when seeding — a stopped service's saved URL still
  // selects that service rather than degrading to custom.
  assert.equal(
    inferLaneSource('http://127.0.0.1:17922/v1/audio/speech', 'tts', SOURCES),
    'service:aokie-tts',
  );
});

test('inferLaneSource: gateway prefix → provider id; anything else → custom', () => {
  assert.equal(
    inferLaneSource(`${AI_GATEWAY_BASE}my-openai/v1/chat/completions`, 'llm', SOURCES),
    'provider:my-openai',
  );
  assert.equal(
    inferLaneSource(`${AI_GATEWAY_BASE}a%20b%2Fc/v1/chat/completions`, 'llm', SOURCES),
    'provider:a b/c',
  );
  assert.equal(inferLaneSource('http://elsewhere:9000/v1/chat/completions', 'llm', SOURCES), 'custom');
  // A service URL with the WRONG lane path is a custom URL, not that service.
  assert.equal(inferLaneSource('http://127.0.0.1:8080/v1/audio/speech', 'llm', SOURCES), 'custom');
});

test('compose → infer round-trips every representable pick', () => {
  const cases: Array<{ source: string; lane: 'llm' | 'stt' | 'tts' }> = [
    { source: 'service:llama-cpp', lane: 'llm' },
    { source: 'service:aokie-stt', lane: 'stt' },
    { source: 'provider:my-openai', lane: 'llm' },
  ];
  for (const { source, lane } of cases) {
    const url = composeLaneUrl(source, '', lane, SOURCES);
    assert.notEqual(url, '');
    assert.equal(inferLaneSource(url, lane, SOURCES), source, `${lane} ${source}`);
  }
  // Custom URLs round-trip through the custom pick.
  const url = composeLaneUrl('custom', 'http://box:1234/v1/chat/completions', 'llm', SOURCES);
  assert.equal(inferLaneSource(url, 'llm', SOURCES), 'custom');
});

test('LANE_PATHS carries the three conventional OpenAI-compatible paths', () => {
  assert.deepEqual(LANE_PATHS, {
    llm: '/v1/chat/completions',
    stt: '/v1/audio/transcriptions',
    tts: '/v1/audio/speech',
  });
});

// ----- engine-aware voice picker (mirrors ui receptionistVoice.tsx — that
// file's vitest suite imports this module and asserts behavioral parity) -----

const CATALOG_RAW = {
  engines: [
    { id: 'pocket', label: 'Pocket-TTS', voices: ['jean', 'alba', 'marius', 'alba'] },
    {
      id: 'sherpa',
      label: 'Sherpa (Piper/VITS/Kokoro)',
      bundles: [
        { dir: 'C:\\models\\tts\\vits-piper-en_GB-jenny_dioco-medium', name: 'vits-piper-en_GB-jenny_dioco-medium', kind: 'vits' },
        { dir: 'C:\\models\\tts\\kokoro-en-v0_19', name: 'kokoro-en-v0_19', kind: 'kokoro' },
      ],
      scanRoot: 'C:\\models\\tts',
    },
  ],
};

test('withAokieDefaults carries ttsEngine/ttsModelDir (defaults blank, tolerant of junk)', () => {
  const d = withAokieDefaults({});
  assert.equal(d.ttsEngine, '');
  assert.equal(d.ttsModelDir, '');
  const s = withAokieDefaults({ ttsEngine: 'sherpa', ttsModelDir: 'E:\\models\\piper\\lessac' });
  assert.equal(s.ttsEngine, 'sherpa');
  assert.equal(s.ttsModelDir, 'E:\\models\\piper\\lessac');
  const junk = withAokieDefaults({ ttsEngine: 7, ttsModelDir: null });
  assert.equal(junk.ttsEngine, '');
  assert.equal(junk.ttsModelDir, '');
});

test('parseTtsVoiceCatalog parses a well-formed catalog and rejects malformed ones', () => {
  const catalog = parseTtsVoiceCatalog(CATALOG_RAW);
  assert.ok(catalog);
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0].voices, ['jean', 'alba', 'marius', 'alba']);
  assert.equal(catalog[1].bundles?.[1].kind, 'kokoro');
  assert.equal(catalog[1].scanRoot, 'C:\\models\\tts');
  for (const bad of [undefined, null, 'nope', {}, { engines: 'nope' }, { engines: [] }, { engines: [{ label: 'no id' }] }]) {
    assert.equal(parseTtsVoiceCatalog(bad), null);
  }
  // Junk bundles are dropped, the engine survives.
  const partial = parseTtsVoiceCatalog({
    engines: [{ id: 'sherpa', bundles: [{ name: 'no-dir' }, { dir: 'D:/v', name: 'v', kind: 'vits' }] }],
  });
  assert.deepEqual(partial?.[0].bundles, [{ dir: 'D:/v', name: 'v', kind: 'vits' }]);
});

test('pocketVoiceOptions: catalog voices sorted/deduped with Default; legacy list without a catalog', () => {
  const catalog = parseTtsVoiceCatalog(CATALOG_RAW) as TtsCatalogEngine[];
  assert.deepEqual(pocketVoiceOptions(catalog), ['', 'alba', 'jean', 'marius']);
  assert.deepEqual(pocketVoiceOptions(null), FALLBACK_POCKET_VOICES);
  assert.deepEqual(pocketVoiceOptions([{ id: 'sherpa', label: 'Sherpa' }]), FALLBACK_POCKET_VOICES);
});

test('prettifyBundleName humanizes piper bundle folder names', () => {
  assert.equal(prettifyBundleName('vits-piper-en_GB-jenny_dioco-medium'), 'Jenny Dioco (en_GB, medium)');
  assert.equal(prettifyBundleName('vits-piper-en_US-lessac-medium'), 'Lessac (en_US, medium)');
  assert.equal(prettifyBundleName('kokoro-en-v0_19'), 'V0 19 (en)');
  assert.equal(prettifyBundleName('myvoice'), 'Myvoice');
  assert.equal(prettifyBundleName('vits'), 'vits');
});

test('bundleSelectionUpdate: pick writes modelDir + voice=bundle NAME; Automatic clears; Custom only reveals', () => {
  const catalog = parseTtsVoiceCatalog(CATALOG_RAW) as TtsCatalogEngine[];
  const bundles = catalog[1].bundles!;
  assert.deepEqual(bundleSelectionUpdate(bundles[0].dir, bundles), {
    engine: { modelDir: bundles[0].dir, customDir: false },
    voice: 'vits-piper-en_GB-jenny_dioco-medium',
  });
  // A dir outside the catalog falls back to its basename as the voice.
  assert.deepEqual(bundleSelectionUpdate('E:\\models\\piper\\vits-piper-en_US-lessac-medium', bundles), {
    engine: { modelDir: 'E:\\models\\piper\\vits-piper-en_US-lessac-medium', customDir: false },
    voice: 'vits-piper-en_US-lessac-medium',
  });
  assert.deepEqual(bundleSelectionUpdate('', bundles), {
    engine: { modelDir: '', customDir: false },
    voice: '',
  });
  assert.deepEqual(bundleSelectionUpdate(CUSTOM_BUNDLE_DIR, bundles), { engine: { customDir: true } });
});
