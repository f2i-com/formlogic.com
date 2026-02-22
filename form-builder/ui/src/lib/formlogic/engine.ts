import { logger } from '../logger';
import {
  FormLogicEngine,
  BooleanObject,
  StringObject,
  IntegerObject,
  FloatObject,
  nullObject,
  trueObject,
  falseObject,
  type BaseObject,
} from 'formlogic-lang';
import { getValue, isNullish } from './modules/helpers';
import { complianceModule } from './modules/compliance';
import { financeModule } from './modules/finance';
import { safetyModule } from './modules/safety';

// Singleton engine instance
let engineInstance: FormLogicEngine | null = null;

/**
 * Get or create the FormLogic engine instance
 */
export function getEngine(): FormLogicEngine {
  if (!engineInstance) {
    engineInstance = new FormLogicEngine();
    registerFormModules(engineInstance);
  }
  return engineInstance;
}

/**
 * Register custom modules for form validation and utilities
 */
function registerFormModules(engine: FormLogicEngine): void {
  // Validators module
  engine.registerModule('validators', {
    email: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      if (typeof value !== 'string') return falseObject;
      // Require local part, @, domain with at least one dot, and TLD of 2+ chars
      const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
      return emailRegex.test(value) ? trueObject : falseObject;
    },

    phone: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      if (typeof value !== 'string') return falseObject;
      // Must start with optional +, contain at least 7 digits total, allow spaces/dashes/parens
      const stripped = value.replace(/[\s\-()]/g, '');
      const phoneRegex = /^\+?\d{7,15}$/;
      return phoneRegex.test(stripped) ? trueObject : falseObject;
    },

    url: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      if (typeof value !== 'string') return falseObject;
      try {
        new URL(value);
        return trueObject;
      } catch {
        return falseObject;
      }
    },

    minLength: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const min = getValue(args[1]);
      if (typeof value !== 'string') return falseObject;
      if (typeof min !== 'number') return falseObject;
      return value.length >= min ? trueObject : falseObject;
    },

    maxLength: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const max = getValue(args[1]);
      if (typeof value !== 'string') return falseObject;
      if (typeof max !== 'number') return falseObject;
      return value.length <= max ? trueObject : falseObject;
    },

    pattern: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const pattern = getValue(args[1]);
      if (typeof value !== 'string') return falseObject;
      if (typeof pattern !== 'string') return falseObject;
      // Limit pattern length to mitigate ReDoS from complex expressions
      if (pattern.length > 500) return falseObject;
      // Reject patterns with known catastrophic backtracking constructs
      if (/(\+|\*|\{[^}]*\})\s*(\+|\*|\{[^}]*\})/.test(pattern) || /\([^)]*\|[^)]*\)\+/.test(pattern)) {
        return falseObject;
      }
      try {
        const regex = new RegExp(pattern);
        return regex.test(value) ? trueObject : falseObject;
      } catch {
        return falseObject;
      }
    },

    required: (args: BaseObject[]) => {
      if (isNullish(args[0])) return falseObject;
      const value = getValue(args[0]);
      if (typeof value === 'string') return value.trim().length > 0 ? trueObject : falseObject;
      if (Array.isArray(value)) return value.length > 0 ? trueObject : falseObject;
      return trueObject;
    },

    min: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const min = getValue(args[1]);
      if (typeof value !== 'number') return falseObject;
      if (typeof min !== 'number') return falseObject;
      return value >= min ? trueObject : falseObject;
    },

    max: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const max = getValue(args[1]);
      if (typeof value !== 'number') return falseObject;
      if (typeof max !== 'number') return falseObject;
      return value <= max ? trueObject : falseObject;
    },
  });

  // Format module
  engine.registerModule('format', {
    currency: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const currency = (getValue(args[1]) as string) || 'USD';
      if (typeof value !== 'number') return new StringObject('');
      const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
      }).format(value);
      return new StringObject(formatted);
    },

    number: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const decimals = (getValue(args[1]) as number) ?? 0;
      if (typeof value !== 'number') return new StringObject('');
      return new StringObject(value.toFixed(decimals));
    },

    date: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      const formatStr = (getValue(args[1]) as string) || 'short';
      if (!value) return new StringObject('');
      try {
        const date = new Date(value as string | number);
        if (formatStr === 'short') {
          return new StringObject(date.toLocaleDateString());
        } else if (formatStr === 'long') {
          return new StringObject(date.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          }));
        }
        return new StringObject(date.toLocaleDateString());
      } catch {
        return new StringObject('');
      }
    },

    uppercase: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      if (typeof value !== 'string') return new StringObject('');
      return new StringObject(value.toUpperCase());
    },

    lowercase: (args: BaseObject[]) => {
      const value = getValue(args[0]);
      if (typeof value !== 'string') return new StringObject('');
      return new StringObject(value.toLowerCase());
    },
  });

  // Compliance module
  engine.registerModule('compliance', complianceModule);

  // Finance module
  engine.registerModule('finance', financeModule);

  // Safety module
  engine.registerModule('safety', safetyModule);

  // Utility functions
  engine.registerBuiltin('isEmpty', (args: BaseObject[]) => {
    if (isNullish(args[0])) return trueObject;
    const value = getValue(args[0]);
    if (typeof value === 'string') return value.trim().length === 0 ? trueObject : falseObject;
    if (Array.isArray(value)) return value.length === 0 ? trueObject : falseObject;
    return falseObject;
  });

  engine.registerBuiltin('isNotEmpty', (args: BaseObject[]) => {
    if (isNullish(args[0])) return falseObject;
    const value = getValue(args[0]);
    if (typeof value === 'string') return value.trim().length > 0 ? trueObject : falseObject;
    if (Array.isArray(value)) return value.length > 0 ? trueObject : falseObject;
    return trueObject;
  });

  engine.registerBuiltin('contains', (args: BaseObject[]) => {
    const arr = getValue(args[0]);
    const item = getValue(args[1]);
    if (!Array.isArray(arr)) return falseObject;
    if (item === undefined) return falseObject;
    return arr.some((v: unknown) => v === item) ? trueObject : falseObject;
  });

  engine.registerBuiltin('sum', (args: BaseObject[]) => {
    const arr = getValue(args[0]);
    if (!Array.isArray(arr)) return new IntegerObject(0);
    const total = arr.reduce((acc: number, v: unknown) => acc + (typeof v === 'number' ? v : 0), 0);
    return new FloatObject(total);
  });

  engine.registerBuiltin('avg', (args: BaseObject[]) => {
    const arr = getValue(args[0]);
    if (!Array.isArray(arr) || arr.length === 0) return new FloatObject(0);
    const nums = arr.filter((v: unknown): v is number => typeof v === 'number');
    if (nums.length === 0) return new FloatObject(0);
    const total = nums.reduce((acc, v) => acc + v, 0);
    return new FloatObject(total / nums.length);
  });

  engine.registerBuiltin('count', (args: BaseObject[]) => {
    const arr = getValue(args[0]);
    if (!Array.isArray(arr)) return new IntegerObject(0);
    return new IntegerObject(arr.length);
  });
}

/**
 * Evaluate a condition expression with form data context
 */
export async function evaluateCondition(
  expression: string,
  formData: Record<string, unknown>
): Promise<boolean> {
  try {
    const engine = getEngine();
    const result = await engine.runWithContext(expression, formData);

    // Handle different result types
    if (!result) return false;
    if (result instanceof BooleanObject) return result.value;
    const value = getValue(result);
    return Boolean(value);
  } catch (error) {
    logger.error('Error evaluating condition:', error);
    return false;
  }
}

/**
 * Validate a field value with custom expression
 * Returns null if valid, or error message string if invalid
 */
export async function validateWithExpression(
  expression: string,
  value: unknown,
  formData: Record<string, unknown>
): Promise<string | null> {
  try {
    const engine = getEngine();
    const context = { ...formData, value };
    const result = await engine.runWithContext(expression, context);

    // If result is a string, it's an error message
    if (result instanceof StringObject) {
      return result.value.length > 0 ? result.value : null;
    }
    const resultValue = getValue(result);
    if (typeof resultValue === 'string' && resultValue.length > 0) {
      return resultValue;
    }
    // If result is truthy or null, validation passed
    return null;
  } catch (error) {
    logger.error('Error in validation expression:', error);
    return 'Validation error';
  }
}

/**
 * Calculate a field value using an expression
 */
export async function calculateValue(
  expression: string,
  formData: Record<string, unknown>
): Promise<unknown> {
  try {
    const engine = getEngine();
    const result = await engine.runWithContext(expression, formData);
    return getValue(result);
  } catch (error) {
    logger.error('Error calculating value:', error);
    return null;
  }
}

/**
 * Test an expression and return the result
 */
export async function testExpression(
  expression: string,
  context: Record<string, unknown>
): Promise<{ valid: boolean; output?: unknown; error?: string }> {
  try {
    const engine = getEngine();
    const result = await engine.runWithContext(expression, context);
    return { valid: true, output: getValue(result) };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid expression',
    };
  }
}

/**
 * Test if an expression is valid FormLogic syntax
 */
export async function validateExpression(expression: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    const engine = getEngine();
    // Try to compile/parse the expression without running
    await engine.run(`let __test__ = (${expression})`);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid expression',
    };
  }
}

export type { FormLogicEngine };

// Re-export object types for use in components
export { BooleanObject, StringObject, IntegerObject, FloatObject, nullObject };
