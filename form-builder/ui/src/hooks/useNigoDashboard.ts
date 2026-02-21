import { useState, useEffect, useRef } from 'react';
import type { FormField } from '../types/form';

export type FieldStatus = 'green' | 'yellow' | 'red';

export interface NigoFieldState {
  fieldId: string;
  label: string;
  status: FieldStatus;
  message: string;
  required: boolean;
}

export interface NigoDashboardState {
  fields: NigoFieldState[];
  completedCount: number;
  totalCount: number;
  score: number;
  overallStatus: FieldStatus;
  isValidating: boolean;
}

const NON_INPUT_TYPES = new Set(['statement', 'welcome_screen', 'thank_you', 'calculated']);

function toSet(input: Set<string> | string[]): Set<string> {
  return input instanceof Set ? input : new Set(input);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function hasPatternError(field: FormField, value: unknown): string | null {
  if (!field.validation) return null;
  const patternRule = field.validation.find((r) => r.type === 'pattern');
  if (!patternRule || typeof patternRule.value !== 'string') return null;
  if (typeof value !== 'string') return null;
  try {
    const regex = new RegExp(patternRule.value);
    if (!regex.test(value)) {
      return patternRule.message || 'Value does not match the required pattern';
    }
  } catch {
    // Invalid regex pattern in rule — skip validation
  }
  return null;
}

function isSuspiciousValue(field: FormField, value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0 && value.length < 2) {
    return 'Value seems too short';
  }

  if (typeof value === 'number') {
    const minRule = field.validation?.find((r) => r.type === 'min');
    const fieldMin = field.properties.min ?? (minRule?.value as number | undefined);
    if (fieldMin !== undefined && fieldMin > 0) {
      if (value <= 0) {
        return 'Value should be a positive number';
      }
    } else if (value === 0) {
      return 'Value is zero';
    } else if (value < 0) {
      return 'Value is negative';
    }
  }

  return null;
}

function evaluateField(
  field: FormField,
  value: unknown,
  isRequired: boolean,
): NigoFieldState {
  const base = { fieldId: field.id, label: field.label, required: isRequired };

  // Check if value is empty
  if (isEmpty(value)) {
    if (isRequired) {
      return { ...base, status: 'red', message: 'Required field is empty' };
    }
    // Optional empty field is fine
    return { ...base, status: 'green', message: 'Optional — no value provided' };
  }

  // Check pattern validation errors
  const patternError = hasPatternError(field, value);
  if (patternError) {
    return { ...base, status: 'red', message: patternError };
  }

  // Check suspicious values — warn for both required and optional fields
  const suspicion = isSuspiciousValue(field, value);
  if (suspicion) {
    return { ...base, status: 'yellow', message: suspicion };
  }

  return { ...base, status: 'green', message: 'Looks good' };
}

export function useNigoDashboard(
  fields: FormField[],
  formData: Record<string, unknown>,
  visibleFieldIds: Set<string> | string[],
  requiredFieldIds: Set<string> | string[],
): NigoDashboardState {
  const [state, setState] = useState<NigoDashboardState>({
    fields: [],
    completedCount: 0,
    totalCount: 0,
    score: 0,
    overallStatus: 'green',
    isValidating: false,
  });

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Track mount state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Mark as validating during debounce
    setState((prev) => ({ ...prev, isValidating: true }));

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      if (!mountedRef.current) return;

      const visibleSet = toSet(visibleFieldIds);
      const requiredSet = toSet(requiredFieldIds);

      const inputFields = fields.filter(
        (f) => !NON_INPUT_TYPES.has(f.type) && visibleSet.has(f.id),
      );

      const evaluatedFields: NigoFieldState[] = inputFields.map((field) => {
        const value = formData[field.id];
        const isRequired = field.required || requiredSet.has(field.id);
        return evaluateField(field, value, isRequired);
      });

      const totalCount = evaluatedFields.length;
      const completedCount = evaluatedFields.filter((f) => f.status === 'green').length;
      const score = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 100;

      // Any red field (required or not) makes overall red; yellow fields make overall yellow
      const hasRed = evaluatedFields.some((f) => f.status === 'red');
      const hasYellow = evaluatedFields.some((f) => f.status === 'yellow');

      let overallStatus: FieldStatus = 'green';
      if (hasRed) {
        overallStatus = 'red';
      } else if (hasYellow) {
        overallStatus = 'yellow';
      }

      setState({
        fields: evaluatedFields,
        completedCount,
        totalCount,
        score,
        overallStatus,
        isValidating: false,
      });
    }, 500);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [fields, formData, visibleFieldIds, requiredFieldIds]);

  return state;
}
