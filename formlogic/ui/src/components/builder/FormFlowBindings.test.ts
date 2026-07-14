import { describe, expect, it } from 'vitest';
import {
  buildBindingPayload,
  buildInputMap,
  fieldSelector,
  parseStaticValue,
  rowsFromInputMap,
  type BindingDraft,
  type InputMappingRow,
} from './formFlowBindingsSerialize';

// The on-submit binding UI serializes its input-mapping rows into an /api/forms/{id}/
// flow-bindings body. The serialization is pure (docs/FORMLOGIC_FLOWS.md §5) — a form-field
// row becomes a `$event.data.answers.<fieldId>` selector, a static row becomes a typed literal.

describe('fieldSelector', () => {
  it('generates the $event.data.answers.<fieldId> selector', () => {
    expect(fieldSelector('phone')).toBe('$event.data.answers.phone');
  });
});

describe('parseStaticValue', () => {
  it('keeps JSON typed and everything else a raw string', () => {
    expect(parseStaticValue('42')).toBe(42);
    expect(parseStaticValue('true')).toBe(true);
    expect(parseStaticValue('null')).toBeNull();
    expect(parseStaticValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseStaticValue('["x"]')).toEqual(['x']);
    expect(parseStaticValue('hello')).toBe('hello');
    expect(parseStaticValue('  ')).toBe('');
    // A malformed JSON-looking string falls back to the raw string.
    expect(parseStaticValue('{oops')).toBe('{oops');
  });
});

describe('buildInputMap', () => {
  it('maps field rows to selectors and static rows to literals', () => {
    const rows: InputMappingRow[] = [
      { input: 'callerPhone', source: 'field', fieldId: 'phone' },
      { input: 'priority', source: 'static', staticValue: '5' },
      { input: 'label', source: 'static', staticValue: 'vip' },
    ];
    expect(buildInputMap(rows)).toEqual({
      callerPhone: '$event.data.answers.phone',
      priority: 5,
      label: 'vip',
    });
  });

  it('drops rows with a blank input name or an unset field', () => {
    const rows: InputMappingRow[] = [
      { input: '', source: 'field', fieldId: 'phone' },
      { input: 'x', source: 'field' }, // no fieldId
    ];
    expect(buildInputMap(rows)).toBeNull();
  });

  it('returns null when nothing maps', () => {
    expect(buildInputMap([])).toBeNull();
  });
});

describe('buildBindingPayload', () => {
  it('always targets form.submitted and carries mode/timeout/enabled', () => {
    const draft: BindingDraft = {
      flow: 'caller-lookup',
      mode: 'sync',
      rows: [{ input: 'callerPhone', source: 'field', fieldId: 'phone' }],
      timeoutMs: 4000,
      enabled: true,
    };
    expect(buildBindingPayload(draft)).toEqual({
      event: 'form.submitted',
      flow: 'caller-lookup',
      mode: 'sync',
      inputMap: { callerPhone: '$event.data.answers.phone' },
      timeoutMs: 4000,
      enabled: true,
    });
  });
});

describe('rowsFromInputMap (round-trip)', () => {
  it('rehydrates answer selectors as field rows and literals as static rows', () => {
    const rows = rowsFromInputMap({ callerPhone: '$event.data.answers.phone', priority: 5 });
    expect(rows).toEqual([
      { input: 'callerPhone', source: 'field', fieldId: 'phone' },
      { input: 'priority', source: 'static', staticValue: '5' },
    ]);
    // Round-trips back to the same inputMap.
    expect(buildInputMap(rows)).toEqual({ callerPhone: '$event.data.answers.phone', priority: 5 });
  });
});
