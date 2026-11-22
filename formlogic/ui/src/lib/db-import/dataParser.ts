import { gunzipSync, unzipSync } from 'fflate';

export interface ParsedTabularData {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  delimiter?: string;
  format: 'csv' | 'tsv' | 'json' | 'ndjson';
  warnings: string[];
}

export interface UnpackedArchiveFile {
  name: string;
  baseName: string;
  ext: string;
  bytes: Uint8Array;
}

/** Strip UTF-8 BOM if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Auto-detect CSV/TSV delimiter from the first few non-empty lines outside quotes. */
export function detectDelimiter(sample: string): string {
  const candidates = [',', '\t', ';', '|'];
  const lines = sample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((line) => {
      let inQuotes = false;
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (!inQuotes && ch === delim) {
          count++;
        }
      }
      return count;
    });
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (min > 0) {
      // Strongly prefer consistent column counts across lines.
      const consistency = min === max ? 10 : 1;
      const score = min * consistency;
      if (score > bestScore) {
        bestScore = score;
        best = delim;
      }
    }
  }
  return best;
}

/**
 * Pure-TS RFC 4180 CSV/TSV parser supporting quoted newlines, escaped quotes (""),
 * and automatic delimiter detection. Zero regex lookbehinds for Safari <16.4 safety.
 */
export function parseDelimitedText(
  rawText: string,
  forcedDelimiter?: string,
  maxRows = 100_000,
): ParsedTabularData {
  const text = stripBom(rawText);
  const warnings: string[] = [];
  if (!text.trim()) {
    return { headers: [], rows: [], format: 'csv', warnings: ['File is empty.'] };
  }

  const delimiter = forcedDelimiter || detectDelimiter(text.slice(0, 8192));
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell);
      cell = '';
      if (ch === '\r' && i + 1 < len && text[i + 1] === '\n') {
        i += 2;
      } else {
        i++;
      }
      if (row.some((c) => c.trim() !== '')) {
        records.push(row);
        if (records.length > maxRows + 1) {
          warnings.push(`Truncated preview/import at ${maxRows.toLocaleString()} rows.`);
          break;
        }
      }
      row = [];
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) {
      records.push(row);
    }
  }

  if (records.length === 0) {
    return { headers: [], rows: [], delimiter, format: delimiter === '\t' ? 'tsv' : 'csv', warnings };
  }

  // Deduplicate blank or repeated headers safely.
  const seen = new Map<string, number>();
  const headers = records[0].map((raw, idx) => {
    const base = raw.trim() || `column_${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });

  const rows: Array<Record<string, unknown>> = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r];
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const val = cells[c] ?? '';
      obj[headers[c]] = val === '' ? null : val;
    }
    rows.push(obj);
  }

  return {
    headers,
    rows,
    delimiter,
    format: delimiter === '\t' ? 'tsv' : 'csv',
    warnings,
  };
}

/**
 * Parse a JSON array of objects, a `{ rows | data | records: [...] }` envelope,
 * or newline-delimited JSON (NDJSON).
 */
export function parseJsonDataText(rawText: string, maxRows = 100_000): ParsedTabularData {
  const text = stripBom(rawText).trim();
  const warnings: string[] = [];
  if (!text) {
    return { headers: [], rows: [], format: 'json', warnings: ['Empty JSON input.'] };
  }

  let items: Array<Record<string, unknown>> = [];
  let format: 'json' | 'ndjson' = 'json';

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      items = parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
    } else if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      const list = rec.rows ?? rec.data ?? rec.records ?? rec.items;
      if (Array.isArray(list)) {
        items = list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
      } else {
        items = [rec];
      }
    }
  } catch {
    // Try NDJSON (one JSON object per line).
    format = 'ndjson';
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      if (!line) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          items.push(obj as Record<string, unknown>);
          if (items.length >= maxRows) {
            warnings.push(`Truncated NDJSON at ${maxRows.toLocaleString()} rows.`);
            break;
          }
        }
      } catch {
        warnings.push(`Skipped malformed JSON on line ${idx + 1}.`);
      }
    }
  }

  if (items.length > maxRows) {
    items = items.slice(0, maxRows);
    warnings.push(`Truncated JSON data at ${maxRows.toLocaleString()} rows.`);
  }

  const headerSet = new Set<string>();
  for (const item of items.slice(0, 500)) {
    for (const k of Object.keys(item)) {
      headerSet.add(k);
    }
  }

  return {
    headers: Array.from(headerSet),
    rows: items,
    format,
    warnings,
  };
}

/** Parse any uploaded tabular data file (CSV, TSV, JSON, NDJSON). */
export function parseDataFileText(filename: string, text: string): ParsedTabularData {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) {
    return parseJsonDataText(text);
  }
  if (lower.endsWith('.tsv')) {
    return parseDelimitedText(text, '\t');
  }
  const trimmed = stripBom(text).trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const jsonRes = parseJsonDataText(trimmed);
    if (jsonRes.rows.length > 0) return jsonRes;
  }
  return parseDelimitedText(text);
}

/** Decompress a .gz file in-browser using fflate. */
export function gunzipBytes(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes);
}

/** Unpack a .zip archive in-browser using fflate, skipping macOS metadata/directories. */
export function unpackZipBytes(bytes: Uint8Array, maxFiles = 200): UnpackedArchiveFile[] {
  const entries = unzipSync(bytes);
  const out: UnpackedArchiveFile[] = [];
  for (const [rawPath, fileBytes] of Object.entries(entries)) {
    if (rawPath.endsWith('/')) continue;
    if (rawPath.includes('__MACOSX/') || rawPath.split('/').some((seg) => seg.startsWith('.'))) {
      continue;
    }
    const name = rawPath.split('/').pop() || rawPath;
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    const baseName = dot >= 0 ? name.slice(0, dot) : name;
    out.push({ name, baseName, ext, bytes: fileBytes });
    if (out.length >= maxFiles) break;
  }
  return out;
}
