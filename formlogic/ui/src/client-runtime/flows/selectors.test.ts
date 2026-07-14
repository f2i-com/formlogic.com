import { describe, expect, it } from 'vitest';
import {
  buildInputs,
  interpolateTemplate,
  isSelector,
  resolveDeep,
  resolvePath,
  resolveSelector,
  whenPasses,
} from './selectors';

// Selector resolution is a PURE path walk (no eval): $event.data.x / $app / $result.x per
// docs/FORMLOGIC_FLOWS.md §5; anything that isn't a recognised $ selector is a literal.

const scope = {
  event: {
    name: 'aokie.call.incoming',
    data: { from: '+61400000000', callerName: 'Alex', nested: { deep: 42 }, list: ['a', 'b'] },
  },
  app: { slug: 'reception', id: 'app-1' },
  result: { found: true, record: { id: 'resp-9' } },
  inputs: { callerPhone: '+61400000000' },
};

describe('resolvePath', () => {
  it('walks nested objects and array indices', () => {
    expect(resolvePath(scope.event, ['data', 'nested', 'deep'])).toBe(42);
    expect(resolvePath(scope.event, ['data', 'list', '1'])).toBe('b');
  });
  it('yields undefined for missing hops, never throws', () => {
    expect(resolvePath(scope.event, ['data', 'missing', 'x'])).toBeUndefined();
    expect(resolvePath(null, ['x'])).toBeUndefined();
    expect(resolvePath('scalar', ['x'])).toBeUndefined();
  });
  it('never walks the prototype chain', () => {
    expect(resolvePath({}, ['constructor'])).toBeUndefined();
    expect(resolvePath({}, ['__proto__'])).toBeUndefined();
    expect(resolvePath({}, ['toString'])).toBeUndefined();
  });
});

describe('resolveSelector', () => {
  it('resolves $event.data.x paths', () => {
    expect(resolveSelector('$event.data.from', scope)).toBe('+61400000000');
    expect(resolveSelector('$event.name', scope)).toBe('aokie.call.incoming');
  });
  it('resolves bare roots ($app, $event, $result)', () => {
    expect(resolveSelector('$app', scope)).toEqual({ slug: 'reception', id: 'app-1' });
    expect(resolveSelector('$result.record.id', scope)).toBe('resp-9');
    expect(resolveSelector('$inputs.callerPhone', scope)).toBe('+61400000000');
  });
  it('missing paths resolve to undefined', () => {
    expect(resolveSelector('$event.data.nope', scope)).toBeUndefined();
    expect(resolveSelector('$result.record.answers.x', scope)).toBeUndefined();
  });
  it('passes literals (including plain and $-unknown strings) through untouched', () => {
    expect(resolveSelector('hello', scope)).toBe('hello');
    expect(resolveSelector(42, scope)).toBe(42);
    expect(resolveSelector({ a: 1 }, scope)).toEqual({ a: 1 });
    // '$unknownroot' is not a recognised selector root — literal.
    expect(resolveSelector('$unknownroot.x', scope)).toBe('$unknownroot.x');
    expect(isSelector('$unknownroot.x')).toBe(false);
  });
});

describe('resolveDeep / buildInputs', () => {
  it('resolves selector strings nested inside objects and arrays', () => {
    expect(
      resolveDeep({ phone: '$event.data.from', tags: ['$app.slug', 'literal'] }, scope)
    ).toEqual({ phone: '+61400000000', tags: ['reception', 'literal'] });
  });
  it('builds flow inputs from an inputMap (selector or literal per entry)', () => {
    expect(
      buildInputs({ callerPhone: '$event.data.from', source: 'phone', app: '$app.slug' }, scope)
    ).toEqual({ callerPhone: '+61400000000', source: 'phone', app: 'reception' });
    expect(buildInputs(null, scope)).toEqual({});
  });
});

describe('whenPasses', () => {
  it('absent gate passes; selector truthiness gates; ! negates', () => {
    expect(whenPasses(undefined, scope)).toBe(true);
    expect(whenPasses('$result.found', scope)).toBe(true);
    expect(whenPasses('!$result.found', scope)).toBe(false);
    expect(whenPasses('$result.missing', scope)).toBe(false);
    expect(whenPasses('!$result.missing', scope)).toBe(true);
  });
});

describe('interpolateTemplate', () => {
  it('interpolates {{path}} against a context; missing → empty string', () => {
    const ctx = { event: scope.event, result: scope.result, inputs: scope.inputs };
    expect(interpolateTemplate('Call from {{event.data.callerName}} ({{event.data.from}})', ctx)).toBe(
      'Call from Alex (+61400000000)'
    );
    expect(interpolateTemplate('missing:[{{event.data.nope}}]', ctx)).toBe('missing:[]');
    // A leading '$' inside braces is tolerated (selector spelling reuse).
    expect(interpolateTemplate('{{$inputs.callerPhone}}', ctx)).toBe('+61400000000');
    // Objects stringify rather than "[object Object]".
    expect(interpolateTemplate('{{result.record}}', ctx)).toBe('{"id":"resp-9"}');
  });
});
