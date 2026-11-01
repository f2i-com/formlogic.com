// The conditions of the logic editor's Simple Mode, and the expression they are saved as.
import type { FieldType } from '../../types/form';

export interface SimpleCondition {
  id: string;
  fieldId: string;
  operator: string;
  value: string;
}

// Whose answer is stored as a real number. A calculated field usually holds one but need not, so
// it compares as a number only when the value it is given is one.
export const NUMBER_ANSWERS: ReadonlySet<string> = new Set(['number', 'rating', 'scale']);
export const CHOICE_FIELDS: ReadonlySet<string> = new Set(['dropdown', 'multiple_choice', 'checkboxes']);
// Whose answer is a list. It is never equal to an option, it holds some: === could never be true.
export const LIST_ANSWERS: ReadonlySet<string> = new Set(['checkboxes']);
export const OPERATORS_ON_AN_OPTION: ReadonlySet<string> = new Set(['===', '!==', 'contains', 'notContains']);
// The inputs these answers are typed into, which store them as ISO text ("2026-01-31", "14:30",
// "2026-01-31T14:30"). Text in that shape sorts in date order, so a date is compared as quoted
// text, the same in the browser and on the server. As a number it read as 0, which no date beats.
export const DATE_INPUTS: Readonly<Record<string, string>> = { date: 'date', time: 'time', datetime: 'datetime-local' };

function isNumberText(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

export function simpleConditionToExpression(
  conditions: SimpleCondition[],
  combinator: 'and' | 'or',
  idToVar: Record<string, string>,
  fieldTypes: ReadonlyMap<string, FieldType>
): string {
  if (conditions.length === 0) return 'true';

  const parts = conditions.map((cond) => {
    // Use variable name instead of field ID
    const fieldRef = idToVar[cond.fieldId] || cond.fieldId;
    const type: string = fieldTypes.get(cond.fieldId) ?? '';
    // Escape quotes in value to prevent expression injection
    const escaped = String(cond.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const text = `"${escaped}"`;
    const number = String(Number(cond.value) || 0);
    // number/rating/scale answers are stored as real JS numbers, so equality must
    // compare against an unquoted numeric literal (0 === "0" is false under the
    // strict equality the ZIPP sandbox evaluates).
    const answerIsNumber = NUMBER_ANSWERS.has(type);
    const literal = answerIsNumber || (type === 'calculated' && isNumberText(cond.value)) ? number : text;

    switch (cond.operator) {
      case '===':
        return `${fieldRef} === ${literal}`;
      case '!==':
        return `${fieldRef} !== ${literal}`;
      case '>':
      case '<':
      case '>=':
      case '<=':
        // An unanswered date is "", which sorts before every date.
        if (type in DATE_INPUTS) return `isNotEmpty(${fieldRef}) && ${fieldRef} ${cond.operator} ${text}`;
        return `${fieldRef} ${cond.operator} ${type === 'calculated' ? literal : number}`;
      case 'contains':
        // Guard against a null/unanswered trigger (null.includes throws -> the
        // condition fails OPEN, inconsistent with ===/notEmpty). isNotEmpty keeps
        // both string-substring and array-membership semantics of .includes;
        // numeric fields have no .includes, so substring-match their stringified value.
        return answerIsNumber || type === 'calculated'
          ? `isNotEmpty(${fieldRef}) && String(${fieldRef}).includes(${text})`
          : `isNotEmpty(${fieldRef}) && ${fieldRef}.includes(${text})`;
      case 'notContains':
        return `!(isNotEmpty(${fieldRef}) && ${fieldRef}.includes(${text}))`;
      case 'notEmpty':
        return `isNotEmpty(${fieldRef})`;
      case 'empty':
        return `isEmpty(${fieldRef})`;
      default:
        return 'true';
    }
  });

  const operator = combinator === 'and' ? ' && ' : ' || ';
  return parts.join(operator);
}
