import type { BaseObject } from 'formlogic-lang';

/** Get the native value from a BaseObject */
export function getValue(obj: BaseObject): unknown {
  if (!obj) return undefined;
  if ('value' in obj) {
    return (obj as { value: unknown }).value;
  }
  return undefined;
}

/** Check if a BaseObject represents null or undefined */
export function isNullish(obj: BaseObject): boolean {
  if (!obj) return true;
  const typeMethod = obj.type;
  if (typeof typeMethod === 'function') {
    const t = typeMethod.call(obj);
    // ObjectType.nullValue = 3, ObjectType.undefinedValue = 4
    return t === 3 || t === 4;
  }
  return false;
}
