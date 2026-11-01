// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvImportWizard } from './CsvImportWizard';
import { api } from '../../lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fields = [
  { id: 'first', label: 'Name', type: 'short_text' },
  { id: 'second', label: 'Name', type: 'short_text' },
  { id: 'photo', label: 'Photo', type: 'file_upload' },
  { id: 'sign', label: 'Sign here', type: 'signature' },
  { id: 'link', label: 'Customer', type: 'linked_record' },
];

let root: Root;
let host: HTMLDivElement;

const page = () => document.body.textContent ?? '';
const button = (name: RegExp) => {
  const found = [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = (name: RegExp) => act(async () => { button(name).click(); });

const open = async (headers: string[], previewCells: string[][]) => {
  vi.spyOn(api, 'parseImportCsv').mockResolvedValue({ data: { headers, rowCount: previewCells.length, previewCells, fields } });
  const importCsv = vi.spyOn(api, 'importCsv').mockResolvedValue({ data: { created: 1, skipped: 0, total: 1, errors: [] } });
  await act(async () => {
    root.render(<CsvImportWizard isOpen onClose={() => {}} formId="f1" fields={fields} />);
  });
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'back.csv', { type: 'text/csv' })], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return importCsv;
};

describe('CsvImportWizard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps two columns with one heading apart, by position', async () => {
    const importCsv = await open(['Name', 'Name', 'Notes'], [['Ada', 'Lovelace', 'x']]);

    expect(page()).toContain('2 of 3 columns mapped');
    await click(/Preview/);

    // Both cells show, each under its own column.
    const cells = [...document.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells).toEqual(['Ada', 'Lovelace']);

    await click(/Import 1 Rows/);
    expect(importCsv.mock.calls[0][2]).toEqual(['first', 'second', 'skip']);
  });

  it('remaps one of two columns with one heading and leaves the other', async () => {
    const importCsv = await open(['Name', 'Name'], [['Ada', 'Lovelace']]);

    const second = document.querySelector('select[aria-label^="Map column 2"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(second, 'skip');
      second.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(page()).toContain('1 of 2 columns mapped');

    await click(/Preview/);
    await click(/Import 1 Rows/);
    expect(importCsv.mock.calls[0][2]).toEqual(['first', 'skip']);
  });

  it('says in the preview that imported rows are new records', async () => {
    await open(['Name'], [['Ada']]);
    await click(/Preview/);

    const status = document.querySelector('[role=status]')?.textContent ?? '';
    expect(status).toMatch(/new record/);
    expect(status).toMatch(/importing the same file twice adds its rows twice/);
  });

  it('says in the preview what a mapped column will not bring back', async () => {
    await open(['Name', 'Photo', 'Sign here', 'Customer'], [['Ada', 'cv.pdf', '[signature]', 'Acme']]);
    await click(/Preview/);

    expect(page()).toContain("Photo: files aren't imported");
    expect(page()).toContain('Sign here: typed signatures are imported');
    expect(page()).toContain('Customer: a linked record needs its record ID');
  });

  it('has nothing to warn about when no such column is mapped', async () => {
    await open(['Name'], [['Ada']]);
    await click(/Preview/);

    expect(page()).not.toContain("aren't imported");
  });
});
