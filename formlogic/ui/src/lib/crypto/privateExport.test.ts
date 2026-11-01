import { describe, expect, it } from 'vitest';
import { exportPrivateFormCsv, type ExportRowWire } from './privateExport';
import type { FormField } from '../../types/form';

const FIELDS = [{ id: 'name', type: 'short_text', label: 'Name' }] as unknown as FormField[];

function row(id: string): ExportRowWire {
  return { id, answers: {}, submittedAt: '2026-01-01 00:00:00' };
}

describe('exportPrivateFormCsv', () => {
  it('writes a record once when one arriving mid-export pushes it onto the next page', async () => {
    // Newest first by offset: "new" arrives after page one, so "c" comes back on page two.
    const pages: ExportRowWire[][] = [[row('a'), row('b'), row('c')], [row('c'), row('d')]];
    const decrypted: string[][] = [];
    let page = 0;
    const result = await exportPrivateFormCsv(
      {
        fetchPage: async () => ({ rows: pages[page++] ?? [], count: 4 }),
        decryptRows: async (rows) => {
          decrypted.push(rows.map((r) => r.id));
          return new Map(rows.map((r) => [r.id, { answers: { name: r.id.toUpperCase() } }])) as never;
        },
        formatDate: (iso) => iso,
      },
      { fields: FIELDS, pageSize: 3 },
    );

    expect(result.rowCount).toBe(4);
    expect(result.csv.split('\n').slice(1).map((line) => line.split(',')[0])).toEqual(['"a"', '"b"', '"c"', '"d"']);
    expect(decrypted).toEqual([['a', 'b', 'c'], ['d']]);
  });
});
