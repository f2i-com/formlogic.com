import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  ExternalLink,
  FileUp,
  Laptop,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { api, type BatchImportRowInput } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { parseDataFileText, unpackZipBytes } from '../../lib/db-import/dataParser';
import { fetchLocalTableBatch } from '../../lib/db-import/localBridge';
import { prepareBatchImportRow, topologicalSortTables } from '../../lib/db-import/mapper';
import { normalizeTableKey, parseSqlSchema } from '../../lib/db-import/sqlParser';
import type {
  ImportedSchema,
  MaterializedMigration,
  MaterializedTable,
  TableMapping,
} from '../../lib/db-import/types';

interface TableDataState {
  enabled: boolean;
  sourceLabel: string | null;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  useLocalBridge: boolean;
  pkColumn: string | null;
  columnToFieldId: Record<string, string>;
}

interface TableRunProgress {
  status: 'idle' | 'running' | 'linking' | 'done' | 'error' | 'cancelled';
  processed: number;
  total: number;
  created: number;
  failed: number;
  linksPatched: number;
  errors: Array<{ row: number; message: string }>;
}

function autoMapColumns(
  headers: string[],
  table: MaterializedTable,
): Record<string, string> {
  const map: Record<string, string> = {};
  const bySource = new Map<string, string>();
  const byFieldId = new Map<string, string>();
  const byLabel = new Map<string, string>();

  for (const f of table.fields) {
    if (!f.include) continue;
    bySource.set(f.sourceColumn.toLowerCase(), f.fieldId);
    byFieldId.set(f.fieldId.toLowerCase(), f.fieldId);
    byLabel.set(f.label.toLowerCase(), f.fieldId);
  }

  for (const h of headers) {
    const key = h.toLowerCase().trim();
    map[h] = bySource.get(key) ?? byFieldId.get(key) ?? byLabel.get(key) ?? '__skip__';
  }
  return map;
}

function buildInitialDataStates(
  schema: ImportedSchema,
  mappings: TableMapping[],
  materialized: MaterializedMigration,
): Record<string, TableDataState> {
  const mappingByKey = new Map(mappings.map((m) => [m.tableKey, m]));
  const out: Record<string, TableDataState> = {};

  for (const tbl of materialized.tables) {
    const mapInfo = mappingByKey.get(tbl.tableKey);
    const initialRows = mapInfo?.initialRows ?? [];
    const headers =
      initialRows.length > 0
        ? Array.from(new Set(initialRows.slice(0, 100).flatMap((r) => Object.keys(r))))
        : tbl.fields.map((f) => f.sourceColumn);
    const useBridge = !!schema.localBridge && initialRows.length === 0;
    const knownRows = initialRows.length > 0 ? initialRows.length : (mapInfo?.totalRowCount ?? 0);
    out[tbl.tableKey] = {
      enabled: initialRows.length > 0 || (useBridge && (mapInfo?.totalRowCount === undefined || knownRows > 0)),
      sourceLabel:
        initialRows.length > 0
          ? `${initialRows.length.toLocaleString()} rows preloaded from ${schema.sourceLabel}`
          : useBridge
            ? knownRows > 0
              ? `${knownRows.toLocaleString()} rows ready via ${schema.sourceLabel} (local bridge)`
              : `0 rows detected in ${schema.sourceLabel} (local bridge)`
            : null,
      headers,
      rows: initialRows,
      useLocalBridge: useBridge,
      pkColumn: tbl.primaryKeyColumn,
      columnToFieldId: autoMapColumns(headers, tbl),
    };
  }
  return out;
}

export function DataImportStep({
  schema,
  mappings,
  materialized,
  onStartOver,
}: {
  schema: ImportedSchema;
  mappings: TableMapping[];
  materialized: MaterializedMigration;
  onStartOver: () => void;
}) {
  const navigate = useNavigate();

  // Order materialized tables in topological order (parents before children).
  const { orderedTables, cyclicByTable } = useMemo(() => {
    const { order, cyclicLinks } = topologicalSortTables(mappings);
    const matByKey = new Map(materialized.tables.map((t) => [t.tableKey, t]));
    const ordered: MaterializedTable[] = [];
    for (const o of order) {
      const mt = matByKey.get(o.tableKey);
      if (mt) ordered.push(mt);
    }
    for (const mt of materialized.tables) {
      if (!ordered.some((o) => o.tableKey === mt.tableKey)) ordered.push(mt);
    }
    const cyclicMap = new Map<string, Set<string>>();
    for (const c of cyclicLinks) {
      if (!cyclicMap.has(c.tableKey)) cyclicMap.set(c.tableKey, new Set());
      cyclicMap.get(c.tableKey)!.add(c.fieldId);
    }
    return { orderedTables: ordered, cyclicByTable: cyclicMap };
  }, [mappings, materialized.tables]);

  const [dataByTable, setDataByTable] = useState<Record<string, TableDataState>>(() =>
    buildInitialDataStates(schema, mappings, materialized),
  );
  const [progressByTable, setProgressByTable] = useState<Record<string, TableRunProgress>>({});
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState<number>(250);
  const [largeTableRowCap, setLargeTableRowCap] = useState<number>(0);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Tables targeted by at least one foreign-key select box — always import 100% of their rows
  // even when a row cap is set on large fact/telemetry tables so select boxes stay complete!
  const referencedParentKeys = useMemo(() => {
    const parents = new Set<string>();
    for (const t of orderedTables) {
      for (const info of Object.values(t.linkedFieldTargets)) {
        parents.add(info.targetTableKey);
      }
    }
    return parents;
  }, [orderedTables]);

  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const multiDropInputRef = useRef<HTMLInputElement>(null);

  const updateTableData = (tableKey: string, updater: (prev: TableDataState) => TableDataState) => {
    setDataByTable((prev) => ({
      ...prev,
      [tableKey]: updater(prev[tableKey]),
    }));
  };

  const loadFilesForTable = async (table: MaterializedTable, file: File) => {
    try {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      let headers: string[] = [];
      let rows: Array<Record<string, unknown>> = [];

      if (lower.endsWith('.sql')) {
        const parsed = parseSqlSchema(text, schema.dialect, file.name);
        const match =
          parsed.tables.find((t) => t.key === table.tableKey) ??
          parsed.tables.find((t) => t.rows.length > 0);
        if (!match || match.rows.length === 0) {
          toast.warning('No rows found', `Could not find INSERT/COPY rows for ${table.sourceName} in ${file.name}.`);
          return;
        }
        rows = match.rows;
        headers = Array.from(new Set(rows.slice(0, 100).flatMap((r) => Object.keys(r))));
      } else {
        const parsed = parseDataFileText(file.name, text);
        if (parsed.rows.length === 0) {
          toast.warning('No rows found', `${file.name} did not contain any data rows.`);
          return;
        }
        headers = parsed.headers;
        rows = parsed.rows;
      }

      const detectedPk =
        headers.find((h) => table.primaryKeyColumn && h.toLowerCase() === table.primaryKeyColumn.toLowerCase()) ??
        headers.find((h) => h.toLowerCase() === 'id') ??
        table.primaryKeyColumn;

      updateTableData(table.tableKey, () => ({
        enabled: true,
        sourceLabel: `${file.name} (${rows.length.toLocaleString()} rows)`,
        headers,
        rows,
        useLocalBridge: false,
        pkColumn: detectedPk ?? null,
        columnToFieldId: autoMapColumns(headers, table),
      }));
      toast.success(`Loaded ${rows.length.toLocaleString()} rows`, `Attached ${file.name} to ${table.formTitle}.`);
    } catch (err) {
      toast.error('Could not read file', err instanceof Error ? err.message : undefined);
    }
  };

  /** Match multiple dropped CSV/TSV/JSON/SQL/ZIP files to tables automatically by filename! */
  const handleBulkDropFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let matchedCount = 0;

    const processOne = (filename: string, text: string) => {
      const lower = filename.toLowerCase();
      if (lower.endsWith('.sql')) {
        const parsed = parseSqlSchema(text, schema.dialect, filename);
        for (const pt of parsed.tables) {
          if (pt.rows.length === 0) continue;
          const target = orderedTables.find((t) => t.tableKey === pt.key);
          if (!target) continue;
          const headers = Array.from(new Set(pt.rows.slice(0, 100).flatMap((r) => Object.keys(r))));
          updateTableData(target.tableKey, () => ({
            enabled: true,
            sourceLabel: `${filename} (${pt.rows.length.toLocaleString()} rows)`,
            headers,
            rows: pt.rows,
            useLocalBridge: false,
            pkColumn: target.primaryKeyColumn,
            columnToFieldId: autoMapColumns(headers, target),
          }));
          matchedCount++;
        }
        return;
      }

      const baseName = filename.replace(/\.[^.]+$/, '');
      const fileKey = normalizeTableKey(baseName);
      const target = orderedTables.find(
        (t) =>
          t.tableKey === fileKey ||
          normalizeTableKey(t.formTitle) === fileKey ||
          normalizeTableKey(t.sourceName) === fileKey,
      );
      if (!target) return;
      const parsed = parseDataFileText(filename, text);
      if (parsed.rows.length === 0) return;

      const detectedPk =
        parsed.headers.find((h) => target.primaryKeyColumn && h.toLowerCase() === target.primaryKeyColumn.toLowerCase()) ??
        parsed.headers.find((h) => h.toLowerCase() === 'id') ??
        target.primaryKeyColumn;

      updateTableData(target.tableKey, () => ({
        enabled: true,
        sourceLabel: `${filename} (${parsed.rows.length.toLocaleString()} rows)`,
        headers: parsed.headers,
        rows: parsed.rows,
        useLocalBridge: false,
        pkColumn: detectedPk ?? null,
        columnToFieldId: autoMapColumns(parsed.headers, target),
      }));
      matchedCount++;
    };

    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        for (const inner of unpackZipBytes(bytes)) {
          processOne(inner.name, decoder.decode(inner.bytes));
        }
      } else {
        processOne(file.name, await file.text());
      }
    }

    if (matchedCount > 0) {
      toast.success(`Matched ${matchedCount} ${matchedCount === 1 ? 'table' : 'tables'}`, 'Review mappings below and click Start batch import.');
    } else {
      toast.info('No filenames matched automatically', 'Use the per-table Upload button below to attach files directly to a specific table.');
    }
  };

  const waitWhilePaused = async () => {
    while (pauseRef.current && !cancelRef.current) {
      await new Promise((r) => window.setTimeout(r, 150));
    }
  };

  const effectiveCapForTable = (tableKey: string): number | null => {
    if (largeTableRowCap <= 0) return null;
    if (referencedParentKeys.has(tableKey)) return null;
    return largeTableRowCap;
  };

  const totalReadyRows = useMemo(() => {
    let sum = 0;
    for (const t of orderedTables) {
      const st = dataByTable[t.tableKey];
      if (!st || !st.enabled) continue;
      const cap = largeTableRowCap > 0 && !referencedParentKeys.has(t.tableKey) ? largeTableRowCap : null;
      if (st.rows.length > 0) {
        sum += cap ? Math.min(st.rows.length, cap) : st.rows.length;
      } else if (st.useLocalBridge) {
        const mapInfo = mappings.find((m) => m.tableKey === t.tableKey);
        const count = mapInfo?.totalRowCount ?? 0;
        sum += cap ? Math.min(count, cap) : count;
      }
    }
    return sum;
  }, [orderedTables, dataByTable, mappings, largeTableRowCap, referencedParentKeys]);

  const hasAnyDataSource = useMemo(
    () =>
      orderedTables.some((t) => {
        const st = dataByTable[t.tableKey];
        return st && st.enabled && (st.rows.length > 0 || st.useLocalBridge);
      }),
    [orderedTables, dataByTable],
  );

  const runBatchImport = async () => {
    if (running) return;
    setRunning(true);
    setPaused(false);
    pauseRef.current = false;
    cancelRef.current = false;

    const pkMaps = new Map<string, Map<string, string>>();
    // Collect deferred Pass-2 cyclic/self links: tableKey -> Array<{ responseId, deferredLinks }>
    const pendingPass2 = new Map<string, Array<{ responseId: string; deferredLinks: Record<string, string> }>>();

    // Reset progress states
    const initProgress: Record<string, TableRunProgress> = {};
    for (const t of orderedTables) {
      const st = dataByTable[t.tableKey];
      const mapInfo = mappings.find((m) => m.tableKey === t.tableKey);
      const rawTotal = st?.rows.length || mapInfo?.totalRowCount || 0;
      const cap = effectiveCapForTable(t.tableKey);
      initProgress[t.tableKey] = {
        status: 'idle',
        processed: 0,
        total: st?.enabled ? (cap ? Math.min(rawTotal, cap) : rawTotal) : 0,
        created: 0,
        failed: 0,
        linksPatched: 0,
        errors: [],
      };
    }
    setProgressByTable(initProgress);

    let grandCreated = 0;
    let grandFailed = 0;

    try {
      for (const table of orderedTables) {
        if (cancelRef.current) break;
        const st = dataByTable[table.tableKey];
        if (!st || !st.enabled || (st.rows.length === 0 && !st.useLocalBridge)) continue;
        const rowCap = effectiveCapForTable(table.tableKey);

        const deferredFieldIds = cyclicByTable.get(table.tableKey) ?? new Set<string>();
        const deferList = Array.from(deferredFieldIds);
        const pkMap = new Map<string, string>();
        pkMaps.set(table.tableKey, pkMap);
        const pass2Items: Array<{ responseId: string; deferredLinks: Record<string, string> }> = [];
        pendingPass2.set(table.tableKey, pass2Items);

        const setProg = (updater: (p: TableRunProgress) => TableRunProgress) => {
          setProgressByTable((prev) => ({
            ...prev,
            [table.tableKey]: updater(prev[table.tableKey]),
          }));
        };

        setProg((p) => ({ ...p, status: 'running' }));

        const processChunk = async (
          chunkRows: Array<Record<string, unknown>>,
          baseOffset: number,
        ): Promise<boolean> => {
          await waitWhilePaused();
          if (cancelRef.current) return false;

          const prepared = chunkRows.map((raw) =>
            prepareBatchImportRow(
              raw,
              table,
              st.columnToFieldId,
              st.pkColumn,
              pkMaps,
              deferredFieldIds,
            ),
          );

          const payloadRows: BatchImportRowInput[] = prepared.map((p) => ({
            ...(p.clientKey !== undefined ? { clientKey: p.clientKey } : {}),
            answers: p.answers,
          }));

          const res = await api.batchImportResponses(table.formId, payloadRows, {
            deferLinkFields: deferList,
          });

          if (res.error || !res.data) {
            const msg = typeof res.error === 'string' ? res.error : 'Batch request failed';
            grandFailed += chunkRows.length;
            setProg((p) => ({
              ...p,
              processed: p.processed + chunkRows.length,
              failed: p.failed + chunkRows.length,
              errors: [...p.errors.slice(0, 99), { row: baseOffset + 1, message: msg }],
            }));
            return true;
          }

          const batchData = res.data;
          grandCreated += batchData.created;
          grandFailed += batchData.failed;

          const newErrors: Array<{ row: number; message: string }> = [];
          for (const item of batchData.results) {
            if (item.responseId) {
              const pItem = prepared[item.index];
              if (pItem?.clientKey) {
                pkMap.set(pItem.clientKey, item.responseId);
              }
              if (pItem && Object.keys(pItem.deferredLinks).length > 0) {
                pass2Items.push({ responseId: item.responseId, deferredLinks: pItem.deferredLinks });
              }
            } else if (item.error) {
              newErrors.push({ row: baseOffset + item.index + 1, message: item.error });
            }
          }

          setProg((p) => ({
            ...p,
            processed: p.processed + chunkRows.length,
            total: Math.max(p.total, p.processed + chunkRows.length),
            created: p.created + batchData.created,
            failed: p.failed + batchData.failed,
            errors: [...p.errors, ...newErrors].slice(0, 100),
          }));

          return true;
        };

        if (st.useLocalBridge && schema.localBridge) {
          // Stream batches directly from the user's 127.0.0.1 loopback bridge!
          const mapSchemaTbl = schema.tables.find((t) => t.key === table.tableKey);
          let offset = 0;
          let hasMore = true;
          while (hasMore && !cancelRef.current) {
            if (rowCap !== null && offset >= rowCap) break;
            await waitWhilePaused();
            if (cancelRef.current) break;
            const remaining = rowCap !== null ? Math.min(batchSize, rowCap - offset) : batchSize;
            try {
              const batch = await fetchLocalTableBatch(
                schema.localBridge,
                table.sourceName,
                mapSchemaTbl?.schemaName,
                offset,
                remaining,
                st.pkColumn,
              );
              if (batch.rows.length === 0) break;
              await processChunk(batch.rows, offset);
              offset += batch.rows.length;
              hasMore = batch.hasMore;
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Local bridge read error';
              setProg((p) => ({
                ...p,
                status: 'error',
                errors: [...p.errors, { row: offset + 1, message: msg }].slice(0, 100),
              }));
              break;
            }
          }
        } else {
          // Chunk in-memory rows into batches of `batchSize`.
          const sourceRows = rowCap !== null ? st.rows.slice(0, rowCap) : st.rows;
          for (let offset = 0; offset < sourceRows.length; offset += batchSize) {
            const ok = await processChunk(sourceRows.slice(offset, offset + batchSize), offset);
            if (!ok) break;
          }
        }

        setProg((p) => ({
          ...p,
          status: cancelRef.current ? 'cancelled' : p.status === 'error' ? 'error' : 'done',
        }));
      }

      // Pass 2: resolve self-referencing and circular foreign keys now that all PK maps are populated!
      if (!cancelRef.current) {
        for (const table of orderedTables) {
          const items = pendingPass2.get(table.tableKey) ?? [];
          if (items.length === 0) continue;

          const updates: Array<{ responseId: string; links: Record<string, string | string[] | null> }> = [];
          for (const item of items) {
            const links: Record<string, string | string[] | null> = {};
            for (const [fieldId, legacyKey] of Object.entries(item.deferredLinks)) {
              const targetInfo = table.linkedFieldTargets[fieldId];
              if (!targetInfo) continue;
              const targetId = pkMaps.get(targetInfo.targetTableKey)?.get(legacyKey);
              if (targetId) {
                links[fieldId] = targetInfo.allowMultiple ? [targetId] : targetId;
              }
            }
            if (Object.keys(links).length > 0) {
              updates.push({ responseId: item.responseId, links });
            }
          }

          if (updates.length === 0) continue;

          setProgressByTable((prev) => ({
            ...prev,
            [table.tableKey]: { ...prev[table.tableKey], status: 'linking' },
          }));

          let patched = 0;
          for (let i = 0; i < updates.length; i += batchSize) {
            if (cancelRef.current) break;
            const res = await api.batchPatchResponseLinks(table.formId, updates.slice(i, i + batchSize));
            if (res.data) patched += res.data.updated;
          }

          setProgressByTable((prev) => ({
            ...prev,
            [table.tableKey]: {
              ...prev[table.tableKey],
              status: 'done',
              linksPatched: patched,
            },
          }));
        }
      }

      if (cancelRef.current) {
        toast.info('Batch import stopped', `${grandCreated.toLocaleString()} rows were imported before cancellation.`);
      } else if (grandFailed > 0) {
        toast.warning(
          `Imported ${grandCreated.toLocaleString()} rows (${grandFailed.toLocaleString()} failed)`,
          'Expand any table below to inspect skipped row errors.',
        );
      } else {
        toast.success(
          `Imported ${grandCreated.toLocaleString()} ${grandCreated === 1 ? 'row' : 'rows'}`,
          'All linked-record relationships are wired and ready in FormLogic!',
        );
      }
    } finally {
      setRunning(false);
      setPaused(false);
      pauseRef.current = false;
    }
  };

  const overall = useMemo(() => {
    let created = 0;
    let failed = 0;
    let processed = 0;
    let total = 0;
    for (const p of Object.values(progressByTable)) {
      created += p.created;
      failed += p.failed;
      processed += p.processed;
      total += p.total;
    }
    return { created, failed, processed, total };
  }, [progressByTable]);

  return (
    <div className="space-y-5">
      {/* Created destination banner */}
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/75 p-4 sm:p-5 dark:border-emerald-500/25 dark:bg-emerald-500/10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-emerald-950 dark:text-emerald-100">
                {materialized.appName
                  ? `"${materialized.appName}" is ready with ${materialized.tables.length} CRUD ${materialized.tables.length === 1 ? 'form' : 'forms'}`
                  : `${materialized.tables.length} CRUD ${materialized.tables.length === 1 ? 'form' : 'forms'} created`}
              </h2>
              <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-300">
                You can open your forms right now, or bring your existing rows in batches below — foreign keys are remapped into FormLogic linked records automatically.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {materialized.appSlug && (
              <Button
                size="sm"
                onClick={() => window.open(`/app/${materialized.appSlug}`, '_blank', 'noopener,noreferrer')}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                Open live app
              </Button>
            )}
            {materialized.appId && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/apps/${materialized.appId}/studio`)}
              >
                Open App Studio
              </Button>
            )}
            <Link
              to="/forms"
              className="inline-flex h-9 items-center rounded-lg border border-emerald-300 bg-white px-3 text-xs font-semibold text-emerald-900 hover:bg-emerald-50 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-emerald-200 dark:hover:bg-slate-800"
            >
              View Forms
            </Link>
          </div>
        </div>
      </div>

      {/* Multi-file auto-match dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files?.length) void handleBulkDropFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-dashed px-4 py-3.5 transition-colors',
          dragActive
            ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
            : 'border-gray-300 bg-white dark:border-slate-700 dark:bg-slate-900/50',
        )}
      >
        <input
          ref={multiDropInputRef}
          type="file"
          multiple
          accept=".csv,.tsv,.json,.ndjson,.jsonl,.sql,.zip"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void handleBulkDropFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
        <div className="flex items-center gap-3 min-w-0">
          <Upload className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-900 dark:text-white">
              Bring your data — drop CSV, TSV, JSON, NDJSON, SQL dump, or a ZIP of table exports
            </p>
            <p className="text-[11px] text-gray-500 dark:text-slate-400">
              Files named after your tables (e.g. <code className="font-mono">customers.csv</code>, <code className="font-mono">orders.json</code>) attach automatically.
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={running}
          onClick={() => multiDropInputRef.current?.click()}
          leftIcon={<FileUp className="h-4 w-4" />}
        >
          Add data files
        </Button>
      </div>

      {/* Batch controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="batch-size-select" className="text-xs font-semibold text-gray-700 dark:text-slate-300">
              Batch size
            </label>
            <select
              id="batch-size-select"
              value={batchSize}
              disabled={running}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value={100}>100 rows / batch</option>
              <option value={250}>250 rows / batch</option>
              <option value={500}>500 rows / batch</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="row-cap-select" className="text-xs font-semibold text-gray-700 dark:text-slate-300">
              Row limit
            </label>
            <select
              id="row-cap-select"
              value={largeTableRowCap}
              disabled={running}
              onChange={(e) => setLargeTableRowCap(Number(e.target.value))}
              title="Referenced lookup/parent tables always import 100% so foreign-key select boxes stay complete."
              className="cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value={0}>All rows</option>
              <option value={250}>Up to 250 / large table (all parents)</option>
              <option value={1000}>Up to 1,000 / large table (all parents)</option>
              <option value={5000}>Up to 5,000 / large table (all parents)</option>
            </select>
          </div>
          <span className="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
            {totalReadyRows > 0
              ? `${totalReadyRows.toLocaleString()} rows queued across ${orderedTables.length} tables`
              : hasAnyDataSource
                ? 'Ready to stream batches from local bridge'
                : 'Attach CSV/JSON/SQL data below to import rows'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!running ? (
            <Button
              onClick={() => void runBatchImport()}
              disabled={!hasAnyDataSource}
              leftIcon={<Play className="h-4 w-4" />}
            >
              Start batch import
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = !paused;
                  pauseRef.current = next;
                  setPaused(next);
                }}
                leftIcon={paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  cancelRef.current = true;
                  pauseRef.current = false;
                  setPaused(false);
                }}
                leftIcon={<Square className="h-4 w-4" />}
              >
                Stop
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Overall progress bar when active or finished */}
      {(running || overall.processed > 0) && (() => {
        const anyCancelled = Object.values(progressByTable).some((p) => p.status === 'cancelled');
        const denom = Math.max(1, overall.total, overall.processed);
        const pct = !running && !anyCancelled && overall.processed >= overall.total && overall.processed > 0
          ? 100
          : Math.min(100, Math.round((overall.processed / denom) * 100));
        return (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-gray-900 dark:text-white">
                {running ? (paused ? 'Import paused' : 'Importing batches…') : anyCancelled ? 'Import stopped' : 'Import complete'}
              </span>
              <span className="tabular-nums text-gray-600 dark:text-slate-300">
                {overall.created.toLocaleString()} created · {overall.failed.toLocaleString()} failed · {overall.processed.toLocaleString()} / {Math.max(overall.total, overall.processed).toLocaleString()} processed
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-150',
                  overall.failed > 0 ? 'bg-amber-500' : 'bg-emerald-500',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })()}

      {/* Per-table queue in topological order */}
      <div className="space-y-3">
        {orderedTables.map((table, idx) => {
          const st = dataByTable[table.tableKey];
          const prog = progressByTable[table.tableKey];
          const isOpen = expandedTable === table.tableKey;
          const cyclicCount = cyclicByTable.get(table.tableKey)?.size ?? 0;

          return (
            <div
              key={table.tableKey}
              className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={Boolean(st?.enabled)}
                    disabled={running || (!st?.rows.length && !st?.useLocalBridge)}
                    aria-label={`Import data for ${table.formTitle}`}
                    onChange={(e) =>
                      updateTableData(table.tableKey, (prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-xs font-bold text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
                    {idx + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('text-sm font-semibold', st?.enabled ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400')}>
                        {table.formTitle}
                      </span>
                      <span className="font-mono text-[11px] text-gray-500 dark:text-slate-400">({table.sourceName})</span>
                      {referencedParentKeys.has(table.tableKey) && (
                        <Badge variant="default" size="sm">Lookup parent</Badge>
                      )}
                      {Object.keys(table.linkedFieldTargets).length > 0 && (
                        <Badge variant="primary" size="sm">
                          {Object.keys(table.linkedFieldTargets).length} FK {Object.keys(table.linkedFieldTargets).length === 1 ? 'select' : 'selects'}
                        </Badge>
                      )}
                      {cyclicCount > 0 && (
                        <Badge variant="info" size="sm">
                          <RefreshCw className="mr-1 inline h-3 w-3" aria-hidden="true" />
                          Pass-2 link
                        </Badge>
                      )}
                      {st?.useLocalBridge && (
                        <Badge variant="primary" size="sm">
                          <Laptop className="mr-1 inline h-3 w-3" aria-hidden="true" />
                          Local bridge
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
                      {st?.sourceLabel || 'No data file attached yet — schema only'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {prog && prog.status !== 'idle' && (
                    <Badge
                      variant={
                        prog.status === 'done'
                          ? prog.failed > 0
                            ? 'warning'
                            : 'success'
                          : prog.status === 'error'
                            ? 'error'
                            : 'primary'
                      }
                      size="sm"
                    >
                      {prog.status === 'running'
                        ? `${prog.processed.toLocaleString()} / ${Math.max(prog.total, prog.processed).toLocaleString()}`
                        : prog.status === 'linking'
                          ? 'Wiring links…'
                          : `${prog.created.toLocaleString()} imported${prog.failed > 0 ? ` · ${prog.failed} failed` : ''}${prog.linksPatched > 0 ? ` · ${prog.linksPatched} ${prog.linksPatched === 1 ? 'link' : 'links'} wired` : ''}`}
                    </Badge>
                  )}

                  <label className={cn(
                    'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
                    running && 'pointer-events-none opacity-50',
                  )}>
                    <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Upload file</span>
                    <input
                      type="file"
                      accept=".csv,.tsv,.json,.ndjson,.jsonl,.sql"
                      disabled={running}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void loadFilesForTable(table, file);
                        e.target.value = '';
                      }}
                    />
                  </label>

                  {st && (st.rows.length > 0 || st.useLocalBridge) && !running && (
                    <button
                      type="button"
                      onClick={() =>
                        updateTableData(table.tableKey, (prev) => ({
                          ...prev,
                          enabled: false,
                          sourceLabel: null,
                          rows: [],
                          useLocalBridge: false,
                        }))
                      }
                      aria-label={`Clear data for ${table.formTitle}`}
                      title="Clear attached data"
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setExpandedTable(isOpen ? null : table.tableKey)}
                    aria-expanded={isOpen}
                    aria-label={`Inspect mapping for ${table.formTitle}`}
                    className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <span>Mapping</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Progress line per table */}
              {prog && prog.processed > 0 && (
                <div className="h-1 w-full bg-gray-100 dark:bg-slate-800">
                  <div
                    className={cn(
                      'h-full transition-all duration-200',
                      prog.failed > 0 ? 'bg-amber-500' : 'bg-emerald-500',
                    )}
                    style={{
                      width: `${Math.min(100, Math.round((prog.processed / Math.max(1, prog.total, prog.processed)) * 100))}%`,
                    }}
                  />
                </div>
              )}

              {/* Expanded mapping + sample rows + errors */}
              {isOpen && st && (
                <div className="space-y-4 border-t border-gray-200/80 bg-gray-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                        Source PK column (used to link child records)
                      </label>
                      <select
                        value={st.pkColumn ?? ''}
                        disabled={running}
                        onChange={(e) =>
                          updateTableData(table.tableKey, (prev) => ({
                            ...prev,
                            pkColumn: e.target.value || null,
                          }))
                        }
                        className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs text-gray-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      >
                        <option value="">None</option>
                        {st.headers.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-wrap items-end justify-end gap-3">
                      {materialized.appSlug ? (
                        <a
                          href={`/app/${materialized.appSlug}/form/${table.formId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          Open CRUD form
                        </a>
                      ) : (
                        <Link
                          to={`/form/${table.formId}`}
                          className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          Open form
                        </Link>
                      )}
                      <Link
                        to={`/responses/${table.formId}`}
                        className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold text-primary-600 hover:underline dark:text-primary-400"
                      >
                        <Database className="h-3.5 w-3.5" aria-hidden="true" />
                        Open records table
                      </Link>
                    </div>
                  </div>

                  {/* Column mapping grid */}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {st.headers.map((col) => (
                      <div key={col} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 dark:border-slate-700/80 dark:bg-slate-900">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700 dark:text-slate-300" title={col}>
                          {col}
                        </span>
                        <select
                          aria-label={`Map ${col} to form field`}
                          value={st.columnToFieldId[col] ?? '__skip__'}
                          disabled={running}
                          onChange={(e) =>
                            updateTableData(table.tableKey, (prev) => ({
                              ...prev,
                              columnToFieldId: { ...prev.columnToFieldId, [col]: e.target.value },
                            }))
                          }
                          className="max-w-[140px] cursor-pointer rounded border border-gray-200 bg-gray-50 px-1.5 py-1 text-[11px] text-gray-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                        >
                          <option value="__skip__">Skip column</option>
                          {table.fields
                            .filter((f) => f.include)
                            .map((f) => (
                              <option key={f.fieldId} value={f.fieldId}>
                                {f.label}{f.fieldType === 'linked_record' ? ' (FK)' : ''}
                              </option>
                            ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {/* Sample preview rows */}
                  {st.rows.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                      <table className="w-full text-left text-[11px]">
                        <thead>
                          <tr className="border-b border-gray-200 bg-gray-50 text-gray-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
                            {st.headers.slice(0, 6).map((h) => (
                              <th key={h} className="px-2.5 py-1.5 font-mono font-semibold">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {st.rows.slice(0, 3).map((r, rIdx) => (
                            <tr key={rIdx}>
                              {st.headers.slice(0, 6).map((h) => (
                                <td key={h} className="max-w-[180px] truncate px-2.5 py-1.5 text-gray-700 dark:text-slate-300">
                                  {r[h] === null || r[h] === undefined ? <span className="italic text-gray-400">null</span> : String(r[h])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Per-row errors if any */}
                  {prog && prog.errors.length > 0 && (
                    <div className="rounded-lg border border-red-200 bg-red-50/70 p-3 dark:border-red-500/30 dark:bg-red-500/10">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-red-800 dark:text-red-300">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Row errors ({prog.errors.length}{prog.errors.length >= 100 ? '+' : ''})
                      </p>
                      <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-[11px] text-red-700 dark:text-red-300">
                        {prog.errors.map((e, i) => (
                          <li key={i}>
                            <strong>Row {e.row}:</strong> {e.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          onClick={onStartOver}
          leftIcon={<RotateCcw className="h-4 w-4" />}
        >
          Import another database
        </Button>
        {materialized.appId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/apps/${materialized.appId}/studio`)}
          >
            Finish &amp; open App Studio
          </Button>
        )}
      </div>
    </div>
  );
}
