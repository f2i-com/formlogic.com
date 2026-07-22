import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  backupTestBadge,
  datasetLabel,
  headComparisonLabel,
  healthBadge,
  keyStoreBanner,
  provenanceBadge,
  summarize,
} from './dataPanelModel.ts';
import type { DataDatasetView, DataStatusSnapshot } from './api.ts';

function dataset(over: Partial<DataDatasetView> = {}): DataDatasetView {
  return {
    datasetId: '11112222-3333-4444-8555-666677778888',
    formId: 'sample-form',
    isSample: true,
    role: 'primary',
    storageEpoch: 1,
    protocolVersion: 1,
    lastSequence: 5,
    lastCheckpointHash: 'ab'.repeat(32),
    records: 5,
    tombstones: 0,
    operations: 5,
    sizeBytes: 40960,
    fileName: 'data.sqlite3.enc',
    health: 'current',
    headComparison: 'current',
    ...over,
  };
}

function status(over: Partial<DataStatusSnapshot> = {}): DataStatusSnapshot {
  return {
    protocol: 'formlogic-data-sync/1',
    keyStoreAvailable: true,
    dataRoot: 'C:/x/data',
    node: null,
    nodeError: null,
    datasets: [],
    datasetErrors: [],
    ...over,
  };
}

test('healthBadge maps the plan §19.5 vocabulary to tones', () => {
  assert.deepEqual(healthBadge('current'), { label: 'Current', tone: 'ok' });
  assert.equal(healthBadge('rollback_detected').tone, 'err');
  assert.equal(healthBadge('history_diverged').tone, 'err');
  assert.equal(healthBadge('integrity_failed').tone, 'err');
  assert.equal(healthBadge('provenance_unverified').tone, 'pending');
  assert.equal(healthBadge('something_new').label, 'something_new');
});

test('headComparisonLabel names the rollback state loudly', () => {
  assert.match(headComparisonLabel('rollback_detected'), /older copy/i);
  assert.match(headComparisonLabel('no_anchor'), /unavailable/i);
});

test('summarize totals datasets and counts unhealthy + errored ones', () => {
  const s = summarize(
    status({
      datasets: [
        dataset(),
        dataset({ health: 'rollback_detected', records: 3, operations: 4, sizeBytes: 1024 }),
      ],
      datasetErrors: [{ datasetId: 'x', code: 'encrypted_store_unavailable', message: 'nope' }],
    }),
  );
  assert.equal(s.datasets, 2);
  assert.equal(s.records, 8);
  assert.equal(s.operations, 9);
  assert.equal(s.sizeBytes, 41984);
  assert.equal(s.unhealthy, 2);
  assert.equal(summarize(null).datasets, 0);
});

test('provenanceBadge never claims full authentication before the owner chain', () => {
  assert.equal(provenanceBadge('cloud_signed_tofu').tone, 'ok');
  assert.match(provenanceBadge('cloud_signed_tofu').label, /owner chain pending/i);
  assert.equal(provenanceBadge('provenance_unverified').tone, 'pending');
  assert.equal(provenanceBadge('signature_invalid').tone, 'err');
  assert.equal(provenanceBadge('??').label, '??');
});

test('backupTestBadge covers never/passed/failed', () => {
  assert.deepEqual(backupTestBadge(null, null), { label: 'Never tested', tone: 'pending' });
  assert.equal(backupTestBadge(true, '2026-07-22T01:02:03Z').label, 'Test passed · 2026-07-22');
  assert.equal(backupTestBadge(false, null).tone, 'err');
});

test('datasetLabel marks samples; keyStoreBanner reflects fail-closed states', () => {
  assert.match(datasetLabel(dataset()), /^Sample dataset 11112222$/);
  assert.equal(datasetLabel(dataset({ isSample: false, formId: 'form-1' })), 'form-1');
  assert.equal(keyStoreBanner(null), null);
  assert.equal(keyStoreBanner(status()), null);
  assert.match(keyStoreBanner(status({ keyStoreAvailable: false }))!, /no plaintext fallback/i);
  assert.match(keyStoreBanner(status({ nodeError: 'replica_integrity_failed' }))!, /replica_integrity_failed/);
});
