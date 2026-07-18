import { describe, expect, it } from 'vitest';
import { FIELD_TYPE_COUNT, PACK_COUNT } from './stats';
import { packManifests } from '../../data/packs';
import { FIELD_TYPE_INFO } from '../../types/form';

/**
 * The landing proof strip advertises concrete numbers. They are hand-written
 * constants (the hero must not pull the whole pack catalogue into its
 * bundle), so this test pins them to their sources of truth — a new pack or
 * field type fails here instead of shipping a stale marketing claim.
 */
describe('landing marketing stats are real', () => {
  it('pack count matches the marketplace catalogue', () => {
    expect(PACK_COUNT).toBe(packManifests.length);
  });

  it('field type count matches the builder palette', () => {
    expect(FIELD_TYPE_COUNT).toBe(Object.keys(FIELD_TYPE_INFO).length);
  });
});
