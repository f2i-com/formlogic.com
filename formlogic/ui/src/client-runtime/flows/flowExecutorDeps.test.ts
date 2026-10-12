import { describe, expect, it, vi } from 'vitest';

// buildWorkspaceExecutorDeps()'s evaluateBoolean/evaluateExpression (docs/FORMLOGIC_FLOWS.md
// §4) must forward a node's clamped `timeoutMs` (nodes.ts) as `budgetMs`, and the
// logic_block path must use the NON-swallowing `calculateValueForFlow` — never
// `calculateValue` — so a timeout/error fails the flow loudly instead of resolving to null.
// (calculateValueForFlow also accepts a function body with a top-level `return`; the
// condition node stays on evaluateCondition, an expression, as on the desktop runner.)
// buildDefaultExecutorDeps() (the app-runtime-store-backed sibling used inside an app
// runtime) wires these two functions IDENTICALLY — see flowDispatcher.ts — and is checked
// alongside the workspace builder. Both forward the node's language as the 4th argument
// (undefined below, where a call passes none).
vi.mock('../../lib/formlogic', () => ({
  evaluateCondition: vi.fn(async () => true),
  calculateValue: vi.fn(async () => {
    throw new Error('calculateValue must NOT be used by the Flows logic_block wiring');
  }),
  calculateValueForFlow: vi.fn(async () => 'flow-value'),
}));

import { evaluateCondition, calculateValue, calculateValueForFlow } from '../../lib/formlogic';
import { buildDefaultExecutorDeps, buildWorkspaceExecutorDeps } from './flowDispatcher';
import { api } from '../../lib/api';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

// A record a flow run writes names the run (flowRunId) on the wire, in both scopes, so the
// server makes the runs it starts that run's children (docs/FORMLOGIC_FLOWS.md §12).
describe('a flow run write carries its run id to the server', () => {
  it('workspace scope: in the body of POST /forms/{id}/responses', async () => {
    const spy = vi.spyOn(api, 'submitResponse').mockResolvedValue({ data: { response: { id: 'r1' } as never } });
    try {
      await buildWorkspaceExecutorDeps().submitResponse('form-1', { note: 'x' }, { flowRunId: 'run-9' });
      expect(spy).toHaveBeenLastCalledWith('form-1', { answers: { note: 'x' }, flowRunId: 'run-9' });
      await buildWorkspaceExecutorDeps().submitResponse('form-1', { note: 'y' });
      expect(spy).toHaveBeenLastCalledWith('form-1', { answers: { note: 'y' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('app runtime: through the store, in the body of the app submit', async () => {
    useAppRuntimeStore.setState({ appSlug: 'shop' });
    const spy = vi.spyOn(api, 'createAppResponse').mockResolvedValue({ data: { response: { id: 'r2' } } });
    try {
      await buildDefaultExecutorDeps().submitResponse('form-1', { note: 'x' }, { flowRunId: 'run-9' });
      expect(spy).toHaveBeenLastCalledWith('shop', 'form-1', expect.objectContaining({ answers: { note: 'x' }, flowRunId: 'run-9' }));
      await buildDefaultExecutorDeps().submitResponse('form-1', { note: 'y' });
      expect(spy.mock.lastCall?.[2]).not.toHaveProperty('flowRunId');
    } finally {
      spy.mockRestore();
      useAppRuntimeStore.setState({ appSlug: null });
    }
  });
});

describe('buildWorkspaceExecutorDeps — timeout-budget + swallow/throw wiring (docs §4)', () => {
  it('evaluateBoolean forwards a declared budgetMs straight through to evaluateCondition', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateBoolean('inputs.x > 1', { inputs: { x: 2 } }, 4500);
    expect(evaluateCondition).toHaveBeenCalledWith('inputs.x > 1', { inputs: { x: 2 } }, 4500, undefined);
  });

  it('evaluateBoolean forwards undefined when the node declared no timeoutMs', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateBoolean('true', {});
    expect(evaluateCondition).toHaveBeenCalledWith('true', {}, undefined, undefined);
  });

  it('evaluateExpression uses the NON-swallowing calculateValueForFlow, never calculateValue', async () => {
    const deps = buildWorkspaceExecutorDeps();
    const result = await deps.evaluateExpression('1 + 1', {}, 3000);
    expect(result).toBe('flow-value');
    expect(calculateValueForFlow).toHaveBeenCalledWith('1 + 1', {}, 3000, undefined);
    expect(calculateValue).not.toHaveBeenCalled();
  });

  it('evaluateExpression forwards undefined when logic_block declared no timeoutMs', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateExpression('1', {});
    expect(calculateValueForFlow).toHaveBeenCalledWith('1', {}, undefined, undefined);
  });

  it('forwards the node language to both evaluators', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateBoolean('inputs["x"] > 1', { inputs: { x: 2 } }, 900, 'python');
    expect(evaluateCondition).toHaveBeenLastCalledWith('inputs["x"] > 1', { inputs: { x: 2 } }, 900, 'python');
    await deps.evaluateExpression('result = 1', {}, 2000, 'python');
    expect(calculateValueForFlow).toHaveBeenLastCalledWith('result = 1', {}, 2000, 'python');
  });
});

describe('buildDefaultExecutorDeps — same node evaluator wiring as the workspace builder', () => {
  it('forwards budgetMs to evaluateCondition and to the NON-swallowing calculateValueForFlow', async () => {
    const deps = buildDefaultExecutorDeps();
    await expect(deps.evaluateBoolean('inputs.x > 1', { inputs: { x: 2 } }, 1200)).resolves.toBe(true);
    expect(evaluateCondition).toHaveBeenCalledWith('inputs.x > 1', { inputs: { x: 2 } }, 1200, undefined);
    await expect(deps.evaluateExpression('return 1;', {}, 2000)).resolves.toBe('flow-value');
    expect(calculateValueForFlow).toHaveBeenCalledWith('return 1;', {}, 2000, undefined);
    expect(calculateValue).not.toHaveBeenCalled();
    await deps.evaluateBoolean('bool(inputs)', {}, 1000, 'python');
    expect(evaluateCondition).toHaveBeenLastCalledWith('bool(inputs)', {}, 1000, 'python');
    await deps.evaluateExpression('result = 2', {}, 2000, 'python');
    expect(calculateValueForFlow).toHaveBeenLastCalledWith('result = 2', {}, 2000, 'python');
  });
});
