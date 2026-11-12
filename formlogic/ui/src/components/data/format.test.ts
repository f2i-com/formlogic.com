// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeStructure } from '../../lib/nativeHosting';
import {
  DEFAULT_PAGE_SIZE, cellKind, cellText, count, defaultWords, filterText, foreignKeyFilters, foreignKeysByColumn, formatBytes, isNumericType, keyWords,
  looksLikeDate, mayBeEmpty, opWords, rememberPageSize, rememberedPageSize, resolveRow, rowId, rowName, rowTitle,
} from './format';

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe('counts and sizes', () => {
  it('writes one row and many rows', () => {
    expect(count(1, 'row')).toBe('1 row');
    expect(count(8214, 'row')).toBe('8,214 rows');
    expect(count(0, 'table')).toBe('0 tables');
  });

  it('writes a size to one decimal above a kilobyte', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(421888)).toBe('412 KB');
    expect(formatBytes(3250586)).toBe('3.1 MB');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('what a column holds', () => {
  it('reads a number column from its declared type', () => {
    for (const type of ['INTEGER', 'int', 'REAL', 'NUMERIC(10,2)', 'DOUBLE PRECISION', 'DECIMAL']) expect(isNumericType(type), type).toBe(true);
    for (const type of ['TEXT', 'BLOB', '', undefined]) expect(isNumericType(type), String(type)).toBe(false);
  });

  it('takes a date for one by its type or the end of its name, and no other word that ends alike', () => {
    for (const name of ['created_at', 'starts_on', 'due_date', 'createdAt', 'startDate', 'date']) expect(looksLikeDate(name, 'TEXT'), name).toBe(true);
    expect(looksLikeDate('happened', 'DATETIME')).toBe(true);
    for (const name of ['update', 'candidate', 'runtime', 'format', 'status']) expect(looksLikeDate(name, 'TEXT'), name).toBe(false);
  });

  it('tells NULL, an empty text, a binary value and a value apart', () => {
    expect(cellKind(null)).toBe('null');
    expect(cellKind('')).toBe('empty');
    expect(cellKind('[binary]')).toBe('binary');
    expect(cellKind(0)).toBe('value');
    expect(cellKind('NULL')).toBe('value');
  });
});

describe('a filter in words', () => {
  it('says how it compares, and reads a date as a date', () => {
    expect(opWords('gte')).toBe('is at least');
    expect(opWords('gte', true)).toBe('on or after');
    expect(opWords('eq', true)).toBe('is');
    expect(filterText({ column: 'starts_at', op: 'gte', value: '2026-11-01' }, true)).toBe('starts_at on or after 2026-11-01');
    expect(filterText({ column: 'notes', op: 'empty' })).toBe('notes is empty');
  });
});

describe('rows and keys', () => {
  it('names a row by its key', () => {
    expect(rowName({ id: '8213' })).toBe('8213');
    expect(rowName({ room_id: '4', day: '17' })).toBe('4, 17');
    expect(rowId({ id: '8213' })).toBe('{"id":"8213"}');
  });

  it('titles a row by its key’s columns, and shows a value exactly as stored', () => {
    expect(rowTitle({ id: '8213' })).toBe('id 8213');
    expect(rowTitle({ room_id: '4', day: '17' })).toBe('room_id 4 · day 17');
    // No thousands marks, no reading of dates or of numbers kept as text.
    expect(cellText(1234567.5)).toBe('1234567.5');
    expect(cellText('007')).toBe('007');
    expect(cellText('2026-11-14 19:30')).toBe('2026-11-14 19:30');
    expect(cellText(0)).toBe('0');
    expect(cellText(false)).toBe('false');
  });

  it('finds the row an address names: by its key, or by the columns a foreign key pointed at', () => {
    const page = { schema: { fields: [], primaryKey: ['id'], canCreate: true }, rows: [{ id: 1902, email: 'ada@example.com' }, { id: 1865, email: 'grace@example.com' }], keys: [{ id: '1902' }, { id: '1865' }] };
    // A key is taken as it is, on the page or not.
    expect(resolveRow({ id: '7' }, page)).toEqual({ id: '7' });
    // Other columns name the row on the page that holds those values.
    expect(resolveRow({ email: 'grace@example.com' }, page)).toEqual({ id: '1865' });
    expect(resolveRow({ email: 'nobody@example.com' }, page)).toBeNull();
    expect(resolveRow(null, page)).toBeNull();
    expect(resolveRow({ id: '7' }, null)).toBeNull();
    // A table with no key has no row to open.
    expect(resolveRow({ id: '1902' }, { ...page, schema: { fields: [], primaryKey: [], canCreate: true } })).toBeNull();
    // A key of two columns, whichever way round the address names them.
    const pair = { schema: { fields: [], primaryKey: ['room_id', 'day'], canCreate: true }, rows: [], keys: [] };
    expect(Object.entries(resolveRow({ day: '17', room_id: '4' }, pair)!)).toEqual([['room_id', '4'], ['day', '17']]);
    expect(resolveRow({ room_id: '4' }, pair)).toBeNull();
  });

  it('finds the row a foreign key points at, one filter per column of the key', () => {
    const key = { columns: ['room_id', 'day'], table: 'slots', to: ['room', 'day'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' };
    expect(foreignKeyFilters(key, { room_id: 4, day: '2026-11-01' })).toEqual([{ column: 'room', op: 'eq', value: '4' }, { column: 'day', op: 'eq', value: '2026-11-01' }]);
    // A NULL in the key points nowhere; a key that names no target column cannot be followed.
    expect(foreignKeyFilters(key, { room_id: null, day: '2026-11-01' })).toBeNull();
    expect(foreignKeyFilters({ ...key, to: [] }, { room_id: 4, day: 'x' })).toBeNull();
  });
});

describe('a table’s structure in words', () => {
  const column = (name: string, over: Partial<NativeStructure['columns'][number]> = {}) => ({ name, type: 'TEXT', notNull: false, defaultValue: null, primaryKey: 0, hidden: false, generated: false, ...over });
  const structure: NativeStructure = {
    table: 'bookings', rows: 3,
    columns: [column('id', { type: 'INTEGER', notNull: true, primaryKey: 1 }), column('customer_id', { type: 'INTEGER', notNull: true }), column('room_id'), column('starts_at', { notNull: true }), column('status', { notNull: true, defaultValue: "'new'" }), column('label', { generated: true })],
    indexes: [
      { name: 'idx_customer', unique: false, origin: 'c', columns: ['customer_id'] },
      { name: 'uq_slot', unique: true, origin: 'c', columns: ['room_id', 'starts_at'] },
    ],
    foreignKeys: [{ columns: ['customer_id'], table: 'customers', to: ['id'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' }],
    referencedBy: [],
  };
  const named = (name: string) => structure.columns.find(each => each.name === name)!;

  it('says what key a column is part of, and its place in a key of several', () => {
    expect(keyWords(named('id'), structure)).toBe('Primary');
    expect(keyWords(named('customer_id'), structure)).toBe('Index');
    expect(keyWords(named('room_id'), structure)).toBe('Unique (1)');
    expect(keyWords(named('starts_at'), structure)).toBe('Unique (2)');
    expect(keyWords(named('status'), structure)).toBe('');
  });

  it('says what a new row starts with', () => {
    expect(defaultWords(named('id'), structure)).toBe('next number');
    expect(defaultWords(named('status'), structure)).toBe("'new'");
    expect(defaultWords(named('room_id'), structure)).toBe('NULL');
    expect(defaultWords(named('starts_at'), structure)).toBe('');
    expect(defaultWords(named('label'), structure)).toBe('computed');
  });

  it('never calls a column of the primary key empty, whatever SQLite reports for it', () => {
    // `id INTEGER PRIMARY KEY` is not declared NOT NULL, and a text key is not numbered by the database.
    expect(mayBeEmpty(column('id', { type: 'INTEGER', notNull: false, primaryKey: 1 }))).toBe(false);
    expect(mayBeEmpty(column('notes'))).toBe(true);
    expect(mayBeEmpty(column('status', { notNull: true }))).toBe(false);
    const settings: NativeStructure = { ...structure, columns: [column('key', { primaryKey: 1 }), column('value')] };
    expect(defaultWords(settings.columns[0], settings)).toBe('');
    expect(defaultWords(settings.columns[1], settings)).toBe('NULL');
  });

  it('maps each column of a foreign key to the key', () => {
    expect(Object.keys(foreignKeysByColumn(structure))).toEqual(['customer_id']);
    expect(foreignKeysByColumn(undefined)).toEqual({});
  });
});

describe('the rows-per-page choice', () => {
  it('is remembered in this browser, and only when it is one of the choices', () => {
    expect(rememberedPageSize()).toBe(DEFAULT_PAGE_SIZE);
    rememberPageSize(100);
    expect(rememberedPageSize()).toBe(100);
    window.localStorage.setItem('formlogic.data.rowsPerPage', '37');
    expect(rememberedPageSize()).toBe(DEFAULT_PAGE_SIZE);
  });

  it('falls back to the default where storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(rememberedPageSize()).toBe(DEFAULT_PAGE_SIZE);
    expect(() => rememberPageSize(50)).not.toThrow();
  });
});
