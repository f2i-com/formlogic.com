// Behavioral + parity tests for the pack-owned Receptionist Settings TSX screen.
//
// Two layers:
//  1. PARITY (module imports): the screen folder's agentPayload.ts is a
//     SELF-CONTAINED copy of the canonical composeAgentPayload /
//     DEFAULT_PERSONA / AI_GATEWAY_BASE (the sandbox cannot import host
//     modules) — import BOTH sides as real modules and pin them: strict-equal
//     constants, deep-equal payloads across the source-pick / persona /
//     greeting matrix.
//  2. BEHAVIOR (compiled artifact): bundle the screen's `files` with the REAL
//     sandbox pipeline and drive the DOM in JSDOM against a mocked
//     window.FormLogic — locking the reviewed security invariants: manager-PIN
//     write-only (blank keeps / typed sends / explicit Remove PIN), partial
//     saves never clobbering the dirty baseline, the shared create-in-flight
//     guard, and the running-now strip.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_RECEPTIONIST_SETTINGS_SCREEN } from './receptionistSettingsScreen';
import {
  flushScreen as flush,
  runScreen,
  setupScreenTestEsbuild,
  teardownScreenTestEsbuild,
  type RunScreenResult,
} from '../../aokieScreenTestHarness';
import {
  AI_GATEWAY_BASE,
  buildAgentPayload,
  composeAgentPayload as canonicalCompose,
  EMPTY_DRAFT,
  type Draft,
  type SourceService,
} from '../receptionistPayload';
import { DEFAULT_PERSONA } from '../persona';
import {
  AI_GATEWAY_BASE as SCREEN_BASE,
  composeAgentPayload as screenCompose,
  DEFAULT_PERSONA as SCREEN_PERSONA,
} from './receptionist-settings/agentPayload';
import { normalizeEngine, voiceMatchesEngine, voiceUsableByEngine } from './receptionist-settings/helpers';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

// ── shared FormLogic mock ────────────────────────────────────────────────────

interface FlCalls {
  /** settings.get count in call order. */
  get: number;
  /** settings.set payloads in call order. */
  set: Array<Record<string, unknown>>;
  submit: Array<Record<string, unknown>>;
  update: Array<{ id: unknown; answers: Record<string, unknown> }>;
}

function makeFl(opts: {
  records?: Array<{ id: string; answers: Record<string, unknown> }>;
  settings?: Record<string, unknown>;
  getExtra?: Record<string, unknown>;
  aiSources?: Array<Record<string, unknown>> | null;
  submitDelayMs?: number;
  settingsGet?: (attempt: number) => Promise<Record<string, unknown>>;
} = {}): { fl: Record<string, unknown>; calls: FlCalls } {
  const calls: FlCalls = { get: 0, set: [], submit: [], update: [] };
  const fl: Record<string, unknown> = {
    presence: () => Promise.resolve({ kind: 'local' }),
    can: () => Promise.resolve(true),
    currentUser: () => Promise.resolve(null),
    aiSources: () => Promise.resolve(opts.aiSources ?? null),
    records: () => Promise.resolve(opts.records ?? []),
    connector: (_id: string, cmd: string, payload: Record<string, unknown>) => {
      if (cmd === 'settings.get') {
        calls.get += 1;
        if (opts.settingsGet) return opts.settingsGet(calls.get);
        return Promise.resolve({ status: 'done', result: { settings: opts.settings ?? {}, ...(opts.getExtra ?? {}) } });
      }
      calls.set.push(payload);
      return Promise.resolve({ status: 'done', result: {} });
    },
    submit: (answers: Record<string, unknown>) => {
      calls.submit.push(answers);
      return new Promise((resolve) => setTimeout(() => resolve({ id: 'rec-new-1' }), opts.submitDelayMs ?? 0));
    },
    updateRecord: (id: unknown, answers: Record<string, unknown>) => {
      calls.update.push({ id, answers });
      return Promise.resolve({});
    },
    toast: {
      success: () => Promise.resolve(true),
      error: () => Promise.resolve(true),
      info: () => Promise.resolve(true),
    },
  };
  return { fl, calls };
}

function typeInto(res: RunScreenResult, el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new res.dom.window.Event('input', { bubbles: true }));
}

// ── screen module shape ──────────────────────────────────────────────────────

describe('receptionist settings screen module', () => {
  it('ships entry+files with the legacy html/css/js DROPPED', () => {
    const s = AOKIE_RECEPTIONIST_SETTINGS_SCREEN as Record<string, unknown>;
    expect(s.enabled).toBe(true);
    expect(s.allowNewResponses).toBe(false);
    expect(s.kind).toBe('code');
    expect(s.title).toBe('Receptionist Settings');
    expect(s.entry).toBe('index.tsx');
    const paths = AOKIE_RECEPTIONIST_SETTINGS_SCREEN.files.map((f) => f.path);
    expect(paths).toContain('index.tsx');
    expect(paths).toContain('store.ts');
    expect(paths).toContain('agentPayload.ts');
    expect(paths).toContain('styles.css');
    expect('js' in s).toBe(false);
    expect('html' in s).toBe(false);
    expect('css' in s).toBe(false);
  });

  it('screen sources are ASCII-clean (no raw em dash / arrows / emoji)', () => {
    for (const f of AOKIE_RECEPTIONIST_SETTINGS_SCREEN.files) {
      for (const ch of f.content) {
        expect(ch.codePointAt(0)! <= 126, `${f.path} contains non-ASCII ${JSON.stringify(ch)}`).toBe(true);
      }
    }
  });
});

// ── (d) composeAgentPayload parity: screen copy vs canonical modules ─────────

describe('agentPayload.ts parity with the canonical modules', () => {
  const draftFor = (over: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...over });
  const SVCS: SourceService[] = [
    { id: 'llama-cpp', name: 'llama.cpp server', category: 'AI', status: 'running', url: 'http://127.0.0.1:8080' },
    { id: 'aokie-voice', name: 'Aokie Voice', category: 'Speech', status: 'stopped', url: '' },
    { id: 'aokie-stt', name: 'Aokie Speech to Text', category: 'Speech-to-Text', status: 'running', url: 'http://127.0.0.1:17921' },
    { id: 'aokie-tts', name: 'Aokie Text to Speech', category: 'Text-to-Speech', status: 'running', url: 'http://127.0.0.1:17922' },
  ];

  it('DEFAULT_PERSONA is STRICTLY equal to the canonical persona module', () => {
    expect(SCREEN_PERSONA).toBe(DEFAULT_PERSONA);
  });

  it('AI_GATEWAY_BASE is strictly equal to the canonical constant', () => {
    expect(SCREEN_BASE).toBe(AI_GATEWAY_BASE);
  });

  const MATRIX: Array<[string, Partial<Draft>, SourceService[] | undefined]> = [
    ['empty draft (default persona + default greeting + agent mode)', {}, SVCS],
    ['custom persona (instructions)', { instructions: 'Be brief.' }, SVCS],
    ['business prefix + default greeting composed from the name', { business_name: 'Bright Smile Dental' }, SVCS],
    ['custom greeting + business info block', { business_name: 'Acme', greeting: 'Gday!', business_info: 'Open 9-5. Checkup $90.' }, SVCS],
    ['reply_mode flow (aiReceptionist false)', { reply_mode: 'flow' }, SVCS],
    ['service picks: running resolves URL+path, stopped resolves empty', { llm_source: 'service:llama-cpp', stt_source: 'service:aokie-stt', tts_source: 'service:aokie-voice', tts_endpoint: 'http://x/legacy' }, SVCS],
    ['service pick UNRESOLVABLE (no desktop listing) omits its key', { llm_source: 'service:llama-cpp', correction_source: 'service:llama-cpp' }, undefined],
    ['provider pick: chat + transcription compose gateway URLs while TTS stays gated', { llm_source: 'provider:my openai', stt_source: 'provider:my openai', tts_source: 'provider:my openai' }, SVCS],
    ['custom URL lanes', { llm_source: 'custom', llm_endpoint: 'http://127.0.0.1:9999/v1/chat/completions', correction_source: 'custom', correction_endpoint: 'http://127.0.0.1:8081/v1/chat/completions' }, SVCS],
    ['blank source + legacy endpoint field', { stt_endpoint: 'http://127.0.0.1:17920/v1/audio/transcriptions' }, SVCS],
    ['voice + model + persona + greeting all set', { voice: 'amy', model: 'llama3.1:8b', business_name: 'B', instructions: 'I', greeting: 'G' }, SVCS],
  ];

  it.each(MATRIX)('deep-equal payloads: %s', (_name, over, svcs) => {
    const draft = draftFor(over);
    const fromScreen = screenCompose(draft, svcs, SCREEN_PERSONA, SCREEN_BASE);
    expect(fromScreen).toEqual(canonicalCompose(draft, svcs, DEFAULT_PERSONA, AI_GATEWAY_BASE));
    expect(fromScreen).toEqual(buildAgentPayload(draft, svcs));
  });

  it('sanity: the provider LLM pick composes the fixed gateway URL', () => {
    const p = screenCompose(draftFor({ llm_source: 'provider:my openai' }), SVCS, SCREEN_PERSONA, SCREEN_BASE);
    expect(p.aiEndpoint).toBe('http://127.0.0.1:17872/api/ai/providers/my%20openai/v1/chat/completions');
  });

  it('sanity: the provider transcription pick composes the fixed multipart gateway URL without a model key', () => {
    const p = screenCompose(draftFor({ stt_source: 'provider:openai-transcribe' }), SVCS, SCREEN_PERSONA, SCREEN_BASE);
    expect(p.sttEndpoint).toBe(
      'http://127.0.0.1:17872/api/ai/providers/openai-transcribe/v1/audio/transcriptions',
    );
    expect('sttModel' in p).toBe(false);
  });

  it('fully blank LLM fields preserve Desktop endpoint+model, while explicit ownership still applies', () => {
    const blank = screenCompose(draftFor({}), SVCS, SCREEN_PERSONA, SCREEN_BASE);
    expect('aiEndpoint' in blank).toBe(false);
    expect('aiModel' in blank).toBe(false);

    const modelOnly = screenCompose(draftFor({ model: 'legacy-model' }), SVCS, SCREEN_PERSONA, SCREEN_BASE);
    expect('aiEndpoint' in modelOnly).toBe(false);
    expect(modelOnly.aiModel).toBe('legacy-model');

    const explicitClear = screenCompose(draftFor({ llm_source: 'custom' }), SVCS, SCREEN_PERSONA, SCREEN_BASE);
    expect(explicitClear.aiEndpoint).toBe('');
    expect(explicitClear.aiModel).toBe('');
  });

  it('the composed payload NEVER carries a manager PIN key (PIN present or absent in the UI, the composer cannot see one)', () => {
    for (const [, over, svcs] of MATRIX) {
      const p = screenCompose(draftFor(over), svcs, SCREEN_PERSONA, SCREEN_BASE);
      expect('managerPin' in p).toBe(false);
      expect('managerPinSet' in p).toBe(false);
    }
  });
});

// ── compiled-screen behavior ─────────────────────────────────────────────────

describe('receptionist settings screen (TSX, compiled artifact)', () => {
  const CODEX_SOURCES = [
    {
      kind: 'provider',
      id: 'provider:openai-codex-agent',
      refId: 'openai-codex-agent',
      name: 'ChatGPT via Codex - Background AI',
      category: 'AI',
      status: 'running',
      url: '',
      capabilities: ['chat'],
      enabled: true,
      model: 'gpt-5.6-luna',
      useCases: ['background', 'forms', 'flows'],
    },
    {
      kind: 'provider',
      id: 'provider:openai-codex-agent-luna-low',
      refId: 'openai-codex-agent-luna-low',
      name: 'ChatGPT / Codex - GPT-5.6 Luna, low reasoning',
      category: 'AI',
      status: 'running',
      url: '',
      capabilities: ['chat'],
      enabled: true,
      model: 'gpt-5.6-luna',
    },
    {
      kind: 'provider',
      id: 'provider:openai-codex-agent-none',
      refId: 'openai-codex-agent-none',
      name: 'ChatGPT/Codex - Off (fastest, experimental)',
      category: 'AI',
      status: 'running',
      url: '',
      capabilities: ['chat'],
      enabled: true,
      model: 'gpt-5.5',
    },
    {
      kind: 'provider',
      id: 'provider:openai-codex-agent-luna-low-fast',
      refId: 'openai-codex-agent-luna-low-fast',
      name: 'ChatGPT / Codex - GPT-5.6 Luna, low reasoning, Fast mode',
      category: 'AI',
      status: 'running',
      url: '',
      capabilities: ['chat'],
      enabled: true,
      model: 'gpt-5.6-luna',
    },
    {
      kind: 'provider',
      id: 'provider:openai-codex-agent-low',
      refId: 'openai-codex-agent-low',
      name: 'ChatGPT/Codex - Low reasoning (experimental)',
      category: 'AI',
      status: 'running',
      url: '',
      capabilities: ['chat'],
      enabled: true,
      model: 'gpt-5.5',
    },
    {
      kind: 'provider',
      id: 'provider:openai-transcribe',
      refId: 'openai-transcribe',
      name: 'OpenAI - GPT-4o mini Transcribe',
      category: 'Speech-to-Text',
      status: 'configured',
      url: '',
      capabilities: ['transcription'],
      enabled: true,
      model: 'gpt-4o-mini-transcribe',
    },
    {
      kind: 'service',
      id: 'service:aokie-stt',
      refId: 'aokie-stt',
      name: 'Aokie Speech to Text',
      category: 'Speech-to-Text',
      status: 'running',
      url: 'http://127.0.0.1:17921',
      capabilities: ['transcription'],
    },
    {
      kind: 'service',
      id: 'service:aokie-tts',
      refId: 'aokie-tts',
      name: 'Aokie Text to Speech',
      category: 'Text-to-Speech',
      status: 'running',
      url: 'http://127.0.0.1:17922',
      capabilities: ['speech'],
    },
  ];

  it('keeps Background AI independent from the live-call LLM and stores only a Desktop provider reference', async () => {
    const { fl, calls } = makeFl({
      records: [{
        id: 'r1',
        answers: {
          llm_source: 'service:llama-cpp',
          model: 'live-model',
          background_ai_model: 'stale-generic-model',
        },
      }],
      aiSources: CODEX_SOURCES,
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    const live = res.root.querySelector('[data-lane="llm"]') as HTMLSelectElement;
    const background = res.root.querySelector('[data-d="background_ai_source"]') as HTMLSelectElement;
    expect(live.value).toBe('service:llama-cpp');
    const backgroundValues = Array.from(background.options).map((o) => o.value);
    expect(backgroundValues).toContain('provider:openai-codex-agent');
    expect(backgroundValues).not.toContain('provider:openai-codex-agent-none');
    expect(backgroundValues).not.toContain('provider:openai-codex-agent-low');
    expect(backgroundValues).not.toContain('provider:openai-codex-agent-luna-low');
    expect(backgroundValues).not.toContain('provider:openai-codex-agent-luna-low-fast');
    expect(Array.from(background.options).some((o) => o.value.indexOf('service:') === 0)).toBe(false);

    background.value = 'provider:openai-codex-agent';
    background.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);

    expect(live.value).toBe('service:llama-cpp');
    const backgroundModel = res.root.querySelector('[data-d="background_ai_model"]') as HTMLInputElement;
    expect(backgroundModel.value).toBe('stale-generic-model');
    expect(res.root.querySelector('[data-background-codex-note]')).toBeNull();
    typeInto(res, backgroundModel, 'gpt-5.6-luna');
    await flush(30);

    (res.root.querySelector('[data-act="save"]') as HTMLButtonElement).click();
    await flush(80);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].answers.background_ai_source).toBe(
      'provider:openai-codex-agent',
    );
    expect(calls.update[0].answers.background_ai_model).toBe('gpt-5.6-luna');
    expect(calls.update[0].answers.llm_source).toBe('service:llama-cpp');
  });

  it('offers transcription-capable Desktop providers and applies their named multipart route', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: { stt_source: 'service:aokie-stt', tts_source: 'service:aokie-tts' } }],
      aiSources: CODEX_SOURCES,
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    const stt = res.root.querySelector('[data-lane="stt"]') as HTMLSelectElement;
    const tts = res.root.querySelector('[data-lane="tts"]') as HTMLSelectElement;
    const sttValues = Array.from(stt.options).map((option) => option.value);
    expect(sttValues).toContain('provider:openai-transcribe');
    expect(sttValues).not.toContain('provider:openai-codex-agent');
    expect(Array.from(tts.options).map((option) => option.value)).not.toContain('provider:openai-transcribe');
    expect(stt.parentElement?.textContent).toContain('models and API credentials are configured once');

    stt.value = 'provider:openai-transcribe';
    stt.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);
    (res.root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(80);

    expect(calls.set).toHaveLength(1);
    expect(calls.set[0].sttEndpoint).toBe(
      'http://127.0.0.1:17872/api/ai/providers/openai-transcribe/v1/audio/transcriptions',
    );
    expect('sttModel' in calls.set[0]).toBe(false);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].answers.stt_source).toBe('provider:openai-transcribe');
    expect('stt_model' in calls.update[0].answers).toBe(false);
  });

  it('offers all four Codex reply modes, pins their models, and blocks direct caller audio', async () => {
    const { fl, calls } = makeFl({
      records: [{
        id: 'r1',
        answers: {
          model: 'local-model',
          stt_source: 'service:aokie-stt',
          tts_source: 'service:aokie-tts',
        },
      }],
      settings: { sendAudio: true, audioTranscript: false },
      aiSources: CODEX_SOURCES,
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;
    const reply = root.querySelector('[data-lane="llm"]') as HTMLSelectElement;
    const values = Array.from(reply.options).map((option) => option.value);
    expect(values).toContain('provider:openai-codex-agent-none');
    expect(values).toContain('provider:openai-codex-agent-low');
    expect(values).toContain('provider:openai-codex-agent-luna-low');
    expect(values).toContain('provider:openai-codex-agent-luna-low-fast');
    expect(values).not.toContain('provider:openai-codex-agent');
    expect(values.some((value) => value.includes('nano'))).toBe(false);

    const editableModel = root.querySelector('[data-d="model"]') as HTMLInputElement;
    expect(editableModel.value).toBe('local-model');
    expect(
      reply.compareDocumentPosition(editableModel) & res.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    reply.value = 'provider:openai-codex-agent-luna-low-fast';
    reply.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);
    expect(root.querySelector('[data-d="model"]')).toBeNull();
    expect(root.querySelector('[data-codex-live-call-note="services"]')?.textContent).toContain(
      'priority service',
    );

    reply.value = 'provider:openai-codex-agent-low';
    reply.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);

    expect(root.querySelector('[data-d="model"]')).toBeNull();
    expect((root.querySelector('[data-lane="stt"]') as HTMLSelectElement).value).toBe('service:aokie-stt');
    expect((root.querySelector('[data-lane="tts"]') as HTMLSelectElement).value).toBe('service:aokie-tts');
    expect(root.querySelector('[data-codex-live-call-note="services"]')?.textContent).toContain('may add noticeable delay');

    const audio = root.querySelector('[data-audio="mode"]') as HTMLSelectElement;
    expect(audio.value).toBe('off');
    expect((audio.querySelector('option[value="direct"]') as HTMLOptionElement).disabled).toBe(true);
    expect((audio.querySelector('option[value="both"]') as HTMLOptionElement).disabled).toBe(true);
    expect(root.querySelector('[data-codex-live-call-note="audio"]')?.textContent).toContain('Direct caller audio is blocked');

    // Even a synthetic/programmatic attempt cannot bypass the store guard.
    audio.value = 'both';
    audio.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);
    expect((root.querySelector('[data-audio="mode"]') as HTMLSelectElement).value).toBe('corrections');

    (root.querySelector('[data-act="save-audio"]') as HTMLButtonElement).click();
    await flush(80);
    expect(calls.set[0].sendAudio).toBe(false);
    expect(calls.set[0].audioTranscript).toBe(true);

    (root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(80);
    expect(calls.set[1].sendAudio).toBe(false);
    expect(calls.set[1].aiModel).toBe('gpt-5.5');
    expect(calls.set[1].aiEndpoint).toBe(
      'http://127.0.0.1:17872/api/ai/providers/openai-codex-agent-low/v1/chat/completions',
    );
    // The picker is record-owned, not merely a transient settings.set choice:
    // Save & apply writes the exact provider id so a fresh screen round-trips it.
    expect(calls.update[1].answers.llm_source).toBe('provider:openai-codex-agent-low');
    expect(calls.update[1].answers.model).toBe('gpt-5.5');
  });

  it('defaults ChatGPT via Codex to Luna low, hides its fixed model input, and hydrates exactly', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: { model: 'local-model' } }],
      settings: { sendAudio: true, audioTranscript: false },
      aiSources: CODEX_SOURCES,
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const reply = res.root.querySelector('[data-lane="llm"]') as HTMLSelectElement;
    expect(reply.options[0].value).toBe('provider:openai-codex-agent-luna-low');
    reply.value = 'provider:openai-codex-agent-luna-low';
    reply.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);

    expect(res.root.querySelector('[data-d="model"]')).toBeNull();
    expect(res.root.querySelector('[data-codex-live-call-note="services"]')?.textContent).toContain(
      'low reasoning, its fastest supported reasoning setting',
    );
    expect(res.root.querySelector('[data-codex-live-call-note="services"]')?.textContent).toContain('streams into Aokie');

    (res.root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(80);
    expect(calls.set[0].sendAudio).toBe(false);
    expect(calls.set[0].aiModel).toBe('gpt-5.6-luna');
    expect(calls.set[0].aiEndpoint).toBe(
      'http://127.0.0.1:17872/api/ai/providers/openai-codex-agent-luna-low/v1/chat/completions',
    );
    expect(calls.update[0].answers.llm_source).toBe('provider:openai-codex-agent-luna-low');
    expect(calls.update[0].answers.model).toBe('gpt-5.6-luna');

    const hydrated = await runScreen(
      AOKIE_RECEPTIONIST_SETTINGS_SCREEN,
      makeFl({
        records: [
          {
            id: 'r2',
            answers: {
              llm_source: 'provider:openai-codex-agent-luna-low',
              model: 'gpt-5.6-luna',
            },
          },
        ],
        settings: { sendAudio: true, audioTranscript: false },
        aiSources: CODEX_SOURCES,
      }).fl,
    );
    await flush(60);
    expect((hydrated.root.querySelector('[data-lane="llm"]') as HTMLSelectElement).value).toBe(
      'provider:openai-codex-agent-luna-low',
    );
    expect(hydrated.root.querySelector('[data-d="model"]')).toBeNull();
    expect((hydrated.root.querySelector('[data-audio="mode"]') as HTMLSelectElement).value).toBe('off');
  });

  it('normalizes a previously saved Codex source and never restores stale sendAudio=true', async () => {
    const { fl, calls } = makeFl({
      records: [{
        id: 'r1',
        answers: {
          llm_source: 'provider:openai-codex-agent-none',
          model: 'stale-model',
          stt_source: 'service:aokie-stt',
          tts_source: 'service:aokie-tts',
        },
      }],
      settings: { sendAudio: true, audioTranscript: false },
      aiSources: CODEX_SOURCES,
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    expect((root.querySelector('[data-lane="llm"]') as HTMLSelectElement).value).toBe(
      'provider:openai-codex-agent-none',
    );
    expect(root.querySelector('[data-d="model"]')).toBeNull();
    expect((root.querySelector('[data-audio="mode"]') as HTMLSelectElement).value).toBe('off');
    expect(root.querySelector('.savebar .dirty')?.textContent).toBe('Unsaved changes');
    expect(root.querySelector('[data-codex-live-call-note="services"]')?.textContent).toContain('fastest setting');

    const audio = root.querySelector('[data-audio="mode"]') as HTMLSelectElement;
    audio.value = 'direct';
    audio.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(30);
    expect((root.querySelector('[data-audio="mode"]') as HTMLSelectElement).value).toBe('off');

    (root.querySelector('[data-act="save-audio"]') as HTMLButtonElement).click();
    await flush(80);
    expect(calls.set[0].sendAudio).toBe(false);
  });

  it('(e) the running-now card renders the authoritative standard voice configuration', async () => {
    const { fl } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settings: {
        greeting: 'Gday mate!',
        persona: 'Pirate persona',
        ttsVoice: 'amy',
        aiModel: 'gemma-4',
        aiReceptionist: true,
        agentHangup: false,
      },
      getExtra: { configVersion: 7, managerPinSet: false },
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(root.querySelector('.running .greet')?.textContent).toBe('Greeting: "Gday mate!"');
    expect(root.querySelector('[data-running-mode]')?.textContent).toContain('Standard STT -> LLM -> TTS');
    expect(root.querySelector('[data-running-provider]')?.textContent).toContain('Automatic / built-in');
    expect(root.querySelector('[data-running-model]')?.textContent).toContain('gemma-4');
    expect(root.querySelector('[data-running-voice]')?.textContent).toContain('amy');
    expect(root.querySelector('[data-running-appointments]')?.textContent).toContain('Lookup + booking requests via FormLogic flows');
    expect(root.querySelector('[data-running-hangup]')?.textContent).toContain('Off - caller or operator ends the call');
    expect(root.querySelector('[data-running-version]')?.textContent).toContain('v7');
    expect(root.querySelector('.running .persona')?.getAttribute('title')).toBe('Pirate persona');
  });

  it('shows Realtime provider/model/voice/tools/hang-up and Refresh recovers after Aokie restarts', async () => {
    const realtimeSettings = {
      greeting: 'Hi there',
      persona: 'Be concise',
      aiReceptionist: true,
      realtimeVoiceMode: 'desktop_realtime',
      realtimeVoiceEndpoint:
        'ws://127.0.0.1:17872/api/ai/providers/openai-gpt-realtime-2-1-mini/v1/realtime/stream',
      realtimeVoice: 'cedar',
      realtimeTurnDetection: 'semantic_vad',
      agentHangup: true,
    };
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settingsGet: (attempt) => Promise.resolve(
        attempt === 1
          ? {
              status: 'failed',
              error: {
                code: 'connector_unavailable',
                message: 'plugin "aokie" is stopped - start it to use this connector',
              },
            }
          : { status: 'done', result: { settings: realtimeSettings, configVersion: 12 } },
      ),
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    expect(res.root.querySelector('.running .muted')?.textContent).toContain(
      'Aokie is stopped or restarting in FormLogic Desktop',
    );
    const refresh = res.root.querySelector('[data-act="refresh-running"]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    await flush(80);

    expect(calls.get).toBe(2);
    expect(res.root.querySelector('[data-running-mode]')?.textContent).toContain(
      'OpenAI Realtime via FormLogic Desktop',
    );
    expect(res.root.querySelector('[data-running-provider]')?.textContent).toContain(
      'OpenAI GPT-Realtime-2.1 mini',
    );
    expect(res.root.querySelector('[data-running-model]')?.textContent).toContain('gpt-realtime-2.1-mini');
    expect(res.root.querySelector('[data-running-voice]')?.textContent).toContain('Cedar - Semantic VAD');
    expect(res.root.querySelector('[data-running-appointments]')?.textContent).toContain(
      'Realtime lookup + booking requests via FormLogic',
    );
    expect(res.root.querySelector('[data-running-hangup]')?.textContent).toContain(
      'On - farewell then end the call',
    );
    expect(res.root.textContent).not.toContain('the desktop did not respond');
  });

  it('uses the Marin Realtime default and never echoes custom endpoints or unknown connector detail', async () => {
    const secretEndpoint = 'wss://operator:secret-token@private.example.test/realtime';
    const { fl } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settingsGet: (attempt) => Promise.resolve(
        attempt === 1
          ? {
              status: 'done',
              result: {
                settings: {
                  aiReceptionist: true,
                  realtimeVoiceMode: 'desktop_realtime',
                  realtimeVoiceEndpoint: secretEndpoint,
                },
              },
            }
          : {
              status: 'failed',
              error: { code: 'unexpected', message: 'failed at ' + secretEndpoint },
            },
      ),
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);

    expect(res.root.querySelector('[data-running-provider]')?.textContent).toContain('Custom endpoint');
    expect(res.root.querySelector('[data-running-voice]')?.textContent).toContain('Marin - Server VAD');
    expect(res.root.textContent).not.toContain('secret-token');

    (res.root.querySelector('[data-act="refresh-running"]') as HTMLButtonElement).click();
    await flush(80);
    expect(res.root.textContent).toContain('Aokie rejected the live settings read');
    expect(res.root.textContent).not.toContain('secret-token');
    expect(res.root.textContent).not.toContain('private.example.test');
  });

  it('(a) manager PIN: blank-on-save KEEPS (no managerPin key), a typed PIN is sent, Remove PIN sends the explicit clear', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settings: { blockedNumbers: '0491570156' },
      getExtra: { managerPinSet: true },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    // Write-only field: a password input, blank, with the set tag from managerPinSet.
    const pin = root.querySelector('[data-sc="managerPin"]') as HTMLInputElement;
    expect(pin).toBeTruthy();
    expect(pin.getAttribute('type')).toBe('password');
    expect(pin.value).toBe('');
    expect(root.textContent).toContain('PIN set');

    // 1. Blank save keeps the stored PIN: the payload has NO managerPin key at all.
    (root.querySelector('[data-act="save-screening"]') as HTMLButtonElement).click();
    await flush(60);
    expect(calls.set.length).toBe(1);
    expect('managerPin' in calls.set[0]).toBe(false);
    expect(calls.set[0].blockedNumbers).toBe('0491570156');
    expect(calls.set[0].managerNumbers).toBe('');

    // 2. A typed PIN is sent, and the field resets to blank after the re-read.
    typeInto(res, root.querySelector('[data-sc="managerPin"]') as HTMLInputElement, '123456');
    await flush(30);
    (root.querySelector('[data-act="save-screening"]') as HTMLButtonElement).click();
    await flush(60);
    expect(calls.set.length).toBe(2);
    expect(calls.set[1].managerPin).toBe('123456');
    expect((root.querySelector('[data-sc="managerPin"]') as HTMLInputElement).value).toBe('');

    // 3. Remove PIN is the ONLY path that clears: an explicit empty-PIN payload.
    const remove = root.querySelector('[data-act="remove-pin"]') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    remove.click();
    await flush(60);
    expect(calls.set.length).toBe(3);
    expect(calls.set[2]).toEqual({ managerPin: '' });
  });

  it('(a+) Save & apply never leaks a PIN: the composed settings.set payload has no managerPin even with one typed', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      getExtra: { managerPinSet: true },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    typeInto(res, res.root.querySelector('[data-sc="managerPin"]') as HTMLInputElement, '999999');
    await flush(30);
    (res.root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(60);
    expect(calls.set.length).toBe(1);
    const applied = calls.set[0];
    expect(typeof applied.persona).toBe('string');
    expect(typeof applied.greeting).toBe('string');
    expect('managerPin' in applied).toBe(false);
  });

  it('(b) a partial card save persists ONLY its keys and never clobbers another card\'s pending edit', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: { business_name: 'Saved Name' } }],
      getExtra: { managerPinSet: false },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    const name = root.querySelector('[data-d="business_name"]') as HTMLInputElement;
    expect(name.value).toBe('Saved Name');
    typeInto(res, name, 'Pending Name');
    await flush(30);
    // Typing re-renders IN PLACE: the input node survives (focus is never lost mid-typing).
    expect(root.querySelector('[data-d="business_name"]')).toBe(name);
    expect(root.querySelector('.savebar .dirty')?.textContent).toBe('Unsaved changes');

    (root.querySelector('[data-act="save-audio"]') as HTMLButtonElement).click();
    await flush(80);
    // The record write was PARTIAL (only the two correction keys) - no create.
    expect(calls.submit.length).toBe(0);
    expect(calls.update.length).toBe(1);
    expect(calls.update[0].id).toBe('r1');
    expect(calls.update[0].answers).toEqual({ correction_source: '', correction_endpoint: '' });
    // The pending edit in ANOTHER card survives, still marked unsaved.
    expect((root.querySelector('[data-d="business_name"]') as HTMLInputElement).value).toBe('Pending Name');
    expect(root.querySelector('.savebar .dirty')?.textContent).toBe('Unsaved changes');
  });

  it('(c) two rapid first-saves share ONE create (full draft); the loser waits then PATCHES the created record', async () => {
    const { fl, calls } = makeFl({ records: [], submitDelayMs: 30, getExtra: { managerPinSet: false } });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    (root.querySelector('[data-act="save-audio"]') as HTMLButtonElement).click();
    (root.querySelector('[data-act="save-screening"]') as HTMLButtonElement).click();
    await flush(150);

    expect(calls.submit.length).toBe(1);
    // The create carried the FULL draft (create validates required fields; no server-side merge).
    const created = calls.submit[0];
    for (const k of [
      'business_name', 'instructions', 'business_info', 'greeting', 'model',
      'llm_endpoint', 'stt_endpoint', 'tts_endpoint', 'llm_source', 'stt_source', 'tts_source',
      'correction_source', 'correction_endpoint', 'background_ai_source', 'background_ai_model',
      'voice', 'reply_mode', 'active',
    ]) {
      expect(k in created, `create payload missing draft key ${k}`).toBe(true);
    }
    // The second saver waited for the shared create then updated the SAME record.
    expect(calls.update.length).toBe(1);
    expect(calls.update[0].id).toBe('rec-new-1');
    // The screening card owns three RECORD policy fields; none of them ride the
    // draft, so this save writes exactly these and nothing else.
    expect(calls.update[0].answers).toEqual({
      whitelist_only: 'no',
      default_country_code: '',
      sms_enabled: 'yes',
    });
  });
});

// The outbound-SMS kill switch. It is a RECORD field, saved by the screening
// card alongside whitelist_only - it never rides the agent payload, because the
// flows read it from the record and the plugin has no such setting.
describe('ScreeningCard: the outbound SMS kill switch', () => {
  const box = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[data-sc="smsEnabled"]');

  it('reads a record with no sms_enabled as ON, matching the flows', async () => {
    // Every install that predates the field is already texting; showing it off
    // would describe behaviour the receptionist does not have.
    const { fl } = makeFl({ records: [{ id: 'r1', answers: {} }], getExtra: { managerPinSet: false } });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(box(root)).not.toBeNull();
    expect(box(root)!.checked).toBe(true);
  });

  it('reads an explicit no as OFF', async () => {
    const { fl } = makeFl({
      records: [{ id: 'r1', answers: { sms_enabled: 'no' } }],
      getExtra: { managerPinSet: false },
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(box(root)!.checked).toBe(false);
  });

  it('turning it off writes sms_enabled no to the record', async () => {
    const { fl, calls } = makeFl({ records: [{ id: 'r1', answers: {} }], getExtra: { managerPinSet: false } });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    const el = box(root)!;
    el.click();
    await flush(40);
    (root.querySelector('[data-act="save-screening"]') as HTMLButtonElement).click();
    await flush(120);

    expect(calls.update.length).toBe(1);
    expect((calls.update[0].answers as Record<string, unknown>).sms_enabled).toBe('no');
    // A kill switch must not quietly change anything else about screening.
    expect((calls.update[0].answers as Record<string, unknown>).whitelist_only).toBe('no');
  });
});

// -- engine / voice pairing -------------------------------------------------
//
// The engine is a LIVE plugin setting saved by its own button; the voice rides
// the RECORD and is pushed by Save & apply. Two buttons, so the two values
// drift - and the drift is inaudible: the plugin refuses a voice belonging to
// the other engine and speaks the engine default, so the console shows Jenny
// while every caller hears the pocket reference sample (live report
// 2026-08-01).

const BUNDLE = 'vits-piper-en_GB-jenny_dioco-medium';

describe('voiceMatchesEngine mirrors the plugin authority', () => {
  // Case-for-case with crates/aokie-plugin/src/voice.rs mod voice_engine_tests.
  // A divergence here means the console offers or pushes something the plugin
  // will refuse, which is exactly the failure this pair of rules exists to stop.
  it('refuses a bundle voice for pocket and accepts it for sherpa', () => {
    for (const bundle of [BUNDLE, 'piper-en_US-amy-low', 'kokoro-en-v0_19', 'en_GB-piper-alba']) {
      expect(voiceMatchesEngine('pocket', bundle), `${bundle} is not a pocket voice`).toBe(false);
      expect(voiceMatchesEngine('sherpa', bundle), `${bundle} IS a sherpa voice`).toBe(true);
      expect(voiceMatchesEngine('piper', bundle), 'piper normalises to sherpa').toBe(true);
    }
  });

  it("leaves pocket's own vocabulary alone", () => {
    for (const ok of ['alba', 'eponine', 'javert', '', 'C:\\voices\\me.wav', 'voices/me.safetensors']) {
      expect(voiceMatchesEngine('pocket', ok), `${JSON.stringify(ok)} is a pocket voice`).toBe(true);
    }
  });

  it('normalises the engine name the same way the plugin does', () => {
    expect(normalizeEngine('')).toBe('pocket');
    expect(normalizeEngine('piper')).toBe('sherpa');
    expect(normalizeEngine('sherpa-onnx')).toBe('sherpa');
    expect(normalizeEngine('nonsense')).toBe('pocket');
  });

  it('the catalog-aware rule also catches a POCKET preset left on sherpa', () => {
    const cat = [{ id: 'pocket', label: 'Pocket-TTS', voices: ['alba', 'eponine'] }];
    // The plugin cannot refuse this (a bundle may name a speaker 'alba'), but
    // the console knows 'alba' is an installed POCKET preset.
    expect(voiceMatchesEngine('sherpa', 'alba')).toBe(true);
    expect(voiceUsableByEngine('sherpa', 'alba', cat)).toBe(false);
    expect(voiceUsableByEngine('sherpa', BUNDLE, cat)).toBe(true);
    expect(voiceUsableByEngine('pocket', 'alba', cat)).toBe(true);
    expect(voiceUsableByEngine('pocket', BUNDLE, cat)).toBe(false);
    // Blank is every engine's default and must never be "cleared".
    expect(voiceUsableByEngine('sherpa', '', cat)).toBe(true);
  });
});

describe('the console never shows a voice the live engine will not speak', () => {
  // esbuild setup/teardown is file-level (top of this suite).
  it('switching the engine to Pocket-TTS drops a Piper bundle off the record', async () => {
    const { fl } = makeFl({
      records: [{ id: 'r1', answers: { voice: BUNDLE } }],
      settings: { ttsEngine: 'sherpa', ttsModelDir: 'C:\\models\\tts\\' + BUNDLE },
      getExtra: { managerPinSet: false },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    // Sherpa is live, so the bundle picker is shown and there is no Voice select.
    expect(root.querySelector('select[data-d="voice"]')).toBe(null);

    const engine = root.querySelector('select[data-eng="engine"]') as HTMLSelectElement;
    engine.value = '';
    engine.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(40);

    // Pocket cannot speak the bundle, so the record's voice reset to Default
    // rather than staying on a name no caller would ever hear.
    const voice = root.querySelector('select[data-d="voice"]') as HTMLSelectElement;
    expect(voice).not.toBe(null);
    expect(voice.value).toBe('');
  });

  it('a record written before the rule shows Default, pending, rather than a voice it cannot use', async () => {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: { voice: BUNDLE } }],
      settings: { ttsEngine: '' },
      getExtra: { managerPinSet: false },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    expect((root.querySelector('select[data-d="voice"]') as HTMLSelectElement).value).toBe('');
    // Pending, not silently rewritten: nothing was saved on load.
    expect(root.querySelector('.savebar .dirty')?.textContent).toBe('Unsaved changes');
    expect(calls.update.length).toBe(0);
    expect(calls.submit.length).toBe(0);
  });

  // The catalog the plugin reports: pocket presets + one installed Piper bundle.
  const CATALOG = {
    engines: [
      { id: 'pocket', label: 'Pocket-TTS', voices: ['alba', 'eponine'] },
      {
        id: 'sherpa',
        label: 'Sherpa',
        bundles: [{ dir: 'C:\\models\\tts\\' + BUNDLE, name: BUNDLE, kind: 'vits' }],
      },
    ],
  };

  // The exact live sequence: the plugin is running pocket, the operator picks
  // Sherpa, picks Jenny from the bundle list that then appears, and presses
  // "Save & apply" - which writes the record and the agent payload but NOT the
  // engine. Before this rule the plugin received a Piper bundle while still
  // running pocket, missed the lookup, and spoke its reference sample instead.
  async function pickSherpaThenJenny() {
    const { fl, calls } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settings: { ttsEngine: '' },
      getExtra: { managerPinSet: false, ttsVoiceCatalog: CATALOG },
    });
    const res = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    const root = res.root;

    expect(root.querySelector('[data-engine-pending]')).toBe(null);

    const engine = root.querySelector('select[data-eng="engine"]') as HTMLSelectElement;
    engine.value = 'sherpa';
    engine.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(40);

    const bundle = root.querySelector('select[data-eng="bundle"]') as HTMLSelectElement;
    expect(bundle, 'the bundle picker appears once sherpa is selected').not.toBe(null);
    bundle.value = 'C:\\models\\tts\\' + BUNDLE;
    bundle.dispatchEvent(new res.dom.window.Event('change', { bubbles: true }));
    await flush(40);

    return { res, root, calls };
  }

  it('Save & apply pushes a blank voice while the engine pick is still unsaved', async () => {
    const { root, calls } = await pickSherpaThenJenny();

    // The pick is pending, and the card says so instead of implying it is live.
    const pending = root.querySelector('[data-engine-pending]');
    expect(pending).not.toBe(null);
    expect(pending?.textContent).toContain('still running Pocket-TTS');

    (root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(120);

    const applied = calls.set[calls.set.length - 1];
    expect(applied.ttsVoice).toBe('');
  });

  it('once the engine is saved, the matching bundle voice IS pushed', async () => {
    const { root, calls } = await pickSherpaThenJenny();

    (root.querySelector('[data-act="save-engine"]') as HTMLButtonElement).click();
    await flush(80);
    expect(root.querySelector('[data-engine-pending]')).toBe(null);

    (root.querySelector('[data-act="save-apply"]') as HTMLButtonElement).click();
    await flush(120);

    const applied = calls.set[calls.set.length - 1];
    expect(applied.ttsVoice).toBe(BUNDLE);
  });
});
