import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 'Unknown';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 0) return 'just now';
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

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary';

/**
 * Maps a response/user status to a single Badge variant so the same semantic
 * state renders one consistent color across the responses table, response detail,
 * and members list (the mapping was previously hand-rolled per screen and had
 * drifted into three different greens).
 */
export function statusBadgeVariant(status: string | undefined | null): BadgeVariant {
  switch ((status || '').toLowerCase()) {
    case 'approved':
    case 'active':
    case 'completed':
      return 'success';
    case 'rejected':
    case 'disabled':
    case 'suspended':
      return 'error';
    case 'submitted':
    case 'reviewed':
      return 'info';
    case 'pending':
    case 'invited':
      return 'warning';
    default:
      return 'default'; // archived, unknown, etc.
  }
}

/** Capitalized, human-friendly label for a status string. */
export function formatStatusLabel(status: string | undefined | null): string {
  const s = (status || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '-').trim() || 'export';
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
  let result = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');

  // Ensure the name doesn't start with a digit (invalid JS identifier)
  if (/^\d/.test(result)) {
    result = '_' + result;
  }

  return result;
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

    // Handle duplicates by appending a number. Keep incrementing until the
    // candidate collides with NEITHER a prior deduped name NOR another field's
    // natural name (e.g. 'Email'+'Email 2'+'Email' must not collapse 'email2'),
    // otherwise two fields would map to the same variable and one reference is lost.
    if (usedNames[varName] !== undefined || toId[varName] !== undefined) {
      const base = varName;
      let counter = usedNames[base] ?? 1;
      do {
        counter++;
        varName = `${base}${counter}`;
      } while (toId[varName] !== undefined);
      usedNames[base] = counter;
    }
    if (usedNames[varName] === undefined) {
      usedNames[varName] = 1;
    }

    toId[varName] = field.id;
    toVar[field.id] = varName;
  }

  return { toId, toVar };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const regex = new RegExp(`\\b${escapeRegExp(varName)}\\b`, 'g');
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

  // Sort by length descending and match whole tokens only — mirrors
  // replaceVariablesWithIds. Field IDs are human-readable slugs, so without this
  // a shorter id ('first_name') would corrupt a longer one ('first_name_1') by
  // matching its prefix mid-token.
  const sortedIds = Object.keys(idToVar).sort((a, b) => b.length - a.length);

  for (const id of sortedIds) {
    const regex = new RegExp(`\\b${escapeRegExp(id)}\\b`, 'g');
    result = result.replace(regex, idToVar[id]);
  }

  return result;
}
