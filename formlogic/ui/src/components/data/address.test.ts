import { describe, expect, it } from 'vitest';
import { NOTHING, pageOf, readQuery, writeQuery, type BrowseState } from './address';

const state = (over: Partial<BrowseState> = {}): BrowseState => ({ ...NOTHING, ...over });

describe('reading the address', () => {
  it('reads nothing from an address that says nothing', () => {
    expect(readQuery()).toEqual(NOTHING);
    expect(readQuery('')).toEqual(NOTHING);
    expect(readQuery('?')).toEqual(NOTHING);
  });

  it('reads the search, the filters, the order, the page and the open row', () => {
    const query = 'q=nuts&filter=%5B%7B%22column%22%3A%22status%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22paid%22%7D%2C%7B%22column%22%3A%22notes%22%2C%22op%22%3A%22empty%22%7D%5D&sort=starts_at&dir=desc&offset=50&row=%7B%22id%22%3A%221458%22%7D';
    expect(readQuery(query)).toEqual({
      q: 'nuts', filters: [{ column: 'status', op: 'eq', value: 'paid' }, { column: 'notes', op: 'empty' }],
      sort: { column: 'starts_at', dir: 'desc' }, offset: 50, row: { id: '1458' },
    });
    // The same with its "?".
    expect(readQuery(`?${query}`)).toEqual(readQuery(query));
  });

  it('sorts ascending unless the address says descending', () => {
    expect(readQuery('sort=id').sort).toEqual({ column: 'id', dir: 'asc' });
    expect(readQuery('sort=id&dir=up').sort).toEqual({ column: 'id', dir: 'asc' });
    expect(readQuery('dir=desc').sort).toBeNull();
  });

  it('ignores a filter or a row it cannot read: a mistyped address is no error', () => {
    for (const filter of ['nonsense', '%7B%22column%22%3A%22a%22%7D', '5', '%5B1%2Cnull%2C%22x%22%5D']) expect(readQuery(`filter=${filter}`).filters, filter).toEqual([]);
    // What can be read of a list of filters is kept: the unknown rule, the missing value and the missing column are left out.
    const mixed = encodeURIComponent(JSON.stringify([{ column: 'a', op: 'eq', value: '1' }, { column: 'b', op: 'like', value: 'x' }, { column: 'c', op: 'gt' }, { op: 'eq', value: '1' }, { column: 'd', op: 'notEmpty', value: 'unused' }, { column: 'e', op: 'lt', value: 7 }]));
    expect(readQuery(`filter=${mixed}`).filters).toEqual([{ column: 'a', op: 'eq', value: '1' }, { column: 'd', op: 'notEmpty' }, { column: 'e', op: 'lt', value: '7' }]);
    for (const row of ['nonsense', '%5B1%5D', '%7B%7D', '5', '%7B%22id%22%3Anull%7D', '%7B%22id%22%3A%7B%7D%7D']) expect(readQuery(`row=${row}`).row, row).toBeNull();
    // A key's number is read as its text.
    expect(readQuery('row=%7B%22id%22%3A1458%7D').row).toEqual({ id: '1458' });
  });

  it('starts from the first row for an offset that is not a whole number of rows', () => {
    for (const offset of ['-25', 'abc', '2.5', '1e999']) expect(readQuery(`offset=${offset}`).offset, offset).toBe(0);
  });

  it('takes no more filters than a request may carry', () => {
    const many = Array.from({ length: 12 }, (_, at) => ({ column: `c${at}`, op: 'empty' }));
    expect(readQuery(`filter=${encodeURIComponent(JSON.stringify(many))}`).filters).toHaveLength(8);
  });
});

describe('writing the address', () => {
  it('writes nothing for a table just opened', () => {
    expect(writeQuery(NOTHING)).toBe('');
  });

  it('writes only what differs, and reads back the same', () => {
    const full = state({ q: 'nuts', filters: [{ column: 'status', op: 'ne', value: 'cancelled' }, { column: 'room_id', op: 'empty' }], sort: { column: 'total', dir: 'desc' }, offset: 75, row: { room_id: '4', day: '2026-11-17' } });
    expect(readQuery(writeQuery(full))).toEqual(full);
    expect(writeQuery(state({ sort: { column: 'id', dir: 'asc' } }))).toBe('sort=id');
    expect(writeQuery(state({ offset: 25 }))).toBe('offset=25');
    expect(writeQuery(state({ row: { id: '1458' } }))).toBe('row=%7B%22id%22%3A%221458%22%7D');
  });

  it('carries quotes, percent signs, ampersands and other alphabets in a search and a filter', () => {
    for (const text of ['50% off', 'O\'Brien & "sons"', 'a=b&c=d', 'naïve café', '日本語 🍣', '%25', 'a+b', ' padded ']) {
      const written = writeQuery(state({ q: text.trim(), filters: [{ column: 'notes', op: 'contains', value: text }] }));
      expect(readQuery(written), text).toEqual(state({ q: text.trim(), filters: [{ column: 'notes', op: 'contains', value: text }] }));
    }
  });

  it('keeps what else the address carried, and replaces its own', () => {
    const written = writeQuery(state({ q: 'new' }), 'tab=data&q=old&offset=50&row=%7B%22id%22%3A%221%22%7D');
    expect(Object.fromEntries(new URLSearchParams(written))).toEqual({ tab: 'data', q: 'new' });
  });
});

describe('a page of rows', () => {
  it('is the same page whichever row is open, and another for any other rows', () => {
    const page = pageOf(state({ q: 'nuts', offset: 25 }), 25);
    expect(pageOf(state({ q: 'nuts', offset: 25, row: { id: '1' } }), 25)).toBe(page);
    expect(pageOf(state({ q: 'nuts', offset: 50 }), 25)).not.toBe(page);
    expect(pageOf(state({ q: 'nuts', offset: 25 }), 50)).not.toBe(page);
    expect(pageOf(state({ q: 'nut', offset: 25 }), 25)).not.toBe(page);
  });
});
