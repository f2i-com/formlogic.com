import { useEffect, useMemo, useRef } from 'react';
import { useCalculatedField } from '../../hooks/useFormLogic';

interface CalculatedFieldDisplayProps {
  expression: string | undefined;
  formData: Record<string, unknown>;
  allFieldIds: string[];
  fieldId?: string;
  onCalculated?: (fieldId: string, value: unknown) => void;
  children: (value: unknown, isCalculating: boolean) => React.ReactNode;
}

/**
 * Wrapper component that evaluates a calculated field expression
 * and provides the result via render prop.
 *
 * Needed because useCalculatedField is a hook and can't be called
 * conditionally inside switch/case field rendering.
 *
 * When fieldId and onCalculated are provided, computed values are
 * reported back so dependent calculated fields can chain off them.
 */
export function CalculatedFieldDisplay({
  expression,
  formData,
  allFieldIds,
  fieldId,
  onCalculated,
  children,
}: CalculatedFieldDisplayProps) {
  // Extract field IDs referenced in the expression as dependencies
  const dependencies = useMemo(
    () => allFieldIds.filter(id => expression?.includes(id)),
    [allFieldIds, expression]
  );

  const { value, isCalculating } = useCalculatedField(expression, formData, dependencies);

  // Report computed value back so dependent calculated fields can access it
  const prevValueRef = useRef<unknown>(undefined);
  useEffect(() => {
    if (fieldId && onCalculated && !isCalculating && value !== prevValueRef.current) {
      prevValueRef.current = value;
      onCalculated(fieldId, value);
    }
  }, [fieldId, onCalculated, value, isCalculating]);

  return <>{children(value, isCalculating)}</>;
}
