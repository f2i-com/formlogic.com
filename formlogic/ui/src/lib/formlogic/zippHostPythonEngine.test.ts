// @vitest-environment node
//
// An engine build without the Python frontend (ZIPP's JavaScript-only web bundle) must refuse
// Python as a host error, before any Engine is built, and keep running JavaScript. The real
// engine is loaded; only its profile is made to report JavaScript alone.
import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
import { engineLanguages, runEval, SandboxGuestError } from './zipp-host';

vi.mock('../../../vendor/zipp-wasm/zipp_wasm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../vendor/zipp-wasm/zipp_wasm.js')>();
  return {
    ...actual,
    zippProfile: () => JSON.stringify({ ...JSON.parse(actual.zippProfile()), languages: ['javascript'] }),
  };
});

describe('zipp-host on an engine without Python', () => {
  it('refuses Python before building an Engine, and still runs JavaScript', async () => {
    const initPythonProject = vi.spyOn(Engine.prototype, 'initPythonProject');
    await expect(engineLanguages()).resolves.toEqual(['javascript']);
    for (const kind of ['flow', 'condition', 'applogic', 'syntax'] as const) {
      const err = await runEval(kind, '1', {}, { language: 'python' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SandboxGuestError);
      expect((err as Error).message).toMatch(/cannot run Python logic/);
    }
    expect(initPythonProject).not.toHaveBeenCalled();
    await expect(runEval('flow', '1 + 1', {})).resolves.toBe(2);
  }, 20_000);
});
