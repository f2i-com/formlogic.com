// What the Browse view shows, as the page's address holds it: the search, the filters, the order,
// where the page of rows starts, and the open row. The address is the one copy of it, so Back,
// Forward, a reload and a copied link all return to the same thing. Rows per page is not here: it
// is a choice the browser remembers.
import type { NativeFilter, NativeFilterOp, NativeSort } from '../../lib/nativeHosting';
import { FILTER_OPS, MAX_FILTERS, MAX_SEARCH, takesValue } from './format';

export interface BrowseState {
  q: string;
  filters: NativeFilter[];
  sort: NativeSort | null;
  /** Where the page of rows starts. */
  offset: number;
  /** The open row, by the columns that find it: its key, or the columns a foreign key pointed at. */
  row: Record<string, string> | null;
}

/** A table as it opens from the list: every row, in its own order, from the first, none open. */
export const NOTHING: BrowseState = { q: '', filters: [], sort: null, offset: 0, row: null };

const OWN = ['q', 'filter', 'sort', 'dir', 'offset', 'row'] as const;

const parse = (text: string | null): unknown => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** The filters an address names. What cannot be read as a filter is left out: a mistyped address is no error. */
function readFilters(value: unknown): NativeFilter[] {
  if (!Array.isArray(value)) return [];
  const filters: NativeFilter[] = [];
  for (const each of value) {
    if (each === null || typeof each !== 'object') continue;
    const { column, op, value: compared } = each as Record<string, unknown>;
    if (typeof column !== 'string' || !column || !FILTER_OPS.includes(op as NativeFilterOp)) continue;
    if (!takesValue(op as NativeFilterOp)) filters.push({ column, op: op as NativeFilterOp });
    else if (typeof compared === 'string' || typeof compared === 'number') filters.push({ column, op: op as NativeFilterOp, value: String(compared) });
  }
  return filters.slice(0, MAX_FILTERS);
}

/** The row an address names: an object of column to text or number, or nothing. */
function readRow(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([, part]) => typeof part !== 'string' && typeof part !== 'number')) return null;
  return Object.fromEntries(entries.map(([name, part]) => [name, String(part)]));
}

/** The Browse state in an address's query string (with or without its "?"). */
export function readQuery(query = ''): BrowseState {
  const params = new URLSearchParams(query);
  const sort = params.get('sort');
  const offset = Number(params.get('offset'));
  return {
    q: (params.get('q') ?? '').slice(0, MAX_SEARCH),
    filters: readFilters(parse(params.get('filter'))),
    sort: sort ? { column: sort, dir: params.get('dir') === 'desc' ? 'desc' : 'asc' } : null,
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    row: readRow(parse(params.get('row'))),
  };
}

/**
 * The query string that holds a Browse state (without the "?"). Only what differs from a table
 * just opened is written, and whatever else the address carried (`current`) is kept.
 */
export function writeQuery(state: BrowseState, current = ''): string {
  const params = new URLSearchParams(current);
  for (const name of OWN) params.delete(name);
  if (state.q) params.set('q', state.q);
  if (state.filters.length) params.set('filter', JSON.stringify(state.filters.map(({ column, op, value }) => takesValue(op) ? { column, op, value: value ?? '' } : { column, op })));
  if (state.sort) {
    params.set('sort', state.sort.column);
    if (state.sort.dir === 'desc') params.set('dir', 'desc');
  }
  if (state.offset > 0) params.set('offset', String(state.offset));
  if (state.row) params.set('row', JSON.stringify(state.row));
  return params.toString();
}

/** Which page of which rows a state asks for, as one string: it does not change with the open row. */
export const pageOf = (state: BrowseState, limit: number) => JSON.stringify([state.offset, limit, state.sort, state.q, state.filters]);
