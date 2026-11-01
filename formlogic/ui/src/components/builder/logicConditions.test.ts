// @vitest-environment node
//
// What Simple Mode writes, run on the real ZIPP engine with answers as the runtime stores them
// (same approach as lib/formlogic/flowEval.test.ts). A rule that reads well and can never be true
// was the fault, so the proof is the verdict, not the text of the expression.
import { describe, expect, it } from 'vitest';
import { runEval } from '../../lib/formlogic/zipp-host';
import { replaceVariablesWithIds } from '../../lib/utils';
import type { FieldType } from '../../types/form';
import { simpleConditionToExpression } from './logicConditions';

const CASE_TIMEOUT_MS = 20_000;

/** The rule `field <operator> value` on a field of this type, judged against this answer. */
async function verdict(type: FieldType, operator: string, value: string, answer: unknown): Promise<unknown> {
  const expression = simpleConditionToExpression([{ id: 'c', fieldId: 'a', operator, value }], 'and', { a: 'a' }, new Map([['a', type]]));
  return runEval('condition', expression, { a: answer });
}

describe('a date compared in Simple Mode', () => {
  it('compares as a date, not as the 0 its value read as', async () => {
    expect(await verdict('date', '>', '2026-01-01', '2026-03-01')).toBe(true);
    expect(await verdict('date', '>', '2026-01-01', '2025-12-31')).toBe(false);
    expect(await verdict('date', '<', '2026-01-01', '2025-12-31')).toBe(true);
    expect(await verdict('date', '>=', '2026-01-01', '2026-01-01')).toBe(true);
    expect(await verdict('date', '<=', '2026-02-01', '2026-10-01')).toBe(false);
  }, CASE_TIMEOUT_MS);

  it('orders times and dates with a time the same way', async () => {
    expect(await verdict('time', '>', '09:00', '14:30')).toBe(true);
    expect(await verdict('time', '<', '09:00', '14:30')).toBe(false);
    expect(await verdict('datetime', '>', '2026-01-31T09:00', '2026-01-31T14:30')).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('is not before anything while it is unanswered', async () => {
    for (const answer of ['', null]) {
      expect(await verdict('date', '<', '2026-01-01', answer)).toBe(false);
      expect(await verdict('date', '>', '2026-01-01', answer)).toBe(false);
    }
  }, CASE_TIMEOUT_MS);

  it('still equals as it did', async () => {
    expect(await verdict('date', '===', '2026-01-01', '2026-01-01')).toBe(true);
    expect(await verdict('date', '!==', '2026-01-01', '2026-01-02')).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('a calculated field compared in Simple Mode', () => {
  it('matches the number it works out to', async () => {
    expect(await verdict('calculated', '===', '10', 10)).toBe(true);
    expect(await verdict('calculated', '!==', '10', 10)).toBe(false);
    expect(await verdict('calculated', '>', '5', 10)).toBe(true);
    expect(await verdict('calculated', 'contains', '1', 10)).toBe(true);
  }, CASE_TIMEOUT_MS);

  // An expression can produce text as well, and a rule on that text used to work.
  it('still matches the text one works out to', async () => {
    expect(await verdict('calculated', '===', 'Pass', 'Pass')).toBe(true);
    expect(await verdict('calculated', '!==', 'Pass', 'Fail')).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('a Checkboxes answer, which is a list', () => {
  const both = ['option_1', 'option_2'];

  it('does not contain what it does not hold', async () => {
    expect(await verdict('checkboxes', 'notContains', 'option_3', both)).toBe(true);
    expect(await verdict('checkboxes', 'notContains', 'option_2', both)).toBe(false);
  }, CASE_TIMEOUT_MS);

  it('contains nothing while it is unanswered', async () => {
    for (const answer of [[], null, '']) {
      expect(await verdict('checkboxes', 'notContains', 'option_1', answer)).toBe(true);
      expect(await verdict('checkboxes', 'contains', 'option_1', answer)).toBe(false);
    }
  }, CASE_TIMEOUT_MS);

  it('keeps to itself when joined to other conditions, either way', async () => {
    const conditions = [
      { id: '1', fieldId: 'a', operator: 'notContains', value: 'option_1' },
      { id: '2', fieldId: 'b', operator: '===', value: 'yes' },
    ];
    const types = new Map<string, FieldType>([['a', 'checkboxes'], ['b', 'short_text']]);
    const run = (combinator: 'and' | 'or', answers: Record<string, unknown>) =>
      runEval('condition', simpleConditionToExpression(conditions, combinator, { a: 'a', b: 'b' }, types), answers);

    expect(await run('and', { a: ['option_2'], b: 'no' })).toBe(false);
    expect(await run('and', { a: ['option_2'], b: 'yes' })).toBe(true);
    expect(await run('and', { a: ['option_1'], b: 'yes' })).toBe(false);
    expect(await run('or', { a: ['option_1'], b: 'yes' })).toBe(true);
    expect(await run('or', { a: ['option_1'], b: 'no' })).toBe(false);
    // Unanswered is where an unbracketed || would take the whole rule with it.
    expect(await run('and', { a: [], b: 'no' })).toBe(false);
  }, CASE_TIMEOUT_MS);

  it('keeps to itself as the last condition too', async () => {
    const conditions = [
      { id: '1', fieldId: 'b', operator: '===', value: 'yes' },
      { id: '2', fieldId: 'a', operator: 'notContains', value: 'option_1' },
    ];
    const types = new Map<string, FieldType>([['a', 'checkboxes'], ['b', 'short_text']]);
    const expression = simpleConditionToExpression(conditions, 'and', { a: 'a', b: 'b' }, types);

    expect(await runEval('condition', expression, { a: ['option_2'], b: 'no' })).toBe(false);
    expect(await runEval('condition', expression, { a: ['option_2'], b: 'yes' })).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('what did not change', () => {
  it('compares number, rating and scale answers as numbers', async () => {
    for (const type of ['number', 'rating', 'scale'] as const) {
      expect(await verdict(type, '===', '3', 3)).toBe(true);
      expect(await verdict(type, '>', '3', 4)).toBe(true);
    }
  }, CASE_TIMEOUT_MS);

  it('finds an option in a checkbox answer and in a text answer', async () => {
    expect(await verdict('checkboxes', 'contains', 'option_2', ['option_1', 'option_2'])).toBe(true);
    expect(await verdict('checkboxes', 'contains', 'option_3', ['option_1', 'option_2'])).toBe(false);
    expect(await verdict('short_text', 'contains', 'ell', 'hello')).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('keeps a quote in a value from ending the text', async () => {
    expect(await verdict('short_text', '===', 'say "hi"', 'say "hi"')).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('a value that is also a field name', () => {
  // A rule built in Simple Mode goes through the same save as a typed one.
  it('stays the value when the rule is saved', async () => {
    const shown = simpleConditionToExpression(
      [{ id: 'c', fieldId: 'role_1', operator: '===', value: 'manager' }],
      'and',
      { role_1: 'role' },
      new Map([['role_1', 'short_text' as FieldType]]),
    );
    const saved = replaceVariablesWithIds(shown, { role: 'role_1', manager: 'mgr_1' });
    expect(saved).toBe('role_1 === "manager"');
    expect(await runEval('condition', saved, { role_1: 'manager', mgr_1: 'Sam' })).toBe(true);
  }, CASE_TIMEOUT_MS);
});
