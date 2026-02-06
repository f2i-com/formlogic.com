import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Trash2, AlertCircle, CheckCircle, Play } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Dropdown } from '../ui/Dropdown';
import { cn } from '../../lib/utils';
import { useExpressionTester } from '../../hooks/useFormLogic';
import type { ValidationRule, FieldType } from '../../types/form';

interface ValidationEditorProps {
  rules: ValidationRule[];
  fieldType: FieldType;
  onChange: (rules: ValidationRule[]) => void;
}

const VALIDATION_TYPES: Record<string, { label: string; hasValue: boolean; valueType: 'number' | 'text' }[]> = {
  text: [
    { label: 'Minimum Length', hasValue: true, valueType: 'number' },
    { label: 'Maximum Length', hasValue: true, valueType: 'number' },
    { label: 'Pattern (Regex)', hasValue: true, valueType: 'text' },
    { label: 'Custom Expression', hasValue: false, valueType: 'text' },
  ],
  number: [
    { label: 'Minimum Value', hasValue: true, valueType: 'number' },
    { label: 'Maximum Value', hasValue: true, valueType: 'number' },
    { label: 'Custom Expression', hasValue: false, valueType: 'text' },
  ],
  default: [
    { label: 'Custom Expression', hasValue: false, valueType: 'text' },
  ],
};

const TYPE_TO_VALIDATION: Record<string, string> = {
  'Minimum Length': 'minLength',
  'Maximum Length': 'maxLength',
  'Pattern (Regex)': 'pattern',
  'Minimum Value': 'min',
  'Maximum Value': 'max',
  'Custom Expression': 'custom',
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
  const { result, isTesting, testExpression } = useExpressionTester();
  const [testValue, setTestValue] = useState('');

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
      expression: type === 'custom' ? '' : undefined,
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

  const handleTestExpression = async (expression: string) => {
    // Wrap expression to return error message or null
    const testExpr = `
      (() => {
        let value = "${testValue}";
        ${expression}
      })()
    `;
    await testExpression(testExpr, { value: testValue });
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
        return 'Custom validation';
      default:
        return rule.type;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-slate-200">Validation Rules</h4>
        <Dropdown
          options={options.map((o) => ({ value: o.label, label: o.label }))}
          value=""
          onChange={addRule}
          placeholder="+ Add Rule"
          className="w-48"
        />
      </div>

      {rules.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-slate-400 text-center py-4">
          No validation rules. Add a rule to validate field input.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="border border-gray-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900"
            >
              {/* Rule Header */}
              <div
                className={cn(
                  'flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-800/50 cursor-pointer',
                  expandedRuleId === rule.id && 'border-b border-gray-200 dark:border-slate-800'
                )}
                onClick={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700 dark:text-slate-200">
                    {getRuleLabel(rule)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove validation rule"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRule(rule.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>

              {/* Rule Content */}
              {expandedRuleId === rule.id && (
                <div className="p-4 space-y-4">
                  {/* Value Input for rules that need it */}
                  {['minLength', 'maxLength', 'min', 'max'].includes(rule.type) && (
                    <Input
                      label="Value"
                      type="number"
                      value={rule.value as number}
                      onChange={(e) =>
                        updateRule(rule.id, { value: parseInt(e.target.value) || 0 })
                      }
                    />
                  )}

                  {rule.type === 'pattern' && (
                    <Input
                      label="Pattern (Regular Expression)"
                      value={rule.value as string}
                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                      placeholder="^[a-zA-Z]+$"
                    />
                  )}

                  {rule.type === 'custom' && (
                    <div className="space-y-3">
                      <Textarea
                        label="Custom Expression"
                        value={rule.expression || ''}
                        onChange={(e) =>
                          updateRule(rule.id, { expression: e.target.value })
                        }
                        placeholder={`// Return error message or null if valid
if (value.length < 5) {
  return "Must be at least 5 characters";
}
return null;`}
                        rows={5}
                        className="font-mono text-sm"
                      />

                      {/* Test Expression */}
                      <div className="bg-gray-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-2 border border-gray-200 dark:border-slate-800">
                        <div className="flex gap-2">
                          <Input
                            placeholder="Test value"
                            value={testValue}
                            onChange={(e) => setTestValue(e.target.value)}
                            className="flex-1"
                          />
                          <Button
                            size="sm"
                            onClick={() => handleTestExpression(rule.expression || '')}
                            isLoading={isTesting}
                            leftIcon={<Play className="h-4 w-4" />}
                          >
                            Test
                          </Button>
                        </div>
                        {result && (
                          <div className="flex items-center gap-2 text-sm">
                            {result.valid ? (
                              <>
                                <CheckCircle className="h-4 w-4 text-green-500" />
                                <span className="text-green-700 dark:text-green-400">
                                  {result.output === null ? 'Valid!' : `Error: ${result.output}`}
                                </span>
                              </>
                            ) : (
                              <>
                                <AlertCircle className="h-4 w-4 text-red-500" />
                                <span className="text-red-700 dark:text-red-400">{result.error}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Error Message */}
                  <Input
                    label="Error Message"
                    value={rule.message}
                    onChange={(e) => updateRule(rule.id, { message: e.target.value })}
                    placeholder="This field is invalid"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
