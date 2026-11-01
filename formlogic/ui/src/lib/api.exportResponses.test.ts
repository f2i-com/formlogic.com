// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const utf8Bom = [0xef, 0xbb, 0xbf];

describe('exportResponses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the bytes as sent, so the BOM Excel reads the file by is still there', async () => {
    const sent = new Uint8Array([...utf8Bom, ...new TextEncoder().encode('Name\r\nJosé\r\n')]);
    // A real Response: its text() is what drops a BOM.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sent, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } })));

    const blob = await api.exportResponses('f1');

    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...sent]);
  });
});
