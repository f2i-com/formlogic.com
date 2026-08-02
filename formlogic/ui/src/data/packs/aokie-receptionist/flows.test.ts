// Aokie Receptionist pack — flow + binding consistency (authoring correctness).
//
// Every starter flow must be a valid, self-consistent graph, and every binding's inputMap must map
// ONLY input names the flow's Trigger declares — so the desktop-run loop (which seeds $inputs from
// the inputMap) always has the inputs the downstream nodes read. Executor semantics untouched.
import { describe, expect, it } from 'vitest';
import { aokieReceptionistPack } from './pack';
import { validateWorkflowGraph } from '../../../client-runtime/flows/flowExecutor';
import { lintFlowGraph, triggerInputNames } from '../../../components/flows/flowGraphLint';

const flows = aokieReceptionistPack.flows ?? [];
const bindings = aokieReceptionistPack.flowBindings ?? [];

describe('aokie pack flows', () => {
  it('has all starter flows', () => {
    expect(flows.map((f) => f.slug).sort()).toEqual(
      ['after-call-actions', 'appointment-request-apply',
      'business-lookup',
      'call-summary-follow-up', 'callback-drain', 'configure-receptionist', 'hardware-error-alert', 'hold-lost-apology', 'incoming-caller-lookup', 'live-reply', 'manager-action-apply', 'manager-action-plan', 'missed-call-follow-up', 'outbound-callback-result', 'personalize-caller', 'sms-approved-drain', 'sms-auto-reply-draft', 'sms-delivery-status', 'sms-followup-conversation'],
    );
  });

  it('routes async SMS and post-call model work through the independent Background AI selection', () => {
    const expected = new Map([
      ['call-summary-follow-up', 'summary'],
      ['sms-auto-reply-draft', 'draft'],
      ['sms-followup-conversation', 'decide'],
      ['after-call-actions', 'extract'],
    ]);
    for (const [slug, nodeId] of expected) {
      const flow = flows.find((item) => item.slug === slug)!;
      const node = flow.flowJson.nodes.find((item) => item.id === nodeId)!;
      expect(String(node.data?.provider), slug).toMatch(/backgroundProvider/);
      expect(String(node.data?.model), slug).toMatch(/backgroundModel/);
    }

    // Caller-waiting model work remains on the live-call provider/model lane.
    const live = flows.find((item) => item.slug === 'live-reply')!;
    expect(live.flowJson.nodes.find((item) => item.id === 'reply')?.data?.provider).toBeUndefined();
    const manager = flows.find((item) => item.slug === 'manager-action-plan')!;
    expect(manager.flowJson.nodes.find((item) => item.id === 'decide')?.data?.provider).toBeUndefined();
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
