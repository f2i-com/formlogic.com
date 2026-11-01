// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// The reply a real v0.1.20 server gave, and the request it reads: this release's page can be left
// open across a rollback. `columns` alone would be taken for a request for another preview.
const olderServerPreview = {
  headers: ['Name', 'City'],
  rowCount: 1,
  previewRows: [{ Name: 'Ada', City: 'Oslo' }],
  fields: [{ id: 'a', label: 'Name', type: 'short_text' }],
};

const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const file = () => new File(['Name,City\nAda,Oslo\n'], 'people.csv', { type: 'text/csv' });

describe('the CSV import against an older server', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a preview that has rows by heading and no cells', async () => {
    vi.stubGlobal('fetch', reply(olderServerPreview));

    const result = await api.parseImportCsv('f1', file());

    expect(result.data?.previewCells).toEqual([['Ada', 'Oslo']]);
  });

  it('keeps the cells of a server that sends them', async () => {
    vi.stubGlobal('fetch', reply({ ...olderServerPreview, previewCells: [['one', 'two']], encoding: 'Windows-1252', endCut: false }));

    const result = await api.parseImportCsv('f1', file());

    expect(result.data?.previewCells).toEqual([['one', 'two']]);
    expect(result.data?.encoding).toBe('Windows-1252');
  });

  it('sends the mapping by heading beside the columns, leaving out what is skipped', async () => {
    const fetchMock = reply({ created: 1, skipped: 0, total: 1, errors: [] });
    vi.stubGlobal('fetch', fetchMock);

    await api.importCsv('f1', file(), ['a', 'skip', 'c'], ['Name', 'City', 'Count']);

    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(JSON.parse(body.get('columns') as string)).toEqual(['a', 'skip', 'c']);
    expect(JSON.parse(body.get('columnMapping') as string)).toEqual({ Name: 'a', Count: 'c' });
  });
});
