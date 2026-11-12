// @vitest-environment jsdom
// What the data manager's calls put on the wire: the records route's query for a page of rows, a
// table's structure, deleting several rows, and the address an export downloads from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';

const requests: { url: URL; init?: RequestInit }[] = [];
const last = () => requests[requests.length - 1];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input), 'https://formlogic.example'), init });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); api.setAdminActing(null); });

describe('a page of rows', () => {
  it('asks for the table and the page alone when nothing else is wanted', async () => {
    await api.browseNativeRecords('app 1', 'bookings', { offset: 50, limit: 25, sort: null, q: '', filters: [] });
    expect(last().url.pathname).toBe('/api/apps/app%201/native/records');
    expect(Object.fromEntries(last().url.searchParams)).toEqual({ table: 'bookings', offset: '50', limit: '25' });
  });

  it('sends the order, the search and the filters as the route reads them', async () => {
    await api.browseNativeRecords('app1', 'bookings', {
      offset: 0, limit: 100, sort: { column: 'starts_at', dir: 'desc' }, q: '50% off',
      filters: [{ column: 'status', op: 'eq', value: 'paid' }, { column: 'notes', op: 'notEmpty', value: 'ignored' }, { column: 'room_id', op: 'empty' }],
    });
    const params = last().url.searchParams;
    expect(params.get('sort')).toBe('starts_at');
    expect(params.get('dir')).toBe('desc');
    expect(params.get('q')).toBe('50% off');
    // A filter that takes no value is sent without one.
    expect(JSON.parse(params.get('filter')!)).toEqual([{ column: 'status', op: 'eq', value: 'paid' }, { column: 'notes', op: 'notEmpty' }, { column: 'room_id', op: 'empty' }]);
  });
});

describe('a search and a filter value on the wire', () => {
  it('arrive as they were typed: quotes, percent signs, ampersands, other alphabets', async () => {
    for (const text of ['50% off', 'O\'Brien & "sons"', 'a=b&c=d#e', 'naïve café', '日本語 🍣', '%25_', 'a+b', '\\']) {
      await api.browseNativeRecords('app1', 'bookings', { q: text, filters: [{ column: 'notes', op: 'contains', value: text }] });
      const params = last().url.searchParams;
      expect(params.get('q'), text).toBe(text);
      expect(JSON.parse(params.get('filter')!), text).toEqual([{ column: 'notes', op: 'contains', value: text }]);
      // Nothing of the value leaks into the address as a parameter or a fragment of its own.
      expect([...params.keys()].sort(), text).toEqual(['filter', 'offset', 'q', 'table']);
      expect(last().url.hash, text).toBe('');
    }
  });

  it('names a table with odd characters as one value', async () => {
    await api.getNativeStructure('app1', 'weird table&x=1#y');
    expect(Object.fromEntries(last().url.searchParams)).toEqual({ table: 'weird table&x=1#y', view: 'structure' });
  });
});

describe('a table’s structure', () => {
  it('is the records route with view=structure', async () => {
    await api.getNativeStructure('app1', 'bookings');
    expect(last().url.pathname).toBe('/api/apps/app1/native/records');
    expect(Object.fromEntries(last().url.searchParams)).toEqual({ table: 'bookings', view: 'structure' });
  });
});

describe('deleting several rows', () => {
  it('posts each row’s key with its stamp', async () => {
    await api.deleteNativeRecords('app1', 'bookings', [{ key: { id: '8213' }, stamp: '9f2c' }, { key: { id: '8212' }, stamp: '71aa' }]);
    expect(last().init?.method).toBe('POST');
    expect(last().url.pathname).toBe('/api/apps/app1/native/records');
    expect(JSON.parse(String(last().init?.body))).toEqual({ table: 'bookings', action: 'deleteMany', rows: [{ key: { id: '8213' }, stamp: '9f2c' }, { key: { id: '8212' }, stamp: '71aa' }] });
  });
});

describe('the export address', () => {
  it('names the table and the format, and asks nothing else of a whole table', () => {
    expect(api.nativeExportUrl('app1', 'bookings', 'csv')).toBe('/api/apps/app1/native/records?table=bookings&export=csv');
    expect(api.nativeExportUrl('app1', '*', 'json')).toBe('/api/apps/app1/native/records?table=*&export=json');
  });

  it('carries the search, the filters and the order for the rows that match', () => {
    const url = new URL(api.nativeExportUrl('app1', 'bookings', 'json', { q: 'nuts', sort: { column: 'id', dir: 'desc' }, filters: [{ column: 'status', op: 'ne', value: 'cancelled' }] }), 'https://formlogic.example');
    expect(Object.fromEntries(url.searchParams)).toEqual({ table: 'bookings', export: 'json', sort: 'id', dir: 'desc', q: 'nuts', filter: '[{"column":"status","op":"ne","value":"cancelled"}]' });
  });

  it('makes no request: it is an address for a plain link', () => {
    api.nativeExportUrl('app1', 'bookings', 'csv');
    expect(requests).toEqual([]);
  });

  it('follows the same route as the rows when an administrator acts for another account', () => {
    api.setAdminActing({ ownerId: 'owner 7' });
    expect(api.nativeExportUrl('app1', 'bookings', 'csv')).toBe('/api/admin/users/owner%207/apps/app1/native/records?table=bookings&export=csv');
  });
});
