import { describe, expect, it } from 'vitest';
import { CHECKBOX_YES, FIELD_TYPE_INFO, checkboxOptions, normalizeFieldType, tickedValues } from './form';

// Legacy aliases (text/textarea) must map onto canonical types — mirrors
// FormService::normalizeFieldType on the backend. Without this, a legacy field hits
// the FormResponse renderer's default case ("Field type not supported").
describe('normalizeFieldType', () => {
  it('maps legacy aliases to canonical types', () => {
    expect(normalizeFieldType('text')).toBe('short_text');
    expect(normalizeFieldType('textarea')).toBe('long_text');
    // HTML's own word for a list to pick one from, which an AI writing a form reaches for.
    expect(normalizeFieldType('select')).toBe('dropdown');
    // One tick box, which bundled packs and the diagram tool write.
    expect(normalizeFieldType('checkbox')).toBe('checkboxes');
  });

  it('gives a checkbox that names no box the one box, and reads only a list as its answer', () => {
    // A form kept in the browser from before the server gave it one.
    expect(checkboxOptions({ type: 'checkbox', properties: {} })).toEqual([CHECKBOX_YES]);
    expect(checkboxOptions({ type: 'checkbox', properties: null })).toEqual([CHECKBOX_YES]);
    expect(checkboxOptions({ type: 'checkbox' })).toEqual([CHECKBOX_YES]);
    const own = [{ id: 'yes', label: 'Follow-up required', value: 'yes' }];
    expect(checkboxOptions({ type: 'checkbox', properties: { options: own } })).toBe(own);
    // A list of tick boxes with none is its owner's to fill: nothing is made up for it.
    expect(checkboxOptions({ type: 'checkboxes', properties: { options: [] } })).toEqual([]);
    expect(tickedValues(['yes'])).toEqual(['yes']);
    for (const other of [true, 'yes', 1, null, undefined, { yes: true }]) expect(tickedValues(other)).toEqual([]);
    expect(tickedValues(['a', 2, 'b'])).toEqual(['a', 'b']);
  });

  it('passes canonical types through unchanged', () => {
    for (const type of Object.keys(FIELD_TYPE_INFO)) {
      expect(normalizeFieldType(type)).toBe(type);
    }
  });
});
