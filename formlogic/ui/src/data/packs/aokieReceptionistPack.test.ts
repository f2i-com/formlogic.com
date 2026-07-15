// Structural validation for the Aokie Receptionist pack — the pack is data, so a broken
// cross-reference (@pack: form ref, flow slug, logic form key, SDK screen id) would only
// surface at import/run time. These tests pin every reference the importer/runtime resolves.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack as pack, DEFAULT_PERSONA } from './aokieReceptionistPack';
import { validateWorkflowGraph } from '../../client-runtime/flows/flowExecutor';
import { packCatalog } from './index';

describe('aokieReceptionistPack — shared persona (audit CROSS-SCHEMA-001)', () => {
  it("matches the cross-repo persona fixture the plugin's DEFAULT_AGENT_PERSONA is locked to", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../../../../docs/contracts/aokie-persona.v1.json'), 'utf8')
    ) as { personaVersion: number; persona: string };
    expect(fixture.personaVersion).toBe(1);
    // Byte-identical to the aokie repo's copy (which contract.rs locks against
    // its DEFAULT_AGENT_PERSONA): the in-plugin voice agent and this flow-based
    // reply path can never speak with two different personas.
    expect(DEFAULT_PERSONA).toBe(fixture.persona);
  });
});

const FORM_IDS = new Set(pack.forms.map((f) => f.packFormId));
const FLOW_SLUGS = new Set((pack.flows ?? []).map((f) => f.slug));
const app = pack.apps[0];

/** Every '@pack:<key>' occurrence in a JSON-ish structure. */
function collectPackRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('@pack:')) out.push(value.slice(6).split('::')[0]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPackRefs(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPackRefs(v, out);
  }
  return out;
}

// The v0 executor's node set (docs/FORMLOGIC_FLOWS.md §4) — a pack flow using anything
// else would fail every run with invalid_flow.
const V0_NODE_TYPES = new Set([
  'input',
  'output',
  'condition',
  'template',
  'logic_block',
  'llm_chat',
  'http_request',
  'formlogic_list_responses',
  'formlogic_submit_response',
  'formlogic_update_response',
  'connector_request',
  'aokie_speak',
]);

// MVP event names the Aokie plugin emits (docs/AOKIE_PLUGIN_CONTRACT.md §3).
const AOKIE_EVENTS = new Set([
  'aokie.dongle.detected', 'aokie.dongle.driver_required', 'aokie.dongle.ready', 'aokie.dongle.error',
  'aokie.phone.pairing_started', 'aokie.phone.paired', 'aokie.phone.disconnected',
  'aokie.call.incoming', 'aokie.call.answered', 'aokie.call.caller_id', 'aokie.call.rejected',
  'aokie.call.turn.partial', 'aokie.call.turn.final', 'aokie.call.turn.corrected', 'aokie.call.ended',
  'aokie.sms.received', 'aokie.sms.sent', 'aokie.sms.failed',
  'aokie.manager.action',
  'aokie.hardware.error',
]);

describe('aokieReceptionistPack — forms', () => {
  it('ships the plan §12.2 record set', () => {
    for (const key of [
      'customers', 'calls', 'transcript-turns', 'sms-threads', 'sms-messages',
      'appointments', 'orders', 'follow-up-tasks', 'hardware-events',
    ]) {
      expect(FORM_IDS.has(key), `missing form '${key}'`).toBe(true);
    }
  });

  it('every linked_record targets a declared pack form', () => {
    for (const form of pack.forms) {
      for (const field of form.fields) {
        if (field.type !== 'linked_record') continue;
        const target = String(field.properties.targetFormId ?? '');
        expect(target.startsWith('@pack:'), `${form.packFormId}.${field.id} must use @pack:`).toBe(true);
        expect(FORM_IDS.has(target.slice(6)), `${form.packFormId}.${field.id} → ${target}`).toBe(true);
      }
    }
  });

  it('every dashboard/report @pack ref resolves to a declared form', () => {
    const refs = [
      ...collectPackRefs(pack.forms.map((f) => f.customScreen)),
      ...collectPackRefs(app.customScreen),
      ...collectPackRefs(app.reports),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(FORM_IDS.has(ref), `dangling @pack:${ref}`).toBe(true);
    }
  });

  it('correlation keys are WRITABLE fields — hidden would be stripped server-side (anti-tamper)', () => {
    // The platform treats `hidden` as server-authoritative: client-submitted values are
    // dropped on submit. App-logic-written correlation keys must therefore be plain fields,
    // or call.answered/call.ended can never match their row (verified live on formlogic.local).
    const writable = (formKey: string, fieldId: string) => {
      const form = pack.forms.find((f) => f.packFormId === formKey);
      const field = form?.fields.find((f) => f.id === fieldId);
      expect(field?.type, `${formKey}.${fieldId}`).toBe('short_text');
    };
    writable('calls', 'call_id');
    writable('transcript-turns', 'call_id');
    writable('sms-messages', 'message_id');
    writable('hardware-events', 'event_id');
    for (const form of pack.forms) {
      for (const field of form.fields) {
        expect(field.type, `${form.packFormId}.${field.id} must not be hidden`).not.toBe('hidden');
      }
    }
  });
});

describe('aokieReceptionistPack — app', () => {
  it('app membership + roles reference declared forms only', () => {
    for (const f of app.forms) {
      expect(FORM_IDS.has(f.packFormId), `app form '${f.packFormId}'`).toBe(true);
    }
    for (const role of app.roles) {
      for (const perm of role.permissions) {
        if (perm.packFormId === null) continue; // app-level declarative grants
        expect(FORM_IDS.has(perm.packFormId), `${role.name} → '${perm.packFormId}'`).toBe(true);
      }
    }
  });

  it('viewer role gets no connector grants; receptionist never gets driver install', () => {
    const viewer = app.roles.find((r) => r.name === 'Viewer');
    expect(viewer).toBeDefined();
    expect(viewer!.permissions.some((p) => String(p.permission).startsWith('connector.'))).toBe(false);
    const receptionist = app.roles.find((r) => r.name === 'Receptionist');
    expect(receptionist).toBeDefined();
    const rPerms = receptionist!.permissions.map((p) => p.permission);
    expect(rPerms).toContain('connector.aokie.call.answer');
    expect(rPerms).toContain('connector.aokie.sms.send');
    expect(rPerms).not.toContain('connector.aokie.dongle.installDriver');
  });

  it('logic scripts reference forms by stable packFormIds — never rename-able labels (audit FL-007)', () => {
    const packFormIds = new Set(app.forms.map((f) => f.packFormId));
    const sources = (app.customLogic?.scripts ?? []).map((s) => s.source).join('\n');
    const keys = [...sources.matchAll(/formKey:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(packFormIds.has(key), `logic formKey '${key}' is not a packFormId`).toBe(true);
    }
  });

  it('logic bundle grants cover every effect type its scripts emit', () => {
    const grants = new Set<string>((app.customLogic?.permissions ?? []) as string[]);
    // Effects used by the scripts: submit/update writes, storage guard, toasts.
    expect(grants.has('formlogic.responses.write')).toBe(true);
    expect(grants.has('storage.local')).toBe(true);
    expect(grants.has('ui.toast')).toBe(true);
    // Connector surface used by the SDK screens is declared (the connectorGrants gate).
    for (const cmd of ['call.answer', 'call.hangup', 'call.operatorSpeak', 'call.current', 'sms.send', 'dongle.list', 'dongle.installDriver', 'phone.status']) {
      expect(grants.has(`connector.aokie.${cmd}`), `missing connector.aokie.${cmd}`).toBe(true);
    }
    expect(app.customLogic?.strictPermissions).toBe(true);
  });

  it('logic scripts only handle contract event names', () => {
    for (const script of app.customLogic?.scripts ?? []) {
      const events = [...script.source.matchAll(/'(aokie\.[a-z._]+)'/g)].map((m) => m[1]);
      expect(events.length, `${script.id} must guard on an event name`).toBeGreaterThan(0);
      for (const ev of events) {
        expect(AOKIE_EVENTS.has(ev), `${script.id} handles unknown event '${ev}'`).toBe(true);
      }
    }
  });

  it('aokie-call-turn: stores turn_key and applies audio-model corrections IN PLACE (audioTranscript)', () => {
    const script = (app.customLogic?.scripts ?? []).find((s) => s.id === 'aokie-call-turn')!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (ctx: any): any => new Function('ctx', `${script.source}; return run(ctx);`)(ctx);
    const stored = run({
      event: {
        name: 'aokie.call.turn.final',
        correlationId: 'call_x',
        idempotencyKey: 'aokie:call_x:turn.3.final:v1',
        data: { callId: 'call_x', turn: 3, speaker: 'caller', text: 'I would like to look a table', at: '2026-07-14T00:00:00Z' },
      },
      storage: {},
    });
    expect(stored.effects[0].type).toBe('formlogic.submitResponse');
    expect(stored.effects[0].answers.turn_key).toBe('call_x:3');
    expect(stored.effects[0].answers.source).toBe('stt');
    const fix = run({
      event: {
        name: 'aokie.call.turn.corrected',
        correlationId: 'call_x',
        idempotencyKey: 'aokie:call_x:turn.3.corrected:v1',
        data: { callId: 'call_x', turn: 3, text: 'I would like to book a table', sttText: 'I would like to look a table' },
      },
      storage: {},
    });
    const upd = fix.effects[0];
    expect(upd.type).toBe('formlogic.updateResponse');
    // Update-only: a correction whose row is missing must stay a no-op,
    // never mint a fresh (partial) turn.
    expect(upd.upsert).toBeUndefined();
    expect(upd.match).toEqual({ field: 'turn_key', value: 'call_x:3' });
    expect(upd.answers.text).toBe('I would like to book a table');
    expect(upd.answers.stt_text).toBe('I would like to look a table');
    expect(upd.answers.source).toBe('audio_model');
    // Blank correction and redelivery are both clean no-ops.
    expect(run({ event: { name: 'aokie.call.turn.corrected', correlationId: 'c', data: { text: '  ' } }, storage: {} })).toEqual({});
    expect(
      run({
        event: { name: 'aokie.call.turn.corrected', idempotencyKey: 'k1', correlationId: 'c', data: { turn: 1, text: 'hello' } },
        storage: { 'seen-k1': 1 },
      })
    ).toEqual({});
  });

  it('SDK screens referenced by the pack are registered in sdkScreenRegistry', () => {
    // Node env — read the registration calls from source instead of importing React modules.
    const dir = join(__dirname, '..', '..', 'components', 'custom-screen');
    const registered = new Set<string>();
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/registerSdkScreen\(\s*['"]([^'"]+)['"]/g)) {
            registered.add(m[1]);
          }
        }
      }
    };
    walk(dir);
    const used: string[] = [];
    for (const form of pack.forms) {
      const cs = form.customScreen;
      if (cs?.kind === 'sdk' && cs.sdkScreen?.screenId) used.push(cs.sdkScreen.screenId);
    }
    expect(used.sort()).toEqual(['aokie-live-call', 'aokie-pairing', 'aokie-receptionist-settings']);
    for (const id of used) {
      expect(registered.has(id), `SDK screen '${id}' is not registered`).toBe(true);
    }
  });
});

describe('aokieReceptionistPack — flows & bindings', () => {
  it('ships the starter flows on valid v0 graphs', () => {
    expect([...FLOW_SLUGS].sort()).toEqual([
      'after-call-actions',
      'business-lookup',
      'call-summary-follow-up',
      'callback-drain',
      'configure-receptionist',
      'hardware-error-alert',
      'hold-lost-apology',
      'incoming-caller-lookup',
      'live-reply',
      'manager-action-apply',
      'manager-action-plan',
      'missed-call-follow-up',
      'outbound-callback-result',
      'personalize-caller',
      'sms-auto-reply-draft',
      'sms-delivery-status',
      'sms-followup-conversation',
    ]);
    for (const flow of pack.flows ?? []) {
      expect(flow.slug).toMatch(/^[a-z][a-z0-9-]{1,127}$/);
      expect(validateWorkflowGraph(flow.flowJson), flow.slug).toBeNull();
      for (const node of flow.flowJson.nodes) {
        expect(V0_NODE_TYPES.has(node.type), `${flow.slug} node '${node.id}' type '${node.type}'`).toBe(true);
      }
    }
  });

  it('flow-node @pack form refs resolve to declared forms', () => {
    let seen = 0;
    for (const flow of pack.flows ?? []) {
      for (const node of flow.flowJson.nodes) {
        for (const key of ['form', 'formId'] as const) {
          const ref = node.data?.[key];
          if (typeof ref !== 'string' || !ref.startsWith('@pack:')) continue;
          seen += 1;
          expect(FORM_IDS.has(ref.slice(6)), `${flow.slug} node '${node.id}' → ${ref}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(0); // caller lookup + summary flows read forms by ref
  });

  it('bindings reference declared flows, contract events, and declared forms', () => {
    expect(pack.flowBindings?.length).toBe(16);
    for (const binding of pack.flowBindings ?? []) {
      expect(FLOW_SLUGS.has(binding.flow), `binding → flow '${binding.flow}'`).toBe(true);
      expect(AOKIE_EVENTS.has(binding.event), `binding event '${binding.event}'`).toBe(true);
      expect(['sync', 'async', 'background', 'manual']).toContain(binding.mode);
      for (const ref of collectPackRefs(binding)) {
        expect(FORM_IDS.has(ref), `binding '${binding.flow}' → @pack:${ref}`).toBe(true);
      }
      // Live-call decisions must stay inside the 2–4s budget with a spoken fallback (§9.7).
      if (binding.mode === 'sync') {
        expect(binding.timeoutMs).toBeGreaterThanOrEqual(2000);
        expect(binding.timeoutMs).toBeLessThanOrEqual(4000);
        expect(binding.fallbackPolicy?.fallbackReply).toBeTruthy();
      }
    }
  });

  it('keeps the single-writer rule: only app logic writes Hardware Events', () => {
    const hw = (pack.flowBindings ?? []).filter((b) => b.event === 'aokie.hardware.error');
    expect(hw.length).toBe(1);
    for (const action of hw[0].outputActions ?? []) {
      expect(action.type).not.toBe('formlogic.submitResponse');
      expect(action.type).not.toBe('formlogic.updateResponse');
    }
  });
});

describe('aokieReceptionistPack — reply_mode (agent vs flow toggle)', () => {
  const settingsForm = pack.forms.find((f) => f.packFormId === 'receptionist-settings')!;
  const replyModeField = settingsForm.fields.find((f) => f.id === 'reply_mode');
  const configureFlow = (pack.flows ?? []).find((f) => f.slug === 'configure-receptionist')!;

  it('Receptionist Settings has a reply_mode dropdown with exactly the agent/flow options, agent first', () => {
    expect(replyModeField, 'reply_mode field').toBeDefined();
    expect(replyModeField!.type).toBe('dropdown');
    const options = (replyModeField!.properties as { options?: Array<{ value: string; label: string }> }).options ?? [];
    expect(options.map((o) => o.value)).toEqual(['agent', 'flow']);
    expect(options.map((o) => o.label)).toEqual([
      'Built-in AI agent (fast, in-app)',
      'Custom flow (edit the Live Reply flow)',
    ]);
  });

  it("reply_mode's own description states the reconnect-required caveat, distinct from the form's next-caller-turn claim", () => {
    // The two claims must not contradict on the same screen: persona/greeting/voice/model
    // (described at the form level) apply next caller turn; reply_mode does not.
    expect(settingsForm.description).toMatch(/next caller turn/);
    expect(replyModeField!.description ?? '').toMatch(/reconnect/i);
    expect(replyModeField!.description ?? '').not.toMatch(/next caller turn/);
  });

  it("Configure Receptionist flow's push node payload sends aiReceptionist alongside the existing keys", () => {
    const push = configureFlow.flowJson.nodes.find((n) => n.id === 'push')!;
    const payload = (push.data as { payload?: Record<string, unknown> }).payload ?? {};
    expect(payload.aiReceptionist).toBe('$nodes.cfg.aiReceptionist');
    expect(payload.persona).toBe('$nodes.cfg.persona');
    expect(payload.greeting).toBe('$nodes.cfg.greeting');
    expect(payload.ttsVoice).toBe('$nodes.cfg.voice');
    expect(payload.aiModel).toBe('$nodes.cfg.model');
  });

  it('declares connector.aokie.settings.set — the same command, so no capability change is needed for the richer payload', () => {
    // The runtime capability gate (desktop runner.rs connector_request / TS nodes.ts
    // requireConnectorCapability) matches on exact `connector.<id>.<command>` or the
    // wildcard `connector.<id>.*` — it never inspects individual payload keys — so adding
    // aiReceptionist to settings.set's payload needs no new nodeCapabilities entry.
    expect(configureFlow.nodeCapabilities).toContain('connector.aokie.settings.set');
  });

  // FLOW_AGENT_CONFIG is an inline (unexported) logic_block expression string; evaluate it
  // exactly as the executor does — as a plain JS expression with `nodes` in scope — rather
  // than re-deriving its logic, so this test exercises the real shipped source.
  function runAgentConfig(answers: Record<string, unknown> | null): { aiReceptionist: boolean } {
    const cfgNode = configureFlow.flowJson.nodes.find((n) => n.id === 'cfg')!;
    const expr = (cfgNode.data as { expr: string }).expr;
    const nodes = { settings: { responses: answers ? [{ answers }] : [] } };
    const fn = new Function('nodes', `return ${expr};`);
    return fn(nodes);
  }

  it('aiReceptionist: reply_mode "agent" -> true', () => {
    expect(runAgentConfig({ reply_mode: 'agent' }).aiReceptionist).toBe(true);
  });

  it('aiReceptionist: reply_mode "flow" -> false', () => {
    expect(runAgentConfig({ reply_mode: 'flow' }).aiReceptionist).toBe(false);
  });

  it('aiReceptionist: reply_mode absent/blank -> true (preserves today\'s deployed default)', () => {
    expect(runAgentConfig({}).aiReceptionist).toBe(true);
    expect(runAgentConfig({ reply_mode: '' }).aiReceptionist).toBe(true);
    expect(runAgentConfig(null).aiReceptionist).toBe(true); // no settings record at all yet
  });
});

describe('aokieReceptionistPack — SMS follow-up loop (logic blocks)', () => {
  // The loop's behaviour lives in logic-block STRINGS; evaluate the shipped source
  // exactly as the executor does (plain JS with `nodes`/`inputs` in scope) so these
  // tests exercise the real pack data, not a re-derivation.
  const flowBySlug = (slug: string) => (pack.flows ?? []).find((f) => f.slug === slug)!;
  const nodeExpr = (slug: string, nodeId: string): string => {
    const node = flowBySlug(slug).flowJson.nodes.find((n) => n.id === nodeId)!;
    return String((node.data as { expr: string }).expr);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evalExpr = (expr: string, scope: { nodes?: unknown; inputs?: unknown }): any =>
    new Function('nodes', 'inputs', `return ${expr};`)(scope.nodes ?? {}, scope.inputs ?? {});

  const future = new Date(Date.now() + 7 * 86400000);
  const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

  describe('after-call-actions plan: SMS kickoff', () => {
    const planExpr = nodeExpr('after-call-actions', 'plan');
    const scopeFor = (extract: Record<string, unknown>, ctxOver: Record<string, unknown> = {}) => ({
      inputs: { callId: 'call_1' },
      nodes: {
        ctx: { hasTranscript: true, phone: '+61400000000', customerId: null, customerName: '', today: 'today', ...ctxOver },
        extract: { content: JSON.stringify(extract) },
        calls: { responses: [{ id: 'resp-call-1', answers: {} }] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
      },
    });
    const booking = {
      intent: 'appointment', sentiment: 'positive', caller_name: 'Lance Baker', service: 'Haircut',
      date: futureIso, time: '14:00', summary: 'Booked a haircut.', callback_requested: false,
    };

    it('booking intent + real caller number → kickoff SMS + SMS-managed task + correlated appointment', () => {
      const r = evalExpr(planExpr, scopeFor(booking));
      expect(r.hasKickoffSms).toBe(true);
      expect(r.task.sms_state).toBe('active');
      expect(r.task.sms_exchanges).toBe(1);
      expect(r.task.phone).toBe('+61400000000');
      expect(r.task.call_id).toBe('call_1');
      expect(r.task.call_link).toBe('resp-call-1');
      expect(r.appointment.phone).toBe('+61400000000');
      expect(r.appointment.call_id).toBe('call_1');
      expect(r.kickoffSms.to).toBe('+61400000000');
      expect(r.kickoffSms.body).toContain('Pirate Cuts');
      expect(r.kickoffSms.body).toContain('Hi Lance!');
      expect(r.kickoffSms.body).toContain('Reply YES to confirm');
      expect(r.kickoffSms.body).toContain('Reply STOP to opt out');
      // eslint-disable-next-line no-control-regex
      expect(r.kickoffSms.body).toMatch(/^[\x20-\x7E]+$/); // plain ASCII (GSM envelope)
      expect(r.kickoffMessage.direction).toBe('outbound');
      expect(r.kickoffMessage.status).toBe('queued');
      expect(r.kickoffMessage.message_id).toBe('smskick_call_1');
      expect(r.summaryLine).toContain('Confirmation SMS sent.');
    });

    it('unclear-date booking still kicks off (asks for a day/time instead of confirming one)', () => {
      const r = evalExpr(planExpr, scopeFor({ ...booking, date: null, time: null }));
      expect(r.hasAppointment).toBe(false);
      expect(r.hasKickoffSms).toBe(true);
      expect(r.kickoffSms.body).toContain('could not pin down a day and time');
      expect(r.task.sms_state).toBe('active');
    });

    it('withheld caller number → no kickoff, task stays human-only', () => {
      const r = evalExpr(planExpr, scopeFor(booking, { phone: 'unknown' }));
      expect(r.hasKickoffSms).toBe(false);
      expect(r.task.sms_state).toBeUndefined();
      expect(r.task.sms_exchanges).toBeUndefined();
    });

    it('non-booking intents never text the caller', () => {
      const r = evalExpr(planExpr, scopeFor({ ...booking, intent: 'message' }));
      expect(r.hasTask).toBe(true);
      expect(r.hasKickoffSms).toBe(false);
      expect(r.task.sms_state).toBeUndefined();
    });
  });

  describe('sms-auto-reply-draft gate: defers to the automated loop', () => {
    const gateExpr = nodeExpr('sms-auto-reply-draft', 'gate');
    const withTask = (answers: Record<string, unknown>) => ({
      nodes: { tasks: { responses: [{ id: 't1', answers }] } },
    });

    it('active SMS-managed task → gate false (no draft; the loop answers)', () => {
      expect(evalExpr(gateExpr, withTask({ status: 'open', sms_state: 'active' }))).toBe(false);
    });
    it('opted-out sender → gate false (no draft at all after STOP)', () => {
      expect(evalExpr(gateExpr, withTask({ status: 'open', sms_state: 'opted_out' }))).toBe(false);
    });
    it('no SMS state / closed task / handoff → gate true (human-approval draft path)', () => {
      expect(evalExpr(gateExpr, withTask({ status: 'open' }))).toBe(true);
      expect(evalExpr(gateExpr, withTask({ status: 'done', sms_state: 'active' }))).toBe(true);
      expect(evalExpr(gateExpr, withTask({ status: 'open', sms_state: 'handoff' }))).toBe(true);
      expect(evalExpr(gateExpr, { nodes: { tasks: { responses: [] } } })).toBe(true);
    });
  });

  describe('sms-followup-conversation ctx: deterministic verdicts', () => {
    const ctxExpr = nodeExpr('sms-followup-conversation', 'ctx');
    const nodesFor = (over: Record<string, unknown> = {}) => ({
      settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
      tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', phone: '+61400000000', call_id: 'call_1', sms_exchanges: 1, summary: 'Confirm appointment with Lance' } }] },
      appointments: { responses: [{ id: 'appt-1', answers: { call_id: 'call_1', service: 'Haircut', date: futureIso, time: '14:00', status: 'requested' } }] },
      messages: { responses: [] },
      ...over,
    });
    const run = (body: string, over: Record<string, unknown> = {}) =>
      evalExpr(ctxExpr, { inputs: { from: '+61400000000', body }, nodes: nodesFor(over) });

    it('STOP always opts out — even punctuated, even past the cap', () => {
      expect(run('STOP').verdict).toBe('stop');
      expect(run('stop!').verdict).toBe('stop');
      const capped = { tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', sms_exchanges: 6 } }] } };
      expect(run('STOP', capped).verdict).toBe('stop');
    });
    it('a plain YES with an appointment confirms without an LLM call', () => {
      expect(run('YES').verdict).toBe('yes');
      expect(run('yes!').verdict).toBe('yes');
      expect(run('Sounds good.').verdict).toBe('yes');
    });
    it('the exchange cap hands off before any model runs', () => {
      const capped = { tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', sms_exchanges: 6 } }] } };
      expect(run('how about friday', capped).verdict).toBe('cap');
    });
    it('anything else goes to the LLM with the appointment + task in context', () => {
      const r = run('Can we do Friday at 9 instead?');
      expect(r.verdict).toBe('llm');
      expect(r.taskId).toBe('task-1');
      expect(r.apptId).toBe('appt-1');
      expect(r.llmContext).toContain('Haircut');
      expect(r.llmContext).toContain('Can we do Friday at 9 instead?');
    });
    it('no active SMS-managed task → verdict none (draft flow owns the reply)', () => {
      expect(run('hello', { tasks: { responses: [] } }).verdict).toBe('none');
      const humanOnly = { tasks: { responses: [{ id: 't', answers: { status: 'open', sms_state: '' } }] } };
      expect(run('hello', humanOnly).verdict).toBe('none');
    });
    it('a YES without any appointment goes to the LLM instead of blind-confirming', () => {
      expect(run('YES', { appointments: { responses: [] } }).verdict).toBe('llm');
    });
  });

  describe('sms-followup-conversation plan: actions → writes + composed reply', () => {
    const planExpr = nodeExpr('sms-followup-conversation', 'plan');
    const ctxVal = {
      verdict: 'llm', hasTask: true, taskId: 'task-1', taskCallId: 'call_1', taskCustomer: '',
      exchanges: 1, apptId: 'appt-1', apptDate: futureIso, apptTime: '14:00', apptService: 'Haircut',
      apptNotes: 'Booked automatically from call call_1', business: 'Pirate Cuts', model: '',
      today: 'today', llmContext: '', phone: '+61400000000',
    };
    const run = (ctxOver: Record<string, unknown>, decideContent?: unknown, body = 'YES') =>
      evalExpr(planExpr, {
        inputs: { body },
        nodes: {
          ctx: { ...ctxVal, ...ctxOver },
          ...(decideContent === undefined ? {} : { decide: { content: typeof decideContent === 'string' ? decideContent : JSON.stringify(decideContent) } }),
        },
      });

    it('YES verdict: appointment confirmed, task closed, composed (non-model) reply sent', () => {
      const r = run({ verdict: 'yes' });
      expect(r.hasApptUpdate).toBe(true);
      expect(r.apptResponseId).toBe('appt-1');
      expect(r.apptUpdate.status).toBe('confirmed');
      expect(r.hasTaskUpdate).toBe(true);
      expect(r.taskUpdate.status).toBe('done');
      expect(r.taskUpdate.sms_state).toBe('done');
      expect(r.taskUpdate.sms_exchanges).toBe(2);
      expect(r.hasReply).toBe(true);
      expect(r.reply.to).toBe('+61400000000');
      expect(r.reply.body).toContain('confirmed');
      expect(r.reply.body).toContain('Haircut');
      expect(r.outboundMessage.status).toBe('queued');
      expect(r.outboundMessage.is_ai_reply).toEqual(['yes']);
    });

    it('every appointment write APPENDS an interaction line to the existing notes', () => {
      const r = run({ verdict: 'yes' });
      // Old content preserved (updates patch-merge whole answers) …
      expect(r.apptUpdate.notes).toContain('Booked automatically from call call_1');
      // … and the new line quotes the customer + records the outcome.
      expect(r.apptUpdate.notes).toContain('customer texted "YES"');
      expect(r.apptUpdate.notes).toContain('CONFIRMED');
      // Appended, not replaced: original first, log line after.
      expect(r.apptUpdate.notes.indexOf('Booked automatically')).toBeLessThan(r.apptUpdate.notes.indexOf('customer texted'));
    });

    it('LLM reschedule with an existing appointment: date/time move, still requested, reply asks for YES', () => {
      const r = run({}, { action: 'reschedule', date: futureIso, time: '09:30', reply: 'model prose ignored' }, 'can we do later that week?');
      expect(r.hasApptUpdate).toBe(true);
      expect(r.apptUpdate.date).toBe(futureIso);
      expect(r.apptUpdate.status).toBe('requested');
      expect(r.apptUpdate.time).toBe('09:30');
      expect(r.apptUpdate.notes).toContain('customer texted "can we do later that week?"');
      expect(r.apptUpdate.notes).toContain('moved to');
      expect(r.taskUpdate.status).toBeUndefined(); // stays open
      expect(r.reply.body).toContain('Reply YES to confirm');
      expect(r.reply.body).not.toContain('model prose');
    });

    it('LLM reschedule with NO appointment yet: creates one from the SMS', () => {
      const r = run({ apptId: null, apptService: '', taskCustomer: 'cust-9' }, { action: 'reschedule', date: futureIso, time: '11:00', service: 'Beard trim' });
      expect(r.hasApptCreate).toBe(true);
      expect(r.hasApptUpdate).toBe(false);
      expect(r.newAppointment.service).toBe('Beard trim');
      expect(r.newAppointment.date).toBe(futureIso);
      expect(r.newAppointment.time).toBe('11:00');
      expect(r.newAppointment.status).toBe('requested');
      expect(r.newAppointment.source).toBe('sms');
      expect(r.newAppointment.phone).toBe('+61400000000');
      expect(r.newAppointment.call_id).toBe('call_1');
      expect(r.newAppointment.customer_link).toBe('cust-9');
    });

    it('cancel: appointment cancelled, task closed', () => {
      const r = run({}, { action: 'cancel', reply: '' }, 'actually cancel it please');
      expect(r.apptUpdate.status).toBe('cancelled');
      expect(r.apptUpdate.notes).toContain('CANCELLED');
      expect(r.apptUpdate.notes).toContain('customer texted "actually cancel it please"');
      expect(r.taskUpdate.status).toBe('done');
      expect(r.taskUpdate.sms_state).toBe('done');
      expect(r.reply.body).toContain('cancelled');
    });

    it('a past/garbage reschedule date degrades to a clarifying question — the booking never moves', () => {
      const r = run({}, { action: 'reschedule', date: '2020-01-01', time: '09:00', reply: '' });
      // The only appointment write is the notes-only interaction log —
      // date/time/status are untouched by a bad model date.
      expect(r.hasApptCreate).toBe(false);
      expect(r.hasApptUpdate).toBe(true);
      expect(Object.keys(r.apptUpdate)).toEqual(['notes']);
      expect(r.hasReply).toBe(true);
      expect(r.taskUpdate.sms_exchanges).toBe(2);
    });

    it('unparseable model output → human handoff with an honest reply (notes-only appointment log)', () => {
      const r = run({}, 'total garbage, not json');
      expect(r.taskUpdate.sms_state).toBe('handoff');
      expect(r.taskUpdate.priority).toBe('high');
      expect(r.hasReply).toBe(true);
      expect(r.reply.body).toContain('team');
      expect(Object.keys(r.apptUpdate)).toEqual(['notes']);
      expect(r.apptUpdate.notes).toContain('handed to a human');
    });

    it('STOP verdict: no reply is ever sent; task flagged opted-out for a human', () => {
      const r = run({ verdict: 'stop' });
      expect(r.hasReply).toBe(false);
      expect(r.taskUpdate).toEqual({ sms_state: 'opted_out', priority: 'high' });
    });

    it('cap verdict: silent handoff, no reply', () => {
      const r = run({ verdict: 'cap', exchanges: 6 });
      expect(r.hasReply).toBe(false);
      expect(r.taskUpdate).toEqual({ sms_state: 'handoff', priority: 'high' });
    });

    it('no-task verdict: nothing happens (draft path owns it)', () => {
      const r = run({ verdict: 'none', hasTask: false });
      expect(r.hasReply).toBe(false);
      expect(r.hasTaskUpdate).toBe(false);
      expect(r.hasApptUpdate).toBe(false);
    });
  });

  describe('sms-delivery-status: queued → sent/failed on the phone\'s ack', () => {
    const markExpr = nodeExpr('sms-delivery-status', 'mark');
    const rows = (list: Array<Record<string, unknown>>) => ({
      nodes: { messages: { responses: list.map((answers, i) => ({ id: `msg-${i}`, answers })) } },
    });

    it('flips the newest QUEUED outbound row to sent', () => {
      const r = evalExpr(markExpr, {
        inputs: { to: '+61400000000', outcome: 'sent' },
        // Newest-first, as the list node returns them.
        nodes: rows([
          { direction: 'inbound', status: 'received', phone: '+61400000000' },
          { direction: 'outbound', status: 'queued', phone: '+61400000000' },
          { direction: 'outbound', status: 'sent', phone: '+61400000000' },
        ]).nodes,
      });
      expect(r.hasUpdate).toBe(true);
      expect(r.responseId).toBe('msg-1');
      expect(r.update).toEqual({ status: 'sent' });
    });

    it('marks failed on the failure ack — inbound and already-sent rows are never touched', () => {
      const r = evalExpr(markExpr, {
        inputs: { to: '+61400000000', outcome: 'failed' },
        nodes: rows([
          { direction: 'inbound', status: 'received' },
          { direction: 'outbound', status: 'queued' },
        ]).nodes,
      });
      expect(r.update).toEqual({ status: 'failed' });
    });

    it('no queued outbound row → no write (a stray ack never corrupts history)', () => {
      const r = evalExpr(markExpr, {
        inputs: { to: '+61400000000', outcome: 'sent' },
        nodes: rows([
          { direction: 'outbound', status: 'sent' },
          { direction: 'inbound', status: 'received' },
        ]).nodes,
      });
      expect(r.hasUpdate).toBe(false);
    });

    it('an unknown outcome coerces to sent — never an invalid dropdown value', () => {
      const r = evalExpr(markExpr, {
        inputs: { to: '+61400000000', outcome: 'exploded' },
        nodes: rows([{ direction: 'outbound', status: 'queued' }]).nodes,
      });
      expect(r.update).toEqual({ status: 'sent' });
    });
  });

  // Multi-booking (live report 2026-07-13): two appointments booked on one
  // call got squeezed into one record, only one confirmation SMS went out,
  // and a time was carried across bookings. One call may now create up to
  // three appointments; the kickoff + YES cover EVERY pending booking for
  // the number; changes/cancels target one by date or ASK.
  describe('multi-booking (2026-07-13)', () => {
    const future2 = new Date(Date.now() + 10 * 86400000);
    const futureIso2 = `${future2.getFullYear()}-${String(future2.getMonth() + 1).padStart(2, '0')}-${String(future2.getDate()).padStart(2, '0')}`;

    describe('after-call-actions plan', () => {
      const planExpr = nodeExpr('after-call-actions', 'plan');
      const scopeFor = (extract: Record<string, unknown>, nodesOver: Record<string, unknown> = {}) => ({
        inputs: { callId: 'call_2' },
        nodes: {
          ctx: { hasTranscript: true, phone: '+61400000000', customerId: null, customerName: '', today: 'today' },
          extract: { content: JSON.stringify(extract) },
          calls: { responses: [{ id: 'resp-call-2', answers: {} }] },
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
          ...nodesOver,
        },
      });
      const twoBookings = {
        intent: 'appointment', sentiment: 'positive', caller_name: 'Lance Baker', service: null,
        appointments: [
          { service: 'Diner', date: futureIso, time: '10:00' },
          { service: 'Dinner', date: futureIso2, time: null },
        ],
        summary: 'Booked two visits.', callback_requested: false,
      };

      it('two agreed bookings → two appointment creates, one task + one kickoff listing both', () => {
        const r = evalExpr(planExpr, scopeFor(twoBookings));
        expect(r.hasAppointment).toBe(true);
        expect(r.hasAppointment2).toBe(true);
        expect(r.hasAppointment3).toBe(false);
        expect(r.appointment.date).toBe(futureIso);
        expect(r.appointment.time).toBe('10:00');
        expect(r.appointment2.date).toBe(futureIso2);
        // Time is PER BOOKING — never carried from the first to the second.
        expect(r.appointment2.time).toBeUndefined();
        expect(r.appointment.call_id).toBe('call_2');
        expect(r.appointment2.call_id).toBe('call_2');
        expect(r.appointment2.phone).toBe('+61400000000');
        expect(r.task.summary).toContain('Diner');
        expect(r.task.summary).toContain('Dinner');
        expect(r.kickoffSms.body).toContain('booking requests');
        expect(r.kickoffSms.body).toContain('Diner');
        expect(r.kickoffSms.body).toContain('Dinner');
        expect(r.kickoffSms.body).toContain('Reply YES to confirm both');
      });

      it('a booking already on record is not duplicated, but a pending one still rides the kickoff', () => {
        const existing = {
          appts: {
            responses: [
              { id: 'appt-old', answers: { status: 'requested', date: futureIso, time: '10:00', service: 'Diner', phone: '+61400000000' } },
            ],
          },
        };
        const r = evalExpr(planExpr, scopeFor(twoBookings, existing));
        // The Diner booking already exists → only Dinner is created…
        expect(r.hasAppointment).toBe(true);
        expect(r.appointment.date).toBe(futureIso2);
        expect(r.hasAppointment2).toBe(false);
        expect(r.summaryLine).toContain('already on record');
        // …but the kickoff still lists BOTH (the pending one folds in).
        expect(r.kickoffSms.body).toContain('Diner');
        expect(r.kickoffSms.body).toContain('Dinner');
        expect(r.kickoffSms.body).toContain('Reply YES to confirm both');
      });

      it('an earlier still-active SMS loop closes as superseded when the new kickoff starts', () => {
        const prior = {
          tasks: {
            responses: [
              { id: 'task-old', answers: { status: 'open', sms_state: 'active', summary: 'Confirm appointment with Lance - Diner', phone: '+61400000000' } },
            ],
          },
        };
        const r = evalExpr(planExpr, scopeFor(twoBookings, prior));
        expect(r.hasPriorTaskClose).toBe(true);
        expect(r.priorTaskId).toBe('task-old');
        expect(r.priorTaskUpdate.status).toBe('done');
        expect(r.priorTaskUpdate.sms_state).toBe('done');
        expect(r.priorTaskUpdate.summary).toContain('superseded');
        expect(r.task.sms_state).toBe('active');
      });

      it('re-confirming only already-CONFIRMED bookings sends no SMS at all', () => {
        const confirmed = {
          appts: {
            responses: [
              { id: 'appt-c', answers: { status: 'confirmed', date: futureIso, time: '10:00', service: 'Diner', phone: '+61400000000' } },
            ],
          },
        };
        const oneRebooking = { ...twoBookings, appointments: [{ service: 'Diner', date: futureIso, time: '10:00' }] };
        const r = evalExpr(planExpr, scopeFor(oneRebooking, confirmed));
        expect(r.hasAppointment).toBe(false);
        expect(r.hasKickoffSms).toBe(false);
        expect(r.task.sms_state).toBeUndefined();
        expect(r.task.summary).toContain('re-confirmed existing');
      });

      it('legacy singular date/time extraction still books (fallback shape)', () => {
        const legacy = {
          intent: 'appointment', sentiment: 'positive', caller_name: 'Lance Baker',
          service: 'Haircut', date: futureIso, time: '14:00', summary: 'Booked.', callback_requested: false,
        };
        const r = evalExpr(planExpr, scopeFor(legacy));
        expect(r.hasAppointment).toBe(true);
        expect(r.appointment.date).toBe(futureIso);
        expect(r.appointment.time).toBe('14:00');
        expect(r.hasAppointment2).toBe(false);
      });
    });

    describe('sms-followup-conversation ctx: the loop covers every pending booking', () => {
      const ctxExpr = nodeExpr('sms-followup-conversation', 'ctx');
      const r = evalExpr(ctxExpr, {
        inputs: { from: '+61400000000', body: 'YES' },
        nodes: {
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
          tasks: { responses: [{ id: 'task-2', answers: { status: 'open', sms_state: 'active', call_id: 'call_2', sms_exchanges: 1 } }] },
          appointments: {
            responses: [
              // Newest-first, as the list node returns them.
              { id: 'appt-new', answers: { call_id: 'call_2', service: 'Dinner', date: futureIso2, status: 'requested' } },
              { id: 'appt-old', answers: { call_id: 'call_1', service: 'Diner', date: futureIso, time: '10:00', status: 'requested' } },
            ],
          },
          messages: { responses: [] },
        },
      });

      it('collects the task-call booking AND the earlier pending one, sorted by date', () => {
        expect(r.verdict).toBe('yes');
        expect(r.appts.map((a: { id: string }) => a.id)).toEqual(['appt-old', 'appt-new']);
        expect(r.llmContext).toContain('1. Diner');
        expect(r.llmContext).toContain('2. Dinner');
      });
    });

    describe('sms-followup-conversation plan: multi-booking actions', () => {
      const planExpr = nodeExpr('sms-followup-conversation', 'plan');
      const twoAppts = [
        { id: 'appt-old', date: futureIso, time: '10:00', service: 'Diner', status: 'requested', notes: 'from call 1' },
        { id: 'appt-new', date: futureIso2, time: '', service: 'Dinner', status: 'requested', notes: 'from call 2' },
      ];
      const ctxVal2 = {
        verdict: 'llm', hasTask: true, taskId: 'task-2', taskCallId: 'call_2', taskCustomer: '',
        exchanges: 1, apptId: 'appt-old', apptDate: futureIso, apptTime: '10:00', apptService: 'Diner',
        apptNotes: 'from call 1', appts: twoAppts, business: 'Pirate Cuts', model: '',
        today: 'today', llmContext: '', phone: '+61400000000',
      };
      const run = (ctxOver: Record<string, unknown>, decideContent?: unknown, body = 'YES') =>
        evalExpr(planExpr, {
          inputs: { body },
          nodes: {
            ctx: { ...ctxVal2, ...ctxOver },
            ...(decideContent === undefined ? {} : { decide: { content: JSON.stringify(decideContent) } }),
          },
        });

      it('YES confirms EVERY booking in the loop and the reply lists them all', () => {
        const r = run({ verdict: 'yes' });
        expect(r.hasApptUpdate).toBe(true);
        expect(r.apptResponseId).toBe('appt-old');
        expect(r.apptUpdate.status).toBe('confirmed');
        expect(r.apptUpdate.notes).toContain('from call 1');
        expect(r.hasApptUpdate2).toBe(true);
        expect(r.apptResponseId2).toBe('appt-new');
        expect(r.apptUpdate2.status).toBe('confirmed');
        expect(r.apptUpdate2.notes).toContain('from call 2');
        expect(r.reply.body).toContain('Diner');
        expect(r.reply.body).toContain('Dinner');
        expect(r.taskUpdate.status).toBe('done');
        expect(r.taskUpdate.sms_state).toBe('done');
      });

      it('cancel without naming WHICH booking asks instead of guessing', () => {
        const r = run({}, { action: 'cancel', target_date: null, reply: '' }, 'cancel my booking');
        // Notes-only log on the first appointment; no status changes anywhere.
        expect(Object.keys(r.apptUpdate)).toEqual(['notes']);
        expect(r.hasApptUpdate2).toBe(false);
        expect(r.reply.body).toContain('Which booking');
        expect(r.reply.body).toContain('Diner');
        expect(r.reply.body).toContain('Dinner');
        expect(r.taskUpdate.status).toBeUndefined();
      });

      it('cancel targeted by date cancels that one and keeps the loop open for the rest', () => {
        const r = run({}, { action: 'cancel', target_date: futureIso2, reply: '' }, 'cancel the dinner one');
        expect(r.hasApptUpdate).toBe(true);
        expect(r.apptResponseId).toBe('appt-new');
        expect(r.apptUpdate.status).toBe('cancelled');
        expect(r.hasApptUpdate2).toBe(false);
        expect(r.reply.body).toContain('cancelled');
        expect(r.reply.body).toContain('Diner');
        expect(r.reply.body).toContain('Reply YES to confirm');
        // The other booking is still pending — the loop must stay open.
        expect(r.taskUpdate.status).toBeUndefined();
        expect(r.taskUpdate.sms_state).toBeUndefined();
      });

      it('reschedule targeted by date moves only that booking', () => {
        const r = run({}, { action: 'reschedule', target_date: futureIso, date: futureIso2, time: '18:00', reply: '' }, 'move the diner one');
        expect(r.hasApptUpdate).toBe(true);
        expect(r.apptResponseId).toBe('appt-old');
        expect(r.apptUpdate.date).toBe(futureIso2);
        expect(r.apptUpdate.time).toBe('18:00');
        expect(r.apptUpdate.status).toBe('requested');
        expect(r.hasApptUpdate2).toBe(false);
        expect(r.taskUpdate.status).toBeUndefined();
      });

      it('reschedule without a target among several bookings asks which one', () => {
        const r = run({}, { action: 'reschedule', target_date: null, date: futureIso2, time: '18:00', reply: '' }, 'can we move it');
        expect(Object.keys(r.apptUpdate)).toEqual(['notes']);
        expect(r.reply.body).toContain('Which booking');
        expect(r.taskUpdate.status).toBeUndefined();
      });

      // The live failure (2026-07-13): "Yes to Thursday 10am and 6pm for
      // Sunday" — one message, DIFFERENT things for different bookings.
      it('compound: confirm one booking AND move the other in one message', () => {
        const r = run(
          {},
          {
            action: 'confirm', // top-level single action would drop the change
            actions: [
              { action: 'confirm', target_date: futureIso },
              { action: 'reschedule', target_date: futureIso2, date: futureIso2, time: '18:00' },
            ],
            reply: 'model prose ignored',
          },
          'Yes to Thursday 10am and 6pm for Sunday. Thanks'
        );
        // Thursday confirmed…
        expect(r.hasApptUpdate).toBe(true);
        expect(r.apptResponseId).toBe('appt-old');
        expect(r.apptUpdate.status).toBe('confirmed');
        // …Sunday MOVED to 18:00 (requested, awaiting its YES) — not confirmed at 10.
        expect(r.hasApptUpdate2).toBe(true);
        expect(r.apptResponseId2).toBe('appt-new');
        expect(r.apptUpdate2.status).toBe('requested');
        expect(r.apptUpdate2.time).toBe('18:00');
        // The reply reports both outcomes and asks for the locking YES.
        expect(r.reply.body).toContain('confirmed');
        expect(r.reply.body).toContain('6 PM');
        expect(r.reply.body.toLowerCase()).toContain('reply yes');
        // A moved booking still needs its YES — the loop stays open.
        expect(r.taskUpdate.status).toBeUndefined();
        expect(r.taskUpdate.sms_state).toBeUndefined();
      });

      it('compound: a time-only change matches its booking by date even without target_date', () => {
        const r = run(
          {},
          {
            action: 'confirm',
            actions: [
              { action: 'reschedule', target_date: null, date: futureIso2, time: '18:00' },
              { action: 'confirm', target_date: null },
            ],
          },
          'yes but make sunday 6pm'
        );
        // The reschedule claims the Sunday booking by its (unchanged) date;
        // the target-less confirm covers the remaining Thursday booking.
        const updates = [
          { id: r.apptResponseId, upd: r.apptUpdate },
          { id: r.apptResponseId2, upd: r.apptUpdate2 },
        ];
        const moved = updates.find((u) => u.id === 'appt-new')!;
        const confirmed = updates.find((u) => u.id === 'appt-old')!;
        expect(moved.upd.time).toBe('18:00');
        expect(moved.upd.status).toBe('requested');
        expect(confirmed.upd.status).toBe('confirmed');
      });

      it('compound: confirm one + cancel the other settles everything and closes the loop', () => {
        const r = run(
          {},
          {
            action: 'confirm',
            actions: [
              { action: 'cancel', target_date: futureIso2 },
              { action: 'confirm', target_date: null },
            ],
          },
          'keep thursday, drop the dinner one'
        );
        const updates = [
          { id: r.apptResponseId, upd: r.apptUpdate },
          { id: r.apptResponseId2, upd: r.apptUpdate2 },
        ];
        expect(updates.find((u) => u.id === 'appt-new')!.upd.status).toBe('cancelled');
        expect(updates.find((u) => u.id === 'appt-old')!.upd.status).toBe('confirmed');
        expect(r.reply.body).toContain('Cancelled');
        // Nothing left pending — the loop closes.
        expect(r.taskUpdate.status).toBe('done');
        expect(r.taskUpdate.sms_state).toBe('done');
      });

      it('compound: a malformed actions array falls back to the single-action path', () => {
        const r = run(
          {},
          { action: 'confirm', actions: [{ action: 'explode' }, { action: 'also-bad' }] },
          'YES please'
        );
        // Legacy confirm-all behaviour (both confirmed, task closed).
        expect(r.apptUpdate.status).toBe('confirmed');
        expect(r.apptUpdate2.status).toBe('confirmed');
        expect(r.taskUpdate.status).toBe('done');
      });
    });

    describe('personalize-caller: bookings-on-record grounding', () => {
      const makeExpr = nodeExpr('personalize-caller', 'make');
      const run = (appointments: Array<Record<string, unknown>>, customers: Array<Record<string, unknown>> = []) =>
        evalExpr(makeExpr, {
          inputs: { from: '+61400000000' },
          nodes: {
            customers: { responses: customers },
            appointments: { responses: appointments.map((answers, i) => ({ id: `a-${i}`, answers })) },
            settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
          },
        });

      it('upcoming bookings land in the persona so the agent answers from records', () => {
        const r = run(
          [
            { status: 'requested', date: futureIso, time: '10:00', service: 'Diner' },
            { status: 'confirmed', date: futureIso2, service: 'Dinner' },
            { status: 'cancelled', date: futureIso, service: 'Ghost' },
            { status: 'requested', date: '2020-01-01', service: 'Ancient' },
          ],
          [{ id: 'cust-1', answers: { name: 'Lance Baker', phone: '+61400000000' } }]
        );
        expect(r.persona).toContain('BOOKINGS ON RECORD');
        expect(r.persona).toContain('Diner');
        expect(r.persona).toContain('Dinner');
        expect(r.persona).toContain('never invent or guess dates');
        // Cancelled + past bookings never reach the persona.
        expect(r.persona).not.toContain('Ghost');
        expect(r.persona).not.toContain('Ancient');
      });

      it('an unknown caller with bookings on record still gets the calendar block', () => {
        const r = run([{ status: 'requested', date: futureIso, time: '10:00', service: 'Diner' }]);
        expect(r.found).toBe(false);
        expect(r.persona).toContain('BOOKINGS ON RECORD');
        expect(r.persona).toContain('Diner');
      });

      it('business-lookup digest evaluates + stays privacy-safe (2026-07-14: an escaping bug shipped a syntax error because this test was missing)', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const r = evalExpr(lookupExpr, {
          inputs: { question: 'any tables Friday?', from: '+61400000000', callId: 'c1' },
          nodes: {
            appts: {
              responses: [
                { id: 'b1', answers: { status: 'confirmed', date: futureIso, time: '10:00', service: 'diner', phone: '+61400000000' } },
                { id: 'b2', answers: { status: 'requested', date: futureIso, time: '18:00', service: 'x', phone: '+61499999999', name: 'Somebody Else' } },
                { id: 'b3', answers: { status: 'cancelled', date: futureIso, time: '12:00' } },
              ],
            },
          },
        });
        expect(r.digest).toContain('CALENDAR OCCUPANCY');
        expect(r.digest).toContain('CALLER OWN BOOKINGS');
        expect(r.digest).toContain('10 AM');
        expect(r.digest).toContain('6 PM');
        expect(r.digest).not.toContain('Somebody Else');
        expect(r.digest).not.toContain('12 PM');
        expect(r.digest.split('\n').length).toBeGreaterThan(3);
      });

      it('business-lookup MANAGER calls (Phase 3): occupancy slots gain customer names; ordinary calls never do — even with the customers node populated', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const nodesWith = {
          appts: {
            responses: [
              // The manager's own booking (never name-annotated — it's the
              // CALLER OWN BOOKINGS section's job).
              { id: 'b1', answers: { status: 'confirmed', date: futureIso, time: '10:00', service: 'diner', phone: '+61400999888' } },
              { id: 'b2', answers: { status: 'requested', date: futureIso, time: '18:00', service: 'cut', phone: '+61499999999' } },
              // Untimed booking from a named customer.
              { id: 'b4', answers: { status: 'requested', date: futureIso2, service: 'colour', phone: '+61488888888' } },
            ],
          },
          customers: {
            responses: [
              { id: 'c1', answers: { name: 'Jane Customer', phone: '0499 999 999' } },
              { id: 'c2', answers: { name: 'Bob Untimed', phone: '0488888888' } },
              { id: 'c3', answers: { name: 'The Manager', phone: '0400999888' } },
            ],
          },
        };
        const mgr = evalExpr(lookupExpr, {
          inputs: { question: `who is booked on ${futureIso}?`, from: '+61400999888', callId: 'c1', manager: true },
          nodes: nodesWith,
        });
        expect(mgr.digest).toContain('6 PM (Jane Customer)');
        expect(mgr.digest).toContain('customer names included');
        expect(mgr.digest).toContain('(Bob Untimed)');
        // The manager's own 10 AM slot is their own booking — the occupancy
        // slot never re-labels it with their name.
        expect(mgr.digest).not.toContain('10 AM (The Manager)');
        // The verbatim spoken date answer names customers for managers too
        // (a manager's 'who is booked Friday?' is a date question).
        expect(String(mgr.spoken ?? '')).toContain('Jane Customer');
        // Ordinary caller, SAME nodes (even if the fetch somehow ran): the
        // privacy lock holds everywhere.
        const plain = evalExpr(lookupExpr, {
          inputs: { question: `who is booked on ${futureIso}?`, from: '+61400000000', callId: 'c1' },
          nodes: nodesWith,
        });
        expect(plain.digest).not.toContain('Jane Customer');
        expect(plain.digest).not.toContain('Bob Untimed');
        expect(String(plain.spoken ?? '')).not.toContain('Jane Customer');
        expect(plain.digest).toContain('never name them');
        // Graph: the customers fetch is condition-gated on the manager flag.
        const flow = flowBySlug('business-lookup');
        const gate = flow.flowJson.nodes.find((n) => n.id === 'mgr')!;
        expect(String((gate.data as { expr: string }).expr)).toContain('manager === true');
        const edges = flow.flowJson.edges as Array<{ source: string; target: string; sourceHandle?: string }>;
        expect(edges).toContainEqual({ source: 'mgr', target: 'customers', sourceHandle: 'true' });
        expect(edges).toContainEqual({ source: 'mgr', target: 'make', sourceHandle: 'false' });
      });

      it('business-lookup DIRECT ANSWER: dates in the question get a deterministic verdict (2026-07-14 live call 1defd805: the 9B model failed the window/absence inference)', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const near = new Date(Date.now() + 20 * 86400_000);
        const iso = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const nearIso = iso(near);
        const emptyDay = iso(new Date(Date.now() + 21 * 86400_000));
        const beyond = iso(new Date(Date.now() + 120 * 86400_000));
        const r = evalExpr(lookupExpr, {
          inputs: {
            question: `availability ${nearIso} and ${emptyDay} and ${beyond}`,
            from: '+61400000000',
            callId: 'c1',
          },
          nodes: {
            appts: {
              responses: [
                // The caller's OWN time-less request on the asked day (the live
                // situation: repeated test calls minted 'Saturday 1 August at ?').
                { id: 'b1', answers: { status: 'requested', date: nearIso, service: 'Appointment', phone: '+61400000000' } },
                { id: 'b2', answers: { status: 'confirmed', date: nearIso, time: '18:00', service: 'x', phone: '+61499999999' } },
              ],
            },
          },
        });
        const lines: string[] = r.digest.split('\n');
        const direct = lines.filter((l: string) => l.startsWith('DIRECT ANSWER'));
        expect(direct).toHaveLength(3);
        // Day with the caller's own time-less request + another booking.
        expect(direct[0]).toContain('this caller ALREADY has');
        expect(direct[0]).toContain('time not yet set');
        expect(direct[0]).toContain('6 PM');
        expect(direct[0]).toContain('other times look open');
        // The caller's own time-less booking is never double-counted as
        // somebody ELSE's untimed booking.
        expect(direct[0]).not.toContain('other booking with no set time');
        // Empty in-window day → plainly open.
        expect(direct[1]).toContain('NO bookings that day at all');
        expect(direct[1]).toContain('OPEN');
        // Beyond the 90-day horizon → team confirms.
        expect(direct[2]).toContain('beyond the calendar view');
        // The confusing 'at ?' rendering is gone everywhere.
        expect(r.digest).not.toContain('?:');
        expect(r.digest).not.toContain('at ?');
        expect(r.digest).toContain('with no set time');
        expect(r.digest).toContain('AUTHORITATIVE');
        // The flow COMPOSES the spoken answer (live calls 1defd805 + b58274ed:
        // the model overrode a correct DIRECT ANSWER with its own
        // persona-window reasoning; the plugin now speaks this verbatim).
        expect(typeof r.spoken).toBe('string');
        expect(r.spoken).toContain('you already have a requested Appointment with no time set yet');
        expect(r.spoken).toContain('looks open');
        expect(r.spoken).toContain('calendar view does not reach that far');
        expect(r.spoken).toContain('Would you like me to put a booking request in?');
        // ASCII-only: the spoken line goes straight to TTS.
        expect(/^[\x20-\x7E]+$/.test(r.spoken)).toBe(true);
      });

      it('business-lookup flow output maps BOTH digest and spoken (live call 61d4545b: the output node mapped only digest, so the plugin never received the composed answer)', () => {
        const out = flowBySlug('business-lookup').flowJson.nodes.find((n) => n.type === 'output')!;
        const value = (out.data as { value: Record<string, string> }).value;
        expect(value.digest).toBe('$nodes.make.digest');
        expect(value.spoken).toBe('$nodes.make.spoken');
      });

      it('business-lookup appointments fetch is date-windowed IN THE DATABASE (gte/lte pushdown - a growing calendar must not overflow the 200-row cap)', () => {
        const flow = flowBySlug('business-lookup');
        const win = flow.flowJson.nodes.find((n) => n.id === 'win')!;
        const winOut = evalExpr(String((win.data as { expr: string }).expr), {});
        expect(winOut.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(winOut.horizonIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(winOut.todayIso < winOut.horizonIso).toBe(true);
        const appts = flow.flowJson.nodes.find((n) => n.id === 'appts')!;
        const filters = (appts.data as { filters: Array<{ field: string; op: string; value: string }> }).filters;
        expect(filters).toEqual([
          { field: 'date', op: 'gte', value: '$nodes.win.todayIso' },
          { field: 'date', op: 'lte', value: '$nodes.win.horizonIso' },
        ]);
        // The window node feeds the fetch: edges run in -> win -> appts.
        const edges = flow.flowJson.edges as Array<{ source: string; target: string }>;
        expect(edges).toContainEqual({ source: 'in', target: 'win' });
        expect(edges).toContainEqual({ source: 'win', target: 'appts' });
      });

      it('business-lookup RANGE questions answer the WHOLE span, not just endpoints (call 372836dc)', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const d = (offset: number) => {
          const t = new Date(Date.now() + offset * 86400_000);
          return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        };
        const start = d(20);
        const mid = d(23);
        const end = d(26);
        const r = evalExpr(lookupExpr, {
          inputs: { question: `availability ${start} to ${end}`, from: '+61400000000', callId: 'c1' },
          nodes: { appts: { responses: [
            { id: 'b1', answers: { status: 'confirmed', date: mid, time: '18:00', service: 'x', phone: '+61499999999' } },
          ] } },
        });
        const direct = (r.digest.split(String.fromCharCode(10)) as string[]).filter((l) => l.startsWith('DIRECT ANSWER'));
        expect(direct).toHaveLength(1);
        expect(direct[0]).toContain('through');
        expect(direct[0]).toContain('6 days fully open');
        expect(direct[0]).toContain('booked at 6 PM');
        expect(r.spoken).toContain('In that span');
        expect(r.spoken).toContain('6 PM');
        expect(r.spoken).toContain('The other 6 days look open');
        const r2 = evalExpr(lookupExpr, {
          inputs: { question: `availability ${start} to ${end}`, from: '', callId: 'c1' },
          nodes: { appts: { responses: [] } },
        });
        expect(r2.spoken).toContain('Everything from');
        expect(r2.spoken).toContain('looks open');
      });

      it('business-lookup spoken: absent when the question names no date (the LLM path still owns free-form questions)', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const r = evalExpr(lookupExpr, {
          inputs: { question: 'do you have any vegan options?', from: '', callId: 'c1' },
          nodes: { appts: { responses: [] } },
        });
        expect(r.spoken).toBeUndefined();
        expect(r.digest).not.toContain('DIRECT ANSWER');
      });

      it('business-lookup DIRECT ANSWER: prose dates like "August 1" resolve to the next occurrence', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const r = evalExpr(lookupExpr, {
          inputs: { question: 'any tables on the 1st of August?', from: '', callId: 'c1' },
          nodes: { appts: { responses: [] } },
        });
        expect(r.digest).toContain('DIRECT ANSWER for');
        expect(r.digest).toContain('1 August');
      });

      it('business-lookup DIRECT ANSWER: WORD ordinals parse (call c01b7dcf: STT writes "twenty first of August")', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const r = evalExpr(lookupExpr, {
          inputs: { question: 'Um what about twenty first of August?', from: '', callId: 'c1' },
          nodes: { appts: { responses: [] } },
        });
        expect(r.digest).toContain('DIRECT ANSWER for');
        expect(r.digest).toContain('21 August');
        expect(r.spoken).toContain('21 August');
        // Compound never collapses to its tail: 21, not 1.
        expect(r.digest).not.toContain('DIRECT ANSWER for Saturday 1 August');
        // "first Saturday of August" is NOT a parseable ordinal-of-month (the
        // weekday sits between) - stays with the model, never minted as Aug 1.
        const r2 = evalExpr(lookupExpr, {
          inputs: { question: 'availability the first Saturday of August', from: '', callId: 'c1' },
          nodes: { appts: { responses: [] } },
        });
        expect(r2.digest).not.toContain('DIRECT ANSWER');
        expect(r2.spoken).toBeUndefined();
      });

      describe('manager-action-plan (Phase 3 slice 2): validated writes, honest refusals', () => {
        const ctxExpr = nodeExpr('manager-action-plan', 'ctx');
        const planExpr = nodeExpr('manager-action-plan', 'plan');
        const day2 = new Date(Date.now() + 9 * 86400000);
        const day2Iso = `${day2.getFullYear()}-${String(day2.getMonth() + 1).padStart(2, '0')}-${String(day2.getDate()).padStart(2, '0')}`;
        const ctxScope = (request: string) => ({
          inputs: { request, callId: 'call_m1', from: '+61400000333' },
          nodes: {
            settings: { responses: [{ answers: { business_name: 'Pirate Cuts', model: 'test-model', active: 'yes' } }] },
            customers: { responses: [{ id: 'cu1', answers: { name: 'Lance Baker', phone: '+61400000111' } }] },
            appts: {
              responses: [
                { id: 'ap1', answers: { status: 'requested', date: futureIso, time: '14:00', service: 'Haircut', phone: '0400000111', notes: 'existing note' } },
                { id: 'ap2', answers: { status: 'confirmed', date: futureIso, time: '16:00', service: 'Dinner', phone: '+61499999999' } },
                { id: 'ap3', answers: { status: 'cancelled', date: futureIso, time: '10:00', service: 'Ghost' } },
              ],
            },
          },
        });
        const planFor = (request: string, decision: unknown) => {
          const ctx = evalExpr(ctxExpr, ctxScope(request));
          return evalExpr(planExpr, {
            inputs: {},
            nodes: { ctx, decide: { content: typeof decision === 'string' ? decision : JSON.stringify(decision) } },
          });
        };

        it('ctx: numbered upcoming bookings with customer names, cancelled + past rows dropped, model from settings', () => {
          const ctx = evalExpr(ctxExpr, ctxScope('cancel the haircut'));
          expect(ctx.hasRequest).toBe(true);
          expect(ctx.model).toBe('test-model');
          expect(ctx.llmContext).toContain('Haircut (requested) for Lance Baker');
          expect(ctx.llmContext).toContain('Dinner (confirmed)');
          expect(ctx.llmContext).not.toContain('Ghost');
          expect(ctx.appts.map((a: { id: string }) => a.id)).toEqual(['ap1', 'ap2']);
        });

        it('confirm: target matched by date+time, status flips, notes append the audit line, spoken composed from the record', () => {
          const r = planFor('confirm the 2 PM haircut on that day', { action: 'confirm', target_date: futureIso, target_time: '14:00' });
          expect(r.ok).toBe(true);
          expect(r.hasUpdate).toBe(true);
          expect(r.updateId).toBe('ap1');
          expect(r.update.status).toBe('confirmed');
          expect(r.update.notes).toContain('existing note');
          expect(r.update.notes).toContain('Manager line (');
          expect(r.update.notes).toContain('CONFIRMED by the manager');
          expect(r.spoken).toContain('Haircut');
          expect(r.spoken).toContain('confirmed');
          expect(r.hasBlock).toBe(false);
        });

        it('ambiguous day (two live bookings, no time/name) = spoken question listing choices, NO write; target_name narrows it', () => {
          const vague = planFor('cancel the booking that day', { action: 'cancel', target_date: futureIso });
          expect(vague.ok).toBe(false);
          expect(vague.hasUpdate).toBe(false);
          expect(vague.spoken).toContain('more than one booking');
          expect(vague.spoken).toContain('Haircut');
          expect(vague.spoken).toContain('Dinner');
          const byName = planFor('cancel lance', { action: 'cancel', target_date: futureIso, target_name: 'Lance' });
          expect(byName.ok).toBe(true);
          expect(byName.updateId).toBe('ap1');
          expect(byName.update.status).toBe('cancelled');
        });

        it('move: new slot re-validated (past date refused with a question); a valid move keeps the parts not given', () => {
          const past = planFor('move it', { action: 'move', target_date: futureIso, target_time: '14:00', new_date: '2020-01-01' });
          expect(past.ok).toBe(false);
          expect(past.hasUpdate).toBe(false);
          expect(past.spoken).toContain('Where should I move it to?');
          const timeOnly = planFor('make the haircut 3pm', { action: 'move', target_date: futureIso, target_time: '14:00', new_time: '15:00' });
          expect(timeOnly.ok).toBe(true);
          expect(timeOnly.updateId).toBe('ap1');
          expect(timeOnly.update.date).toBe(futureIso);
          expect(timeOnly.update.time).toBe('15:00');
          const dayMove = planFor('move the haircut', { action: 'move', target_date: futureIso, target_time: '14:00', new_date: day2Iso });
          expect(dayMove.ok).toBe(true);
          expect(dayMove.update.date).toBe(day2Iso);
          expect(dayMove.update.time).toBe('14:00');
        });

        it('block: digits pass through; a too-short number is refused, never half-blocked', () => {
          const r = planFor('block that last caller', { action: 'block', block_number: '+61 499 999 999' });
          expect(r.ok).toBe(true);
          expect(r.hasBlock).toBe(true);
          expect(r.blockNumber).toBe('+61499999999');
          expect(r.hasUpdate).toBe(false);
          const short = planFor('block 12', { action: 'block', block_number: '12' });
          expect(short.ok).toBe(false);
          expect(short.hasBlock).toBe(false);
        });

        it('garbled JSON / unknown action / missing date / no booking on the date = ok:false with an honest spoken line', () => {
          const garbled = planFor('confirm friday', 'not json at all');
          expect(garbled.ok).toBe(false);
          expect(garbled.spoken.length).toBeGreaterThan(0);
          const unknown = planFor('do a dance', { action: 'jazzhands' });
          expect(unknown.ok).toBe(false);
          const dateless = planFor('confirm the booking', { action: 'confirm' });
          expect(dateless.ok).toBe(false);
          expect(dateless.spoken).toContain('Which date');
          const empty = planFor('confirm the tenth', { action: 'confirm', target_date: day2Iso });
          expect(empty.ok).toBe(false);
          expect(empty.spoken).toContain('do not see any booking');
        });

        it('manager-action-apply pass-through refuses malformed events (non-object update / missing id)', () => {
          const passExpr = nodeExpr('manager-action-apply', 'pass');
          const good = evalExpr(passExpr, {
            inputs: { hasUpdate: true, updateId: 'ap1', update: { status: 'confirmed' }, summary: 'ok' },
            nodes: {},
          });
          expect(good.hasUpdate).toBe(true);
          expect(good.update.status).toBe('confirmed');
          const badUpdate = evalExpr(passExpr, { inputs: { hasUpdate: true, updateId: 'ap1', update: 'DROP TABLE' }, nodes: {} });
          expect(badUpdate.hasUpdate).toBe(false);
          const noId = evalExpr(passExpr, { inputs: { hasUpdate: true, update: { a: 1 } }, nodes: {} });
          expect(noId.hasUpdate).toBe(false);
        });
      });

      it('calendar occupancy digest: whole-calendar times, NEVER other customers names (2026-07-14 live business data)', () => {
        const futureIsoLocal = futureIso;
        const r = evalExpr(makeExpr, {
          inputs: { from: '+61400000000' },
          nodes: {
            customers: { responses: [] },
            appointments: { responses: [] },
            allappts: {
              responses: [
                { id: 'x1', answers: { status: 'confirmed', date: futureIsoLocal, time: '10:00', service: 'Cut', name: 'Somebody Else', phone: '+61499999999' } },
                { id: 'x2', answers: { status: 'requested', date: futureIsoLocal, time: '18:00', service: 'Dinner' } },
                { id: 'x3', answers: { status: 'cancelled', date: futureIsoLocal, time: '12:00' } },
                { id: 'x4', answers: { status: 'confirmed', date: '2020-01-01', time: '09:00' } },
              ],
            },
            settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
          },
        });
        expect(r.persona).toContain('CALENDAR OCCUPANCY');
        expect(r.persona).toContain('10 AM');
        expect(r.persona).toContain('6 PM');
        expect(r.persona).toContain('NEVER mention or hint at other customers');
        // Privacy: no other customer's name/phone; no cancelled/ancient slots.
        expect(r.persona).not.toContain('Somebody Else');
        expect(r.persona).not.toContain('+61499999999');
        expect(r.persona).not.toContain('12 PM');
      });

      it('no upcoming bookings → an EXPLICIT none-upcoming block (2026-07-14: an absent block let the model dredge old dates out of customer notes)', () => {
        const r = run([]);
        expect(r.persona).toContain('BOOKINGS ON RECORD');
        expect(r.persona).toContain('none upcoming');
        expect(r.persona).toContain('Never treat dates from the customer notes as bookings');
      });
    });
  });
});

describe('aokieReceptionistPack — Phase 0.5 record-driven screening & SMS policy (call-policy spec)', () => {
  const flowBySlug = (slug: string) => (pack.flows ?? []).find((f) => f.slug === slug)!;
  const nodeExpr = (slug: string, nodeId: string): string => {
    const node = flowBySlug(slug).flowJson.nodes.find((n) => n.id === nodeId)!;
    return String((node.data as { expr: string }).expr);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evalExpr = (expr: string, scope: { nodes?: unknown; inputs?: unknown }): any =>
    new Function('nodes', 'inputs', `return ${expr};`)(scope.nodes ?? {}, scope.inputs ?? {});
  const future = new Date(Date.now() + 7 * 86400000);
  const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

  describe('personalize-caller: blocked customers & whitelist mode', () => {
    const makeExpr = nodeExpr('personalize-caller', 'make');
    const run = (customers: Array<Record<string, unknown>>, settingsAnswers: Record<string, unknown> = {}) =>
      evalExpr(makeExpr, {
        inputs: { from: '+61400000000' },
        nodes: {
          customers: { responses: customers },
          appointments: { responses: [] },
          allappts: { responses: [] },
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...settingsAnswers } }] },
        },
      });

    it("a customer whose profile Status is 'blocked' is rejected (reason blocked_customer)", () => {
      const r = run([{ id: 'c1', answers: { name: 'Lance Baker', phone: '+61400000000', status: 'blocked' } }]);
      expect(r.reject).toBe(true);
      expect(r.rejectReason).toBe('blocked_customer');
    });

    it('whitelist mode rejects a caller with NO Customer record (reason not_whitelisted)', () => {
      const r = run([], { whitelist_only: 'yes' });
      expect(r.reject).toBe(true);
      expect(r.rejectReason).toBe('not_whitelisted');
    });

    it('whitelist mode ADMITS a known (non-blocked) customer', () => {
      const r = run([{ id: 'c1', answers: { name: 'Lance Baker', phone: '+61400000000', status: 'active' } }], { whitelist_only: 'yes' });
      expect(r.reject).toBe(false);
      expect(r.rejectReason).toBe('');
      expect(r.found).toBe(true);
    });

    it('whitelist off (blank/legacy records): unknown callers are configured exactly as before', () => {
      const r = run([]);
      expect(r.reject).toBe(false);
      expect(r.found).toBe(false);
      expect(typeof r.persona).toBe('string');
    });

    it('the flow routes reject → call.reject and SKIPS configureAgent (exclusive branches)', () => {
      const flow = flowBySlug('personalize-caller');
      const gate = flow.flowJson.nodes.find((n) => n.id === 'gate')!;
      expect(String((gate.data as { expr: string }).expr)).toContain('reject');
      const reject = flow.flowJson.nodes.find((n) => n.id === 'reject')!;
      const rejData = reject.data as { command: string; payload: Record<string, string> };
      expect(rejData.command).toBe('call.reject');
      expect(rejData.payload.callId).toBe('$inputs.callId');
      const edges = flow.flowJson.edges as Array<{ source: string; target: string; sourceHandle?: string }>;
      expect(edges).toContainEqual({ source: 'gate', target: 'reject', sourceHandle: 'true' });
      expect(edges).toContainEqual({ source: 'gate', target: 'push', sourceHandle: 'false' });
      // Capability for the new command rides the flow definition.
      expect(flow.nodeCapabilities).toContain('connector.aokie.call.reject');
    });

    it('the output node maps reject + rejectReason (the output-map trap: unmapped fields silently vanish)', () => {
      const out = flowBySlug('personalize-caller').flowJson.nodes.find((n) => n.type === 'output')!;
      const value = (out.data as { value: Record<string, string> }).value;
      expect(value.reject).toBe('$nodes.make.reject');
      expect(value.rejectReason).toBe('$nodes.make.rejectReason');
    });
  });

  describe('after-call-actions plan: sms_capable gate + defaultCountryCode', () => {
    const planExpr = nodeExpr('after-call-actions', 'plan');
    const booking = {
      intent: 'appointment', sentiment: 'positive', caller_name: 'Lance Baker', service: 'Haircut',
      date: futureIso, time: '14:00', summary: 'Booked a haircut.', callback_requested: false,
    };
    const scopeFor = (opts: { customer?: Record<string, unknown> | null; settings?: Record<string, unknown>; phone?: string } = {}) => ({
      inputs: { callId: 'call_1' },
      nodes: {
        ctx: { hasTranscript: true, phone: opts.phone ?? '+61400000000', customerId: opts.customer ? 'cust-1' : null, customerName: '', today: 'today' },
        extract: { content: JSON.stringify(booking) },
        calls: { responses: [{ id: 'resp-call-1', answers: {} }] },
        customers: { responses: opts.customer ? [{ id: 'cust-1', answers: opts.customer }] : [] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...(opts.settings ?? {}) } }] },
      },
    });

    it("sms_capable 'no' (landline) → NO kickoff text; the task tells a human to call", () => {
      const r = evalExpr(planExpr, scopeFor({ customer: { name: 'Lance Baker', phone: '+61400000000', sms_capable: 'no' } }));
      expect(r.hasKickoffSms).toBe(false);
      expect(r.task.sms_state).toBeUndefined();
      expect(r.task.summary).toContain('cannot receive SMS - call them to confirm');
      expect(r.summaryLine).toContain('SMS skipped (customer cannot receive SMS)');
    });

    it('a blocked customer never gets a kickoff text either', () => {
      const r = evalExpr(planExpr, scopeFor({ customer: { name: 'X', phone: '+61400000000', status: 'blocked' } }));
      expect(r.hasKickoffSms).toBe(false);
      expect(r.summaryLine).toContain('SMS skipped (customer is blocked)');
    });

    it('blank sms_capable counts as Yes (existing records unchanged); unknown numbers still text', () => {
      const known = evalExpr(planExpr, scopeFor({ customer: { name: 'Lance Baker', phone: '+61400000000' } }));
      expect(known.hasKickoffSms).toBe(true);
      const unknown = evalExpr(planExpr, scopeFor({}));
      expect(unknown.hasKickoffSms).toBe(true);
    });

    it('defaultCountryCode: a 0-prefixed number is texted as +CC…; records keep the observed number', () => {
      const r = evalExpr(planExpr, scopeFor({ phone: '0491570156', settings: { default_country_code: '+61' } }));
      expect(r.hasKickoffSms).toBe(true);
      expect(r.kickoffSms.to).toBe('+61491570156');
      // Matching is last-9-suffix everywhere: rows keep the observed format.
      expect(r.task.phone).toBe('0491570156');
      expect(r.kickoffMessage.phone).toBe('0491570156');
    });

    it("defaultCountryCode tolerance: bare '61' works, junk disables, +numbers pass through untouched", () => {
      const bare = evalExpr(planExpr, scopeFor({ phone: '0491570156', settings: { default_country_code: '61' } }));
      expect(bare.kickoffSms.to).toBe('+61491570156');
      const junk = evalExpr(planExpr, scopeFor({ phone: '0491570156', settings: { default_country_code: 'oops' } }));
      expect(junk.kickoffSms.to).toBe('0491570156');
      const intl = evalExpr(planExpr, scopeFor({ phone: '+61491570156', settings: { default_country_code: '+61' } }));
      expect(intl.kickoffSms.to).toBe('+61491570156');
      const none = evalExpr(planExpr, scopeFor({ phone: '0491570156' }));
      expect(none.kickoffSms.to).toBe('0491570156');
    });
  });

  describe('sms-followup-conversation: mid-loop no_sms stop + reply normalization', () => {
    const ctxExpr = nodeExpr('sms-followup-conversation', 'ctx');
    const planExpr = nodeExpr('sms-followup-conversation', 'plan');
    const nodesFor = (customer: Record<string, unknown> | null, settingsAnswers: Record<string, unknown> = {}) => ({
      settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...settingsAnswers } }] },
      customers: { responses: customer ? [{ id: 'c1', answers: customer }] : [] },
      tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', phone: '+61400000000', call_id: 'call_1', sms_exchanges: 1, summary: 'Confirm appointment' } }] },
      appointments: { responses: [{ id: 'appt-1', answers: { call_id: 'call_1', service: 'Haircut', date: futureIso, time: '14:00', status: 'requested' } }] },
      messages: { responses: [] },
    });
    const runCtx = (body: string, customer: Record<string, unknown> | null, settingsAnswers: Record<string, unknown> = {}) =>
      evalExpr(ctxExpr, { inputs: { from: '+61400000000', body }, nodes: nodesFor(customer, settingsAnswers) });

    it("a sender marked sms_capable 'no' (or blocked) mid-loop → verdict no_sms, LLM never runs", () => {
      expect(runCtx('how about friday', { sms_capable: 'no' }).verdict).toBe('no_sms');
      expect(runCtx('YES', { status: 'blocked' }).verdict).toBe('no_sms');
      // The flow's LLM gate only passes verdict 'llm'.
      const gate = flowBySlug('sms-followup-conversation').flowJson.nodes.find((n) => n.id === 'gate')!;
      expect(String((gate.data as { expr: string }).expr)).toContain("'llm'");
    });

    it('STOP still wins over no_sms (the opt-out must always be recorded)', () => {
      expect(runCtx('STOP', { sms_capable: 'no' }).verdict).toBe('stop');
    });

    it('a normal customer (or none on record) keeps the existing verdicts', () => {
      expect(runCtx('YES', { name: 'Lance' }).verdict).toBe('yes');
      expect(runCtx('YES', null).verdict).toBe('yes');
    });

    it('the plan turns no_sms into a human handoff with NO reply', () => {
      const r = evalExpr(planExpr, {
        inputs: { body: 'how about friday' },
        nodes: { ctx: { verdict: 'no_sms', hasTask: true, taskId: 'task-1', exchanges: 1, phone: '+61400000000' } },
      });
      expect(r.hasReply).toBe(false);
      expect(r.hasTaskUpdate).toBe(true);
      expect(r.taskUpdate.sms_state).toBe('handoff');
      expect(r.taskUpdate.priority).toBe('high');
    });

    it('ctx validates + passes the country code through; the plan normalizes the reply target with it', () => {
      expect(runCtx('YES', null, { default_country_code: '61' }).cc).toBe('+61');
      expect(runCtx('YES', null, { default_country_code: 'oops' }).cc).toBe('');
      const r = evalExpr(planExpr, {
        inputs: { body: 'YES' },
        nodes: {
          ctx: {
            verdict: 'yes', hasTask: true, taskId: 'task-1', taskCallId: 'call_1', taskCustomer: '',
            exchanges: 1, apptId: 'appt-1', apptDate: futureIso, apptTime: '14:00', apptService: 'Haircut',
            apptNotes: '', business: 'Pirate Cuts', model: '', today: 'today', llmContext: '',
            phone: '0491570156', cc: '+61',
          },
        },
      });
      expect(r.hasReply).toBe(true);
      expect(r.reply.to).toBe('+61491570156');
      // The Messages row keeps the number as observed (suffix matching).
      expect(r.outboundMessage.phone).toBe('0491570156');
    });

    it('the sender lookup is a phone_eq node feeding ctx (works at any customer count)', () => {
      const flow = flowBySlug('sms-followup-conversation');
      const cust = flow.flowJson.nodes.find((n) => n.id === 'customers')!;
      const data = cust.data as { form: string; filters: Array<{ field: string; op: string; value: string }> };
      expect(data.form).toBe('@pack:customers');
      expect(data.filters).toEqual([{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }]);
      const edges = flow.flowJson.edges as Array<{ source: string; target: string }>;
      expect(edges).toContainEqual({ source: 'customers', target: 'ctx' });
    });
  });

  describe('Phase 1 abuse handling (audit trail + no-SMS guard)', () => {
    it("Calls status offers terminated_abuse and LOGIC_CALL_ENDED passes the plugin's outcome through", () => {
      const calls = pack.forms.find((f) => f.packFormId === 'calls')!;
      const status = calls.fields.find((f) => f.id === 'status')!;
      const values = (status.properties as { options: Array<{ value: string }> }).options.map((o) => o.value);
      expect(values).toContain('terminated_abuse');
      // The app-logic whitelist must let the new outcome through — anything
      // unknown collapses to 'completed', which would hide the abuse trail.
      const app = pack.apps![0];
      const script = (app.customLogic!.scripts as Array<{ id: string; source: string }>).find(
        (s) => s.id === 'aokie-call-ended'
      )!;
      expect(script.source).toContain("outcome === 'terminated_abuse'");
    });

    it('after-call-actions never runs on an abuse-terminated call (no records/tasks/SMS off an abusive transcript)', () => {
      const binding = (pack.flowBindings ?? []).find(
        (b) => b.flow === 'after-call-actions' && b.event === 'aokie.call.ended'
      )!;
      const expr = String((binding.condition as { expr: string }).expr);
      expect(expr).toContain("!== 'terminated_abuse'");
      // Evaluate the REAL expression the runners run.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evalCond = (data: Record<string, unknown>): any =>
        new Function('event', `return ${expr};`)({ data });
      expect(evalCond({ durationSeconds: 30, outcome: 'completed' })).toBe(true);
      expect(evalCond({ durationSeconds: 30, outcome: 'terminated_abuse' })).toBe(false);
      expect(evalCond({ durationSeconds: 2, outcome: 'completed' })).toBe(false);
      // Phase 2 (live test call 2821e7e2): the inbound booking extractor must
      // never run on an OUTBOUND call — it minted a junk appointment + an
      // active SMS loop at the callee on the very first outbound test.
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'outbound' })).toBe(false);
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound' })).toBe(true);
      // Phase 3 (live call a5c3f900): nor on a MANAGER call — a manager-line
      // move was ALSO read as a new booking (duplicate appointment + kickoff
      // SMS at the manager). Manager writes ride aokie.manager.action.
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: true })).toBe(false);
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: false })).toBe(true);
      // Older plugins that don't send the flag keep working (absent ≠ true).
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: undefined })).toBe(true);
      // The summary binding still covers the Calls row for abuse calls.
      const summary = (pack.flowBindings ?? []).find(
        (b) => b.flow === 'call-summary-follow-up' && b.event === 'aokie.call.ended'
      )!;
      const sExpr = String((summary.condition as { expr: string }).expr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evalSummary = (data: Record<string, unknown>): any =>
        new Function('event', `return ${sExpr};`)({ data });
      expect(evalSummary({ durationSeconds: 30, outcome: 'terminated_abuse' })).toBe(true);
    });
  });

  describe('Phase 2: missed-call callback queue', () => {
    const taskExpr = nodeExpr('missed-call-follow-up', 'task');
    const resultExpr = nodeExpr('outbound-callback-result', 'plan');
    const runMissed = (opts: {
      phone?: string;
      customer?: Record<string, unknown> | null;
      tasks?: Array<Record<string, unknown>>;
      settings?: Record<string, unknown>;
    } = {}) =>
      evalExpr(taskExpr, {
        inputs: { callerPhone: opts.phone ?? '0491570156', callId: 'call_m1' },
        nodes: {
          customers: { responses: opts.customer ? [{ id: 'c1', answers: opts.customer }] : [] },
          tasks: { responses: (opts.tasks ?? []).map((answers, i) => ({ id: `t-${i}`, answers })) },
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...(opts.settings ?? {}) } }] },
        },
      });

    it('a dialable missed caller gets a QUEUED callback task + a composed opening line', () => {
      const r = runMissed({ customer: { name: 'Lance Baker', phone: '0491570156' }, settings: { default_country_code: '+61' } });
      expect(r.wantsCallback).toBe(true);
      expect(r.task.callback_state).toBe('queued');
      expect(r.task.summary).toContain('calling back automatically');
      expect(r.task.phone).toBe('0491570156');
      expect(r.task.call_id).toBe('call_m1');
      expect(r.task.customer_link).toBe('c1');
      expect(r.dial.number).toBe('+61491570156');
      expect(r.dial.openingLine).toContain('Hi Lance!');
      expect(r.dial.openingLine).toContain('missed your call');
      expect(r.dial.openingLine).toContain('Pirate Cuts');
      // eslint-disable-next-line no-control-regex
      expect(r.dial.openingLine).toMatch(/^[\x20-\x7E]+$/);
      expect(r.dial.purpose).toContain('RETURNING a missed call');
    });

    it('withheld ids and blocked customers never get a callback (task still raised)', () => {
      const withheld = runMissed({ phone: 'unknown' });
      expect(withheld.wantsCallback).toBe(false);
      expect(withheld.task.callback_state).toBe('');
      expect(withheld.task.summary).toContain('call back');
      const blocked = runMissed({ customer: { name: 'X', phone: '0491570156', status: 'blocked' } });
      expect(blocked.wantsCallback).toBe(false);
    });

    it('one callback per number: an already-queued open task suppresses a second dial', () => {
      const r = runMissed({ tasks: [{ status: 'open', callback_state: 'queued', phone: '0491570156' }] });
      expect(r.wantsCallback).toBe(false);
      const closed = runMissed({ tasks: [{ status: 'done', callback_state: 'reached', phone: '0491570156' }] });
      expect(closed.wantsCallback).toBe(true);
    });

    const runResult = (outcome: string, opts: {
      tasks?: Array<Record<string, unknown>>;
      customer?: Record<string, unknown> | null;
      settings?: Record<string, unknown>;
    } = {}) =>
      evalExpr(resultExpr, {
        inputs: { callId: 'call_o1', to: '0491570156', outcome },
        nodes: {
          tasks: {
            responses: (opts.tasks ?? [{ status: 'open', callback_state: 'queued', phone: '0491570156', summary: 'Missed call from Lance' }]).map(
              (answers, i) => ({ id: `t-${i}`, answers })
            ),
          },
          customers: { responses: opts.customer === null ? [] : [{ id: 'c1', answers: opts.customer ?? { name: 'Lance Baker', phone: '0491570156' } }] },
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...(opts.settings ?? {}) } }] },
        },
      });

    it('callback REACHED → task done, no SMS', () => {
      const r = runResult('completed');
      expect(r.hasTaskUpdate).toBe(true);
      expect(r.taskUpdate.status).toBe('done');
      expect(r.taskUpdate.callback_state).toBe('reached');
      expect(r.hasSms).toBe(false);
    });

    it('callback NOT answered + sms-capable → apology text (normalized to +CC), task stays open as sms_sent', () => {
      const r = runResult('no_answer', { settings: { default_country_code: '61' } });
      expect(r.hasSms).toBe(true);
      expect(r.sms.to).toBe('+61491570156');
      expect(r.sms.body).toContain('sorry we missed your call');
      expect(r.sms.body).toContain('Pirate Cuts');
      // eslint-disable-next-line no-control-regex
      expect(r.sms.body).toMatch(/^[\x20-\x7E]+$/);
      expect(r.smsMessage.status).toBe('queued');
      expect(r.taskUpdate.callback_state).toBe('sms_sent');
      expect(r.taskUpdate.status).toBeUndefined();
    });

    it('callback NOT answered + landline/blocked → needs_human at urgent priority, never a text', () => {
      const landline = runResult('no_answer', { customer: { name: 'X', phone: '0491570156', sms_capable: 'no' } });
      expect(landline.hasSms).toBe(false);
      expect(landline.taskUpdate.callback_state).toBe('needs_human');
      expect(landline.taskUpdate.priority).toBe('urgent');
      const blocked = runResult('failed', { customer: { name: 'X', phone: '0491570156', status: 'blocked' } });
      expect(blocked.hasSms).toBe(false);
      expect(blocked.taskUpdate.callback_state).toBe('needs_human');
    });

    it('an outbound call with NO queued callback (manual test dial) is a clean no-op', () => {
      const r = runResult('completed', { tasks: [] });
      expect(r.hasTaskUpdate).toBe(false);
      expect(r.hasSms).toBe(false);
      expect(r.summaryLine).toContain('no pending callback');
    });

    it('bindings: missed-call dials via output action gated on wantsCallback; outbound results route by direction', () => {
      const missed = (pack.flowBindings ?? []).find((b) => b.flow === 'missed-call-follow-up')!;
      const dialAction = (missed.outputActions ?? []).find(
        (a) => (a as { command?: string }).command === 'call.dial'
      ) as { when?: string; payload?: Record<string, string> };
      expect(dialAction).toBeDefined();
      expect(dialAction.when).toBe('$result.wantsCallback');
      expect(dialAction.payload?.openingLine).toBe('$result.dial.openingLine');
      // A missed OUTBOUND call must never trigger its own callback loop.
      const mExpr = String((missed.condition as { expr: string }).expr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evalM = (data: Record<string, unknown>): any => new Function('event', `return ${mExpr};`)({ data });
      expect(evalM({ outcome: 'missed' })).toBe(true);
      expect(evalM({ outcome: 'missed', direction: 'outbound' })).toBe(false);
      const result = (pack.flowBindings ?? []).find((b) => b.flow === 'outbound-callback-result')!;
      const rExpr = String((result.condition as { expr: string }).expr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evalR = (data: Record<string, unknown>): any => new Function('event', `return ${rExpr};`)({ data });
      expect(evalR({ outcome: 'no_answer', direction: 'outbound' })).toBe(true);
      expect(evalR({ outcome: 'completed', direction: 'inbound' })).toBe(false);
    });

    it('LOGIC_CALL_ENDED stores direction + passes no_answer through; the forms carry the new fields', () => {
      const app = pack.apps![0];
      const script = (app.customLogic!.scripts as Array<{ id: string; source: string }>).find((s) => s.id === 'aokie-call-ended')!;
      expect(script.source).toContain("outcome === 'no_answer'");
      expect(script.source).toContain("answers.direction = 'outbound'");
      const calls = pack.forms.find((f) => f.packFormId === 'calls')!;
      const status = calls.fields.find((f) => f.id === 'status')!;
      expect((status.properties as { options: Array<{ value: string }> }).options.map((o) => o.value)).toContain('no_answer');
      expect(calls.fields.some((f) => f.id === 'direction')).toBe(true);
      const tasks = pack.forms.find((f) => f.packFormId === 'follow-up-tasks')!;
      const cb = tasks.fields.find((f) => f.id === 'callback_state')!;
      expect((cb.properties as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['queued', 'reached', 'sms_sent', 'needs_human']);
    });
  });

  describe('form fields', () => {
    it("Customers has sms_capable (yes/no, blank = yes semantics documented) and the existing status dropdown offers 'blocked'", () => {
      const customers = pack.forms.find((f) => f.packFormId === 'customers')!;
      const smsCap = customers.fields.find((f) => f.id === 'sms_capable')!;
      expect(smsCap.type).toBe('dropdown');
      const values = (smsCap.properties as { options: Array<{ value: string }> }).options.map((o) => o.value);
      expect(values).toEqual(['yes', 'no']);
      const status = customers.fields.find((f) => f.id === 'status')!;
      const statusValues = (status.properties as { options: Array<{ value: string }> }).options.map((o) => o.value);
      expect(statusValues).toContain('blocked');
    });

    it('Receptionist Settings has whitelist_only + default_country_code (the flow layer reads the record per call)', () => {
      const settings = pack.forms.find((f) => f.packFormId === 'receptionist-settings')!;
      const wl = settings.fields.find((f) => f.id === 'whitelist_only')!;
      expect(wl.type).toBe('dropdown');
      expect((wl.properties as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['no', 'yes']);
      // The whitelist cannot see withheld numbers (no caller_id event) — the
      // field copy must point at the plugin's private-number screening.
      expect(String(wl.description ?? '')).toContain('WITHHOLD');
      const cc = settings.fields.find((f) => f.id === 'default_country_code')!;
      expect(cc.type).toBe('short_text');
    });
  });
});

describe('aokieReceptionistPack — catalog', () => {
  it('is registered in the pack catalog with matching counts', () => {
    const entry = packCatalog.find((e) => e.id === 'aokie-receptionist');
    expect(entry).toBeDefined();
    expect(entry!.formCount).toBe(pack.forms.length);
    expect(entry!.appCount).toBe(1);
  });
});

describe('aokieReceptionistPack — hold-abandonment follow-ups (Phase 4 hold queue)', () => {
  const flowBySlug = (slug: string) => (pack.flows ?? []).find((f) => f.slug === slug)!;
  const nodeExpr = (slug: string, nodeId: string): string => {
    const node = flowBySlug(slug).flowJson.nodes.find((n) => n.id === nodeId)!;
    return String((node.data as { expr: string }).expr);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evalExpr = (expr: string, scope: { nodes?: unknown; inputs?: unknown }): any =>
    new Function('nodes', 'inputs', `return ${expr};`)(scope.nodes ?? {}, scope.inputs ?? {});
  const future = new Date(Date.now() + 7 * 86400000);
  const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

  describe('missed-call-follow-up: hold apology + bookings context in the dial purpose', () => {
    const taskExpr = nodeExpr('missed-call-follow-up', 'task');
    const scopeFor = (inputsOver: Record<string, unknown> = {}, apptRows: unknown[] = []) => ({
      inputs: { callId: 'call_9', callerPhone: '0491570156', from: '0491570156', ...inputsOver },
      nodes: {
        customers: { first: { id: 'cust-1', answers: { name: 'Jane Customer', phone: '0491570156', status: 'active' } }, responses: [] },
        tasks: { responses: [] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', default_country_code: '61' } }] },
        appts: { responses: apptRows },
      },
    });

    it('a plain missed call keeps the classic opening + cc-normalized dial target', () => {
      const r = evalExpr(taskExpr, scopeFor());
      expect(r.wantsCallback).toBe(true);
      expect(r.dial.openingLine).toContain('sorry, we just missed your call');
      expect(r.dial.number).toBe('+61491570156');
      expect(r.dial.purpose).toContain('NO upcoming bookings');
      expect(r.task.summary).toContain('Missed call');
    });

    it('abandoned_in_queue leads with the hold apology, never the missed-call line', () => {
      const r = evalExpr(taskExpr, scopeFor({ outcome: 'abandoned_in_queue' }));
      expect(r.dial.openingLine).toContain('so sorry to keep you waiting on hold');
      expect(r.dial.openingLine).not.toContain('missed your call');
      expect(r.dial.purpose).toContain('GAVE UP WAITING ON HOLD');
      expect(r.task.summary).toContain('Caller gave up on hold');
      // Still a callback: they never got served, so ringing back is right.
      expect(r.wantsCallback).toBe(true);
    });

    it('upcoming bookings ride the purpose so the callback can answer appointment questions', () => {
      const rows = [
        { id: 'a1', answers: { date: futureIso, time: '15:00', service: 'general checkup', status: 'confirmed' } },
        { id: 'a2', answers: { date: futureIso, time: '09:30', service: 'cleaning', status: 'cancelled' } },
      ];
      const r = evalExpr(taskExpr, scopeFor({}, rows));
      expect(r.dial.purpose).toContain('THEIR UPCOMING BOOKINGS ON RECORD');
      expect(r.dial.purpose).toContain('general checkup');
      expect(r.dial.purpose).toContain('3 PM');
      // Cancelled bookings never surface; the purpose stays within the
      // plugin's 1000-char cap.
      expect(r.dial.purpose).not.toContain('cleaning');
      expect(r.dial.purpose.length).toBeLessThanOrEqual(990);
    });
  });

  describe('hold-lost-apology: SMS to a caller who hung up while parked mid-conversation', () => {
    const planExpr = nodeExpr('hold-lost-apology', 'plan');
    const scopeFor = (customer: Record<string, unknown> | null, inputsOver: Record<string, unknown> = {}) => ({
      inputs: { callId: 'call_h1', callerPhone: '0491570156', from: '0491570156', ...inputsOver },
      nodes: {
        customers: customer ? { first: { id: 'cust-1', answers: customer }, responses: [] } : { responses: [] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', default_country_code: '61' } }] },
      },
    });

    it('sms-capable caller gets the apology text (cc-normalized), never a callback dial', () => {
      const r = evalExpr(planExpr, scopeFor({ name: 'Jane Customer', status: 'active' }));
      expect(r.hasSms).toBe(true);
      expect(r.hasTask).toBe(false);
      expect(r.sms.to).toBe('+61491570156');
      expect(r.sms.body).toContain('we had you on hold and lost you');
      expect(r.sms.body).toContain('call back whenever suits');
      expect(r.sms.body.length).toBeLessThanOrEqual(440);
      expect(r.smsMessage.status).toBe('queued');
      expect(r.smsMessage.direction).toBe('outbound');
    });

    it('sms_capable No raises a human task instead of a text', () => {
      const r = evalExpr(planExpr, scopeFor({ name: 'Jane Customer', status: 'active', sms_capable: 'no' }));
      expect(r.hasSms).toBe(false);
      expect(r.hasTask).toBe(true);
      expect(r.task.summary).toContain('gave up while ON HOLD');
      expect(r.task.callback_state).toBe('');
      expect(r.task.customer_link).toBe('cust-1');
    });

    it('blocked customers and withheld numbers are a clean no-op', () => {
      const blocked = evalExpr(planExpr, scopeFor({ name: 'X', status: 'blocked' }));
      expect(blocked.hasSms).toBe(false);
      expect(blocked.hasTask).toBe(false);
      const withheld = evalExpr(planExpr, scopeFor(null, { callerPhone: '', from: '' }));
      expect(withheld.hasSms).toBe(false);
      expect(withheld.hasTask).toBe(false);
    });
  });

  describe('binding conditions route the two abandonment outcomes correctly', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evalCond = (expr: string, data: Record<string, unknown>): any =>
      new Function('event', `return ${expr};`)({ data });
    const bindingFor = (flow: string, event = 'aokie.call.ended') =>
      (pack.flowBindings ?? []).find((b) => b.flow === flow && b.event === event)!;

    it('abandoned_in_queue rings back via missed-call-follow-up; abandoned_on_hold does not', () => {
      const cond = (bindingFor('missed-call-follow-up').condition as { expr: string }).expr;
      expect(evalCond(cond, { outcome: 'abandoned_in_queue' })).toBe(true);
      expect(evalCond(cond, { outcome: 'missed' })).toBe(true);
      expect(evalCond(cond, { outcome: 'abandoned_on_hold' })).toBe(false);
      expect(evalCond(cond, { outcome: 'abandoned_in_queue', direction: 'outbound' })).toBe(false);
    });

    it('abandoned_on_hold gets the apology SMS flow; nothing else does', () => {
      const cond = (bindingFor('hold-lost-apology').condition as { expr: string }).expr;
      expect(evalCond(cond, { outcome: 'abandoned_on_hold' })).toBe(true);
      expect(evalCond(cond, { outcome: 'abandoned_in_queue' })).toBe(false);
      expect(evalCond(cond, { outcome: 'completed' })).toBe(false);
      expect(evalCond(cond, { outcome: 'abandoned_on_hold', direction: 'outbound' })).toBe(false);
    });

    it('after-call-actions skips both abandonment outcomes (no booking mining off a cut conversation)', () => {
      const cond = (bindingFor('after-call-actions').condition as { expr: string }).expr;
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'abandoned_on_hold' })).toBe(false);
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'abandoned_in_queue' })).toBe(false);
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'completed' })).toBe(true);
    });
  });
});

describe('aokieReceptionistPack — callback drain (queued callbacks dial when the line frees)', () => {
  const flowBySlug = (slug: string) => (pack.flows ?? []).find((f) => f.slug === slug)!;
  const nodeExpr = (slug: string, nodeId: string): string => {
    const node = flowBySlug(slug).flowJson.nodes.find((n) => n.id === nodeId)!;
    return String((node.data as { expr: string }).expr);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evalExpr = (expr: string, scope: { nodes?: unknown; inputs?: unknown }): any =>
    new Function('nodes', 'inputs', `return ${expr};`)(scope.nodes ?? {}, scope.inputs ?? {});
  const planExpr = nodeExpr('callback-drain', 'plan');
  const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  const task = (over: Record<string, unknown>, submittedAt?: string) => ({
    id: 't-' + Math.random().toString(36).slice(2, 8),
    submittedAt,
    answers: {
      status: 'open',
      callback_state: 'queued',
      phone: '0491570156',
      callback_number: '+61491570156',
      callback_opening: "Hi! It's the clinic - sorry we missed your call.",
      callback_purpose: 'You are returning a missed call.',
      ...over,
    },
  });

  it('dials the OLDEST fresh queued callback', () => {
    const older = task({ callback_number: '+61491570156' }, minsAgo(30));
    const newer = task({ callback_number: '+61491570157' }, minsAgo(5));
    const r = evalExpr(planExpr, { nodes: { tasks: { responses: [newer, older] } }, inputs: {} });
    expect(r.hasDial).toBe(true);
    expect(r.dial.number).toBe('+61491570156');
    expect(r.dial.openingLine).toContain('missed your call');
  });

  it('skips stale entries (>12h), tasks without a stored number, and non-queued states', () => {
    const stale = task({}, minsAgo(13 * 60));
    const numberless = task({ callback_number: '' }, minsAgo(10));
    const done = task({ status: 'done' }, minsAgo(10));
    const reached = task({ callback_state: 'reached' }, minsAgo(10));
    const r = evalExpr(planExpr, {
      nodes: { tasks: { responses: [stale, numberless, done, reached] } },
      inputs: {},
    });
    expect(r.hasDial).toBe(false);
  });

  it('no queued callbacks is a clean no-op', () => {
    const r = evalExpr(planExpr, { nodes: { tasks: { responses: [] } }, inputs: {} });
    expect(r.hasDial).toBe(false);
    expect(r.summaryLine).toContain('No queued callbacks');
  });

  it('binding fires on inbound endeds only (the callback own-ended never re-drains)', () => {
    const binding = (pack.flowBindings ?? []).find((b) => b.flow === 'callback-drain')!;
    const cond = (binding.condition as { expr: string }).expr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evalCond = (data: Record<string, unknown>): any =>
      new Function('event', `return ${cond};`)({ data });
    expect(evalCond({ outcome: 'completed' })).toBe(true);
    expect(evalCond({ outcome: 'missed', direction: '' })).toBe(true);
    expect(evalCond({ outcome: 'no_answer', direction: 'outbound' })).toBe(false);
  });

  it('the missed-call task stores the composed callback payload for the drain', () => {
    const taskExpr = nodeExpr('missed-call-follow-up', 'task');
    const r = evalExpr(taskExpr, {
      inputs: { callId: 'call_9', callerPhone: '0491570156', from: '0491570156' },
      nodes: {
        customers: { first: { id: 'cust-1', answers: { name: 'Jane', phone: '0491570156', status: 'active' } }, responses: [] },
        tasks: { responses: [] },
        settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', default_country_code: '61' } }] },
        appts: { responses: [] },
      },
    });
    expect(r.task.callback_number).toBe('+61491570156');
    expect(r.task.callback_opening).toContain('missed your call');
    expect(r.task.callback_purpose).toContain('RETURNING a missed call');
  });
});
