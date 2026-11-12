import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Dropdown } from '../ui/Dropdown';
import { isUnsafePattern } from '../../lib/patternGuard';
import { cn } from '../../lib/utils';
import type { ValidationRule, FieldType } from '../../types/form';

interface ValidationEditorProps {
  rules: ValidationRule[];
  fieldType: FieldType;
  onChange: (rules: ValidationRule[]) => void;
}

const VALIDATION_TYPES: Record<string, { label: string; hasValue: boolean; valueType: 'number' | 'text' }[]> = {
  text: [
    { label: 'Minimum length', hasValue: true, valueType: 'number' },
    { label: 'Maximum length', hasValue: true, valueType: 'number' },
    { label: 'Pattern (regex)', hasValue: true, valueType: 'text' },
  ],
  number: [
    { label: 'Minimum value', hasValue: true, valueType: 'number' },
    { label: 'Maximum value', hasValue: true, valueType: 'number' },
  ],
  // 'Custom Expression' (type 'custom') is not offered: no screen a form is filled in
  // and not the server checks one, so offering it was misleading. A custom rule saved
  // on a field (older forms, packs, MCP or API writes) stays in the data and is shown
  // below as not checked; the form's onSubmit script is where such a check runs.
  default: [],
};

const TYPE_TO_VALIDATION: Record<string, string> = {
  'Minimum length': 'minLength',
  'Maximum length': 'maxLength',
  'Pattern (regex)': 'pattern',
  'Minimum value': 'min',
  'Maximum value': 'max',
};

function getValidationOptions(fieldType: FieldType) {
  if (['short_text', 'long_text', 'email', 'phone', 'url'].includes(fieldType)) {
    return VALIDATION_TYPES.text;
  }
  if (fieldType === 'number') {
    return VALIDATION_TYPES.number;
  }
  return VALIDATION_TYPES.default;
}

export function ValidationEditor({ rules, fieldType, onChange }: ValidationEditorProps) {
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const toggleRule = (ruleId: string) => {
    setExpandedRuleId((prev) => (prev === ruleId ? null : ruleId));
  };

  const options = getValidationOptions(fieldType);

  const addRule = (optionLabel: string) => {
    const option = options.find((o) => o.label === optionLabel);
    if (!option) return;

    const type = TYPE_TO_VALIDATION[optionLabel] as ValidationRule['type'];
    const ruleId = uuidv4();
    const newRule: ValidationRule = {
      id: ruleId,
      type,
      message: `Validation failed for ${optionLabel.toLowerCase()}`,
      value: option.hasValue ? (option.valueType === 'number' ? 0 : '') : undefined,
    };

    onChange([...rules, newRule]);
    setExpandedRuleId(ruleId);
  };

  const updateRule = (ruleId: string, updates: Partial<ValidationRule>) => {
    const newRules = rules.map((rule) =>
      rule.id === ruleId ? { ...rule, ...updates } : rule
    );
    onChange(newRules);
  };

  const removeRule = (ruleId: string) => {
    onChange(rules.filter((rule) => rule.id !== ruleId));
    if (expandedRuleId === ruleId) {
      setExpandedRuleId(null);
    }
  };

  const getRuleLabel = (rule: ValidationRule): string => {
    switch (rule.type) {
      case 'minLength':
        return `Min length: ${rule.value}`;
      case 'maxLength':
        return `Max length: ${rule.value}`;
      case 'min':
        return `Min value: ${rule.value}`;
      case 'max':
        return `Max value: ${rule.value}`;
      case 'pattern':
        return `Pattern: ${rule.value}`;
      case 'custom':
        return 'Custom expression (not checked)';
      default:
        return rule.type;
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Validation rules</h4>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          {rules.length === 0
            ? options.length > 0
              ? 'No rules yet. A rule refuses an answer that does not fit.'
              : 'This kind of field has no rules to add.'
            : 'An answer that breaks a rule is refused with the rule’s message.'}
        </p>
      </div>

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900"
            >
              {/* Rule Header */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={expandedRuleId === rule.id}
                className={cn(
                  'flex min-h-10 items-center justify-between gap-2 py-1 pl-3 pr-1 bg-gray-50 dark:bg-slate-800/50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 max-sm:min-h-11',
                  expandedRuleId === rule.id && 'border-b border-gray-200 dark:border-slate-700'
                )}
                onClick={() => toggleRule(rule.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRule(rule.id); } }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ChevronRight className={cn('h-3.5 w-3.5 flex-none text-gray-400 transition-transform dark:text-slate-500', expandedRuleId === rule.id && 'rotate-90')} aria-hidden="true" />
                  <span className="min-w-0 break-words text-sm font-medium text-gray-700 dark:text-slate-200">
                    {getRuleLabel(rule)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 flex-none px-0 text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400 max-sm:w-11"
                  aria-label="Remove validation rule"
                  title="Remove rule"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRule(rule.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {/* Rule Content */}
              {expandedRuleId === rule.id && (
                <div className="p-3 space-y-3">
                  {/* Value Input for rules that need it */}
                  {['minLength', 'maxLength', 'min', 'max'].includes(rule.type) && (
                    <Input
                      label="Value"
                      type="number"
                      value={rule.value ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        // Preserve decimals (parseInt truncated min/max) and treat an
                        // empty input as "no value" rather than silently becoming 0.
                        const n = raw === '' ? undefined : Number(raw);
                        updateRule(rule.id, { value: n === undefined || Number.isNaN(n) ? undefined : n });
                      }}
                    />
                  )}

                  {rule.type === 'pattern' && (() => {
                    let patternError: string | undefined;
                    const raw = String(rule.value ?? '');
                    if (raw) { try { new RegExp(raw); } catch { patternError = 'Not a valid regular expression'; } }
                    // The browser will not run it (patternGuard), so an answer hears only at submit.
                    if (!patternError && isUnsafePattern(raw)) patternError = 'This pattern could freeze a visitor’s browser, so it is checked only when the answer is sent. To check it as they type, give a repeated group a fixed step, such as a separator.';
                    return (
                      <Input
                        label="Pattern (regular expression)"
                        value={rule.value as string}
                        onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                        placeholder="^[a-zA-Z]+$"
                        error={patternError}
                      />
                    );
                  })()}

                  {rule.type === 'custom' ? (
                    // Shown so the author can move the check where it runs, and remove the rule.
                    <div className="space-y-2 text-sm text-gray-600 dark:text-slate-300">
                      <p>
                        This expression rule is not checked when the form is filled in or submitted, by any
                        screen or by the server. To refuse an answer, use a rule from Add a rule or the
                        form&apos;s onSubmit script (return <code>{'{ reject: true, message }'}</code>), then
                        remove this rule.
                      </p>
                      {rule.expression && (
                        <pre className="whitespace-pre-wrap break-words rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 p-3 font-mono text-xs">
                          {rule.expression}
                        </pre>
                      )}
                    </div>
                  ) : (
                    /* Error Message */
                    <Input
                      label="Error message"
                      value={rule.message}
                      onChange={(e) => updateRule(rule.id, { message: e.target.value })}
                      placeholder="This field is invalid"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Only show the picker when this field type actually has rules to add —
          otherwise "Add a rule" opened an empty menu (e.g. for 11 field types). Under the
          rules and as wide as the panel: beside the heading it took most of the line. */}
      {options.length > 0 && (
        <Dropdown
          options={options.map((o) => ({ value: o.label, label: o.label }))}
          value=""
          onChange={addRule}
          placeholder="Add a rule"
        />
      )}
    </div>
  );
}
