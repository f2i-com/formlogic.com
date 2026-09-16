// @vitest-environment node
//
// A guest that traps the WASM instance (a panic inside the engine surfaces as a WebAssembly
// "unreachable") leaves nothing usable in it. zipp-host must report it as a host error,
// refuse anything more on the instance, and report the instance over any retention budget
// so engine.ts replaces the Worker. The trap is simulated: ZIPP v0.0.18's real trigger
// (thousands of sys.stdout.write calls without a newline) took seconds, would poison the
// instance for every other case in the file, and no longer traps v0.0.19 (which stops such a
// run on its memory budget), so no released engine offers a trigger to run here.
import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
import { INSTANCE_RETAINED_BUDGET_BYTES } from './engine';
import { instanceUsage, runEval, SandboxGuestError } from './zipp-host';

describe('zipp-host after a trapped instance', () => {
  it('reports the trap as a host error, stops using the instance and asks for a new Worker', async () => {
    await expect(runEval('flow', '1 + 1', {}, { language: 'python' })).resolves.toBe(2);
    expect(instanceUsage().trapped).toBeUndefined();

    // A trap while the project initializes is not a compile error: no module retry.
    const initPythonProject = vi.spyOn(Engine.prototype, 'initPythonProject').mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    const err = await runEval('flow', 'x = 1\nresult = x', {}, { language: 'python' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxGuestError);
    expect((err as Error).message).toMatch(/stopped on an internal error/);
    expect(initPythonProject).toHaveBeenCalledTimes(1);

    const usage = instanceUsage();
    expect(usage.trapped).toBe(true);
    expect(usage.retainedBytes).toBeGreaterThanOrEqual(INSTANCE_RETAINED_BUDGET_BYTES);

    initPythonProject.mockClear();
    const initScript = vi.spyOn(Engine.prototype, 'initScript');
    await expect(runEval('flow', '1', {}, { language: 'python' })).rejects.toThrow(/stopped on an internal error/);
    await expect(runEval('calc', '1 + 1', {})).rejects.toThrow(/stopped on an internal error/);
    expect(initPythonProject).not.toHaveBeenCalled();
    expect(initScript).not.toHaveBeenCalled();
    initPythonProject.mockRestore();
    initScript.mockRestore();
  }, 20_000);
});
