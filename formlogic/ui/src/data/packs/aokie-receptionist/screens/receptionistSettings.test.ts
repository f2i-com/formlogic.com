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
} from '../../../../components/custom-screen/aokie/receptionistPayload';
import { DEFAULT_PERSONA } from '../persona';
import {
  AI_GATEWAY_BASE as SCREEN_BASE,
  composeAgentPayload as screenCompose,
  DEFAULT_PERSONA as SCREEN_PERSONA,
} from './receptionist-settings/agentPayload';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

// ── shared FormLogic mock ────────────────────────────────────────────────────

interface FlCalls {
  /** settings.set payloads in call order. */
  set: Array<Record<string, unknown>>;
  submit: Array<Record<string, unknown>>;
  update: Array<{ id: unknown; answers: Record<string, unknown> }>;
}

function makeFl(opts: {
  records?: Array<{ id: string; answers: Record<string, unknown> }>;
  settings?: Record<string, unknown>;
  getExtra?: Record<string, unknown>;
  submitDelayMs?: number;
} = {}): { fl: Record<string, unknown>; calls: FlCalls } {
  const calls: FlCalls = { set: [], submit: [], update: [] };
  const fl: Record<string, unknown> = {
    presence: () => Promise.resolve({ kind: 'local' }),
    can: () => Promise.resolve(true),
    currentUser: () => Promise.resolve(null),
    aiSources: () => Promise.resolve(null),
    records: () => Promise.resolve(opts.records ?? []),
    connector: (_id: string, cmd: string, payload: Record<string, unknown>) => {
      if (cmd === 'settings.get') {
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
    ['provider pick: LLM lane composes the gateway URL, speech lanes are gated', { llm_source: 'provider:my openai', stt_source: 'provider:my openai', tts_source: 'provider:my openai' }, SVCS],
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
  it('(e) the running-now strip renders greeting/voice/model/mode/configVersion from settings.get', async () => {
    const { fl } = makeFl({
      records: [{ id: 'r1', answers: {} }],
      settings: { greeting: 'Gday mate!', persona: 'Pirate persona', ttsVoice: 'amy', aiModel: 'gemma-4', aiReceptionist: true },
      getExtra: { configVersion: 7, managerPinSet: false },
    });
    const { root } = await runScreen(AOKIE_RECEPTIONIST_SETTINGS_SCREEN, fl);
    await flush(60);
    expect(root.querySelector('.running .greet')?.textContent).toBe('Greeting: "Gday mate!"');
    expect(root.querySelector('.running .meta')?.textContent).toBe('Voice amy - model gemma-4 - built-in AI agent replies - config v7');
    expect(root.querySelector('.running .persona')?.getAttribute('title')).toBe('Pirate persona');
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
      'correction_source', 'correction_endpoint', 'voice', 'reply_mode', 'active',
    ]) {
      expect(k in created, `create payload missing draft key ${k}`).toBe(true);
    }
    // The second saver waited for the shared create then updated the SAME record.
    expect(calls.update.length).toBe(1);
    expect(calls.update[0].id).toBe('rec-new-1');
    expect(calls.update[0].answers).toEqual({ whitelist_only: 'no', default_country_code: '' });
  });
});
