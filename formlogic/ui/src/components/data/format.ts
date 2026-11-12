// What the data manager shows, as words and numbers: counts, sizes, a filter in plain words, what
// kind of value a cell holds. No React here, so each rule is tested on its own.
import type { NativeBrowse, NativeFilter, NativeFilterOp, NativeForeignKey, NativeRecordField, NativeStructure } from '../../lib/nativeHosting';

export type DataView = 'browse' | 'structure' | 'export' | 'import';
export const DATA_VIEWS: readonly DataView[] = ['browse', 'structure', 'export', 'import'];
export const VIEW_LABELS: Record<DataView, string> = { browse: 'Browse', structure: 'Structure', export: 'Export', import: 'Import' };

/** A line said above the open table: what was done, or why it was not. */
export interface Notice { tone: 'done' | 'problem'; text: string }

/** A table as the list shows it. The counts are absent when the server sent names alone. */
export interface TableInfo { name: string; rows?: number; columns?: number }

export const number = (n: number) => n.toLocaleString();
/** 1 → "1 row", 8214 → "8,214 rows". */
export const count = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/** 3,145,728 → "3.0 MB": a database's size, to one decimal above a kilobyte (as the app's overview writes it). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A column that holds numbers, by its declared type (the row editor reads types the same way). */
export const isNumericType = (type: string | undefined) => /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(type ?? '');

/** A column that reads as a date or a time, by its type or its name (created_at, startDate): only the filter's words depend on it. */
export const looksLikeDate = (name: string, type: string | undefined) => /DATE|TIME/i.test(type ?? '') || /(?:^|_)(?:at|on|date|time|datetime|timestamp)$/i.test(name) || /[a-z](?:At|On|Date|Time)$/.test(name);

export const FILTER_OPS: readonly NativeFilterOp[] = ['eq', 'ne', 'contains', 'starts', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'];
const OP_WORDS: Record<NativeFilterOp, string> = { eq: 'is', ne: 'is not', contains: 'contains', starts: 'starts with', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', empty: 'is empty', notEmpty: 'is not empty' };
const DATE_WORDS: Partial<Record<NativeFilterOp, string>> = { gt: 'after', gte: 'on or after', lt: 'before', lte: 'on or before' };
export const takesValue = (op: NativeFilterOp) => op !== 'empty' && op !== 'notEmpty';
/** How a filter compares, in plain words: "is at least", or "on or after" for a date. */
export const opWords = (op: NativeFilterOp, date = false) => (date && DATE_WORDS[op]) || OP_WORDS[op];
/** A whole filter as one line, for a screen reader: "starts_at on or after 2026-11-01". */
export const filterText = (filter: NativeFilter, date = false) => `${filter.column} ${opWords(filter.op, date)}${takesValue(filter.op) ? ` ${filter.value ?? ''}` : ''}`;

/** The most filters one request may carry. */
export const MAX_FILTERS = 8;
/** The longest search the server reads. */
export const MAX_SEARCH = 200;

/**
 * What a cell holds. NULL and an empty text are different values and are shown differently. The
 * server sends a binary value as the text `[binary]` (a text that reads the same is taken for one).
 */
export type CellKind = 'null' | 'empty' | 'binary' | 'value';
export function cellKind(value: unknown): CellKind {
  if (value === null || value === undefined) return 'null';
  if (value === '') return 'empty';
  if (value === '[binary]') return 'binary';
  return 'value';
}

/** A row's key as one string: what a selection remembers across a reload of the page. */
export const rowId = (key: Record<string, string>) => JSON.stringify(key);
/** A row's key as a person reads it: "8213", or "4, 17" for a key of two columns. */
export const rowName = (key: Record<string, string>) => Object.values(key).join(', ');
/** A row's key with its columns named: "id 8213", or "room_id 4 · day 17". */
export const rowTitle = (key: Record<string, string>) => Object.entries(key).map(([column, value]) => `${column} ${value}`).join(' · ');

/** A cell's value as text, exactly as stored: no thousands marks, no reading of dates. */
export const cellText = (value: unknown): string => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);

/**
 * The key of the row an address names, in a page of the table. The address may name the row by
 * its key, or by the columns a foreign key pointed at: then the row on the page that holds those
 * values is the one. Null when the table has no key, or the page holds no such row.
 */
export function resolveRow(row: Record<string, string> | null, page: Pick<NativeBrowse, 'schema' | 'rows' | 'keys'> | null): Record<string, string> | null {
  const key = page?.schema?.primaryKey ?? [];
  if (!row || !page || key.length === 0) return null;
  const names = Object.keys(row);
  if (names.length === key.length && key.every(name => name in row)) return Object.fromEntries(key.map(name => [name, row[name]]));
  const at = (page.rows ?? []).findIndex(each => names.every(name => each[name] !== null && each[name] !== undefined && cellText(each[name]) === row[name]));
  return at >= 0 ? page.keys?.[at] ?? null : null;
}

export const PAGE_SIZES: readonly number[] = [25, 50, 100, 250];
export const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_KEY = 'formlogic.data.rowsPerPage';
/** The page size chosen last time, in this browser. Storage may be refused (private browsing): then the default. */
export function rememberedPageSize(): number {
  try {
    const stored = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(stored) ? stored : DEFAULT_PAGE_SIZE;
  } catch { return DEFAULT_PAGE_SIZE; }
}
export function rememberPageSize(size: number): void {
  try { window.localStorage.setItem(PAGE_SIZE_KEY, String(size)); } catch { /* private browsing: the choice lasts for this visit */ }
}

/** Each column that is part of a foreign key, to that key. A column in two keys keeps the first. */
export function foreignKeysByColumn(structure: NativeStructure | undefined): Record<string, NativeForeignKey> {
  const byColumn: Record<string, NativeForeignKey> = {};
  for (const key of structure?.foreignKeys ?? []) for (const column of key.columns) byColumn[column] ??= key;
  return byColumn;
}

/**
 * The filters that find the row a foreign key points at, from the row that holds it: one per
 * column of the key. Null when the row points nowhere (a NULL in the key) or the key does not name
 * the columns it points at.
 */
export function foreignKeyFilters(key: NativeForeignKey, row: Record<string, unknown>): NativeFilter[] | null {
  const filters: NativeFilter[] = [];
  for (let at = 0; at < key.columns.length; at++) {
    const value = row[key.columns[at]], to = key.to?.[at];
    if (value === null || value === undefined || !to) return null;
    filters.push({ column: to, op: 'eq', value: String(value) });
  }
  return filters;
}

/** What a column's key cell says in the structure view: "Primary", "Unique (2)", "Index". The number is its place in a key of several columns. */
export function keyWords(column: { name: string; primaryKey: number }, structure: NativeStructure): string {
  const place = (columns: string[]) => columns.length > 1 ? ` (${columns.indexOf(column.name) + 1})` : '';
  if (column.primaryKey > 0) return `Primary${structure.columns.filter(other => other.primaryKey > 0).length > 1 ? ` (${column.primaryKey})` : ''}`;
  const holding = structure.indexes.filter(index => index.origin !== 'pk' && index.columns.includes(column.name));
  const index = holding.find(candidate => candidate.unique) ?? holding[0];
  return index ? `${index.unique ? 'Unique' : 'Index'}${place(index.columns)}` : '';
}

/**
 * Whether a column may hold no value. A column of the primary key never does, whatever SQLite
 * reports for it (`id INTEGER PRIMARY KEY` is not declared NOT NULL, and is never NULL).
 */
export const mayBeEmpty = (column: { notNull: boolean; primaryKey: number }) => !column.notNull && column.primaryKey === 0;

/**
 * What a column's default cell says. A whole-number primary key on its own is numbered by the
 * database; a column that may be empty and names no default starts as NULL.
 */
export function defaultWords(column: NativeStructure['columns'][number], structure: NativeStructure): string {
  if (column.generated) return 'computed';
  if (column.defaultValue !== null) return column.defaultValue;
  if (column.primaryKey > 0 && column.type.toUpperCase() === 'INTEGER' && structure.columns.filter(other => other.primaryKey > 0).length === 1) return 'next number';
  return mayBeEmpty(column) ? 'NULL' : '';
}

/** The row editor's fields by name. */
export const fieldsByName = (fields: NativeRecordField[] | undefined): Record<string, NativeRecordField> => Object.fromEntries((fields ?? []).map(field => [field.name, field]));
