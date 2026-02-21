import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  evaluateCondition,
  validateWithExpression,
  calculateValue,
  validateExpression,
} from '../lib/formlogic';
import type { FormField } from '../types/form';

/**
 * Hook for evaluating conditional logic on fields
 */
export function useConditionalLogic(
  fields: FormField[],
  formData: Record<string, unknown>
) {
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());
  const [requiredFields, setRequiredFields] = useState<Set<string>>(new Set());
  const [isEvaluating, setIsEvaluating] = useState(false);

  const evaluateAllConditions = useCallback(async () => {
    setIsEvaluating(true);

    const visible = new Set<string>();
    const required = new Set<string>();

    for (const field of fields) {
      // If no conditional logic, field is visible
      if (!field.conditionalLogic?.expression) {
        visible.add(field.id);
        if (field.required) required.add(field.id);
        continue;
      }

      try {
        const result = await evaluateCondition(
          field.conditionalLogic.expression,
          formData
        );

        const action = field.conditionalLogic.action;

        if (action === 'show') {
          if (result) visible.add(field.id);
        } else if (action === 'hide') {
          if (!result) visible.add(field.id);
        } else if (action === 'require') {
          visible.add(field.id);
          if (result) required.add(field.id);
        } else {
          // Default: show
          visible.add(field.id);
        }

        // Add base required fields
        if (field.required && visible.has(field.id)) {
          required.add(field.id);
        }
      } catch {
        // On error, show the field
        visible.add(field.id);
        if (field.required) required.add(field.id);
      }
    }

    // Only update state if the actual contents changed (prevents cascading re-renders)
    setVisibleFields((prev) => {
      if (prev.size === visible.size && [...visible].every((id) => prev.has(id))) return prev;
      return visible;
    });
    setRequiredFields((prev) => {
      if (prev.size === required.size && [...required].every((id) => prev.has(id))) return prev;
      return required;
    });
    setIsEvaluating(false);
  }, [fields, formData]);

  useEffect(() => {
    evaluateAllConditions();
  }, [evaluateAllConditions]);

  const isFieldVisible = useCallback(
    (fieldId: string) => visibleFields.has(fieldId),
    [visibleFields]
  );

  const isFieldRequired = useCallback(
    (fieldId: string) => requiredFields.has(fieldId),
    [requiredFields]
  );

  return {
    visibleFields,
    requiredFields,
    isFieldVisible,
    isFieldRequired,
    isEvaluating,
    refresh: evaluateAllConditions,
  };
}

/**
 * Hook for field validation with custom expressions
 */
export function useFieldValidation(
  field: FormField,
  value: unknown,
  formData: Record<string, unknown>
) {
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validate = useCallback(async () => {
    setIsValidating(true);

    // Check built-in validations first
    if (field.required && !value) {
      setError('This field is required');
      setIsValidating(false);
      return false;
    }

    // Check validation rules
    if (field.validation && field.validation.length > 0) {
      for (const rule of field.validation) {
        if (rule.type === 'custom' && rule.expression) {
          const result = await validateWithExpression(
            rule.expression,
            value,
            formData
          );
          if (result) {
            setError(result);
            setIsValidating(false);
            return false;
          }
        } else if (rule.type === 'minLength' && typeof value === 'string') {
          if (value.length < (rule.value as number)) {
            setError(rule.message || `Minimum ${rule.value} characters required`);
            setIsValidating(false);
            return false;
          }
        } else if (rule.type === 'maxLength' && typeof value === 'string') {
          if (value.length > (rule.value as number)) {
            setError(rule.message || `Maximum ${rule.value} characters allowed`);
            setIsValidating(false);
            return false;
          }
        } else if (rule.type === 'pattern' && typeof value === 'string') {
          try {
            const regex = new RegExp(rule.value as string);
            if (!regex.test(value)) {
              setError(rule.message || 'Invalid format');
              setIsValidating(false);
              return false;
            }
          } catch {
            setError(rule.message || 'Invalid validation pattern');
            setIsValidating(false);
            return false;
          }
        } else if (rule.type === 'min' && typeof value === 'number') {
          if (value < (rule.value as number)) {
            setError(rule.message || `Minimum value is ${rule.value}`);
            setIsValidating(false);
            return false;
          }
        } else if (rule.type === 'max' && typeof value === 'number') {
          if (value > (rule.value as number)) {
            setError(rule.message || `Maximum value is ${rule.value}`);
            setIsValidating(false);
            return false;
          }
        }
      }
    }

    setError(null);
    setIsValidating(false);
    return true;
  }, [field, value, formData]);

  // Debounced validation
  const validateDebounced = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      validate();
    }, 300);
  }, [validate]);

  useEffect(() => {
    if (value !== undefined) {
      validateDebounced();
    }
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, validateDebounced]);

  return {
    error,
    isValidating,
    validate,
  };
}

/**
 * Hook for calculated fields
 */
export function useCalculatedField(
  expression: string | undefined,
  formData: Record<string, unknown>,
  dependencies: string[] = []
) {
  const [value, setValue] = useState<unknown>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create a stable key for the dependency values
  const dependencyKey = useMemo(() => {
    return dependencies.map(dep => JSON.stringify(formData[dep])).join('|');
  }, [dependencies, formData]);

  // Use a ref for formData to avoid re-creating calculate on every formData change.
  // The dependencyKey already tracks the relevant dependency values.
  const formDataRef = useRef(formData);
  formDataRef.current = formData;

  const calculate = useCallback(async () => {
    if (!expression) {
      setValue(null);
      return;
    }

    setIsCalculating(true);
    setError(null);

    try {
      const result = await calculateValue(expression, formDataRef.current);
      setValue(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calculation error');
      setValue(null);
    }

    setIsCalculating(false);
  }, [expression]);

  useEffect(() => {
    calculate();
  }, [calculate, dependencyKey]);

  return {
    value,
    isCalculating,
    error,
    recalculate: calculate,
  };
}

/**
 * Hook for testing expressions
 */
export function useExpressionTester() {
  const [result, setResult] = useState<{
    valid: boolean;
    output?: unknown;
    error?: string;
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const testExpression = useCallback(
    async (expression: string, context: Record<string, unknown> = {}) => {
      setIsTesting(true);

      // Skip syntax validation when we have context variables, since
      // validateExpression runs without context and would fail on undefined vars.
      // The evaluateCondition call below will catch any actual errors.
      if (Object.keys(context).length === 0) {
        const validation = await validateExpression(expression);
        if (!validation.valid) {
          setResult({ valid: false, error: validation.error });
          setIsTesting(false);
          return;
        }
      }

      // Evaluate with context
      try {
        const output = await evaluateCondition(expression, context);
        setResult({ valid: true, output });
      } catch (err) {
        setResult({
          valid: false,
          error: err instanceof Error ? err.message : 'Evaluation error',
        });
      }

      setIsTesting(false);
    },
    []
  );

  const reset = useCallback(() => {
    setResult(null);
  }, []);

  return {
    result,
    isTesting,
    testExpression,
    reset,
  };
}
