import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryStatusNote } from './deliveryStatusNote.ts';

test('a recovered relay poll error is not presented as current', () => {
  assert.equal(deliveryStatusNote({
    linked: true,
    lastError: 'relay poll: network error',
    recordsWritten: 12,
    relayPollOk: true,
  }), '12 records written');
});

test('a currently failing relay poll stays visible', () => {
  assert.equal(deliveryStatusNote({
    linked: true,
    lastError: 'relay poll: network error',
    recordsWritten: 12,
    relayPollOk: false,
  }), 'relay poll: network error');
});

test('an unrelated delivery failure is not hidden by a healthy relay', () => {
  assert.equal(deliveryStatusNote({
    linked: true,
    lastError: 'record write failed',
    recordsWritten: 12,
    relayPollOk: true,
  }), 'record write failed');
});
