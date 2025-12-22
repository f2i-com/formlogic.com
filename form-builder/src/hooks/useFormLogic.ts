import { useState, useCallback, useEffect, useRef } from 'react';
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
      } catch (error) {
        // On error, show the field
        visible.add(field.id);
        if (field.required) required.add(field.id);
      }
    }

    setVisibleFields(visible);
    setRequiredFields(required);
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
          const regex = new RegExp(rule.value as string);
          if (!regex.test(value)) {
            setError(rule.message || 'Invalid format');
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

  const calculate = useCallback(async () => {
    if (!expression) {
      setValue(null);
      return;
    }

    setIsCalculating(true);
    setError(null);

    try {
      const result = await calculateValue(expression, formData);
      setValue(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calculation error');
      setValue(null);
    }

    setIsCalculating(false);
  }, [expression, formData]);

  useEffect(() => {
    calculate();
  }, [calculate, ...dependencies.map(dep => formData[dep])]);

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

      // First validate syntax
      const validation = await validateExpression(expression);
      if (!validation.valid) {
        setResult({ valid: false, error: validation.error });
        setIsTesting(false);
        return;
      }

      // Then try to evaluate
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
