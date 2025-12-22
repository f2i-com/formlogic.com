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
  const availableFields = allFields.filter(
    (f) => !['welcome_screen', 'thank_you', 'statement', 'calculated'].includes(f.type)
  );

  // Create variable name mappings
  const { toId: varToId, toVar: idToVar } = useMemo(
    () => createFieldVariableMap(availableFields),
    [availableFields]
  );

  // Initialize with variable names (convert IDs to variable names for display)
  useEffect(() => {
    const displayExpr = replaceIdsWithVariables(expression, idToVar);
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
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Calculator className="h-5 w-5 text-primary-600" />
        <h4 className="text-sm font-medium text-gray-700">Calculated Field</h4>
      </div>

      <p className="text-sm text-gray-500">
        This field's value will be automatically calculated based on other fields.
      </p>

      {/* Available Fields */}
      <div>
        <p className="text-xs text-gray-500 mb-2">Click to insert variable:</p>
        <div className="flex flex-wrap gap-1">
          {availableFields.map((field) => {
            const varName = idToVar[field.id];
            return (
              <button
                key={field.id}
                onClick={() => insertFieldReference(field.id)}
                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 rounded transition-colors font-mono"
                title={field.label}
              >
                {varName}
              </button>
            );
          })}
        </div>
      </div>

      {/* Expression Editor */}
      <Textarea
        label="Calculation Expression"
        value={localExpression}
        onChange={(e) => setLocalExpression(e.target.value)}
        onBlur={handleBlur}
        placeholder={`// Example: Calculate total
price * quantity * (1 + taxRate / 100)`}
        rows={4}
        className="font-mono text-sm"
      />

      {/* Quick Reference */}
      <div className="bg-blue-50 rounded-lg p-3">
        <h5 className="text-xs font-medium text-blue-800 mb-2">Quick Reference</h5>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-blue-700">
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
      <div className="border border-gray-200 rounded-lg p-4 space-y-3">
        <h5 className="text-sm font-medium text-gray-700">Test Calculation</h5>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
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
            Calculate
          </Button>
          {result && (
            <div className="flex items-center gap-2">
              {result.valid ? (
                <>
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-green-700">
                    Result: <strong>{String(result.output)}</strong>
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-red-500" />
                  <span className="text-sm text-red-700">{result.error}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Example Formulas */}
      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600 hover:text-gray-800">
          <HelpCircle className="h-4 w-4 inline mr-1" />
          Example Formulas
        </summary>
        <div className="mt-2 space-y-2 text-gray-600 pl-5">
          <div>
            <strong>Order Total:</strong>
            <code className="block bg-gray-100 p-2 rounded mt-1 text-xs">
              {`subtotal + shipping - discount`}
            </code>
          </div>
          <div>
            <strong>Tax Amount:</strong>
            <code className="block bg-gray-100 p-2 rounded mt-1 text-xs">
              {`subtotal * (taxRate / 100)`}
            </code>
          </div>
          <div>
            <strong>Percentage:</strong>
            <code className="block bg-gray-100 p-2 rounded mt-1 text-xs">
              {`Math.round((completed / total) * 100)`}
            </code>
          </div>
          <div>
            <strong>Conditional:</strong>
            <code className="block bg-gray-100 p-2 rounded mt-1 text-xs">
              {`quantity > 10 ? price * 0.9 : price`}
            </code>
          </div>
        </div>
      </details>
    </div>
  );
}
