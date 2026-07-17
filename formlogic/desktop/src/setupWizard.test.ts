import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveSetupChecklist,
  setupChecklistComplete,
  LOCAL_AI_SERVICE_ID,
  type SetupOverviewLike,
} from './setupWizard.ts';

/** A blank overview — nothing installed, nothing linked. */
function emptyOverview(overrides: Partial<SetupOverviewLike> = {}): SetupOverviewLike {
  return {
    services: { services: [] },
    models: { models: [] },
    plugins: { plugins: [] },
    ...overrides,
  };
}

test('local choice: llama service + model + the two optional rows, in order', () => {
  const items = deriveSetupChecklist(emptyOverview(), undefined, 'local');
  assert.deepEqual(
    items.map((i) => i.id),
    ['llama-service', 'model', 'aokie-plugin', 'cloud-link'],
  );
  assert.deepEqual(
    items.map((i) => i.section),
    ['services', 'models', 'plugins', 'connections'],
  );
  assert.ok(items.every((i) => !i.done), 'blank overview → nothing ticked');
  assert.deepEqual(
    items.map((i) => i.optional),
    [false, false, true, true],
  );
});

test('cloud choice: provider row replaces the local pair; optional rows stay', () => {
  const items = deriveSetupChecklist(emptyOverview(), undefined, 'cloud');
  assert.deepEqual(
    items.map((i) => i.id),
    ['ai-provider', 'aokie-plugin', 'cloud-link'],
  );
  // The AI providers panel lives inside the Services section.
  assert.equal(items[0].section, 'services');
});

test('llama row: done only when installed AND running', () => {
  const cases: Array<[{ installed: boolean; status: string }, boolean]> = [
    [{ installed: true, status: 'running' }, true],
    [{ installed: true, status: 'stopped' }, false],
    [{ installed: false, status: 'running' }, false],
  ];
  for (const [svc, expected] of cases) {
    const items = deriveSetupChecklist(
      emptyOverview({ services: { services: [{ id: LOCAL_AI_SERVICE_ID, ...svc }] } }),
      undefined,
      'local',
    );
    assert.equal(items.find((i) => i.id === 'llama-service')?.done, expected);
  }
  // A DIFFERENT running service never ticks the llama row.
  const other = deriveSetupChecklist(
    emptyOverview({
      services: { services: [{ id: 'comfyui', installed: true, status: 'running' }] },
    }),
    undefined,
    'local',
  );
  assert.equal(other.find((i) => i.id === 'llama-service')?.done, false);
});

test('model row: any model on disk ticks it', () => {
  const items = deriveSetupChecklist(
    emptyOverview({ models: { models: [{ name: 'q.gguf' }] } }),
    undefined,
    'local',
  );
  assert.equal(items.find((i) => i.id === 'model')?.done, true);
});

test('provider row: enabled + (key OR local endpoint) counts; disabled/keyless never', () => {
  const check = (providers: { enabled: boolean; hasKey: boolean; allowLocal?: boolean }[]) =>
    deriveSetupChecklist(emptyOverview(), providers, 'cloud').find((i) => i.id === 'ai-provider')
      ?.done;
  assert.equal(check([{ enabled: true, hasKey: true }]), true, 'keyed provider');
  assert.equal(check([{ enabled: true, hasKey: false, allowLocal: true }]), true, 'keyless local');
  assert.equal(check([{ enabled: false, hasKey: true }]), false, 'disabled');
  assert.equal(check([{ enabled: true, hasKey: false }]), false, 'no key, not local');
  assert.equal(check([]), false, 'no providers');
  const undef = deriveSetupChecklist(emptyOverview(), undefined, 'cloud');
  assert.equal(undef.find((i) => i.id === 'ai-provider')?.done, false, 'list not fetched yet');
});

test('aokie row: done only for the aokie plugin in state running', () => {
  const running = deriveSetupChecklist(
    emptyOverview({ plugins: { plugins: [{ id: 'aokie', state: 'running' }] } }),
    undefined,
    'local',
  );
  assert.equal(running.find((i) => i.id === 'aokie-plugin')?.done, true);
  const stopped = deriveSetupChecklist(
    emptyOverview({ plugins: { plugins: [{ id: 'aokie', state: 'disabled' }] } }),
    undefined,
    'local',
  );
  assert.equal(stopped.find((i) => i.id === 'aokie-plugin')?.done, false);
});

test('cloud-link row: runtime.linked wins; falls back to cloud.linked', () => {
  const viaRuntime = deriveSetupChecklist(
    emptyOverview({ runtime: { linked: true } }),
    undefined,
    'local',
  );
  assert.equal(viaRuntime.find((i) => i.id === 'cloud-link')?.done, true);
  const viaCloud = deriveSetupChecklist(
    emptyOverview({ cloud: { linked: true } }),
    undefined,
    'local',
  );
  assert.equal(viaCloud.find((i) => i.id === 'cloud-link')?.done, true);
  const runtimeSaysNo = deriveSetupChecklist(
    emptyOverview({ runtime: { linked: false }, cloud: { linked: true } }),
    undefined,
    'local',
  );
  assert.equal(
    runtimeSaysNo.find((i) => i.id === 'cloud-link')?.done,
    false,
    'a present runtime answer beats the stale config view',
  );
});

test('completion: optional rows never block; required rows all must tick', () => {
  // Local path with both required rows done, optionals untouched → complete.
  const localDone = deriveSetupChecklist(
    emptyOverview({
      services: {
        services: [{ id: LOCAL_AI_SERVICE_ID, installed: true, status: 'running' }],
      },
      models: { models: [{ name: 'q.gguf' }] },
    }),
    undefined,
    'local',
  );
  assert.equal(setupChecklistComplete(localDone), true);

  // One required row missing → not complete, even with every optional done.
  const missingModel = deriveSetupChecklist(
    emptyOverview({
      services: {
        services: [{ id: LOCAL_AI_SERVICE_ID, installed: true, status: 'running' }],
      },
      plugins: { plugins: [{ id: 'aokie', state: 'running' }] },
      runtime: { linked: true },
    }),
    undefined,
    'local',
  );
  assert.equal(setupChecklistComplete(missingModel), false);

  // Cloud path: one working provider completes the guide.
  const cloudDone = deriveSetupChecklist(
    emptyOverview(),
    [{ enabled: true, hasKey: true }],
    'cloud',
  );
  assert.equal(setupChecklistComplete(cloudDone), true);
});

test('sparse overview (nothing fetched yet) derives safely, all unticked', () => {
  const items = deriveSetupChecklist({}, undefined, 'local');
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => !i.done));
});
