// Structural validation for the Aokie Receptionist pack â€” the pack is data, so a broken
// cross-reference (@pack: form ref, flow slug, logic form key, SDK screen id) would only
// surface at import/run time. These tests pin every reference the importer/runtime resolves.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack as pack, DEFAULT_PERSONA } from './pack';
import { AOKIE_CALL_TRANSCRIPT_SCREEN, compareTurns } from './screens/transcriptScreen';
import { AOKIE_DEVICE_SETUP_SCREEN } from './screens/deviceSetupScreen';
import { AOKIE_LIVE_CALL_SCREEN } from './screens/liveCallScreen';
import { AOKIE_RECEPTIONIST_SETTINGS_SCREEN } from './screens/receptionistSettingsScreen';
import { validateWorkflowGraph } from '../../../client-runtime/flows/flowExecutor';
import { loadPack, packManifests } from '../index';
import {
  buildAgentPayload,
  EMPTY_DRAFT,
  AI_GATEWAY_BASE,
  type Draft,
  type SourceService,
} from './receptionistPayload';
import {
  composeAgentPayload as screenCompose,
  DEFAULT_PERSONA as SCREEN_PERSONA,
  AI_GATEWAY_BASE as SCREEN_GATEWAY,
} from './screens/receptionist-settings/agentPayload';

describe('aokieReceptionistPack â€” shared persona (audit CROSS-SCHEMA-001)', () => {
  it("matches the cross-repo persona fixture the plugin's DEFAULT_AGENT_PERSONA is locked to", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../../../../../docs/contracts/aokie-persona.v1.json'), 'utf8')
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

// The v0 executor's node set (docs/FORMLOGIC_FLOWS.md Â§4) â€” a pack flow using anything
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
  // Read-only Desktop services listing â€” resolves `service:<id>` source picks
  // to live loopback URLs at configure time (implemented in BOTH runners).
  'desktop_services',
]);

// MVP event names the Aokie plugin emits (docs/AOKIE_PLUGIN_CONTRACT.md Â§3).
const AOKIE_EVENTS = new Set([
  'aokie.dongle.detected', 'aokie.dongle.driver_required', 'aokie.dongle.ready', 'aokie.dongle.error',
  'aokie.phone.pairing_started', 'aokie.phone.paired', 'aokie.phone.disconnected',
  'aokie.call.incoming', 'aokie.call.answered', 'aokie.call.caller_id', 'aokie.call.rejected',
  'aokie.call.turn.partial', 'aokie.call.turn.final', 'aokie.call.turn.corrected', 'aokie.call.transcript.settled', 'aokie.call.ended',
  'aokie.appointment.requested',
  'aokie.sms.received', 'aokie.sms.sent', 'aokie.sms.failed',
  'aokie.manager.action',
  'aokie.hardware.error',
]);

describe('aokieReceptionistPack â€” forms', () => {
  it('ships the plan Â§12.2 record set', () => {
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
        expect(FORM_IDS.has(target.slice(6)), `${form.packFormId}.${field.id} â†’ ${target}`).toBe(true);
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

  it('correlation keys are WRITABLE fields â€” hidden would be stripped server-side (anti-tamper)', () => {
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

describe('aokieReceptionistPack â€” app', () => {
  it('app membership + roles reference declared forms only', () => {
    for (const f of app.forms) {
      expect(FORM_IDS.has(f.packFormId), `app form '${f.packFormId}'`).toBe(true);
    }
    for (const role of app.roles) {
      for (const perm of role.permissions) {
        if (perm.packFormId === null) continue; // app-level declarative grants
        expect(FORM_IDS.has(perm.packFormId), `${role.name} â†’ '${perm.packFormId}'`).toBe(true);
      }
    }
  });

  it('declares exactly the companion-relay included service, honestly worded (pack services wave 1)', () => {
    // The importer composes settings.services['companion-relay'] from this declaration and
    // the backend gates the Companion admission endpoints on the owner's toggle.
    expect(app.services).toBeDefined();
    expect(app.services).toHaveLength(1);
    const svc = app.services![0];
    expect(svc.id).toBe('companion-relay');
    expect(svc.defaultEnabled).toBe(true);
    expect(svc.title).toBe('Companion app relay');
    // The description must carry the honest trust framing: relayed traffic is
    // signature-verified but READABLE by the relay host, and call audio never
    // transits the relay.
    expect(svc.description).toMatch(/signature-verified/i);
    expect(svc.description).toMatch(/readable by the relay host/i);
    expect(svc.description).toMatch(/audio never passes through/i);
    // Slug shape matches the backend validator (^[a-z0-9][a-z0-9-]{1,40}$).
    expect(svc.id).toMatch(/^[a-z0-9][a-z0-9-]{1,40}$/);
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

  it('logic scripts reference forms by stable packFormIds â€” never rename-able labels (audit FL-007)', () => {
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
    // Node env â€” read the registration calls from source instead of importing React modules.
    const dir = join(__dirname, '..', '..', '..', 'components', 'custom-screen');
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
    // ALL three aokie section screens are pack-owned CODE now (plan §8.4 ports
    // #3/#4/#6): transcript, Device Setup, Live Call, and Receptionist Settings.
    // No compiled sdk section reference remains — the epic's screens are
    // self-contained. (The compiled screens stay in the registry for rollback.)
    expect(used.sort()).toEqual([]);
    for (const id of used) {
      expect(registered.has(id), `SDK screen '${id}' is not registered`).toBe(true);
    }
  });
});

describe('aokieReceptionistPack â€” pack-owned Calls transcript record screen (plan APP-505 PoC)', () => {
  const calls = pack.forms.find((f) => f.packFormId === 'calls');
  const rs = calls?.customScreen?.recordScreen;

  it('ships the transcript as pack-owned CODE, not a compiled-registry reference', () => {
    expect(rs?.kind).toBe('code');
    // No registry coupling left: the source travels with the pack.
    expect(rs?.screenId).toBeUndefined();
    expect(rs?.js).toBeUndefined();
    expect(rs?.entry).toBe('index.tsx');
    expect((rs?.files ?? []).map((f) => f.path)).toEqual(['index.tsx', 'sort.ts', 'styles.css']);
    expect(rs?.files).toEqual(AOKIE_CALL_TRANSCRIPT_SCREEN.files);
    // The generic related panel keeps hiding the group this widget renders itself â€”
    // packFormId-qualified because follow-up-tasks also link via a call_link field.
    expect(rs?.consumesRelated).toEqual(['transcript-turns.call_link']);
  });

  it('the TSX source renders record data as JSX text and marks audio-model corrections', () => {
    const js = (rs?.files ?? []).map((f) => f.content).join('\n');
    // JSX text auto-escapes; the source must never open a raw-HTML sink for record data.
    expect(js).not.toContain('dangerouslySetInnerHTML');
    expect(js).not.toContain('innerHTML');
    // Corrected-turn affordance: rows the audio model re-heard carry the tooltip.
    expect(js).toContain("f.source === 'audio_model'");
    expect(js).toContain('Corrected by the audio model');
    // The embedded comparator IS the exported (unit-tested) helper â€” one source of truth.
    expect(js).toContain('export function compareTurns');
    expect(js).toContain("import { compareTurns } from './sort'");
    // Data path: record screens read the record's related groups via the bridge.
    expect(js).toContain('FormLogic.related()');
  });

  it('the related columns feed the screen what it renders (timestamp for ordering, source for corrections)', () => {
    const turns = pack.forms.find((f) => f.packFormId === 'transcript-turns');
    const link = turns?.fields.find((f) => f.id === 'call_link');
    expect(link?.properties?.relatedColumnFieldIds).toEqual(['speaker', 'text', 'turn_index', 'timestamp', 'source']);
  });

  it('orders turns by speech-start stamp, then turn number, then commit time', () => {
    const t = (spokenAt: string | null, turnIndex: number | null, submittedAt: string, id: string) =>
      ({ spokenAt, turnIndex, submittedAt, id });
    // A caller line spoken OVER a bot reply (back-dated spokenAt, committed AFTER it)
    // must sort where it was SAID â€” the exact overlap case the stamp exists for.
    const bot = t('2026-07-17T00:00:05Z', 4, '2026-07-17T00:00:06Z', 'bot');
    const overlap = t('2026-07-17T00:00:03Z', 5, '2026-07-17T00:00:09Z', 'overlap');
    expect([bot, overlap].sort(compareTurns).map((x) => x.id)).toEqual(['overlap', 'bot']);
    // Stamp-less rows (older plugins) fall back to the turn numberâ€¦
    const a = t(null, 2, '2026-07-17T00:00:01Z', 'a');
    const b = t(null, 1, '2026-07-17T00:00:02Z', 'b');
    expect([a, b].sort(compareTurns).map((x) => x.id)).toEqual(['b', 'a']);
    // â€¦a stamped row against a stamp-less one also uses the turn numberâ€¦
    const c = t('2026-07-17T00:00:01Z', 3, '2026-07-17T00:00:01Z', 'c');
    const d = t(null, 2, '2026-07-17T00:00:05Z', 'd');
    expect([c, d].sort(compareTurns).map((x) => x.id)).toEqual(['d', 'c']);
    // â€¦and submittedAt breaks the remaining ties.
    const e = t(null, null, '2026-07-17T00:00:02Z', 'e');
    const f = t(null, null, '2026-07-17T00:00:01Z', 'f');
    expect([e, f].sort(compareTurns).map((x) => x.id)).toEqual(['f', 'e']);
    // Equal stamps defer to the turn number (two lines in the same second).
    const g = t('2026-07-17T00:00:01Z', 2, '2026-07-17T00:00:04Z', 'g');
    const h = t('2026-07-17T00:00:01Z', 1, '2026-07-17T00:00:03Z', 'h');
    expect([g, h].sort(compareTurns).map((x) => x.id)).toEqual(['h', 'g']);
  });
});

describe('aokieReceptionistPack â€” flows & bindings', () => {
  it('ships the starter flows on valid v0 graphs', () => {
    expect([...FLOW_SLUGS].sort()).toEqual([
      'after-call-actions',
      'appointment-request-apply',
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
          expect(FORM_IDS.has(ref.slice(6)), `${flow.slug} node '${node.id}' â†’ ${ref}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(0); // caller lookup + summary flows read forms by ref
  });

  it('bindings reference declared flows, contract events, and declared forms', () => {
    expect(pack.flowBindings?.length).toBe(17);
    for (const binding of pack.flowBindings ?? []) {
      expect(FLOW_SLUGS.has(binding.flow), `binding â†’ flow '${binding.flow}'`).toBe(true);
      expect(AOKIE_EVENTS.has(binding.event), `binding event '${binding.event}'`).toBe(true);
      expect(['sync', 'async', 'background', 'manual']).toContain(binding.mode);
      for (const ref of collectPackRefs(binding)) {
        expect(FORM_IDS.has(ref), `binding '${binding.flow}' â†’ @pack:${ref}`).toBe(true);
      }
      // Live-call decisions must stay inside the 2â€“4s budget with a spoken fallback (Â§9.7).
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

describe('aokieReceptionistPack â€” deterministic Realtime appointment requests', () => {
  const exprFor = (slug: string, nodeId: string): string => {
    const flow = (pack.flows ?? []).find((f) => f.slug === slug)!;
    const node = flow.flowJson.nodes.find((n) => n.id === nodeId)!;
    return (node.data as { expr: string }).expr;
  };
  const evaluate = (expr: string, inputs: Record<string, unknown>, nodes: Record<string, unknown>): any =>
    new Function('inputs', 'nodes', `return ${expr};`)(inputs, nodes);
  const futureDate = (): string => {
    const d = new Date(Date.now() + 5 * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const baseInput = () => ({
    requestId: 'apptreq_0123456789abcdef0123456789abcdef',
    callId: 'call_5685374790b241a1a48dd8549c0c6a4c',
    from: '+61400000000',
    callerName: 'Lance',
    service: 'Lawn mowing',
    date: futureDate(),
    time: '10:00',
    agreementTurn: 6,
    at: new Date().toISOString(),
  });
  const emptyNodes = (callId: string) => ({
    requestAppointments: { responses: [] },
    callAppointments: { responses: [] },
    requestTasks: { responses: [] },
    callTasks: { responses: [] },
    calls: { responses: [{ id: 'call-response-1', answers: { call_id: callId } }] },
    customers: { responses: [] },
    phoneTasks: { responses: [] },
    settings: { responses: [{ id: 'settings-1', answers: { business_name: 'Test Business', default_country_code: '61', active: 'yes' } }] },
  });

  it('uses no LLM and writes Appointment before its confirmation task', () => {
    const flow = (pack.flows ?? []).find((f) => f.slug === 'appointment-request-apply')!;
    expect(flow.flowJson.nodes.some((node) => node.type === 'llm_chat')).toBe(false);
    const binding = (pack.flowBindings ?? []).find((item) => item.flow === 'appointment-request-apply')!;
    expect(binding.event).toBe('aokie.appointment.requested');
    expect(binding.outputActions?.slice(0, 3)).toMatchObject([
      { type: 'formlogic.submitResponse', form: '@pack:appointments' },
      { type: 'formlogic.updateResponse', form: '@pack:follow-up-tasks' },
      { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks' },
    ]);
  });

  it('validates and creates a requested appointment first-class, never a confirmed booking', () => {
    const input = baseInput();
    const result = evaluate(exprFor('appointment-request-apply', 'plan'), input, emptyNodes(input.callId));
    expect(result.ok).toBe(true);
    expect(result.hasAppointment).toBe(true);
    expect(result.appointment).toMatchObject({
      request_id: input.requestId,
      call_id: input.callId,
      service: 'Lawn mowing',
      date: input.date,
      time: '10:00',
      status: 'requested',
      source: 'call',
    });
    expect(result.appointment.notes).toContain('request only');
    expect(result.hasTask).toBe(true);
    expect(result.task).toMatchObject({ request_id: input.requestId, call_id: input.callId, status: 'open', priority: 'high' });
    expect(result.task.summary).toContain('NOT yet confirmed');
  });

  it('deduplicates exact replays by request_id and call_id', () => {
    const input = baseInput();
    const appt = { request_id: input.requestId, call_id: input.callId, service: input.service, date: input.date, time: input.time, status: 'requested' };
    const task = { request_id: input.requestId, call_id: input.callId, status: 'open' };
    const nodes = emptyNodes(input.callId);
    nodes.requestAppointments.responses = [{ id: 'appt-1', answers: appt }];
    nodes.callAppointments.responses = [{ id: 'appt-1', answers: appt }];
    nodes.requestTasks.responses = [{ id: 'task-1', answers: task }];
    nodes.callTasks.responses = [{ id: 'task-1', answers: task }];
    const result = evaluate(exprFor('appointment-request-apply', 'plan'), input, nodes);
    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(true);
    expect(result.hasAppointment).toBe(false);
    expect(result.hasTask).toBe(false);
  });

  it('kicks off the SMS confirmation loop for a new realtime booking', () => {
    const input = { ...baseInput(), from: '0491570156' };
    const result = evaluate(exprFor('appointment-request-apply', 'plan'), input, emptyNodes(input.callId));
    expect(result.hasKickoffSms).toBe(true);
    expect(result.kickoffSms.to).toBe('+61491570156');
    expect(result.kickoffSms.body).toContain("It's Test Business");
    expect(result.kickoffSms.body).toContain('Lawn mowing');
    expect(result.kickoffSms.body).toContain('Reply YES to confirm');
    expect(result.kickoffSms.body).toContain('Reply STOP to opt out');
    expect(result.kickoffSms.body.length).toBeLessThanOrEqual(440);
    expect([...result.kickoffSms.body].every((ch: string) => ch >= ' ' && ch <= '~')).toBe(true);
    expect(result.kickoffMessage).toMatchObject({
      message_id: `smskick_${input.requestId}`.slice(0, 64),
      phone: '0491570156',
      direction: 'outbound',
      status: 'queued',
    });
    expect(result.task.sms_state).toBe('active');
    expect(result.task.sms_exchanges).toBe(1);
  });

  it('never kicks off SMS for duplicates, blocked or SMS-incapable customers', () => {
    const input = { ...baseInput(), from: '0491570156' };
    // Duplicate replay: no second SMS.
    const appt = { request_id: input.requestId, call_id: input.callId, service: input.service, date: input.date, time: input.time, status: 'requested' };
    const task = { request_id: input.requestId, call_id: input.callId, status: 'open' };
    const dupNodes = emptyNodes(input.callId);
    dupNodes.requestAppointments.responses = [{ id: 'appt-1', answers: appt }];
    dupNodes.callAppointments.responses = [{ id: 'appt-1', answers: appt }];
    dupNodes.requestTasks.responses = [{ id: 'task-1', answers: task }];
    dupNodes.callTasks.responses = [{ id: 'task-1', answers: task }];
    let result = evaluate(exprFor('appointment-request-apply', 'plan'), input, dupNodes);
    expect(result.hasKickoffSms).toBe(false);

    // Blocked customer: task only, no text.
    const blockedNodes = emptyNodes(input.callId);
    (blockedNodes.customers.responses as unknown[]).push({ id: 'cust-1', answers: { phone: input.from, status: 'blocked' } });
    result = evaluate(exprFor('appointment-request-apply', 'plan'), input, blockedNodes);
    expect(result.hasKickoffSms).toBe(false);
    expect(result.hasTask).toBe(true);
    expect(result.task.sms_state).toBeUndefined();

    // sms_capable No (landline): task only.
    const landlineNodes = emptyNodes(input.callId);
    (landlineNodes.customers.responses as unknown[]).push({ id: 'cust-2', answers: { phone: input.from, status: 'active', sms_capable: 'No' } });
    result = evaluate(exprFor('appointment-request-apply', 'plan'), input, landlineNodes);
    expect(result.hasKickoffSms).toBe(false);
  });

  it('supersedes an active SMS loop from another call, never its own', () => {
    const input = { ...baseInput(), from: '0491570156' };
    const nodes = emptyNodes(input.callId);
    (nodes.phoneTasks.responses as unknown[]).push({
      id: 'prior-task-1',
      answers: { call_id: 'call_other_1234567890abcdef', status: 'open', sms_state: 'active', summary: 'Confirm gardening' },
    });
    let result = evaluate(exprFor('appointment-request-apply', 'plan'), input, nodes);
    expect(result.hasPriorTaskClose).toBe(true);
    expect(result.priorTaskId).toBe('prior-task-1');
    expect(result.priorTaskUpdate).toMatchObject({ status: 'done', sms_state: 'done' });
    expect(result.priorTaskUpdate.summary).toContain('superseded');

    const ownNodes = emptyNodes(input.callId);
    (ownNodes.phoneTasks.responses as unknown[]).push({
      id: 'own-task-1',
      answers: { call_id: input.callId, status: 'open', sms_state: 'active', summary: 'Same call loop' },
    });
    result = evaluate(exprFor('appointment-request-apply', 'plan'), input, ownNodes);
    expect(result.hasPriorTaskClose).toBe(false);
  });

  it('wires the kickoff SMS actions after the task and before the toast', () => {
    const binding = (pack.flowBindings ?? []).find((item) => item.flow === 'appointment-request-apply')!;
    const types = (binding.outputActions ?? []).map((action) => `${action.type}:${(action as { form?: string; command?: string }).form ?? (action as { command?: string }).command ?? ''}`);
    expect(types).toEqual([
      'formlogic.submitResponse:@pack:appointments',
      'formlogic.updateResponse:@pack:follow-up-tasks',
      'formlogic.submitResponse:@pack:follow-up-tasks',
      'formlogic.updateResponse:@pack:calls',
      'formlogic.submitResponse:@pack:sms-messages',
      'connector.request:sms.send',
      'formlogic.toast:',
    ]);
  });

  it('fails closed on malformed dates and request-id collisions', () => {
    const malformed = baseInput();
    malformed.date = '2026-02-31';
    let result = evaluate(exprFor('appointment-request-apply', 'plan'), malformed, emptyNodes(malformed.callId));
    expect(result.ok).toBe(false);
    expect(result.hasAppointment).toBe(false);
    expect(result.hasTask).toBe(false);

    const input = baseInput();
    const nodes = emptyNodes(input.callId);
    nodes.requestAppointments.responses = [{ id: 'appt-other', answers: { request_id: input.requestId, call_id: 'call_someone_else', service: input.service, date: input.date, time: input.time } }];
    result = evaluate(exprFor('appointment-request-apply', 'plan'), input, nodes);
    expect(result.ok).toBe(false);
    expect(result.summaryLine).toContain('collides');
  });

  it('after-call enrichment sees the direct request and skips duplicate appointment, task, and SMS', () => {
    const input = baseInput();
    const apptRow = {
      id: 'appt-direct',
      answers: {
        request_id: input.requestId,
        call_id: input.callId,
        phone: input.from,
        service: input.service,
        date: input.date,
        time: input.time,
        status: 'requested',
      },
    };
    const taskRow = { id: 'task-direct', answers: { request_id: input.requestId, call_id: input.callId, phone: input.from, status: 'open' } };
    const result = evaluate(exprFor('after-call-actions', 'plan'), { callId: input.callId }, {
      ctx: { hasTranscript: true, phone: input.from, customerId: null, customerName: '' },
      extract: { content: JSON.stringify({
        intent: 'appointment', sentiment: 'positive', caller_name: input.callerName,
        service: input.service, appointments: [{ service: input.service, date: input.date, time: input.time }],
        summary: 'Caller requested lawn mowing.', callback_requested: false,
      }) },
      calls: { responses: [{ id: 'call-response-1', answers: {} }] },
      appts: { responses: [apptRow] },
      direct_appts: { responses: [apptRow] },
      tasks: { responses: [taskRow] },
      direct_tasks: { responses: [taskRow] },
      settings: { responses: [] },
      customers: { responses: [] },
    });
    expect(result.hasAppointment).toBe(false);
    expect(result.hasTask).toBe(false);
    expect(result.hasKickoffSms).toBe(false);
  });
});

describe('aokieReceptionistPack â€” reply_mode (agent vs flow toggle)', () => {
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

  it("Configure Receptionist resolves the cfg block's whole dynamic settings payload", () => {
    const push = configureFlow.flowJson.nodes.find((n) => n.id === 'push')!;
    expect((push.data as { payload?: unknown }).payload).toBe('$nodes.cfg.settingsPayload');
  });

  it('declares connector.aokie.settings.set â€” the same command, so no capability change is needed for the richer payload', () => {
    // The runtime capability gate (desktop runner.rs connector_request / TS nodes.ts
    // requireConnectorCapability) matches on exact `connector.<id>.<command>` or the
    // wildcard `connector.<id>.*` â€” it never inspects individual payload keys â€” so adding
    // aiReceptionist to settings.set's payload needs no new nodeCapabilities entry.
    expect(configureFlow.nodeCapabilities).toContain('connector.aokie.settings.set');
  });

  // FLOW_AGENT_CONFIG is an inline (unexported) logic_block expression string; evaluate it
  // exactly as the executor does â€” as a plain JS expression with `nodes` in scope â€” rather
  // than re-deriving its logic, so this test exercises the real shipped source.
  function runAgentConfig(
    answers: Record<string, unknown> | null,
    services?: Array<Record<string, unknown>>,
  ): {
    aiReceptionist: boolean;
    aiEndpoint?: string;
    applyAiEndpoint: boolean;
    applyAiModel: boolean;
    sttEndpoint: string;
    ttsEndpoint: string;
    audioTranscriptEndpoint: string;
    settingsPayload: Record<string, unknown>;
  } {
    const cfgNode = configureFlow.flowJson.nodes.find((n) => n.id === 'cfg')!;
    const expr = (cfgNode.data as { expr: string }).expr;
    const nodes = {
      settings: { responses: answers ? [{ answers }] : [] },
      svc: services ? { services } : undefined,
    };
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

  // â”€â”€ Source picks (CON-301/302): laneUrl resolution inside FLOW_AGENT_CONFIG â”€â”€
  const RUNNING_SVCS = [
    { id: 'llama-cpp', name: 'llama.cpp server', status: 'running', port: 8080, url: 'http://127.0.0.1:8080' },
    { id: 'aokie-voice', name: 'Aokie Voice', status: 'stopped', port: 17920, url: '' },
  ];

  it('service: pick resolves to the RUNNING service URL + the lane path', () => {
    const r = runAgentConfig({ llm_source: 'service:llama-cpp' }, RUNNING_SVCS);
    expect(r.aiEndpoint).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('service: pick of a STOPPED service resolves to blank (plugin default), never a dead URL', () => {
    const r = runAgentConfig({ tts_source: 'service:aokie-voice', tts_endpoint: 'http://x/legacy' }, RUNNING_SVCS);
    expect(r.ttsEndpoint).toBe('');
  });

  it('service: pick with NO desktop listing (svc node empty/absent) resolves blank', () => {
    expect(runAgentConfig({ llm_source: 'service:llama-cpp' }).aiEndpoint).toBe('');
    expect(runAgentConfig({ llm_source: 'service:llama-cpp' }, []).aiEndpoint).toBe('');
  });

  it('blank LLM preserves Desktop ownership, while legacy URL/custom selections still apply', () => {
    const r = runAgentConfig({ llm_endpoint: ' http://127.0.0.1:9999/v1/chat/completions ' }, RUNNING_SVCS);
    expect(r.aiEndpoint).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(r.applyAiEndpoint).toBe(true);
    expect(r.applyAiModel).toBe(true);
    expect(r.settingsPayload.aiEndpoint).toBe(r.aiEndpoint);
    expect(r.settingsPayload.aiModel).toBe('');
    const c = runAgentConfig(
      { stt_source: 'custom', stt_endpoint: 'http://127.0.0.1:17920/v1/audio/transcriptions' },
      RUNNING_SVCS,
    );
    expect(c.sttEndpoint).toBe('http://127.0.0.1:17920/v1/audio/transcriptions');
    const blank = runAgentConfig({}, RUNNING_SVCS);
    expect(blank.aiEndpoint).toBeUndefined();
    expect(blank.applyAiEndpoint).toBe(false);
    expect(blank.applyAiModel).toBe(false);
    expect('aiEndpoint' in blank.settingsPayload).toBe(false);
    expect('aiModel' in blank.settingsPayload).toBe(false);
    const modelOnly = runAgentConfig({ model: 'desktop-compatible-model' }, RUNNING_SVCS);
    expect(modelOnly.aiEndpoint).toBeUndefined();
    expect(modelOnly.applyAiEndpoint).toBe(false);
    expect(modelOnly.applyAiModel).toBe(true);
    expect('aiEndpoint' in modelOnly.settingsPayload).toBe(false);
    expect(modelOnly.settingsPayload.aiModel).toBe('desktop-compatible-model');
    const clear = runAgentConfig({ llm_source: 'custom' }, RUNNING_SVCS);
    expect(clear.aiEndpoint).toBe('');
    expect(clear.applyAiEndpoint).toBe(true);
    expect(clear.applyAiModel).toBe(true);
    expect(clear.settingsPayload.aiEndpoint).toBe('');
    expect(clear.settingsPayload.aiModel).toBe('');
  });

  // â”€â”€ provider: picks (SRC-203): the desktop AI gateway's per-provider OpenAI base â”€â”€
  it('provider: pick on the LLM lane composes the FIXED desktop AI-gateway URL â€” even with no services listed', () => {
    // Must match the desktop's gateway routes exactly:
    //   POST /api/ai/providers/:id/v1/chat/completions (and GET .../v1/models,
    //   which the plugin's LlmClient derives by replacing /chat/completions).
    const url = 'http://127.0.0.1:17872/api/ai/providers/my-openai/v1/chat/completions';
    const configured = runAgentConfig({ llm_source: 'provider:my-openai' }, RUNNING_SVCS);
    expect(configured.aiEndpoint).toBe(url);
    expect(configured.settingsPayload.aiEndpoint).toBe(url);
    // The gateway port is fixed â€” no desktop_services lookup is needed, so the
    // URL is emitted even when the svc node lists nothing / is absent.
    expect(runAgentConfig({ llm_source: 'provider:my-openai' }, []).aiEndpoint).toBe(url);
    expect(runAgentConfig({ llm_source: 'provider:my-openai' }).aiEndpoint).toBe(url);
  });

  it('provider: transcription picks compose the Desktop multipart route while TTS remains gated', () => {
    const r = runAgentConfig(
      { stt_source: 'provider:my-openai', stt_endpoint: 'http://x/legacy', tts_source: 'provider:my-openai' },
      RUNNING_SVCS,
    );
    expect(r.sttEndpoint).toBe(
      'http://127.0.0.1:17872/api/ai/providers/my-openai/v1/audio/transcriptions',
    );
    expect(r.ttsEndpoint).toBe('');
    expect('sttModel' in r.settingsPayload).toBe(false);
  });

  // â”€â”€ Correction lane (audioTranscript side runs): correction_source â†’
  // audioTranscriptEndpoint, the SAME laneUrl rule with the CHAT path (the
  // plugin's correction client is LlmClient â€” a full /v1/chat/completions URL).
  it('correction_source service pick resolves to the running service URL + the CHAT path', () => {
    const r = runAgentConfig({ correction_source: 'service:llama-cpp' }, RUNNING_SVCS);
    expect(r.audioTranscriptEndpoint).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('correction_source of a STOPPED service resolves to blank (main reply model), never a dead URL', () => {
    const r = runAgentConfig(
      { correction_source: 'service:aokie-voice', correction_endpoint: 'http://x/legacy' },
      RUNNING_SVCS,
    );
    expect(r.audioTranscriptEndpoint).toBe('');
  });

  it('correction_source custom uses the correction_endpoint field; blank pushes "" (clears = main model)', () => {
    const c = runAgentConfig(
      { correction_source: 'custom', correction_endpoint: 'http://127.0.0.1:8081/v1/chat/completions' },
      RUNNING_SVCS,
    );
    expect(c.audioTranscriptEndpoint).toBe('http://127.0.0.1:8081/v1/chat/completions');
    expect(runAgentConfig({}, RUNNING_SVCS).audioTranscriptEndpoint).toBe('');
    expect(runAgentConfig(null).audioTranscriptEndpoint).toBe('');
  });

  it('blank stt/tts source semantics are UNCHANGED â€” the aokie-stt/aokie-tts default is a CONSOLE-side record write', () => {
    const svcs = [
      ...RUNNING_SVCS,
      { id: 'aokie-stt', name: 'Aokie Speech-to-Text', status: 'running', port: 17921, url: 'http://127.0.0.1:17921' },
      { id: 'aokie-tts', name: 'Aokie Text-to-Speech', status: 'running', port: 17922, url: 'http://127.0.0.1:17922' },
    ];
    // Blank stays "plugin default" in the flow even when the Aokie services runâ€¦
    const blank = runAgentConfig({}, svcs);
    expect(blank.sttEndpoint).toBe('');
    expect(blank.ttsEndpoint).toBe('');
    // â€¦the console defaults NEW/blank records by WRITING the pick explicitly.
    const picked = runAgentConfig({ stt_source: 'service:aokie-stt', tts_source: 'service:aokie-tts' }, svcs);
    expect(picked.sttEndpoint).toBe('http://127.0.0.1:17921/v1/audio/transcriptions');
    expect(picked.ttsEndpoint).toBe('http://127.0.0.1:17922/v1/audio/speech');
  });

  // â”€â”€ Console mirror parity: buildAgentPayload must compose the SAME endpoints
  // as this flow for every source-pick shape ("Save & apply now" and the
  // per-call Configure flow can never disagree).
  describe('console mirror (buildAgentPayload) parity', () => {
    const draftFor = (over: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...over });
    const asSourceServices = (svcs: Array<Record<string, unknown>>): SourceService[] =>
      svcs.map((s) => ({
        id: String(s.id),
        name: String(s.name ?? s.id),
        category: String(s.category ?? ''),
        status: String(s.status ?? ''),
        url: String(s.url ?? ''),
      }));

    const CASES: Array<[string, Partial<Draft>]> = [
      ['running service pick', { llm_source: 'service:llama-cpp' }],
      ['stopped service pick', { tts_source: 'service:aokie-voice', tts_endpoint: 'http://x/legacy' }],
      ['provider pick (LLM lane)', { llm_source: 'provider:my-openai' }],
      ['provider pick with chars needing encoding', { llm_source: 'provider:acme corp' }],
      ['provider transcription + gated TTS picks', { stt_source: 'provider:my-openai', tts_source: 'provider:my-openai' }],
      ['custom URLs', { llm_source: 'custom', llm_endpoint: 'http://127.0.0.1:9999/v1/chat/completions' }],
      ['blank + legacy endpoint field', { stt_endpoint: 'http://127.0.0.1:17920/v1/audio/transcriptions' }],
      ['correction service pick', { correction_source: 'service:llama-cpp' }],
      ['correction stopped service pick', { correction_source: 'service:aokie-voice', correction_endpoint: 'http://x/legacy' }],
      ['correction custom URL', { correction_source: 'custom', correction_endpoint: 'http://127.0.0.1:8081/v1/chat/completions' }],
      ['all blank', {}],
    ];

    it.each(CASES)('%s', (_name, over) => {
      const flow = runAgentConfig(over as Record<string, unknown>, RUNNING_SVCS);
      const ui = buildAgentPayload(draftFor(over), asSourceServices(RUNNING_SVCS));
      expect(ui.aiEndpoint).toBe(flow.aiEndpoint);
      expect(ui.sttEndpoint).toBe(flow.sttEndpoint);
      expect(ui.ttsEndpoint).toBe(flow.ttsEndpoint);
      expect(ui.audioTranscriptEndpoint).toBe(flow.audioTranscriptEndpoint);
    });

    it('provider: composes identically with NO listing at all (remote console â†” empty svc node)', () => {
      const ui = buildAgentPayload(draftFor({ llm_source: 'provider:my-openai' }));
      const flow = runAgentConfig({ llm_source: 'provider:my-openai' });
      expect(ui.aiEndpoint).toBe(flow.aiEndpoint);
      expect(ui.aiEndpoint).toBe('http://127.0.0.1:17872/api/ai/providers/my-openai/v1/chat/completions');
    });

    it('unresolvable service picks are OMITTED by the console (undefined services) so the per-call flow owns them', () => {
      const ui = buildAgentPayload(draftFor({ llm_source: 'service:llama-cpp', correction_source: 'service:llama-cpp' }));
      expect('aiEndpoint' in ui).toBe(false);
      expect('audioTranscriptEndpoint' in ui).toBe(false);
    });

    it('the console never pushes audioTranscriptModel â€” the chosen correction service owns its model', () => {
      const ui = buildAgentPayload(draftFor({ correction_source: 'service:llama-cpp' }), asSourceServices(RUNNING_SVCS));
      expect('audioTranscriptModel' in ui).toBe(false);
      expect(ui.audioTranscriptEndpoint).toBe('http://127.0.0.1:8080/v1/chat/completions');
    });

    // PERSONA + GREETING parity flow↔console (review 2026-07-18: the endpoint
    // cases above don't cover persona/greeting composition — the business prefix,
    // BUSINESS INFO block and default-greeting must also never drift).
    it.each([
      ['default persona + default greeting', {}],
      ['business prefix + custom greeting', { business_name: 'Bright Smile Dental', greeting: 'Gday!' }],
      ['custom instructions + business info + default greeting', { business_name: 'Acme', instructions: 'Be brief.', business_info: 'Open 9-5. Checkup $90.' }],
    ] as Array<[string, Partial<Draft>]>)('persona/greeting: %s', (_name, over) => {
      const flow = runAgentConfig(over as Record<string, unknown>) as unknown as { persona: string; greeting: string };
      const ui = buildAgentPayload(draftFor(over));
      expect(ui.persona).toBe(flow.persona);
      expect(ui.greeting).toBe(flow.greeting);
    });

    // ── The pack-owned settings screen embeds composeAgentPayload via toString().
    // This is the THIRD lock-step surface (flow ≡ buildAgentPayload ≡ embedded
    // copy). Evaluate the embedded copy exactly as the sandbox does and deep-equal
    // the WHOLE payload — persona/greeting/ttsVoice/aiModel/aiReceptionist AND the
    // four endpoints — so persona/business-info/greeting composition can't drift.
    describe('sandbox embed (composeAgentPayload) parity', () => {
      // The pack-owned settings screen ships composeAgentPayload as a REAL source
      // file (aokie-screens/receptionist-settings/agentPayload.ts) inside its
      // customScreen.files. Import the SHIPPED module directly and call it exactly
      // as the sandbox does.
      const embedded = (draft: Draft, svcs: SourceService[] | undefined): Record<string, unknown> =>
        screenCompose(draft as never, svcs as never, SCREEN_PERSONA, SCREEN_GATEWAY) as Record<string, unknown>;

      it('the shipped constants strict-equal the canonical persona + gateway base', () => {
        expect(SCREEN_PERSONA).toBe(DEFAULT_PERSONA);
        expect(SCREEN_GATEWAY).toBe(AI_GATEWAY_BASE);
        // The shipped module travels in the screen's files (not just the repo).
        const shipped = (AOKIE_RECEPTIONIST_SETTINGS_SCREEN.files as Array<{ path: string }>).map((f) => f.path);
        expect(shipped).toContain('agentPayload.ts');
      });

      it.each(CASES)('whole-payload deep-equal vs buildAgentPayload: %s', (_name, over) => {
        const draft = draftFor(over);
        const svcs = asSourceServices(RUNNING_SVCS);
        expect(embedded(draft, svcs)).toEqual(buildAgentPayload(draft, svcs));
      });

      it('matches for a rich draft (persona prefix + business info + greeting default + voice/model/mode)', () => {
        const draft = draftFor({
          business_name: 'Bright Smile Dental',
          instructions: 'Be warm. Book Mon-Fri 9-5.',
          business_info: 'Checkup $90. Open 9-5.',
          voice: 'amy',
          model: 'llama3.1:8b',
          reply_mode: 'flow',
        });
        expect(embedded(draft, undefined)).toEqual(buildAgentPayload(draft, undefined));
      });

      it('omits unresolvable service picks in the embed too (remote console → per-call flow owns them)', () => {
        const draft = draftFor({ llm_source: 'service:llama-cpp', correction_source: 'service:llama-cpp' });
        const p = embedded(draft, undefined);
        expect('aiEndpoint' in p).toBe(false);
        expect('audioTranscriptEndpoint' in p).toBe(false);
        expect(p).toEqual(buildAgentPayload(draft, undefined));
      });
    });
  });
});

describe('aokieReceptionistPack â€” SMS follow-up loop (logic blocks)', () => {
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

    it('booking intent + real caller number â†’ kickoff SMS + SMS-managed task + correlated appointment', () => {
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

    it('withheld caller number â†’ no kickoff, task stays human-only', () => {
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

    it('active SMS-managed task â†’ gate false (no draft; the loop answers)', () => {
      expect(evalExpr(gateExpr, withTask({ status: 'open', sms_state: 'active' }))).toBe(false);
    });
    it('opted-out sender â†’ gate false (no draft at all after STOP)', () => {
      expect(evalExpr(gateExpr, withTask({ status: 'open', sms_state: 'opted_out' }))).toBe(false);
    });
    it('no SMS state / closed task / handoff â†’ gate true (human-approval draft path)', () => {
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

    it('STOP always opts out â€” even punctuated, even past the cap', () => {
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
    it('passes the independent Background AI provider/model to the async model node', () => {
      const r = run('Can we do Friday at 9 instead?', {
        settings: {
          responses: [{
            answers: {
              business_name: 'Pirate Cuts',
              active: 'yes',
              model: 'live-call-model',
              background_ai_source: 'provider:openai-codex-agent',
              background_ai_model: 'gpt-5.6-luna',
            },
          }],
        },
      });
      expect(r.backgroundProvider).toBe('provider:openai-codex-agent');
      expect(r.backgroundModel).toBe('gpt-5.6-luna');
      expect(r.model).toBe('live-call-model');
    });
    it('no active SMS-managed task â†’ verdict none (draft flow owns the reply)', () => {
      expect(run('hello', { tasks: { responses: [] } }).verdict).toBe('none');
      const humanOnly = { tasks: { responses: [{ id: 't', answers: { status: 'open', sms_state: '' } }] } };
      expect(run('hello', humanOnly).verdict).toBe('none');
    });
    it('a YES without any appointment goes to the LLM instead of blind-confirming', () => {
      expect(run('YES', { appointments: { responses: [] } }).verdict).toBe('llm');
    });
  });

  describe('sms-followup-conversation plan: actions â†’ writes + composed reply', () => {
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
      // Old content preserved (updates patch-merge whole answers) â€¦
      expect(r.apptUpdate.notes).toContain('Booked automatically from call call_1');
      // â€¦ and the new line quotes the customer + records the outcome.
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

    it('a past/garbage reschedule date degrades to a clarifying question â€” the booking never moves', () => {
      const r = run({}, { action: 'reschedule', date: '2020-01-01', time: '09:00', reply: '' });
      // The only appointment write is the notes-only interaction log â€”
      // date/time/status are untouched by a bad model date.
      expect(r.hasApptCreate).toBe(false);
      expect(r.hasApptUpdate).toBe(true);
      expect(Object.keys(r.apptUpdate)).toEqual(['notes']);
      expect(r.hasReply).toBe(true);
      expect(r.taskUpdate.sms_exchanges).toBe(2);
    });

    it('unparseable model output â†’ human handoff with an honest reply (notes-only appointment log)', () => {
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

  describe('sms-delivery-status: exact messageId â†’ sent/failed on the phone\'s ack', () => {
    const markExpr = nodeExpr('sms-delivery-status', 'mark');
    const rows = (list: Array<Record<string, unknown>>) => ({
      nodes: { messages: { responses: list.map((answers, i) => ({ id: `msg-${i}`, answers })) } },
    });

    it('flips only the queued outbound row with the acknowledged messageId', () => {
      const r = evalExpr(markExpr, {
        inputs: { messageId: 'sms-target', to: '+61400000000', outcome: 'sent' },
        nodes: rows([
          { direction: 'outbound', status: 'queued', phone: '+61400000000', message_id: 'sms-other' },
          { direction: 'outbound', status: 'queued', phone: '+61400000000', message_id: 'sms-target' },
          { direction: 'outbound', status: 'sent', phone: '+61400000000', message_id: 'sms-target' },
        ]).nodes,
      });
      expect(r.hasUpdate).toBe(true);
      expect(r.responseId).toBe('msg-1');
      expect(r.update).toEqual({ status: 'sent' });
    });

    it('marks failed on the failure ack â€” inbound and already-sent rows are never touched', () => {
      const r = evalExpr(markExpr, {
        inputs: { messageId: 'sms-failed', to: '+61400000000', outcome: 'failed' },
        nodes: rows([
          { direction: 'inbound', status: 'received', message_id: 'sms-failed' },
          { direction: 'outbound', status: 'queued', message_id: 'sms-failed' },
        ]).nodes,
      });
      expect(r.update).toEqual({ status: 'failed' });
    });

    it('no queued outbound row â†’ no write (a stray ack never corrupts history)', () => {
      const r = evalExpr(markExpr, {
        inputs: { messageId: 'sms-stray', to: '+61400000000', outcome: 'sent' },
        nodes: rows([
          { direction: 'outbound', status: 'sent', message_id: 'sms-stray' },
          { direction: 'inbound', status: 'received', message_id: 'sms-stray' },
        ]).nodes,
      });
      expect(r.hasUpdate).toBe(false);
    });

    it('an unknown outcome coerces to sent â€” never an invalid dropdown value', () => {
      const r = evalExpr(markExpr, {
        inputs: { messageId: 'sms-unknown', to: '+61400000000', outcome: 'exploded' },
        nodes: rows([{ direction: 'outbound', status: 'queued', message_id: 'sms-unknown' }]).nodes,
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

      it('two agreed bookings â†’ two appointment creates, one task + one kickoff listing both', () => {
        const r = evalExpr(planExpr, scopeFor(twoBookings));
        expect(r.hasAppointment).toBe(true);
        expect(r.hasAppointment2).toBe(true);
        expect(r.hasAppointment3).toBe(false);
        expect(r.appointment.date).toBe(futureIso);
        expect(r.appointment.time).toBe('10:00');
        expect(r.appointment2.date).toBe(futureIso2);
        // Time is PER BOOKING â€” never carried from the first to the second.
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
        // The Diner booking already exists â†’ only Dinner is createdâ€¦
        expect(r.hasAppointment).toBe(true);
        expect(r.appointment.date).toBe(futureIso2);
        expect(r.hasAppointment2).toBe(false);
        expect(r.summaryLine).toContain('already on record');
        // â€¦but the kickoff still lists BOTH (the pending one folds in).
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
        // The other booking is still pending â€” the loop must stay open.
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
      // Sunday" â€” one message, DIFFERENT things for different bookings.
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
        // Thursday confirmedâ€¦
        expect(r.hasApptUpdate).toBe(true);
        expect(r.apptResponseId).toBe('appt-old');
        expect(r.apptUpdate.status).toBe('confirmed');
        // â€¦Sunday MOVED to 18:00 (requested, awaiting its YES) â€” not confirmed at 10.
        expect(r.hasApptUpdate2).toBe(true);
        expect(r.apptResponseId2).toBe('appt-new');
        expect(r.apptUpdate2.status).toBe('requested');
        expect(r.apptUpdate2.time).toBe('18:00');
        // The reply reports both outcomes and asks for the locking YES.
        expect(r.reply.body).toContain('confirmed');
        expect(r.reply.body).toContain('6 PM');
        expect(r.reply.body.toLowerCase()).toContain('reply yes');
        // A moved booking still needs its YES â€” the loop stays open.
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
        // Nothing left pending â€” the loop closes.
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

      it('business-lookup MANAGER calls (Phase 3): occupancy slots gain customer names; ordinary calls never do â€” even with the customers node populated', () => {
        const lookupExpr = nodeExpr('business-lookup', 'make');
        const nodesWith = {
          appts: {
            responses: [
              // The manager's own booking (never name-annotated â€” it's the
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
        // The manager's own 10 AM slot is their own booking â€” the occupancy
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
        // Empty in-window day â†’ plainly open.
        expect(direct[1]).toContain('NO bookings that day at all');
        expect(direct[1]).toContain('OPEN');
        // Beyond the 90-day horizon â†’ team confirms.
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

        it("query (2026-07-17, live call 085ce239): lists upcoming bookings with names from records, cancelled dropped, never a write", () => {
          const r = planFor('what appointments do I have booked', { action: 'query' });
          expect(r.ok).toBe(true);
          expect(r.hasUpdate).toBe(false);
          expect(r.hasBlock).toBe(false);
          expect(r.spoken).toContain('2 upcoming bookings');
          expect(r.spoken).toContain('Haircut');
          expect(r.spoken).toContain('Lance Baker');
          expect(r.spoken).toContain('Dinner');
          expect(r.spoken).not.toContain('Ghost');
        });

        it('query with a day narrows to that date; an empty day reads as nothing booked', () => {
          const day = planFor('what is booked that day', { action: 'query', target_date: futureIso });
          expect(day.ok).toBe(true);
          expect(day.spoken).toContain('has 2 bookings');
          const none = planFor('what about next week', { action: 'query', target_date: day2Iso });
          expect(none.ok).toBe(true);
          expect(none.spoken).toContain('Nothing is booked');
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
            inputs: { managerActionId: 'manager_1', hasUpdate: true, updateId: 'ap1', update: { status: 'confirmed' }, summary: 'ok' },
            nodes: {},
          });
          expect(good.hasUpdate).toBe(true);
          expect(good.managerActionId).toBe('manager_1');
          expect(good.update.status).toBe('confirmed');
          const badUpdate = evalExpr(passExpr, { inputs: { managerActionId: 'manager_2', hasUpdate: true, updateId: 'ap1', update: 'DROP TABLE' }, nodes: {} });
          expect(badUpdate.hasUpdate).toBe(false);
          const noId = evalExpr(passExpr, { inputs: { managerActionId: 'manager_3', hasUpdate: true, update: { a: 1 } }, nodes: {} });
          expect(noId.hasUpdate).toBe(false);
          const noActionId = evalExpr(passExpr, { inputs: { hasUpdate: true, updateId: 'ap1', update: { status: 'confirmed' } }, nodes: {} });
          expect(noActionId.hasUpdate).toBe(false);
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

      it('no upcoming bookings â†’ an EXPLICIT none-upcoming block (2026-07-14: an absent block let the model dredge old dates out of customer notes)', () => {
        const r = run([]);
        expect(r.persona).toContain('BOOKINGS ON RECORD');
        expect(r.persona).toContain('none upcoming');
        expect(r.persona).toContain('Never treat dates from the customer notes as bookings');
      });
    });
  });
});

describe('aokieReceptionistPack â€” Phase 0.5 record-driven screening & SMS policy (call-policy spec)', () => {
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

    it('the flow routes reject â†’ call.reject and SKIPS configureAgent (exclusive branches)', () => {
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

  describe('personalize-caller: Calls-row caller_name backfill (2026-07-17)', () => {
    // caller_name was write-orphaned after the 'Unknown caller' literal was
    // removed â€” nothing populated it. The flow now hands the matched name +
    // the call's Calls-row id to the binding's output action.
    const makeExpr = nodeExpr('personalize-caller', 'make');
    const run = (customers: Array<Record<string, unknown>>, calls: Array<Record<string, unknown>>) =>
      evalExpr(makeExpr, {
        inputs: { callId: 'call_abc', from: '+61400000000' },
        nodes: {
          customers: { responses: customers },
          appointments: { responses: [] },
          allappts: { responses: [] },
          settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
          calls: { responses: calls },
        },
      });
    const lance = { id: 'c1', answers: { name: 'Lance Baker', phone: '+61400000000', status: 'active' } };

    it('matched customer + Calls row â†’ hasCallName with the update payload', () => {
      const r = run([lance], [{ id: 'call-resp-1', answers: { call_id: 'call_abc' } }]);
      expect(r.hasCallName).toBe(true);
      expect(r.callResponseId).toBe('call-resp-1');
      expect(r.callNameUpdate).toEqual({ caller_name: 'Lance Baker' });
    });

    it('no customer match â†’ hasCallName false (nothing written)', () => {
      const r = run([], [{ id: 'call-resp-1', answers: { call_id: 'call_abc' } }]);
      expect(r.hasCallName).toBe(false);
    });

    it('missing Calls row (raced) â†’ hasCallName false even with a match', () => {
      const r = run([lance], []);
      expect(r.hasCallName).toBe(false);
      expect(r.callResponseId).toBe(null);
    });

    it("another call's row is never claimed (call_id must match)", () => {
      const r = run([lance], [{ id: 'other', answers: { call_id: 'call_OTHER' } }]);
      expect(r.hasCallName).toBe(false);
    });

    it('the output node + binding output action carry the backfill end-to-end', () => {
      const out = flowBySlug('personalize-caller').flowJson.nodes.find((n) => n.type === 'output')!;
      const value = (out.data as { value: Record<string, string> }).value;
      expect(value.callResponseId).toBe('$nodes.make.callResponseId');
      expect(value.hasCallName).toBe('$nodes.make.hasCallName');
      expect(value.callNameUpdate).toBe('$nodes.make.callNameUpdate');
      const binding = (pack.flowBindings ?? []).find((b) => b.flow === 'personalize-caller')!;
      expect(binding.outputActions).toContainEqual({
        type: 'formlogic.updateResponse',
        form: '@pack:calls',
        when: '$result.hasCallName',
        responseId: '$result.callResponseId',
        answers: '$result.callNameUpdate',
      });
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

    it("sms_capable 'no' (landline) â†’ NO kickoff text; the task tells a human to call", () => {
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

    it('defaultCountryCode: a 0-prefixed number is texted as +CCâ€¦; records keep the observed number', () => {
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

    it("a sender marked sms_capable 'no' (or blocked) mid-loop â†’ verdict no_sms, LLM never runs", () => {
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
    it('waits for transcript settlement only for transcript-consuming background flows', () => {
      const bindings = pack.flowBindings ?? [];
      for (const flow of ['call-summary-follow-up', 'after-call-actions']) {
        expect(bindings.some((binding) => binding.flow === flow && binding.event === 'aokie.call.transcript.settled')).toBe(true);
        expect(bindings.some((binding) => binding.flow === flow && binding.event === 'aokie.call.ended')).toBe(false);
      }

      // Lifecycle/queue actions must stay immediate and must not wait for an
      // optional model correction or its bounded timeout.
      for (const flow of [
        'callback-drain',
        'missed-call-follow-up',
        'hold-lost-apology',
        'outbound-callback-result',
      ]) {
        expect(bindings.some((binding) => binding.flow === flow && binding.event === 'aokie.call.ended')).toBe(true);
      }
    });

    it("Calls status offers terminated_abuse and LOGIC_CALL_ENDED passes the plugin's outcome through", () => {
      const calls = pack.forms.find((f) => f.packFormId === 'calls')!;
      const status = calls.fields.find((f) => f.id === 'status')!;
      const values = (status.properties as { options: Array<{ value: string }> }).options.map((o) => o.value);
      expect(values).toContain('terminated_abuse');
      // The app-logic whitelist must let the new outcome through â€” anything
      // unknown collapses to 'completed', which would hide the abuse trail.
      const app = pack.apps![0];
      const script = (app.customLogic!.scripts as Array<{ id: string; source: string }>).find(
        (s) => s.id === 'aokie-call-ended'
      )!;
      expect(script.source).toContain("outcome === 'terminated_abuse'");
    });

    it('after-call-actions never runs on an abuse-terminated call (no records/tasks/SMS off an abusive transcript)', () => {
      const binding = (pack.flowBindings ?? []).find(
        (b) => b.flow === 'after-call-actions' && b.event === 'aokie.call.transcript.settled'
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
      // never run on an OUTBOUND call â€” it minted a junk appointment + an
      // active SMS loop at the callee on the very first outbound test.
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'outbound' })).toBe(false);
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound' })).toBe(true);
      // Phase 3 (live call a5c3f900): nor on a MANAGER call â€” a manager-line
      // move was ALSO read as a new booking (duplicate appointment + kickoff
      // SMS at the manager). Manager writes ride aokie.manager.action.
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: true })).toBe(false);
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: false })).toBe(true);
      // Older plugins that don't send the flag keep working (absent â‰  true).
      expect(evalCond({ durationSeconds: 65, outcome: 'completed', direction: 'inbound', manager: undefined })).toBe(true);
      // The summary binding still covers the Calls row for abuse calls.
      const summary = (pack.flowBindings ?? []).find(
        (b) => b.flow === 'call-summary-follow-up' && b.event === 'aokie.call.transcript.settled'
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

    it('callback REACHED â†’ task done, no SMS', () => {
      const r = runResult('completed');
      expect(r.hasTaskUpdate).toBe(true);
      expect(r.taskUpdate.status).toBe('done');
      expect(r.taskUpdate.callback_state).toBe('reached');
      expect(r.hasSms).toBe(false);
    });

    it('callback NOT answered + sms-capable â†’ apology text (normalized to +CC), task stays open as sms_sent', () => {
      const r = runResult('no_answer', { settings: { default_country_code: '61' } });
      expect(r.hasSms).toBe(true);
      expect(r.sms.to).toBe('+61491570156');
      expect(r.sms.body).toContain('sorry we missed your call');
      expect(r.sms.body).toContain('Pirate Cuts');
      expect(r.sms.body).toMatch(/^[\x20-\x7E]+$/);
      expect(r.smsMessage.status).toBe('queued');
      expect(r.taskUpdate.callback_state).toBe('sms_sent');
      expect(r.taskUpdate.status).toBeUndefined();
    });

    it('callback NOT answered + landline/blocked â†’ needs_human at urgent priority, never a text', () => {
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
      // The whitelist cannot see withheld numbers (no caller_id event) â€” the
      // field copy must point at the plugin's private-number screening.
      expect(String(wl.description ?? '')).toContain('WITHHOLD');
      const cc = settings.fields.find((f) => f.id === 'default_country_code')!;
      expect(cc.type).toBe('short_text');
    });

    it('Receptionist Settings appends an independent background provider reference and optional model override', () => {
      const settings = pack.forms.find((f) => f.packFormId === 'receptionist-settings')!;
      const ids = settings.fields.map((field) => field.id);
      expect(ids.slice(-2)).toEqual(['background_ai_source', 'background_ai_model']);
      expect(settings.fields.find((field) => field.id === 'background_ai_source')?.type).toBe('short_text');
      expect(settings.fields.find((field) => field.id === 'background_ai_model')?.type).toBe('short_text');
    });
  });
});

describe('aokieReceptionistPack â€” catalog', () => {
  it('is registered in the pack catalog with matching counts', async () => {
    expect(packManifests.some((m) => m.id === 'aokie-receptionist')).toBe(true);
    const entry = await loadPack('aokie-receptionist');
    expect(entry).toBeDefined();
    expect(entry!.formCount).toBe(pack.forms.length);
    expect(entry!.appCount).toBe(1);
    // The lazy loader serves the SAME payload this suite validates.
    expect(entry!.pack).toBe(pack as unknown as NonNullable<typeof entry>['pack']);
  });
});

describe('aokieReceptionistPack â€” hold-abandonment follow-ups (Phase 4 hold queue)', () => {
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
      const cond = (bindingFor('after-call-actions', 'aokie.call.transcript.settled').condition as { expr: string }).expr;
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'abandoned_on_hold' })).toBe(false);
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'abandoned_in_queue' })).toBe(false);
      expect(evalCond(cond, { durationSeconds: 60, outcome: 'completed' })).toBe(true);
    });
  });
});

describe('aokieReceptionistPack â€” callback drain (queued callbacks dial when the line frees)', () => {
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

  it('a finished callback CHAINS to the next queued number, never redialing itself', () => {
    const served = task({ callback_number: '+61491570156', phone: '0491570156' }, minsAgo(30));
    const next = task({ callback_number: '+61491570157', phone: '0491570157' }, minsAgo(20));
    const r = evalExpr(planExpr, {
      nodes: { tasks: { responses: [served, next] } },
      inputs: { direction: 'outbound', outcome: 'no_answer', from: '+61491570156' },
    });
    expect(r.hasDial).toBe(true);
    expect(r.dial.number).toBe('+61491570157');
    // The served task's transition belongs to outbound-callback-result.
    expect(r.hasTaskUpdate).toBe(false);
  });

  it('a caller who reaches us themselves gets their queued callback closed, and the chain continues', () => {
    const theirs = task({ callback_number: '0491570156', phone: '0491570156' }, minsAgo(30));
    const other = task({ callback_number: '0491570157', phone: '0491570157' }, minsAgo(20));
    const r = evalExpr(planExpr, {
      nodes: { tasks: { responses: [theirs, other] } },
      inputs: { direction: '', outcome: 'completed', from: '+61491570156' },
    });
    expect(r.hasTaskUpdate).toBe(true);
    expect(r.taskUpdate.status).toBe('done');
    expect(r.taskUpdate.callback_state).toBe('reached');
    expect(r.hasDial).toBe(true);
    expect(r.dial.number).toBe('0491570157');
  });

  it('binding fires unconditionally (chaining) and closes the task before dialing', () => {
    const binding = (pack.flowBindings ?? []).find((b) => b.flow === 'callback-drain')!;
    expect(binding.condition).toBeUndefined();
    const kinds = (binding.outputActions ?? []).map((a: { type: string }) => a.type);
    expect(kinds.indexOf('formlogic.updateResponse')).toBeLessThan(kinds.indexOf('connector.request'));
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

describe('aokieReceptionistPack â€” pack-owned Device Setup section screen (plan Â§8.4 port #4)', () => {
  const hw = pack.forms.find((f) => f.packFormId === 'hardware-events');
  const cs = hw?.customScreen as Record<string, unknown> | undefined;

  const files = (cs?.files as Array<{ path: string; content: string }> | undefined) ?? [];
  const src = files.map((f) => f.content).join('\n');

  it('ships Device Setup as pack-owned TSX SOURCE FILES, not a compiled-registry reference', () => {
    expect(cs?.kind).toBe('code');
    expect(cs?.sdkScreen).toBeUndefined();
    expect(cs?.enabled).toBe(true);
    // Rows land automatically from aokie.hardware.error - no manual entry.
    expect(cs?.allowNewResponses).toBe(false);
    expect(cs?.js).toBeUndefined();
    expect(cs?.entry).toBe('index.tsx');
    expect(files.map((f) => f.path)).toContain('index.tsx');
    expect(files).toEqual(AOKIE_DEVICE_SETUP_SCREEN.files);
  });

  it('the TSX source renders data as JSX text (no raw-HTML sink)', () => {
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toContain('innerHTML');
  });

  it('drives ONLY sanctioned bridge surfaces - ceremonies stay host-owned', () => {
    for (const needle of [
      "FormLogic.connector('aokie'",
      'FormLogic.service(',
      'FormLogic.presence()',
      'FormLogic.records(',
      'FormLogic.deleteRecords(',
      'FormLogic.can(',
      "ceremony('connect-desktop')",
      "ceremony('start-fresh')",
    ]) {
      expect(src, needle).toContain(needle);
    }
    // The pack never mints pairing tokens or bulk-clears itself: the desktop
    // pairing and the whole-app reset go through named host ceremonies only.
    expect(src).not.toContain('requestPairing');
    expect(src).not.toContain('clearFormResponses');
    // Only registered service operations are referenced (svc('<op>') literals).
    const ops = src.match(/svc\('([^']+)'/g) ?? [];
    expect(ops.length).toBeGreaterThan(0);
    const allowed = new Set([
      "svc('desktop.connections.list'",
      "svc('aokie.companion.policy.get'",
      "svc('aokie.companion.policy.update'",
      "svc('aokie.companion.devices.list'",
      "svc('aokie.companion.devices.revoke'",
      "svc('aokie.companion.devices.approve'",
    ]);
    for (const op of ops) expect(allowed.has(op), op).toBe(true);
  });

  it('destructive controls are double-gated (type-to-confirm + host ceremony dialog)', () => {
    expect(src).toContain('delete all');
    expect(src).toContain('Confirm clear');
    expect(src).toContain('Confirm revoke');
  });
});



describe('aokieReceptionistPack — pack-owned Live Call section screen (plan §8.4 port #6)', () => {
  const calls = pack.forms.find((f) => f.packFormId === 'calls');
  const cs = calls?.customScreen as Record<string, unknown> | undefined;

  const lcFiles = (cs?.files as Array<{ path: string; content: string }> | undefined) ?? [];
  const lcSrc = lcFiles.map((f) => f.content).join('\n');
  const lcIndex = lcFiles.find((f) => f.path === 'index.tsx')?.content ?? '';

  it('ships the Calls SECTION as pack-owned TSX SOURCE FILES while KEEPING the record transcript', () => {
    expect(cs?.kind).toBe('code');
    expect(cs?.sdkScreen).toBeUndefined();
    expect(cs?.allowNewResponses).toBe(false);
    expect(cs?.js).toBeUndefined();
    expect(cs?.entry).toBe('index.tsx');
    expect(lcFiles).toEqual(AOKIE_LIVE_CALL_SCREEN.files);
    // The per-record transcript widget is a separate blob and must survive the section port.
    const rs = (cs?.recordScreen as Record<string, unknown> | undefined);
    expect(rs?.kind).toBe('code');
    expect(rs?.consumesRelated).toEqual(['transcript-turns.call_link']);
    expect(((rs?.files as unknown[] | undefined) ?? []).length).toBeGreaterThan(0);
  });

  it('the TSX source renders data as JSX text, regex-free', () => {
    expect(lcSrc.length).toBeGreaterThan(0);
    expect(lcSrc).not.toContain('dangerouslySetInnerHTML');
    expect(lcSrc).not.toContain('innerHTML');
    expect(lcSrc).not.toContain('.match(');
    expect(lcSrc).not.toContain('.replace(/');
  });

  it('drives the subscription lanes + the full bridge - commands go through connector()', () => {
    for (const needle of [
      "FormLogic.connector('aokie', 'call.current'",
      "FormLogic.events.subscribe({ connectorId: 'aokie' }",
      'FormLogic.captions.subscribe(',
      "FormLogic.queryRecords('customers'",
      "FormLogic.queryRecords('transcript-turns'",
      'FormLogic.records(',
      'FormLogic.presence()',
      "FormLogic.host.ceremony('simulate-call')",
      "FormLogic.can('connector.aokie.'",
    ]) {
      expect(lcSrc, needle).toContain(needle);
    }
    // The correction event patches the live bubble (converges with stored surfaces).
    expect(lcSrc).toContain('aokie.call.turn.corrected');
    // Captions tombstone when a durable caller turn lands (final wins).
    expect(lcSrc).toContain('tombstone');
  });

  it('offers the demo Simulate ONLY when there is no real runtime - never in remote mode', () => {
    // A REAL desktop reachable over the relay (presence 'remote') must show a
    // mirror note, NOT the scripted "Simulate incoming call" button - that was
    // the "connected but shows Simulate" bug. Structural lock on index.tsx: the
    // remote branch renders the mirror text, and the simulate affordance lives
    // in the SEPARATE non-local ternary branch that comes after it. The
    // behavioral twin lives in aokieLiveCallScreenTsx.test.ts (executed DOM).
    const remoteIdx = lcIndex.indexOf('mirrors its calls and relays your controls');
    const simIdx = lcIndex.indexOf('data-act="simulate"');
    expect(remoteIdx).toBeGreaterThan(-1);
    expect(simIdx).toBeGreaterThan(remoteIdx);
    expect(lcIndex.slice(remoteIdx, simIdx)).toContain("s.presence.kind !== 'local'");
    expect(lcIndex).toContain("s.presence.kind === 'remote'");
  });
});


describe('aokieReceptionistPack — pack-owned Receptionist Settings section screen (plan §8.4 port #3)', () => {
  const rsForm = pack.forms.find((f) => f.packFormId === 'receptionist-settings');
  const cs = rsForm?.customScreen as Record<string, unknown> | undefined;
  const rsFiles = (cs?.files as Array<{ path: string; content: string }> | undefined) ?? [];
  const rsSrc = rsFiles.map((f) => f.content).join('\n');

  it('ships the section as pack-owned TSX SOURCE FILES, not a compiled-registry reference', () => {
    expect(cs?.kind).toBe('code');
    expect(cs?.sdkScreen).toBeUndefined();
    expect(cs?.allowNewResponses).toBe(false);
    expect(cs?.js).toBeUndefined();
    expect(cs?.entry).toBe('index.tsx');
    expect(rsFiles.map((f) => f.path)).toContain('agentPayload.ts');
    expect(rsFiles).toEqual(AOKIE_RECEPTIONIST_SETTINGS_SCREEN.files);
  });

  it('the TSX source renders data as JSX text (no raw-HTML sink)', () => {
    expect(rsSrc.length).toBeGreaterThan(0);
    expect(rsSrc).not.toContain('dangerouslySetInnerHTML');
    expect(rsSrc).not.toContain('innerHTML');
  });

  it('drives ONLY sanctioned bridge surfaces (settings via connector, record via submit/updateRecord)', () => {
    for (const needle of [
      "FormLogic.connector('aokie', 'settings.get'",
      "FormLogic.connector('aokie', 'settings.set'",
      'FormLogic.records(',
      'FormLogic.submit(',
      'FormLogic.updateRecord(',
      'FormLogic.aiSources()',
      'FormLogic.presence()',
      "FormLogic.can('connector.aokie.settings.get')",
      "FormLogic.can('connector.aokie.settings.set')",
      'composeAgentPayload(',
    ]) {
      expect(rsSrc, needle).toContain(needle);
    }
  });

  it('manager-PIN guardrails: write-only, blank-means-keep, explicit remove', () => {
    // The PIN key is sent ONLY when a new value was typed (blank keeps the stored PIN).
    expect(rsSrc).toContain('if (newPin) payload.managerPin = newPin;');
    // A dedicated Remove PIN action sends an explicit empty PIN.
    expect(rsSrc).toContain("settingsSet({ managerPin: '' })");
    // The PIN is never seeded from settings.get (write-only) — only managerPinSet is read.
    expect(rsSrc).toContain('res.managerPinSet === true');
    expect(rsSrc).toContain("state.screening.managerPin = ''");
    // The field renders as a password input, never plain text.
    expect(rsSrc).toContain('type="password"');
  });

  it('partial saves never clobber the whole dirty baseline (review 2026-07-18 HIGH)', () => {
    // A save handler must not unconditionally re-clone the entire draft into the
    // saved baseline — that would mark unrelated pending edits as saved + lose
    // them. Partial saves reflect ONLY their own keys (audio patches correction;
    // screening writes no draft keys) unless it was the first-ever create.
    expect(rsSrc).toContain('const wasCreate = !state.recordId;');
    expect(rsSrc).toContain('(state.saved as Draft).correction_source = (state.draft as Draft).correction_source;');
    // The full-clone is gated behind wasCreate, not run on every partial save.
    expect(rsSrc).not.toContain('.then(function () { state.saved = JSON.parse(JSON.stringify(state.draft)); return settingsGet(); })');
  });

  it('a shared in-flight guard prevents duplicate singleton records (review 2026-07-18 MEDIUM)', () => {
    // Concurrent first-saves must not each FormLogic.submit and duplicate the singleton.
    expect(rsSrc).toContain('let createInFlight: Promise<unknown> | null = null;');
    expect(rsSrc).toContain('if (createInFlight) return createInFlight.then(');
    // The create sends the FULL draft (create validates required fields, no merge).
    expect(rsSrc).toContain('for (const j in answers) full[j] = answers[j];');
  });
});
