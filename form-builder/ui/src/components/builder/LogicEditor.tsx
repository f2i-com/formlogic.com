import { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Code, Wand2, Play, AlertCircle, CheckCircle, Plus, Trash2, HelpCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Dropdown } from '../ui/Dropdown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { cn, createFieldVariableMap, replaceVariablesWithIds, replaceIdsWithVariables } from '../../lib/utils';
import { useExpressionTester } from '../../hooks/useFormLogic';
import type { FormField, ConditionalLogic } from '../../types/form';

interface LogicEditorProps {
  isOpen: boolean;
  onClose: () => void;
  field: FormField;
  allFields: FormField[];
  onSave: (logic: ConditionalLogic | undefined) => void;
}

interface SimpleCondition {
  id: string;
  fieldId: string;
  operator: string;
  value: string;
}

const OPERATORS = [
  { value: '===', label: 'equals' },
  { value: '!==', label: 'does not equal' },
  { value: '>', label: 'is greater than' },
  { value: '<', label: 'is less than' },
  { value: '>=', label: 'is greater than or equal to' },
  { value: '<=', label: 'is less than or equal to' },
  { value: 'contains', label: 'contains' },
  { value: 'notEmpty', label: 'is not empty' },
  { value: 'empty', label: 'is empty' },
];

const ACTIONS = [
  { value: 'show', label: 'Show this field' },
  { value: 'hide', label: 'Hide this field' },
  { value: 'require', label: 'Make this field required' },
  { value: 'skip', label: 'Skip this field' },
];

function simpleConditionToExpression(
  conditions: SimpleCondition[],
  combinator: 'and' | 'or',
  idToVar: Record<string, string>
): string {
  if (conditions.length === 0) return 'true';

  const parts = conditions.map((cond) => {
    // Use variable name instead of field ID
    const fieldRef = idToVar[cond.fieldId] || cond.fieldId;
    // Escape quotes in value to prevent expression injection
    const escaped = String(cond.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const value = cond.value;

    switch (cond.operator) {
      case '===':
        return `${fieldRef} === "${escaped}"`;
      case '!==':
        return `${fieldRef} !== "${escaped}"`;
      case '>':
        return `${fieldRef} > ${Number(value) || 0}`;
      case '<':
        return `${fieldRef} < ${Number(value) || 0}`;
      case '>=':
        return `${fieldRef} >= ${Number(value) || 0}`;
      case '<=':
        return `${fieldRef} <= ${Number(value) || 0}`;
      case 'contains':
        // Guard against a null/unanswered trigger (null.includes throws -> the
        // condition fails OPEN, inconsistent with ===/notEmpty). isNotEmpty keeps
        // both string-substring and array-membership semantics of .includes.
        return `isNotEmpty(${fieldRef}) && ${fieldRef}.includes("${escaped}")`;
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

export function LogicEditor({
  isOpen,
  onClose,
  field,
  allFields,
  onSave,
}: LogicEditorProps) {
  const [mode, setMode] = useState<'simple' | 'expression'>('simple');
  const [action, setAction] = useState<string>(field.conditionalLogic?.action || 'show');
  const [expression, setExpression] = useState('');
  const [conditions, setConditions] = useState<SimpleCondition[]>([]);
  const [combinator, setCombinator] = useState<'and' | 'or'>('and');
  const [testContext, setTestContext] = useState('{}');

  const { result, isTesting, testExpression } = useExpressionTester();

  // Available fields for conditions (excluding the current field)
  const availableFields = useMemo(
    () => allFields.filter((f) => f.id !== field.id && !['welcome_screen', 'thank_you', 'statement'].includes(f.type)),
    [allFields, field.id]
  );

  // Create variable name mappings
  const { toId: varToId, toVar: idToVar } = useMemo(
    () => createFieldVariableMap(availableFields),
    [availableFields]
  );

  // Initialize from existing logic (convert IDs to variable names for display)
  useEffect(() => {
    if (field.conditionalLogic) {
      setAction(field.conditionalLogic.action);
      // Convert field IDs to variable names for display
      const displayExpr = replaceIdsWithVariables(field.conditionalLogic.expression, idToVar);
      setExpression(displayExpr);
      // Simple Mode can't represent an arbitrary saved expression, so it would
      // render empty (looks like "no logic") and then overwrite the saved value
      // the moment a condition is added. Open in Expression mode to show the
      // real saved logic.
      setMode('expression');
    } else {
      setAction('show');
      setExpression('');
      setConditions([]);
      setMode('simple');
    }
  }, [field, idToVar]);

  // Update expression when simple conditions change. Must also handle the empty
  // case: when the last condition is removed, clear the expression — otherwise the
  // stale generated string persists and handleSave writes a phantom rule the author
  // believed they had cleared.
  useEffect(() => {
    if (mode === 'simple') {
      setExpression(conditions.length > 0 ? simpleConditionToExpression(conditions, combinator, idToVar) : '');
    }
  }, [conditions, combinator, mode, idToVar]);

  const handleAddCondition = () => {
    if (availableFields.length === 0) return;
    setConditions([
      ...conditions,
      { id: uuidv4(), fieldId: availableFields[0].id, operator: '===', value: '' },
    ]);
  };

  const handleRemoveCondition = (conditionId: string) => {
    setConditions(conditions.filter((cond) => cond.id !== conditionId));
  };

  const handleConditionChange = (conditionId: string, updates: Partial<SimpleCondition>) => {
    setConditions(
      conditions.map((cond) => (cond.id === conditionId ? { ...cond, ...updates } : cond))
    );
  };

  const parseTestContext = (input: string): Record<string, unknown> => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === '{}') return {};

    try {
      // First try standard JSON
      return JSON.parse(trimmed);
    } catch {
      // Try to fix JavaScript-style object literals (unquoted keys)
      // Convert {key: "value"} to {"key": "value"}
      const fixed = trimmed.replace(
        /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
        '$1"$2":'
      );
      try {
        return JSON.parse(fixed);
      } catch {
        return {};
      }
    }
  };

  const handleTest = async () => {
    // Test with variable names directly (don't convert to field IDs)
    // Field IDs are UUIDs with hyphens which aren't valid JS identifiers
    const context = parseTestContext(testContext);
    await testExpression(expression, context);
  };

  const handleSave = () => {
    if (!expression.trim()) {
      onSave(undefined);
    } else {
      // Convert variable names to field IDs when saving
      const exprWithIds = replaceVariablesWithIds(expression.trim(), varToId);
      onSave({
        expression: exprWithIds,
        action: action as ConditionalLogic['action'],
      });
    }
    onClose();
  };

  const handleClear = () => {
    setExpression('');
    setConditions([]);
    setAction('show');
  };

  const fieldOptions = availableFields.map((f) => ({
    value: f.id,
    label: f.label || f.id,
  }));

  // Generate sample test context with variable names
  const sampleContext = useMemo(() => {
    const sample: Record<string, string> = {};
    availableFields.slice(0, 2).forEach((f) => {
      const varName = idToVar[f.id];
      sample[varName] = f.type === 'number' ? '0' : 'value';
    });
    return JSON.stringify(sample, null, 2);
  }, [availableFields, idToVar]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Conditional Logic"
      size="lg"
    >
      <div className="p-6 space-y-6">
        {/* Field Info */}
        <div className="bg-gray-50 dark:bg-slate-800 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Configure when the field <strong>"{field.label}"</strong> should be shown, hidden, or required.
          </p>
        </div>

        {/* Action Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
            When condition is met:
          </label>
          <Dropdown
            options={ACTIONS}
            value={action}
            onChange={setAction}
          />
        </div>

        {/* Mode Tabs */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'simple' | 'expression')}>
          <TabsList>
            <TabsTrigger value="simple">
              <Wand2 className="h-4 w-4 mr-2" />
              Simple Mode
            </TabsTrigger>
            <TabsTrigger value="expression">
              <Code className="h-4 w-4 mr-2" />
              Expression Mode
            </TabsTrigger>
          </TabsList>

          {/* Simple Mode */}
          <TabsContent value="simple" className="mt-4">
            {availableFields.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-slate-500">
                <HelpCircle className="h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                <p>Add more fields to your form to create conditions.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {conditions.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600 dark:text-slate-400">Match</span>
                    <div className="flex bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
                      <button
                        type="button"
                        onClick={() => setCombinator('and')}
                        className={cn(
                          'px-3 py-1 text-sm rounded-md transition-colors cursor-pointer',
                          combinator === 'and' ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700/50'
                        )}
                      >
                        All conditions (AND)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCombinator('or')}
                        className={cn(
                          'px-3 py-1 text-sm rounded-md transition-colors cursor-pointer',
                          combinator === 'or' ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700/50'
                        )}
                      >
                        Any condition (OR)
                      </button>
                    </div>
                  </div>
                )}

                {/* Condition Rows */}
                <div className="space-y-3">
                  {conditions.map((cond, index) => (
                    <div key={cond.id} className="flex flex-col sm:flex-row items-start sm:items-center gap-2 bg-gray-50 dark:bg-slate-800 p-3 rounded-lg border border-gray-100 dark:border-slate-700">
                      {index > 0 && (
                        <span className="text-xs text-gray-500 dark:text-slate-500 uppercase font-medium w-10 shrink-0">
                          {combinator}
                        </span>
                      )}
                      <Dropdown
                        options={fieldOptions}
                        value={cond.fieldId}
                        onChange={(v) => handleConditionChange(cond.id, { fieldId: v })}
                        className="flex-1 min-w-[150px]"
                      />
                      <Dropdown
                        options={OPERATORS.map((op) => ({ value: op.value, label: op.label }))}
                        value={cond.operator}
                        onChange={(v) => handleConditionChange(cond.id, { operator: v })}
                        className="w-full sm:w-48"
                      />
                      {!['notEmpty', 'empty'].includes(cond.operator) && (
                        <Input
                          value={cond.value}
                          onChange={(e) => handleConditionChange(cond.id, { value: e.target.value })}
                          placeholder="Value"
                          className="w-full sm:w-32"
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove condition ${index + 1}`}
                        onClick={() => handleRemoveCondition(cond.id)}
                        className="self-end sm:self-center"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddCondition}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Add Condition
                </Button>

                {/* Generated Expression Preview */}
                {conditions.length > 0 && (
                  <div className="mt-4 p-3 bg-gray-100 dark:bg-slate-900 rounded-lg">
                    <p className="text-xs text-gray-500 dark:text-slate-500 mb-1">Generated Expression:</p>
                    <code className="text-sm text-gray-700 dark:text-slate-300 font-mono break-all">{expression}</code>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* Expression Mode */}
          <TabsContent value="expression" className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                FormLogic Expression
              </label>
              <Textarea
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder="e.g., age >= 18 && country === 'US'"
                rows={4}
                className="font-mono text-sm"
              />
              {/* Available Variables */}
              <div className="mt-2">
                <p className="text-xs text-gray-500 dark:text-slate-500 mb-1">Available variables:</p>
                <div className="flex flex-wrap gap-1">
                  {availableFields.map((f) => {
                    const varName = idToVar[f.id];
                    return (
                      <button
                        key={f.id}
                        onClick={() => setExpression((prev) => prev + varName)}
                        className="px-2 py-0.5 text-xs bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 rounded hover:bg-primary-200 dark:hover:bg-primary-500/30 transition-colors font-mono cursor-pointer"
                        title={f.label}
                      >
                        {varName}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Quick Reference */}
            <div className="bg-primary-50 dark:bg-primary-500/10 rounded-lg p-4 border border-primary-100 dark:border-primary-500/20">
              <h4 className="text-sm font-medium text-primary-800 dark:text-primary-400 mb-2">Quick Reference</h4>
              <div className="grid grid-cols-2 gap-2 text-xs text-primary-700 dark:text-primary-300/80">
                <div><code>===</code> equals</div>
                <div><code>!==</code> not equals</div>
                <div><code>&&</code> AND</div>
                <div><code>||</code> OR</div>
                <div><code>isEmpty(field)</code> check empty</div>
                <div><code>isNotEmpty(field)</code> check not empty</div>
                <div><code>contains(arr, val)</code> array contains</div>
                <div><code>validators.email(val)</code> validate email</div>
              </div>
            </div>

            {/* Test Panel */}
            <div className="border border-gray-200 dark:border-slate-700 rounded-lg p-4 bg-white dark:bg-slate-800/50">
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Test Expression</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-slate-500 mb-1">
                    Test Context (JSON) - use variable names as keys
                  </label>
                  <Textarea
                    value={testContext}
                    onChange={(e) => setTestContext(e.target.value)}
                    placeholder={sampleContext}
                    rows={2}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    onClick={handleTest}
                    isLoading={isTesting}
                    leftIcon={<Play className="h-4 w-4" />}
                  >
                    Test
                  </Button>
                  {result && (
                    <div className="flex items-center gap-2">
                      {result.valid ? (
                        <>
                          <CheckCircle className="h-4 w-4 text-green-500" />
                          <span className="text-sm text-green-700 dark:text-green-400">
                            Result: <strong>{String(result.output)}</strong>
                          </span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-4 w-4 text-red-500" />
                          <span className="text-sm text-red-700 dark:text-red-400">{result.error}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-slate-700">
          <Button variant="ghost" onClick={handleClear}>
            Clear Logic
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save Condition
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
