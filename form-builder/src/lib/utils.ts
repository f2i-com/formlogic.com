import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatDate(d);
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert a field label to a camelCase variable name
 * "Your Email Address" → "yourEmailAddress"
 * "First Name" → "firstName"
 */
export function labelToVariableName(label: string): string {
  if (!label) return '';

  // Remove special characters and split into words
  const words = label
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return '';

  // Convert to camelCase
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * Create a mapping of variable names to field IDs
 * Handles duplicates by appending numbers
 */
export function createFieldVariableMap(
  fields: Array<{ id: string; label: string }>
): { toId: Record<string, string>; toVar: Record<string, string> } {
  const toId: Record<string, string> = {};
  const toVar: Record<string, string> = {};
  const usedNames: Record<string, number> = {};

  for (const field of fields) {
    let varName = labelToVariableName(field.label);

    // Handle empty or invalid names
    if (!varName) {
      varName = 'field';
    }

    // Handle duplicates by appending a number
    if (usedNames[varName] !== undefined) {
      usedNames[varName]++;
      varName = `${varName}${usedNames[varName]}`;
    } else {
      usedNames[varName] = 1;
    }

    toId[varName] = field.id;
    toVar[field.id] = varName;
  }

  return { toId, toVar };
}

/**
 * Replace variable names with field IDs in an expression
 */
export function replaceVariablesWithIds(
  expression: string,
  varToId: Record<string, string>
): string {
  let result = expression;

  // Sort by length descending to replace longer names first
  // This prevents "email" from being replaced before "emailAddress"
  const sortedVars = Object.keys(varToId).sort((a, b) => b.length - a.length);

  for (const varName of sortedVars) {
    // Match whole words only (not part of another word)
    const regex = new RegExp(`\\b${varName}\\b`, 'g');
    result = result.replace(regex, varToId[varName]);
  }

  return result;
}

/**
 * Replace field IDs with variable names in an expression (for display)
 */
export function replaceIdsWithVariables(
  expression: string,
  idToVar: Record<string, string>
): string {
  let result = expression;

  for (const [id, varName] of Object.entries(idToVar)) {
    // UUIDs are unique enough to replace directly
    result = result.replace(new RegExp(id, 'g'), varName);
  }

  return result;
}
