// Aokie Receptionist pack — flow + binding consistency (authoring correctness).
//
// Every starter flow must be a valid, self-consistent graph, and every binding's inputMap must map
// ONLY input names the flow's Trigger declares — so the desktop-run loop (which seeds $inputs from
// the inputMap) always has the inputs the downstream nodes read. Executor semantics untouched.
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack } from './aokieReceptionistPack';
import { validateWorkflowGraph } from '../../client-runtime/flows/flowExecutor';
import { lintFlowGraph, triggerInputNames } from '../../components/flows/flowGraphLint';

const flows = aokieReceptionistPack.flows ?? [];
const bindings = aokieReceptionistPack.flowBindings ?? [];

describe('aokie pack flows', () => {
  it('has all starter flows', () => {
    expect(flows.map((f) => f.slug).sort()).toEqual(
      ['after-call-actions',
      'business-lookup',
      'call-summary-follow-up', 'callback-drain', 'configure-receptionist', 'hardware-error-alert', 'hold-lost-apology', 'incoming-caller-lookup', 'live-reply', 'manager-action-apply', 'manager-action-plan', 'missed-call-follow-up', 'outbound-callback-result', 'personalize-caller', 'sms-auto-reply-draft', 'sms-delivery-status', 'sms-followup-conversation'],
    );
  });

  it('every flow is a valid WorkflowGraph', () => {
    for (const f of flows) expect(validateWorkflowGraph(f.flowJson), f.slug).toBeNull();
  });

  it('every flow lints clean (node refs resolve, condition branches routed)', () => {
    for (const f of flows) expect(lintFlowGraph(f.flowJson), f.slug).toEqual([]);
  });

  it('every flow has a Trigger that declares its inputs', () => {
    for (const f of flows) {
      const trigger = f.flowJson.nodes.find((n) => n.type === 'input');
      expect(trigger, `${f.slug} has a Trigger`).toBeDefined();
      expect(triggerInputNames(f.flowJson).length, `${f.slug} declares inputs`).toBeGreaterThan(0);
    }
  });
});

describe('aokie pack bindings', () => {
  it('every binding targets an existing flow', () => {
    const slugs = new Set(flows.map((f) => f.slug));
    for (const b of bindings) expect(slugs.has(b.flow), `binding → ${b.flow}`).toBe(true);
  });

  it("every binding inputMap key is one the flow's Trigger declares", () => {
    for (const b of bindings) {
      const flow = flows.find((f) => f.slug === b.flow)!;
      const declared = new Set(triggerInputNames(flow.flowJson));
      for (const key of Object.keys(b.inputMap ?? {})) {
        expect(declared.has(key), `${b.flow} inputMap '${key}' must be a declared Trigger input`).toBe(true);
      }
    }
  });
});
