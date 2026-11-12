import { useState, useEffect, useMemo } from 'react';
import { Calculator, Play, AlertCircle, CheckCircle, HelpCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { createFieldVariableMap, replaceVariablesWithIds, replaceIdsWithVariables } from '../../lib/utils';
import { useExpressionTester } from '../../hooks/useFormLogic';
import type { FormField } from '../../types/form';

interface CalculatedFieldEditorProps {
  expression: string;
  allFields: FormField[];
  onChange: (expression: string) => void;
}

export function CalculatedFieldEditor({
  expression,
  allFields,
  onChange,
}: CalculatedFieldEditorProps) {
  const [localExpression, setLocalExpression] = useState('');
  const [testContext, setTestContext] = useState('{}');
  const { result, isTesting, testExpression } = useExpressionTester();

  // Available fields for calculations (excluding layout fields)
  const availableFields = useMemo(
    () => allFields.filter(
      (f) => !['welcome_screen', 'thank_you', 'statement', 'calculated'].includes(f.type)
    ),
    [allFields]
  );

  // Create variable name mappings
  const { toId: varToId, toVar: idToVar } = useMemo(
    () => createFieldVariableMap(availableFields),
    [availableFields]
  );

  // Initialize with variable names (convert IDs to variable names for display)
  useEffect(() => {
    const displayExpr = replaceIdsWithVariables(expression, idToVar);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop->local sync: reset displayed expression when the expression prop or id/var map changes externally
    setLocalExpression(displayExpr);
  }, [expression, idToVar]);

  const handleBlur = () => {
    // Convert variable names to field IDs when saving
    const exprWithIds = replaceVariablesWithIds(localExpression, varToId);
    if (exprWithIds !== expression) {
      onChange(exprWithIds);
    }
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
    await testExpression(localExpression, context);
  };

  const insertFieldReference = (fieldId: string) => {
    const varName = idToVar[fieldId] || fieldId;
    setLocalExpression((prev) => prev + varName);
  };

  // Generate sample test context with variable names
  const sampleContext = useMemo(() => {
    const sample: Record<string, number> = {};
    availableFields.slice(0, 3).forEach((f) => {
      const varName = idToVar[f.id];
      sample[varName] = f.type === 'number' ? 100 : 0;
    });
    return JSON.stringify(sample, null, 2);
  }, [availableFields, idToVar]);

  return (
    <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-slate-800">
      <div>
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
          <Calculator className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" />
          Calculation
        </h4>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Nobody types this field: its value is worked out from other fields' answers.
        </p>
      </div>

      {/* Available Fields */}
      {availableFields.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-1.5">Press a field to add it to the calculation</p>
          <div className="flex flex-wrap gap-1">
            {availableFields.map((field) => {
              const varName = idToVar[field.id];
              return (
                <button
                  key={field.id}
                  type="button"
                  onClick={() => insertFieldReference(field.id)}
                  // A long name breaks inside its chip: in one piece it ran out of the panel.
                  className="max-w-full cursor-pointer break-all px-2 py-1 text-left text-xs bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-500/30 rounded-md transition-colors font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 max-sm:px-3"
                  title={field.label}
                >
                  {varName}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Expression Editor */}
      <Textarea
        label="Calculation"
        value={localExpression}
        onChange={(e) => setLocalExpression(e.target.value)}
        onBlur={handleBlur}
        placeholder={`// Example: Calculate total
price * quantity * (1 + taxRate / 100)`}
        rows={4}
        className="font-mono text-sm"
      />

      {/* One column: in a panel of 320 px two columns broke every line in two. */}
      <div className="bg-gray-50 dark:bg-slate-800/50 rounded-xl p-3 border border-gray-200 dark:border-slate-700">
        <h5 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-2">Quick reference</h5>
        <div className="grid grid-cols-1 gap-y-1 text-xs text-gray-600 dark:text-slate-300 [&_code]:font-mono [&_code]:text-primary-700 dark:[&_code]:text-primary-300">
          <div><code>+</code> <code>-</code> <code>*</code> <code>/</code> math</div>
          <div><code>sum([a, b, c])</code> sum array</div>
          <div><code>avg([a, b, c])</code> average</div>
          <div><code>count(array)</code> count items</div>
          <div><code>Math.round(n)</code> round number</div>
          <div><code>Math.floor(n)</code> floor number</div>
          <div><code>format.currency(n)</code> format as $</div>
          <div><code>format.number(n, 2)</code> 2 decimals</div>
        </div>
      </div>

      {/* Test Panel */}
      <div className="border border-gray-200 dark:border-slate-700 rounded-xl p-3 space-y-3 bg-white dark:bg-slate-900/50">
        <h5 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Try the calculation</h5>
        <div>
          <label className="block text-xs leading-5 text-gray-500 dark:text-slate-400 mb-1">
            Answers to try (JSON), with the fields' names as keys
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
            Calculate
          </Button>
          {result && (
            <div className="flex min-w-0 items-center gap-2 break-words">
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

      {/* Example Formulas */}
      <details className="text-sm group">
        <summary className="cursor-pointer rounded-md text-gray-600 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:flex max-sm:min-h-11 max-sm:items-center">
          <HelpCircle className="h-4 w-4 inline mr-1" />
          Example formulas
        </summary>
        <div className="mt-2 space-y-2 text-gray-600 dark:text-slate-400">
          <div>
            <strong>Order total:</strong>
            <code className="block bg-gray-100 dark:bg-slate-800 p-2 rounded mt-1 text-xs border border-gray-200 dark:border-slate-700">
              {`subtotal + shipping - discount`}
            </code>
          </div>
          <div>
            <strong>Tax amount:</strong>
            <code className="block bg-gray-100 dark:bg-slate-800 p-2 rounded mt-1 text-xs border border-gray-200 dark:border-slate-700">
              {`subtotal * (taxRate / 100)`}
            </code>
          </div>
          <div>
            <strong>Percentage:</strong>
            <code className="block bg-gray-100 dark:bg-slate-800 p-2 rounded mt-1 text-xs border border-gray-200 dark:border-slate-700">
              {`Math.round((completed / total) * 100)`}
            </code>
          </div>
          <div>
            <strong>Conditional:</strong>
            <code className="block bg-gray-100 dark:bg-slate-800 p-2 rounded mt-1 text-xs border border-gray-200 dark:border-slate-700">
              {`quantity > 10 ? price * 0.9 : price`}
            </code>
          </div>
        </div>
      </details>
    </div>
  );
}
