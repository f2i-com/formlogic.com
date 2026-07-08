import { describe, expect, it, vi } from 'vitest';

// buildWorkspaceExecutorDeps()'s evaluateBoolean/evaluateExpression (docs/FORMLOGIC_FLOWS.md
// §4) must forward a node's clamped `timeoutMs` (nodes.ts) as `budgetMs`, and the
// logic_block path must use the NON-swallowing `calculateValueForFlow` — never
// `calculateValue` — so a timeout/error fails the flow loudly instead of resolving to null.
// buildDefaultExecutorDeps() (the app-runtime-store-backed sibling used inside an app
// runtime) wires these two functions IDENTICALLY — see flowDispatcher.ts — so exercising the
// exported workspace builder is representative of both.
vi.mock('../../lib/formlogic', () => ({
  evaluateCondition: vi.fn(async () => true),
  calculateValue: vi.fn(async () => {
    throw new Error('calculateValue must NOT be used by the Flows logic_block wiring');
  }),
  calculateValueForFlow: vi.fn(async () => 'flow-value'),
}));

import { evaluateCondition, calculateValue, calculateValueForFlow } from '../../lib/formlogic';
import { buildWorkspaceExecutorDeps } from './flowDispatcher';

describe('buildWorkspaceExecutorDeps — timeout-budget + swallow/throw wiring (docs §4)', () => {
  it('evaluateBoolean forwards a declared budgetMs straight through to evaluateCondition', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateBoolean('inputs.x > 1', { inputs: { x: 2 } }, 4500);
    expect(evaluateCondition).toHaveBeenCalledWith('inputs.x > 1', { inputs: { x: 2 } }, 4500);
  });

  it('evaluateBoolean forwards undefined when the node declared no timeoutMs', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateBoolean('true', {});
    expect(evaluateCondition).toHaveBeenCalledWith('true', {}, undefined);
  });

  it('evaluateExpression uses the NON-swallowing calculateValueForFlow, never calculateValue', async () => {
    const deps = buildWorkspaceExecutorDeps();
    const result = await deps.evaluateExpression('1 + 1', {}, 3000);
    expect(result).toBe('flow-value');
    expect(calculateValueForFlow).toHaveBeenCalledWith('1 + 1', {}, 3000);
    expect(calculateValue).not.toHaveBeenCalled();
  });

  it('evaluateExpression forwards undefined when logic_block declared no timeoutMs', async () => {
    const deps = buildWorkspaceExecutorDeps();
    await deps.evaluateExpression('1', {});
    expect(calculateValueForFlow).toHaveBeenCalledWith('1', {}, undefined);
  });
});
