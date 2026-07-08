// Structural validation for the Aokie Receptionist pack — the pack is data, so a broken
// cross-reference (@pack: form ref, flow slug, logic form key, SDK screen id) would only
// surface at import/run time. These tests pin every reference the importer/runtime resolves.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack as pack } from './aokieReceptionistPack';
import { validateWorkflowGraph } from '../../client-runtime/flows/flowExecutor';
import { packCatalog } from './index';

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
  'aokie.call.incoming', 'aokie.call.answered', 'aokie.call.rejected',
  'aokie.call.turn.partial', 'aokie.call.turn.final', 'aokie.call.ended',
  'aokie.sms.received', 'aokie.sms.sent', 'aokie.sms.failed',
  'aokie.hardware.error',
]);

describe('aokieReceptionistPack — forms', () => {
  it('ships the plan §12.2 record set', () => {
    for (const key of [
      'customers', 'calls', 'transcript-turns', 'sms-threads', 'sms-messages',
      'appointments', 'orders', 'follow-up-tasks', 'flow-runs', 'hardware-events',
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

  it('logic scripts reference forms by the app display names (the runtime logic keys)', () => {
    const displayNames = new Set(app.forms.map((f) => f.displayName));
    const sources = (app.customLogic?.scripts ?? []).map((s) => s.source).join('\n');
    const keys = [...sources.matchAll(/formKey:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(displayNames.has(key), `logic formKey '${key}' is not an app display name`).toBe(true);
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
    expect(used.sort()).toEqual(['aokie-live-call', 'aokie-pairing']);
    for (const id of used) {
      expect(registered.has(id), `SDK screen '${id}' is not registered`).toBe(true);
    }
  });
});

describe('aokieReceptionistPack — flows & bindings', () => {
  it('ships the starter flows on valid v0 graphs', () => {
    expect([...FLOW_SLUGS].sort()).toEqual([
      'call-summary-follow-up',
      'hardware-error-alert',
      'incoming-caller-lookup',
      'live-reply',
      'missed-call-follow-up',
      'sms-auto-reply-draft',
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
    expect(pack.flowBindings?.length).toBe(6);
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

describe('aokieReceptionistPack — catalog', () => {
  it('is registered in the pack catalog with matching counts', () => {
    const entry = packCatalog.find((e) => e.id === 'aokie-receptionist');
    expect(entry).toBeDefined();
    expect(entry!.formCount).toBe(pack.forms.length);
    expect(entry!.appCount).toBe(1);
  });
});
