import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeEngineArgs,
  parseEngineArgs,
  STT_ENGINE_FLAGS,
  TTS_ENGINE_FLAGS,
} from './speechEngineArgs.ts';

test('parse: empty args → defaults, nothing lost', () => {
  const p = parseEngineArgs([], STT_ENGINE_FLAGS);
  assert.deepEqual(p, { engine: '', modelDir: '', rest: [] });
});

test('parse: extracts engine + model dir, preserves other tokens in order', () => {
  const p = parseEngineArgs(
    ['-t', '16', '--stt-engine', 'moonshine', '--parallel', '2', '--stt-model-dir', 'E:\\models\\stt'],
    STT_ENGINE_FLAGS,
  );
  assert.equal(p.engine, 'moonshine');
  assert.equal(p.modelDir, 'E:\\models\\stt');
  assert.deepEqual(p.rest, ['-t', '16', '--parallel', '2']);
});

test('parse: last duplicate wins; dangling flag is dropped', () => {
  const p = parseEngineArgs(
    ['--tts-engine', 'pocket', '--tts-engine', 'sherpa', '--tts-model-dir'],
    TTS_ENGINE_FLAGS,
  );
  assert.equal(p.engine, 'sherpa');
  assert.equal(p.modelDir, '', 'dangling flag reads as unset');
  assert.deepEqual(p.rest, []);
});

test('parse: stt flags never react to tts flags (and vice versa)', () => {
  const p = parseEngineArgs(['--tts-engine', 'sherpa'], STT_ENGINE_FLAGS);
  assert.equal(p.engine, '');
  assert.deepEqual(p.rest, ['--tts-engine', 'sherpa'], 'foreign flags are user tokens');
});

test('compose: writes engine + model dir, preserving user tokens', () => {
  const out = composeEngineArgs(['-t', '16'], STT_ENGINE_FLAGS, 'qwen3-asr', 'D:\\stt models');
  assert.deepEqual(out, ['-t', '16', '--stt-engine', 'qwen3-asr', '--stt-model-dir', 'D:\\stt models']);
});

test('compose: REPLACES existing pairs (no duplicate flags)', () => {
  const out = composeEngineArgs(
    ['--stt-engine', 'parakeet', '--verbose', '--stt-model-dir', 'C:\\old'],
    STT_ENGINE_FLAGS,
    'moonshine',
    '',
  );
  assert.deepEqual(out, ['--verbose', '--stt-engine', 'moonshine']);
});

test('compose: blank engine + blank dir removes the tokens entirely', () => {
  const out = composeEngineArgs(
    ['--tts-engine', 'sherpa', '--tts-model-dir', 'E:\\voices', '--foo', 'bar'],
    TTS_ENGINE_FLAGS,
    '',
    '',
  );
  assert.deepEqual(out, ['--foo', 'bar']);
});

test('compose: whitespace-only inputs count as blank', () => {
  const out = composeEngineArgs([], TTS_ENGINE_FLAGS, '  ', ' ');
  assert.deepEqual(out, []);
});

test('compose ∘ parse round-trips a selection', () => {
  const composed = composeEngineArgs(['-x'], TTS_ENGINE_FLAGS, 'sherpa', 'E:\\models\\piper');
  const p = parseEngineArgs(composed, TTS_ENGINE_FLAGS);
  assert.equal(p.engine, 'sherpa');
  assert.equal(p.modelDir, 'E:\\models\\piper');
  assert.deepEqual(p.rest, ['-x']);
});
