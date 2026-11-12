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
import { CHOICE_FIELDS, DATE_INPUTS, LIST_ANSWERS, NUMBER_ANSWERS, OPERATORS_ON_AN_OPTION, simpleConditionToExpression, type SimpleCondition } from './logicConditions';

interface LogicEditorProps {
  isOpen: boolean;
  onClose: () => void;
  field: FormField;
  allFields: FormField[];
  onSave: (logic: ConditionalLogic | undefined) => void;
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

const LIST_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'notEmpty', label: 'is not empty' },
  { value: 'empty', label: 'is empty' },
];

// 'hide' and 'skip' execute byte-identical logic on both the client (useFormLogic) and the
// server (ResponseService) — both simply mark the field not-visible when the condition is
// false. Offering them as two distinct choices here just confused users, since nothing
// changes when switching between them. 'skip' is intentionally NOT removed from the runtime
// (useFormLogic.ts / ResponseService.php) — only the duplicate menu entry is gone, so any
// form logic rule saved with action:'skip' before this change keeps behaving exactly as before.
const ACTIONS = [
  { value: 'show', label: 'Show this field' },
  { value: 'hide', label: 'Hide this field' },
  { value: 'require', label: 'Make this field required' },
];

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
  // The test context is pre-filled from the form's fields (see defaultTestContext); we only
  // store the user's edits here, keyed by field so switching fields shows the right default
  // without a state-resetting effect. null = untouched -> show the auto-filled default.
  const [editedContext, setEditedContext] = useState<{ fieldId: string; value: string } | null>(null);

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

  // What each field's answer is, which decides how a condition on it compares.
  const fieldTypes = useMemo(() => new Map(availableFields.map((f) => [f.id, f.type])), [availableFields]);

  // Initialize from existing logic (convert IDs to variable names for display)
  useEffect(() => {
    if (field.conditionalLogic) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop->local-state sync: reset the editor draft when the selected field prop changes
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

  // Regenerate the expression from simple conditions only when there ARE
  // conditions — otherwise switching to Simple Mode on a field whose saved logic
  // can't be represented as simple conditions (conditions stays []) would wipe the
  // loaded expression and Save would delete the rule. Clearing the last condition
  // is handled explicitly in handleRemoveCondition / handleClear.
  useEffect(() => {
    if (mode === 'simple' && conditions.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derived expression must be regenerated synchronously when simple conditions/combinator change
      setExpression(simpleConditionToExpression(conditions, combinator, idToVar, fieldTypes));
    }
  }, [conditions, combinator, mode, idToVar, fieldTypes]);

  const operatorsFor = (fieldId: string) => (LIST_ANSWERS.has(fieldTypes.get(fieldId) ?? '') ? LIST_OPERATORS : OPERATORS);

  const handleAddCondition = () => {
    if (availableFields.length === 0) return;
    const fieldId = availableFields[0].id;
    setConditions([
      ...conditions,
      { id: uuidv4(), fieldId, operator: operatorsFor(fieldId)[0].value, value: '' },
    ]);
  };

  const handleRemoveCondition = (conditionId: string) => {
    const next = conditions.filter((cond) => cond.id !== conditionId);
    setConditions(next);
    // Removing the last condition clears the rule (the effect above no longer
    // regenerates from an empty set).
    if (next.length === 0) setExpression('');
  };

  const handleConditionChange = (conditionId: string, updates: Partial<SimpleCondition>) => {
    setConditions(
      conditions.map((cond) => (cond.id === conditionId ? { ...cond, ...updates } : cond))
    );
  };

  /** Another field may not take the same comparison, and the box would show none picked. */
  const handleConditionFieldChange = (cond: SimpleCondition, fieldId: string) => {
    const operators = operatorsFor(fieldId);
    const operator = operators.some((op) => op.value === cond.operator) ? cond.operator : operators[0].value;
    handleConditionChange(cond.id, { fieldId, operator });
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

  // Pre-fill the test context with every available field's variable as a key, with a
  // sensible default by type, so the user only has to refine the values.
  const defaultTestContext = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    for (const f of availableFields) {
      const varName = idToVar[f.id];
      if (!varName) continue;
      if (NUMBER_ANSWERS.has(f.type) || f.type === 'calculated') ctx[varName] = 0;
      else if (f.type === 'checkboxes') ctx[varName] = [];
      else ctx[varName] = '';
    }
    return Object.keys(ctx).length ? JSON.stringify(ctx, null, 2) : '{}';
  }, [availableFields, idToVar]);

  // Show the user's edits for THIS field if any, otherwise the auto-filled default.
  const testContext = editedContext && editedContext.fieldId === field.id ? editedContext.value : defaultTestContext;

  /** The box a condition's value goes in, which depends on the field and how it is compared. */
  const conditionValue = (cond: SimpleCondition, index: number) => {
    const conditionField = availableFields.find((f) => f.id === cond.fieldId);
    const setValue = (value: string) => handleConditionChange(cond.id, { value });
    if (conditionField && CHOICE_FIELDS.has(conditionField.type) && OPERATORS_ON_AN_OPTION.has(cond.operator)) {
      // A rule compares what is stored for an answer, an option's value. Its label can be renamed
      // while the value stays option_1, and nothing in a free text box said so: a rule typed from
      // the label never matched. A value no option holds is still offered, so it stays in sight.
      const options = (conditionField.properties.options ?? []).map((o) => ({ value: o.value, label: o.label || o.value }));
      if (cond.value !== '' && !options.some((o) => o.value === cond.value)) {
        options.unshift({ value: cond.value, label: `${cond.value} (not an option)` });
      }
      return (
        <div role="group" aria-label={`Value for condition ${index + 1}`} className="w-full sm:w-52 sm:flex-none">
          <Dropdown options={options} value={cond.value} onChange={setValue} placeholder="Choose an option" />
        </div>
      );
    }
    const dateInput = conditionField && cond.operator !== 'contains' ? DATE_INPUTS[conditionField.type] : undefined;
    return (
      // The box's own wrapper takes the width it is given, which in a row is all that is left:
      // the field's picker beside it was squeezed to two lines. Sized here, the field's
      // picker gets the spare width.
      <div className="w-full sm:w-52 sm:flex-none">
        <Input
          type={dateInput ?? 'text'}
          value={cond.value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          aria-label={`Value for condition ${index + 1}`}
        />
      </div>
    );
  };

  return (
    // Wide enough for a condition's row (a field, how it is compared, a value): at 32rem the
    // row ran out of the dialog's right edge from the second condition on.
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Conditional logic"
      description={`When "${field.label}" is shown, hidden or required.`}
      size="full"
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={handleClear} className="max-sm:min-h-11">
            Clear rule
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="max-sm:min-h-11">
              Cancel
            </Button>
            <Button onClick={handleSave} className="max-sm:min-h-11">
              Save rule
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-5 p-4 sm:p-6">
        {/* Action Selector */}
        <div className="max-w-sm">
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
            When the condition is met
          </label>
          <Dropdown
            options={ACTIONS}
            // Legacy rules saved with action:'skip' have no matching option now — display them
            // as 'hide' (their real behavior is identical) rather than showing an empty
            // placeholder. `action` state itself stays 'skip' until the user actively changes
            // this dropdown, so re-saving without touching it doesn't rewrite the stored value.
            value={action === 'skip' ? 'hide' : action}
            onChange={setAction}
          />
        </div>

        {/* Mode Tabs */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'simple' | 'expression')}>
          <TabsList className="w-fit max-w-full" aria-label="How the condition is written">
            <TabsTrigger value="simple" className="inline-flex items-center">
              <Wand2 className="h-4 w-4 mr-2" />
              Simple
            </TabsTrigger>
            <TabsTrigger value="expression" className="inline-flex items-center">
              <Code className="h-4 w-4 mr-2" />
              Expression
            </TabsTrigger>
          </TabsList>

          {/* Simple Mode */}
          <TabsContent value="simple" className="mt-4">
            {availableFields.length === 0 ? (
              <p className="flex items-start gap-2 text-sm text-gray-500 dark:text-slate-400">
                <HelpCircle className="mt-0.5 h-4 w-4 flex-none text-gray-400 dark:text-slate-500" />
                A condition compares another field's answer. Add another field to the form first.
              </p>
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
                <div className="space-y-2">
                  {conditions.map((cond, index) => (
                    <div key={cond.id} className="flex flex-col sm:flex-row items-start sm:items-center gap-2 bg-gray-50 dark:bg-slate-800/60 p-2.5 rounded-xl border border-gray-200 dark:border-slate-700">
                      {index > 0 && (
                        <span className="text-xs text-gray-500 dark:text-slate-400 uppercase font-semibold tracking-wider w-8 shrink-0">
                          {combinator}
                        </span>
                      )}
                      <Dropdown
                        options={fieldOptions}
                        value={cond.fieldId}
                        onChange={(v) => handleConditionFieldChange(cond, v)}
                        className="w-full min-w-0 sm:w-auto sm:flex-1 sm:min-w-[150px]"
                      />
                      <Dropdown
                        options={operatorsFor(cond.fieldId).map((op) => ({ value: op.value, label: op.label }))}
                        value={cond.operator}
                        onChange={(v) => handleConditionChange(cond.id, { operator: v })}
                        className="w-full sm:w-60"
                      />
                      {!['notEmpty', 'empty'].includes(cond.operator) && conditionValue(cond, index)}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove condition ${index + 1}`}
                        title="Remove condition"
                        onClick={() => handleRemoveCondition(cond.id)}
                        className="flex-none self-end px-2.5 text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400 sm:self-center"
                      >
                        <Trash2 className="h-4 w-4" />
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
                  Add condition
                </Button>

                {/* Generated Expression Preview */}
                {conditions.length > 0 && (
                  <div className="p-3 bg-gray-50 dark:bg-slate-800/50 border border-gray-200 dark:border-slate-700 rounded-xl">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1">Generated expression</p>
                    <code className="text-sm text-gray-700 dark:text-slate-300 font-mono break-all">{expression}</code>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* Expression Mode */}
          <TabsContent value="expression" className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                FormLogic expression
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
                        type="button"
                        onClick={() => setExpression((prev) => prev + (prev && !/\s$/.test(prev) ? ' ' : '') + varName)}
                        className="max-w-full break-all px-2 py-0.5 text-left text-xs bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 rounded-md hover:bg-primary-200 dark:hover:bg-primary-500/30 transition-colors font-mono cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 max-sm:px-3"
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
            <div className="bg-gray-50 dark:bg-slate-800/50 rounded-xl p-3 border border-gray-200 dark:border-slate-700">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-2">Quick reference</h4>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs text-gray-600 dark:text-slate-300 sm:grid-cols-2 lg:grid-cols-4 [&_code]:font-mono [&_code]:text-primary-700 dark:[&_code]:text-primary-300">
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
            <div className="border border-gray-200 dark:border-slate-700 rounded-xl p-3 bg-white dark:bg-slate-800/50">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-2">Test the expression</h4>
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-xs leading-5 text-gray-500 dark:text-slate-400">
                      Answers to test with (JSON), filled in from your fields: change the values to try
                    </label>
                    {editedContext && editedContext.fieldId === field.id && (
                      <button
                        type="button"
                        onClick={() => setEditedContext(null)}
                        className="text-xs text-primary-600 dark:text-primary-400 hover:underline cursor-pointer"
                      >
                        Reset to fields
                      </button>
                    )}
                  </div>
                  <Textarea
                    value={testContext}
                    onChange={(e) => setEditedContext({ fieldId: field.id, value: e.target.value })}
                    placeholder="{}"
                    rows={Math.min(10, Math.max(3, availableFields.length + 2))}
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
      </div>
    </Modal>
  );
}
