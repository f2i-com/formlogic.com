// Client-side CSV export for private forms (plan SS10): the server can only
// stream ciphertext, so the export is a full paged fetch + worker decrypt in the
// owner's browser, with progress and a cancel path that names the file
// '-partial' (never a silently truncated "complete" export).

import type { FormField } from '../../types/form';
import { formatValue } from '../../components/responses/recordFormat';
import type { OpenRowsResult } from './formCrypto';

/**
 * Hardened CSV cell escaping - identical rules to the responses table's
 * client-side export (and the backend's exportResponsesStreaming): quotes
 * doubled, and any leading formula trigger (incl. after whitespace/TAB/CR)
 * neutralized with a leading apostrophe.
 */
export function csvEscapeCell(val: unknown): string {
  let str = String(val ?? '').replace(/"/g, '""');
  if (/^\s*[=+\-@\t\r]/.test(str)) str = "'" + str;
  return `"${str}"`;
}

export function buildCsv(headers: string[], rows: string[][]): string {
  return [
    headers.map(csvEscapeCell).join(','),
    ...rows.map((row) => row.map(csvEscapeCell).join(',')),
  ].join('\n');
}

export interface PrivateCsvProgress {
  fetched: number;
  decrypted: number;
  total: number | null;
}

export interface ExportRowWire {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
  status?: string;
}

export interface PrivateCsvExportDeps {
  /** Fetch one page of raw (envelope) rows. */
  fetchPage: (offset: number, limit: number) => Promise<{ rows: ExportRowWire[]; count: number | null }>;
  /** Batch-decrypt a page (cryptoClient.openResponsesForForm bound to the form). */
  decryptRows: (rows: Array<{ id: string; answers: unknown }>) => Promise<OpenRowsResult>;
  formatDate: (iso: string) => string;
}

export interface PrivateCsvExportArgs {
  fields: FormField[];
  displayTz?: string;
  pageSize?: number;
  onProgress?: (progress: PrivateCsvProgress) => void;
  /** Checked between pages; returning true stops the export as partial. */
  shouldCancel?: () => boolean;
}

export interface PrivateCsvExportResult {
  csv: string;
  rowCount: number;
  /** True when the export was cancelled before all rows were fetched. */
  partial: boolean;
}

const EXPORTABLE = (f: FormField) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type);

/**
 * Full-fetch decrypt-and-assemble CSV. Fetches ALL rows page by page (no search
 * cap - plan SS10), decrypting each page in the worker as it lands. Rows that
 * fail to decrypt export as '[encrypted - could not decrypt]' placeholders
 * rather than being silently dropped.
 */
export async function exportPrivateFormCsv(
  deps: PrivateCsvExportDeps,
  args: PrivateCsvExportArgs,
): Promise<PrivateCsvExportResult> {
  const pageSize = args.pageSize ?? 500;
  const exportFields = args.fields.filter(EXPORTABLE);
  const headers = ['ID', 'Submitted At', 'Status', ...exportFields.map((f) => f.label)];
  const rows: string[][] = [];
  let fetched = 0;
  let decrypted = 0;
  let total: number | null = null;
  let partial = false;

  for (let offset = 0; ; offset += pageSize) {
    if (args.shouldCancel?.()) {
      partial = true;
      break;
    }
    const page = await deps.fetchPage(offset, pageSize);
    // Failure integrity (review 2026-07-22): a page that isn't the expected list
    // shape aborts the export — an API failure must NEVER look like an empty final
    // page and produce a normal-looking incomplete CSV. Only a genuinely empty
    // page ends iteration.
    if (!page || !Array.isArray(page.rows)) {
      throw new Error('Export aborted: the server returned an unexpected page of responses. No file was produced.');
    }
    if (total === null && page.count !== null) total = page.count;
    if (page.rows.length === 0) break;
    fetched += page.rows.length;
    args.onProgress?.({ fetched, decrypted, total });

    const opened = await deps.decryptRows(page.rows.map((r) => ({ id: r.id, answers: r.answers })));
    for (const row of page.rows) {
      const dec = opened.get(row.id);
      const answers = dec && !('error' in dec) ? dec.answers : null;
      rows.push([
        row.id,
        deps.formatDate(row.submittedAt),
        row.status ?? 'submitted',
        ...exportFields.map((f) => answers === null
          ? '[encrypted - could not decrypt]'
          : formatValue(answers[f.id], f.type, f.properties?.options, args.displayTz)),
      ]);
    }
    decrypted += page.rows.length;
    args.onProgress?.({ fetched, decrypted, total });

    if (page.rows.length < pageSize) break;
  }

  return { csv: buildCsv(headers, rows), rowCount: rows.length, partial };
}
