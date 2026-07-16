import assert from 'node:assert/strict';
import test from 'node:test';
import { aokieCommandRequestId } from './aokieRequestId.ts';

test('physical Aokie commands receive a safe request id', () => {
  const id = aokieCommandRequestId('aokie', 'phone.connect', undefined, () => 'fixed-uuid');
  assert.equal(id, 'desktop-phone-connect-fixed-uuid');
  assert.match(id ?? '', /^[A-Za-z0-9_.:-]{1,128}$/);
});

test('an explicit request id is retained across caller-managed retries', () => {
  const generate = () => {
    throw new Error('must not mint a replacement');
  };
  assert.equal(
    aokieCommandRequestId('aokie', 'phone.connect', 'desktop-existing', generate),
    'desktop-existing',
  );
});

test('reads and non-Aokie plugins are not given unnecessary request ids', () => {
  assert.equal(aokieCommandRequestId('aokie', 'phone.status', undefined, () => 'x'), undefined);
  assert.equal(aokieCommandRequestId('other', 'phone.connect', undefined, () => 'x'), undefined);
});
