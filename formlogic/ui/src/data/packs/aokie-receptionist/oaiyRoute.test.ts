// The OAIY route: calls go to OAIY on this computer (its voice gateway hears
// and speaks, its Front desk agent talks, the model is the one in OAIY's
// Engines). These tests pin the three lock-step payload composers (the
// per-call Configure Receptionist flow, the console's buildAgentPayload and
// the settings screen's embedded copy), the brief OAIY reads for a known
// caller, and the callback gating that keeps one missed call from ringing
// twice. Every flow expression runs exactly as the executor runs it.
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack as pack, DEFAULT_PERSONA } from './pack';
import {
  AI_GATEWAY_BASE,
  buildAgentPayload,
  EMPTY_DRAFT,
  liveRoute,
  OAIY_DESTINATION,
  OAIY_PROVIDER_ID,
  OAIY_REALTIME_ENDPOINT,
  realtimeProviderId,
  type Draft,
} from './receptionistPayload';
import {
  AI_GATEWAY_BASE as SCREEN_GATEWAY,
  composeAgentPayload as screenCompose,
  DEFAULT_PERSONA as SCREEN_PERSONA,
  liveRoute as screenLiveRoute,
  OAIY_DESTINATION as SCREEN_OAIY_DESTINATION,
  OAIY_PROVIDER_ID as SCREEN_OAIY_PROVIDER_ID,
  OAIY_REALTIME_ENDPOINT as SCREEN_OAIY_ENDPOINT,
  realtimeProviderId as screenRealtimeProviderId,
} from './screens/receptionist-settings/agentPayload';
import manifest from './connector/manifest.json';

const flowBySlug = (slug: string) => (pack.flows ?? []).find((f) => f.slug === slug)!;
const nodeExpr = (slug: string, nodeId: string): string => {
  const node = flowBySlug(slug).flowJson.nodes.find((n) => n.id === nodeId)!;
  return String((node.data as { expr: string }).expr);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evalExpr = (expr: string, scope: { nodes?: unknown; inputs?: unknown }): any =>
  new Function('nodes', 'inputs', `return ${expr};`)(scope.nodes ?? {}, scope.inputs ?? {});

const draftFor = (over: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...over });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runConfigure = (answers: Record<string, unknown> | null): any =>
  evalExpr(nodeExpr('configure-receptionist', 'cfg'), {
    nodes: { settings: { responses: answers ? [{ answers }] : [] }, svc: { services: [] } },
  });

const OAIY_KEYS = {
  aiReceptionist: true,
  realtimeVoiceMode: 'desktop_realtime',
  realtimeVoiceEndpoint: 'ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream',
  realtimeVoiceDestination: 'https://oaiy.localhost',
};

describe('OAIY route constants', () => {
  it('match what Aokie\'s own receptionist screen writes, in both modules', () => {
    expect(OAIY_PROVIDER_ID).toBe('oaiy');
    expect(OAIY_REALTIME_ENDPOINT).toBe(OAIY_KEYS.realtimeVoiceEndpoint);
    expect(OAIY_DESTINATION).toBe(OAIY_KEYS.realtimeVoiceDestination);
    expect(SCREEN_OAIY_PROVIDER_ID).toBe(OAIY_PROVIDER_ID);
    expect(SCREEN_OAIY_ENDPOINT).toBe(OAIY_REALTIME_ENDPOINT);
    expect(SCREEN_OAIY_DESTINATION).toBe(OAIY_DESTINATION);
    // The endpoint the composers derive from the gateway base IS the constant.
    expect(AI_GATEWAY_BASE.replace(/^http/, 'ws') + 'oaiy/v1/realtime/stream').toBe(OAIY_REALTIME_ENDPOINT);
  });
});

describe('the live route read from Aokie settings', () => {
  const CASES: Array<[string, Record<string, unknown> | null, string]> = [
    ['OAIY realtime', { realtimeVoiceMode: 'desktop_realtime', realtimeVoiceEndpoint: OAIY_REALTIME_ENDPOINT, aiReceptionist: true }, 'oaiy'],
    ['another realtime provider', { realtimeVoiceMode: 'desktop_realtime', realtimeVoiceEndpoint: 'ws://127.0.0.1:17872/api/ai/providers/openai-gpt-realtime-2-1-mini/v1/realtime/stream' }, 'realtime'],
    ['a custom realtime endpoint', { realtimeVoiceMode: 'desktop_realtime', realtimeVoiceEndpoint: 'wss://example.test/x' }, 'realtime'],
    ['Aokie lanes', { realtimeVoiceMode: 'legacy', aiReceptionist: true }, 'local'],
    ['no mode, receptionist on (string)', { aiReceptionist: 'true' }, 'local'],
    ['flows speak', { aiReceptionist: false }, 'flows'],
    ['nothing known', {}, 'unknown'],
    ['no settings', null, 'unknown'],
  ];
  it.each(CASES)('%s', (_name, settings, want) => {
    expect(liveRoute(settings)).toBe(want);
    expect(screenLiveRoute(settings)).toBe(want);
  });

  it('reads only the provider segment of an exact realtime stream path', () => {
    for (const fn of [realtimeProviderId, screenRealtimeProviderId]) {
      expect(fn(OAIY_REALTIME_ENDPOINT)).toBe('oaiy');
      expect(fn('ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/chat/completions')).toBe('');
      expect(fn('not a url')).toBe('');
      expect(fn('')).toBe('');
    }
  });
});

describe('Configure Receptionist on the OAIY route', () => {
  it('pushes only the greeting, the brief and the four route keys', () => {
    const r = runConfigure({
      call_route: 'oaiy',
      business_name: 'Pirate Cuts',
      instructions: 'Be brief.',
      greeting: 'Ahoy!',
      voice: 'jenny',
      model: 'llama3.1:8b',
      llm_source: 'provider:my-openai',
      stt_source: 'service:aokie-stt',
      tts_source: 'service:aokie-tts',
      correction_source: 'custom',
      correction_endpoint: 'http://127.0.0.1:8081/v1/chat/completions',
      reply_mode: 'flow',
    });
    expect(r.callRoute).toBe('oaiy');
    expect(r.settingsPayload).toEqual({
      persona: 'You are the phone receptionist for Pirate Cuts.\nBe brief.',
      greeting: 'Ahoy!',
      ...OAIY_KEYS,
    });
    // Nothing OAIY ignores or owns rides along, whatever the record holds.
    for (const k of ['ttsVoice', 'aiModel', 'aiEndpoint', 'sttEndpoint', 'ttsEndpoint', 'audioTranscriptEndpoint', 'sendAudio', 'realtimeVoice', 'realtimeTurnDetection']) {
      expect(k in r.settingsPayload, k).toBe(false);
    }
  });

  it('a blank brief sends the default persona: business context written for the Front desk', () => {
    const r = runConfigure({ call_route: 'oaiy' });
    expect(r.settingsPayload.persona).toBe(DEFAULT_PERSONA);
    expect(r.settingsPayload.greeting).toBe('Thanks for calling! How can I help you today?');
    const withInfo = runConfigure({ call_route: 'oaiy', business_info: 'Open 9-5.' });
    expect(withInfo.settingsPayload.persona.startsWith(DEFAULT_PERSONA + '\n\nBUSINESS INFO')).toBe(true);
  });

  it('records without a route keep the legacy payload and never touch the realtime keys', () => {
    const r = runConfigure({ business_name: 'Pirate Cuts' });
    expect(r.callRoute).toBe('');
    expect(r.settingsPayload.persona).toContain(DEFAULT_PERSONA);
    expect('realtimeVoiceMode' in r.settingsPayload).toBe(false);
    expect('ttsVoice' in r.settingsPayload).toBe(true);
    // No record at all behaves the same (a new install before its first save).
    expect('realtimeVoiceMode' in runConfigure(null).settingsPayload).toBe(false);
  });

  it("'aokie' takes calls back to Aokie's lanes from any realtime route", () => {
    const r = runConfigure({ call_route: 'aokie', llm_source: 'provider:my-openai' });
    expect(r.settingsPayload.realtimeVoiceMode).toBe('legacy');
    expect(r.settingsPayload.aiEndpoint).toBe('http://127.0.0.1:17872/api/ai/providers/my-openai/v1/chat/completions');
  });

  const CASES: Array<[string, Partial<Draft>]> = [
    ['oaiy, all blank', { call_route: 'oaiy' }],
    ['oaiy, business + brief + info + greeting', { call_route: 'oaiy', business_name: 'Acme', instructions: 'Be warm.', business_info: 'Open 9-5.', greeting: 'Hi!' }],
    ['oaiy ignores lanes, voice, model and reply mode', { call_route: 'oaiy', voice: 'amy', model: 'm', llm_source: 'custom', llm_endpoint: 'http://127.0.0.1:9/v1/chat/completions', reply_mode: 'flow' }],
    ['aokie lanes', { call_route: 'aokie', llm_source: 'provider:acme', stt_source: 'provider:acme' }],
    ['aokie with flow replies', { call_route: 'aokie', reply_mode: 'flow' }],
    ['no route (legacy record)', { business_name: 'Acme', voice: 'amy' }],
  ];

  it.each(CASES)('flow, console and screen compose the same payload: %s', (_name, over) => {
    const flow = runConfigure(over as Record<string, unknown>).settingsPayload;
    const draft = draftFor(over);
    const ui = buildAgentPayload(draft, []);
    const screen = screenCompose(draft as never, [], SCREEN_PERSONA, SCREEN_GATEWAY);
    expect(ui).toEqual(flow);
    expect(screen).toEqual(ui);
  });
});

describe('Personalize Caller on the OAIY route', () => {
  const expr = nodeExpr('personalize-caller', 'make');
  const run = (settings: Record<string, unknown>, customer: Record<string, unknown> | null) =>
    evalExpr(expr, {
      inputs: { callId: 'call_p1', from: '+61491570156' },
      nodes: {
        customers: { responses: customer ? [{ id: 'c1', answers: customer }] : [] },
        appointments: { responses: [] },
        allappts: { responses: [] },
        settings: { responses: [{ answers: { active: 'yes', ...settings } }] },
        calls: { responses: [] },
      },
    });

  it('sends the brief and names the lookup tool, not the marker', () => {
    const r = run({ call_route: 'oaiy', business_name: 'Pirate Cuts' }, { name: 'Lance Baker', phone: '0491570156' });
    expect(r.persona.startsWith('You are the phone receptionist for Pirate Cuts.\n' + DEFAULT_PERSONA)).toBe(true);
    expect(r.persona).toContain('lookup_business_data');
    expect(r.persona).not.toContain('[[LOOKUP');
    expect(r.persona).toContain('request_appointment');
    expect(r.persona).toContain('KNOWN CALLER');
    expect(r.greeting).toContain('Hi Lance!');
  });

  it('keeps the Aokie persona and the [[LOOKUP]] marker on the other routes', () => {
    const r = run({ business_name: 'Pirate Cuts' }, null);
    expect(r.persona).toContain(DEFAULT_PERSONA);
    expect(r.persona).toContain('[[LOOKUP: ...]]');
  });

  it('screening still applies on the OAIY route (blocked customers are rejected)', () => {
    const r = run({ call_route: 'oaiy' }, { name: 'X', phone: '0491570156', status: 'blocked' });
    expect(r.reject).toBe(true);
    expect(r.rejectReason).toBe('blocked_customer');
  });
});

describe('missed-call callbacks: OAIY takes priority on its route', () => {
  const runMissed = (settings: Record<string, unknown>, opts: { phone?: string; outcome?: string; customer?: Record<string, unknown> } = {}) =>
    evalExpr(nodeExpr('missed-call-follow-up', 'task'), {
      inputs: { callerPhone: opts.phone ?? '0491570156', callId: 'call_m1', outcome: opts.outcome ?? 'missed' },
      nodes: {
        customers: { responses: opts.customer ? [{ id: 'c1', answers: opts.customer }] : [] },
        tasks: { responses: [] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...settings } }] },
        appts: { responses: [] },
      },
    });

  it('FormLogic never dials on the OAIY route; the task says who calls back', () => {
    for (const outcome of ['missed', 'abandoned_in_queue']) {
      const r = runMissed({ call_route: 'oaiy' }, { outcome, customer: { name: 'Lance', phone: '0491570156' } });
      expect(r.wantsCallback, outcome).toBe(false);
      expect(r.callbacksBy).toBe('oaiy');
      expect(r.task.callback_state).toBe('');
      expect(r.task.summary).toContain('FormLogic did not ring them');
      expect(r.task.summary).toContain('OAIY > Agent > Phone');
      expect(r.task.status).toBe('open');
      expect(r.task.phone).toBe('0491570156');
    }
  });

  it('the other routes still queue FormLogic\'s own callback', () => {
    for (const settings of [{}, { call_route: 'aokie' }]) {
      const r = runMissed(settings);
      expect(r.wantsCallback).toBe(true);
      expect(r.callbacksBy).toBe('formlogic');
      expect(r.task.callback_state).toBe('queued');
    }
  });

  it('withheld numbers get the plain call-back note on every route', () => {
    const r = runMissed({ call_route: 'oaiy' }, { phone: 'unknown' });
    expect(r.task.summary).not.toContain('OAIY');
    expect(r.task.summary).toContain('call back');
  });

  it('the binding dials only when the flow wants a callback', () => {
    const binding = (pack.flowBindings ?? []).find((b) => b.flow === 'missed-call-follow-up')!;
    const dial = (binding.outputActions ?? []).find((a) => (a as { command?: string }).command === 'call.dial') as { when?: string };
    expect(dial.when).toBe('$result.wantsCallback');
  });

  it('the drain never dials on the OAIY route, but a caller who reached us still closes their task', () => {
    const plan = nodeExpr('callback-drain', 'plan');
    const queued = (phone: string, number: string) => ({
      id: 't-' + phone,
      submittedAt: new Date(Date.now() - 5 * 60000).toISOString(),
      answers: { status: 'open', callback_state: 'queued', phone, callback_number: number, callback_opening: 'Hi!', callback_purpose: 'p' },
    });
    const nodes = (route: string) => ({
      tasks: { responses: [queued('0491570156', '+61491570156'), queued('0491570157', '+61491570157')] },
      settings: { responses: [{ answers: { active: 'yes', call_route: route } }] },
    });
    const onOaiy = evalExpr(plan, { nodes: nodes('oaiy'), inputs: { from: '0491570156', outcome: 'completed', direction: '' } });
    expect(onOaiy.hasDial).toBe(false);
    expect(onOaiy.hasTaskUpdate).toBe(true);
    expect(onOaiy.taskUpdate.callback_state).toBe('reached');
    expect(onOaiy.summaryLine).toContain('OAIY calls back missed calls');
    const onAokie = evalExpr(plan, { nodes: nodes('aokie'), inputs: { from: '0491570156', outcome: 'completed', direction: '' } });
    expect(onAokie.hasDial).toBe(true);
    expect(onAokie.dial.number).toBe('+61491570157');
  });

  it('the drain reads the settings form (its graph routes through it)', () => {
    const flow = flowBySlug('callback-drain');
    expect(flow.flowJson.nodes.some((n) => n.id === 'settings' && n.type === 'formlogic_list_responses')).toBe(true);
    expect(flow.flowJson.edges).toContainEqual({ source: 'settings', target: 'plan' });
  });

  it('the SMS apologies do not depend on the route', () => {
    const hold = evalExpr(nodeExpr('hold-lost-apology', 'plan'), {
      inputs: { callId: 'call_h1', callerPhone: '0491570156' },
      nodes: {
        customers: { responses: [] },
        settings: { responses: [{ answers: { active: 'yes', call_route: 'oaiy', business_name: 'Pirate Cuts' } }] },
      },
    });
    expect(hold.hasSms).toBe(true);
    expect(hold.sms.body).toContain('lost you');
  });
});

describe('OAIY failing mid-call (aokie.hardware.error realtime_failed)', () => {
  const script = pack.apps[0].customLogic!.scripts.find((s) => s.id === 'aokie-hardware-error')!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (event: Record<string, unknown>): any => new Function('ctx', `${script.source}; return run(ctx);`)({ event, storage: {} });

  it('logs a readable event and a system note in the call\'s own transcript', () => {
    const at = '2026-09-29T01:02:03.000Z';
    const out = run({
      name: 'aokie.hardware.error', correlationId: 'call_abc12345', idempotencyKey: 'aokie:call_abc12345:hardware.error:v1', occurredAt: at,
      data: { code: 'realtime_failed', callId: 'call_abc12345', route: 'oaiy', apologized: true, at },
    });
    const event = out.effects.find((e: { formKey?: string }) => e.formKey === 'hardware-events');
    expect(event.answers.event_name).toBe('realtime_failed');
    expect(event.answers.message).toContain('OAIY stopped answering during the call');
    expect(event.answers.message).toContain('technical trouble');
    const note = out.effects.find((e: { formKey?: string }) => e.formKey === 'transcript-turns');
    expect(note.answers).toMatchObject({ call_id: 'call_abc12345', speaker: 'system', turn_key: 'call_abc12345:realtime_failed', timestamp: at });
    expect(out.effects.find((e: { type: string }) => e.type === 'ui.toast').message).toContain('OAIY stopped answering a call');
  });

  it('says when no apology could be spoken, and leaves radio incidents as they were', () => {
    const silent = run({ name: 'aokie.hardware.error', correlationId: 'call_x', data: { code: 'realtime_failed', callId: 'call_x', apologized: false } });
    expect(silent.effects[0].answers.message).toContain('no voice to apologise');
    const radio = run({ name: 'aokie.hardware.error', correlationId: 'radio', data: { message: 'USB read stalled' } });
    expect(radio.effects.some((e: { formKey?: string }) => e.formKey === 'transcript-turns')).toBe(false);
    expect(radio.effects[0].answers.message).toBe('USB read stalled');
  });
});

describe('dongle.reset', () => {
  const app = pack.apps[0];
  it('is a declared connector command with a Device Admin grant', () => {
    expect((manifest as { commands: string[] }).commands).toContain('dongle.reset');
    // A physical mutation: journalled, as in the Aokie contract.
    expect((manifest as { journalledCommands: string[] }).journalledCommands).toContain('dongle.reset');
    expect(app.customLogic!.permissions).toContain('connector.aokie.dongle.reset');
    const admin = app.roles!.find((r) => r.name === 'Device Admin')!;
    expect(admin.permissions).toContainEqual({ packFormId: null, permission: 'connector.aokie.dongle.reset' });
    const receptionist = app.roles!.find((r) => r.name === 'Receptionist')!;
    expect(receptionist.permissions.some((p) => p.permission === 'connector.aokie.dongle.reset')).toBe(false);
  });
});
