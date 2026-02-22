import { useMemo } from 'react';
import { useCalculatedField } from '../../hooks/useFormLogic';

interface CalculatedFieldDisplayProps {
  expression: string | undefined;
  formData: Record<string, unknown>;
  allFieldIds: string[];
  children: (value: unknown, isCalculating: boolean) => React.ReactNode;
}

/**
 * Wrapper component that evaluates a calculated field expression
 * and provides the result via render prop.
 *
 * Needed because useCalculatedField is a hook and can't be called
 * conditionally inside switch/case field rendering.
 */
export function CalculatedFieldDisplay({
  expression,
  formData,
  allFieldIds,
  children,
}: CalculatedFieldDisplayProps) {
  // Extract field IDs referenced in the expression as dependencies
  const dependencies = useMemo(
    () => allFieldIds.filter(id => expression?.includes(id)),
    [allFieldIds, expression]
  );

  const { value, isCalculating } = useCalculatedField(expression, formData, dependencies);

  return <>{children(value, isCalculating)}</>;
}
