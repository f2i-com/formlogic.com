import { describe, expect, it } from 'vitest';
import { FIELD_TYPE_INFO, normalizeFieldType } from './form';

// Legacy aliases (text/textarea) must map onto canonical types — mirrors
// FormService::normalizeFieldType on the backend. Without this, a legacy field hits
// the FormResponse renderer's default case ("Field type not supported").
describe('normalizeFieldType', () => {
  it('maps legacy aliases to canonical types', () => {
    expect(normalizeFieldType('text')).toBe('short_text');
    expect(normalizeFieldType('textarea')).toBe('long_text');
  });

  it('passes canonical types through unchanged', () => {
    for (const type of Object.keys(FIELD_TYPE_INFO)) {
      expect(normalizeFieldType(type)).toBe(type);
    }
  });
});
