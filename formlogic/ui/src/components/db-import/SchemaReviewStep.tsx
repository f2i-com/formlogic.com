import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Database,
  GitFork,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { cn } from '../../lib/utils';
import { expandRelatedTableKeys, topologicalSortTables } from '../../lib/db-import/mapper';
import type { FieldType } from '../../types/form';
import type { FieldMapping, ImportedSchema, TableMapping } from '../../lib/db-import/types';

const FIELD_TYPE_CHOICES: Array<{ value: FieldType; label: string }> = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'url', label: 'URL' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'multiple_choice', label: 'Multiple choice' },
  { value: 'checkboxes', label: 'Checkbox (Yes/No)' },
  { value: 'rating', label: 'Rating' },
  { value: 'scale', label: 'Scale' },
  { value: 'linked_record', label: 'Related form (Select box)' },
];

export function SchemaReviewStep({
  schema,
  tables,
  onChangeTables,
  onBack,
  onContinue,
}: {
  schema: ImportedSchema;
  tables: TableMapping[];
  onChangeTables: (next: TableMapping[]) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>(
    () => tables.find((t) => t.include)?.tableKey ?? tables[0]?.tableKey ?? '',
  );
  const [tableFilter, setTableFilter] = useState('');
  const [showRelationsList, setShowRelationsList] = useState(true);

  const tableByKey = useMemo(() => new Map(tables.map((t) => [t.tableKey, t])), [tables]);

  const activeTable = useMemo(
    () => tableByKey.get(selectedKey) ?? tables[0] ?? null,
    [tableByKey, selectedKey, tables],
  );

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        t.sourceName.toLowerCase().includes(q) ||
        t.formTitle.toLowerCase().includes(q),
    );
  }, [tables, tableFilter]);

  const includedTables = useMemo(() => tables.filter((t) => t.include), [tables]);
  const includedKeySet = useMemo(() => new Set(includedTables.map((t) => t.tableKey)), [includedTables]);

  const { order: importOrder, cyclicLinks } = useMemo(
    () => topologicalSortTables(tables),
    [tables],
  );

  const activeRelations = useMemo(() => {
    const list: Array<{
      sourceTable: TableMapping;
      field: FieldMapping;
      targetTable: TableMapping;
      targetDisplayPreview: string;
    }> = [];
    for (const t of includedTables) {
      for (const f of t.fields) {
        if (!f.include || f.fieldType !== 'linked_record' || !f.targetTableKey) continue;
        const target = tableByKey.get(f.targetTableKey);
        if (!target || !target.include) continue;
        const displayLabels = target.displayFieldIds
          .map((fid) => target.fields.find((tf) => tf.fieldId === fid)?.label)
          .filter((x): x is string => Boolean(x));
        list.push({
          sourceTable: t,
          field: f,
          targetTable: target,
          targetDisplayPreview: displayLabels.length > 0 ? displayLabels.join(' - ') : 'Record',
        });
      }
    }
    return list;
  }, [includedTables, tableByKey]);

  const brokenFkCount = useMemo(() => {
    let count = 0;
    for (const t of includedTables) {
      for (const f of t.fields) {
        if (f.include && f.fieldType === 'linked_record' && f.targetTableKey && !includedKeySet.has(f.targetTableKey)) {
          count++;
        }
      }
    }
    return count;
  }, [includedTables, includedKeySet]);

  const stats = useMemo(() => {
    let fieldCount = 0;
    let explicitFkCount = 0;
    let inferredFkCount = 0;
    let preloadedRows = 0;
    for (const t of includedTables) {
      for (const f of t.fields) {
        if (!f.include) continue;
        fieldCount++;
        if (f.fieldType === 'linked_record' && f.targetTableKey && includedKeySet.has(f.targetTableKey)) {
          if (f.fkSource === 'inferred') inferredFkCount++;
          else explicitFkCount++;
        }
      }
      preloadedRows += t.totalRowCount ?? t.initialRows.length;
    }
    return {
      fieldCount,
      relationCount: explicitFkCount + inferredFkCount,
      explicitFkCount,
      inferredFkCount,
      preloadedRows,
    };
  }, [includedTables, includedKeySet]);

  const updateTable = (tableKey: string, updater: (t: TableMapping) => TableMapping) => {
    onChangeTables(tables.map((t) => (t.tableKey === tableKey ? updater(t) : t)));
  };

  const updateField = (
    tableKey: string,
    sourceColumn: string,
    patch: Partial<FieldMapping>,
  ) => {
    updateTable(tableKey, (t) => ({
      ...t,
      fields: t.fields.map((f) =>
        f.sourceColumn === sourceColumn ? { ...f, ...patch } : f,
      ),
    }));
  };

  const toggleAllTables = (include: boolean) => {
    onChangeTables(tables.map((t) => ({ ...t, include: include ? !t.isSystemTable : false })));
  };

  const selectTablesWithData = () => {
    const seeds = new Set(
      tables
        .filter((t) => !t.isSystemTable && (t.totalRowCount ?? t.initialRows.length) > 0)
        .map((t) => t.tableKey),
    );
    const expanded = expandRelatedTableKeys(tables, seeds, 50);
    onChangeTables(tables.map((t) => ({ ...t, include: expanded.has(t.tableKey) })));
  };

  const includeRelatedTargets = () => {
    const expanded = expandRelatedTableKeys(tables, includedKeySet, 50);
    onChangeTables(tables.map((t) => ({ ...t, include: expanded.has(t.tableKey) })));
  };

  const includeSingleTable = (tableKey: string) => {
    onChangeTables(tables.map((t) => (t.tableKey === tableKey ? { ...t, include: true } : t)));
  };

  const selectableTargetTables = useMemo(
    () => [...tables].filter((t) => !t.isSystemTable).sort((a, b) => Number(b.include) - Number(a.include) || a.formTitle.localeCompare(b.formTitle)),
    [tables],
  );

  const activeDisplayCandidates = useMemo(
    () => (activeTable ? activeTable.fields.filter((f) => f.include && f.fieldType !== 'linked_record') : []),
    [activeTable],
  );

  const primaryDisplayId = activeTable?.displayFieldIds[0] ?? '';
  const secondaryDisplayId = activeTable?.displayFieldIds[1] ?? '';

  return (
    <div className="space-y-4">
      {/* Top summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200/90 bg-white px-4 py-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="primary" size="sm" className="uppercase">{schema.dialect}</Badge>
          <span className="font-semibold text-gray-900 dark:text-white">{schema.sourceLabel}</span>
          <span className="text-gray-400 dark:text-slate-600">·</span>
          <span className="text-gray-600 dark:text-slate-300 tabular-nums">
            {includedTables.length}/{tables.length} {tables.length === 1 ? 'table' : 'tables'}
          </span>
          <span className="text-gray-400 dark:text-slate-600">·</span>
          <span className="text-gray-600 dark:text-slate-300 tabular-nums">
            {stats.fieldCount} {stats.fieldCount === 1 ? 'field' : 'fields'}
          </span>
          <span className="text-gray-400 dark:text-slate-600">·</span>
          <Badge variant="info" size="sm">
            <Link2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {stats.relationCount} related select {stats.relationCount === 1 ? 'box' : 'boxes'}
          </Badge>
          {stats.preloadedRows > 0 && (
            <>
              <span className="text-gray-400 dark:text-slate-600">·</span>
              <Badge variant="success" size="sm">
                {stats.preloadedRows.toLocaleString()} rows ready
              </Badge>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onBack}>
            Change source
          </Button>
          <Button
            size="sm"
            disabled={includedTables.length === 0 || includedTables.length > 50}
            onClick={onContinue}
            rightIcon={<ArrowRight className="h-4 w-4" />}
          >
            Continue to create forms
          </Button>
        </div>
      </div>

      {includedTables.length > 50 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Select up to 50 tables per import ({includedTables.length} selected). Deselect extra tables or use &ldquo;With data&rdquo; on the left.</span>
          </span>
          <Button variant="secondary" size="sm" onClick={selectTablesWithData}>
            Auto-pick tables with data
          </Button>
        </div>
      )}

      {brokenFkCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200/90 bg-amber-50/80 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="flex items-center gap-2">
            <GitFork className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>
              <strong>{brokenFkCount}</strong> foreign-key {brokenFkCount === 1 ? 'field points' : 'fields point'} to an excluded parent table (they will become plain text unless the parent table is included).
            </span>
          </span>
          <Button variant="secondary" size="sm" onClick={includeRelatedTargets} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Include related parent tables
          </Button>
        </div>
      )}

      {schema.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-semibold">Parser notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {schema.warnings.slice(0, 5).map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Main 2-column mapping workbench */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        {/* Left: table selector */}
        <section className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="border-b border-gray-200/80 p-3 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                Tables <span className="font-normal text-gray-500 dark:text-slate-400">({includedTables.length}/{tables.length})</span>
              </h2>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => toggleAllTables(true)}
                className="cursor-pointer rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-medium text-gray-700 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => toggleAllTables(false)}
                className="cursor-pointer rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-medium text-gray-700 hover:border-gray-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                None
              </button>
              {tables.some((t) => (t.totalRowCount ?? t.initialRows.length) > 0) && (
                <button
                  type="button"
                  onClick={selectTablesWithData}
                  title="Select populated tables plus their referenced parent tables"
                  className="cursor-pointer rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
                >
                  With data
                </button>
              )}
              <button
                type="button"
                onClick={includeRelatedTargets}
                title="Automatically include all parent tables referenced by selected tables"
                className="cursor-pointer rounded-md border border-primary-200 bg-primary-50 px-2 py-1 font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/15 dark:text-primary-300"
              >
                + Related
              </button>
            </div>
            {tables.length > 6 && (
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
                <input
                  type="search"
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="Filter tables…"
                  aria-label="Filter tables"
                  className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-8 pr-2.5 text-xs text-gray-900 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
            )}
          </div>

          <div className="scrollbar-thin max-h-[560px] divide-y divide-gray-100 overflow-y-auto dark:divide-slate-800/80">
            {filteredTables.map((t) => {
              const isSelected = activeTable?.tableKey === t.tableKey;
              const activeFields = t.fields.filter((f) => f.include).length;
              const fkCount = t.fields.filter((f) => f.include && f.fieldType === 'linked_record' && f.targetTableKey).length;
              const rowCount = t.totalRowCount ?? t.initialRows.length;
              return (
                <div
                  key={t.tableKey}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2.5 transition-colors',
                    isSelected
                      ? 'bg-primary-50/90 dark:bg-primary-500/15'
                      : 'hover:bg-gray-50 dark:hover:bg-slate-800/50',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={t.include}
                    aria-label={`Include table ${t.sourceName}`}
                    onChange={(e) =>
                      updateTable(t.tableKey, (prev) => ({ ...prev, include: e.target.checked }))
                    }
                    className="h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedKey(t.tableKey)}
                    className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-primary-500 rounded"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={cn(
                        'truncate text-xs font-semibold',
                        t.include ? 'text-gray-900 dark:text-white' : 'text-gray-400 line-through dark:text-slate-500',
                      )}>
                        {t.formTitle}
                      </span>
                      {t.isSystemTable && (
                        <span className="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-gray-500 dark:bg-slate-800 dark:text-slate-400">
                          sys
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
                      <span className="truncate font-mono">{t.sourceName}</span>
                      <span>· {activeFields}f</span>
                      {fkCount > 0 && <span className="font-medium text-primary-600 dark:text-primary-400">· {fkCount} FK</span>}
                      {rowCount > 0 && (
                        <span className="text-emerald-700 dark:text-emerald-400">· {rowCount.toLocaleString()} rows</span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right: field mapping editor for selected table */}
        {activeTable ? (
          <section className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="border-b border-gray-200/80 p-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Table2 className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                    {activeTable.schemaName ? `${activeTable.schemaName}.${activeTable.sourceName}` : activeTable.sourceName}
                  </h2>
                  {!activeTable.include && <Badge variant="default" size="sm">Excluded</Badge>}
                </div>
                <span className="text-xs text-gray-500 dark:text-slate-400">
                  {activeTable.fields.filter((f) => f.include).length} of {activeTable.fields.length} columns mapped
                </span>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <label htmlFor="map-form-title" className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-400">
                    Form title
                  </label>
                  <Input
                    id="map-form-title"
                    value={activeTable.formTitle}
                    onChange={(e) =>
                      updateTable(activeTable.tableKey, (t) => ({ ...t, formTitle: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label htmlFor="map-pk-col" className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-400">
                    Legacy primary key (for FK links)
                  </label>
                  <select
                    id="map-pk-col"
                    value={activeTable.primaryKeyColumn ?? ''}
                    onChange={(e) =>
                      updateTable(activeTable.tableKey, (t) => ({
                        ...t,
                        primaryKeyColumn: e.target.value || null,
                      }))
                    }
                    className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    <option value="">None detected</option>
                    {activeTable.fields.map((f) => (
                      <option key={f.sourceColumn} value={f.sourceColumn}>{f.sourceColumn}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="map-display-col" className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-400">
                    Select-box label (primary)
                  </label>
                  <select
                    id="map-display-col"
                    value={primaryDisplayId}
                    onChange={(e) => {
                      const nextPrimary = e.target.value;
                      const nextList = [nextPrimary, secondaryDisplayId].filter(
                        (x, i, arr) => Boolean(x) && arr.indexOf(x) === i,
                      );
                      updateTable(activeTable.tableKey, (t) => ({
                        ...t,
                        displayFieldIds: nextList,
                      }));
                    }}
                    className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    {activeDisplayCandidates.map((f) => (
                      <option key={f.fieldId} value={f.fieldId}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="map-display-col-2" className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-400">
                    Second label <span className="font-normal text-gray-400">(optional)</span>
                  </label>
                  <select
                    id="map-display-col-2"
                    value={secondaryDisplayId}
                    onChange={(e) => {
                      const nextSecondary = e.target.value;
                      const nextList = [primaryDisplayId, nextSecondary].filter(
                        (x, i, arr) => Boolean(x) && arr.indexOf(x) === i,
                      );
                      updateTable(activeTable.tableKey, (t) => ({
                        ...t,
                        displayFieldIds: nextList,
                      }));
                    }}
                    className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    <option value="">None</option>
                    {activeDisplayCandidates
                      .filter((f) => f.fieldId !== primaryDisplayId)
                      .map((f) => (
                        <option key={f.fieldId} value={f.fieldId}>{f.label}</option>
                      ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                    <th className="w-9 px-2 py-2.5 text-center">Use</th>
                    <th className="px-2.5 py-2.5">Source column</th>
                    <th className="px-2.5 py-2.5">Form label</th>
                    <th className="w-52 px-2.5 py-2.5">Control &amp; relation</th>
                    <th className="w-16 px-2 py-2.5 text-center">Req</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-800/80">
                  {activeTable.fields.map((f) => {
                    const targetTable = f.targetTableKey ? tableByKey.get(f.targetTableKey) : undefined;
                    const isTargetExcluded = f.fieldType === 'linked_record' && Boolean(targetTable && !targetTable.include);
                    return (
                      <tr
                        key={f.sourceColumn}
                        className={cn(
                          'transition-colors',
                          !f.include && 'opacity-50',
                          f.include && f.fieldType === 'linked_record' && 'bg-primary-50/25 dark:bg-primary-500/[0.04]',
                          'hover:bg-gray-50/70 dark:hover:bg-slate-800/40',
                        )}
                      >
                        <td className="px-2 py-2.5 text-center align-top">
                          <input
                            type="checkbox"
                            checked={f.include}
                            aria-label={`Include column ${f.sourceColumn}`}
                            onChange={(e) =>
                              updateField(activeTable.tableKey, f.sourceColumn, {
                                include: e.target.checked,
                              })
                            }
                            className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          />
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-medium text-gray-900 dark:text-slate-100">
                              {f.sourceColumn}
                            </span>
                            {f.isPrimaryKey && (
                              <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                                <KeyRound className="h-2.5 w-2.5" aria-hidden="true" /> PK
                              </span>
                            )}
                            {f.fieldType === 'linked_record' && targetTable && (
                              <span
                                className={cn(
                                  'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                                  f.fkSource === 'inferred'
                                    ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300'
                                    : f.fkSource === 'manual'
                                      ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300'
                                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
                                )}
                                title={
                                  f.fkSource === 'inferred'
                                    ? 'Auto-matched foreign key by column name & PK type'
                                    : f.fkSource === 'manual'
                                      ? 'Custom related-form select box'
                                      : 'Explicit SQL FOREIGN KEY constraint'
                                }
                              >
                                {f.fkSource === 'inferred' ? (
                                  <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                                ) : (
                                  <Link2 className="h-2.5 w-2.5" aria-hidden="true" />
                                )}
                                {f.fkSource === 'inferred' ? 'Auto FK' : f.fkSource === 'manual' ? 'Linked' : 'SQL FK'}
                              </span>
                            )}
                          </div>
                          <span className="mt-0.5 block font-mono text-[10px] text-gray-500 dark:text-slate-400">
                            {f.rawType}
                            {f.options && f.options.length > 0 && f.fieldType === 'dropdown'
                              ? ` · [${f.options.slice(0, 4).map((o) => o.label).join(', ')}${f.options.length > 4 ? '…' : ''}]`
                              : ''}
                          </span>
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <input
                            type="text"
                            value={f.label}
                            disabled={!f.include}
                            aria-label={`Label for ${f.sourceColumn}`}
                            onChange={(e) =>
                              updateField(activeTable.tableKey, f.sourceColumn, { label: e.target.value })
                            }
                            className="h-8 w-full min-w-[110px] rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                          />
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <div className="space-y-1.5">
                            <select
                              value={f.fieldType}
                              disabled={!f.include}
                              aria-label={`Field type for ${f.sourceColumn}`}
                              onChange={(e) => {
                                const nextType = e.target.value as FieldType;
                                if (nextType === 'linked_record') {
                                  const fallbackTarget =
                                    f.targetTableKey ||
                                    selectableTargetTables.find((t) => t.tableKey !== activeTable.tableKey)?.tableKey ||
                                    activeTable.tableKey;
                                  const targetTbl = tableByKey.get(fallbackTarget);
                                  updateField(activeTable.tableKey, f.sourceColumn, {
                                    fieldType: nextType,
                                    targetTableKey: fallbackTarget,
                                    targetColumn: f.targetColumn ?? targetTbl?.primaryKeyColumn ?? 'id',
                                    fkSource: f.fkSource ?? 'manual',
                                  });
                                } else {
                                  updateField(activeTable.tableKey, f.sourceColumn, {
                                    fieldType: nextType,
                                  });
                                }
                              }}
                              className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                            >
                              {FIELD_TYPE_CHOICES.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>

                            {f.include && f.fieldType === 'linked_record' && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <select
                                  value={f.targetTableKey ?? ''}
                                  aria-label={`Related form for ${f.sourceColumn}`}
                                  onChange={(e) => {
                                    const nextTarget = e.target.value;
                                    const tbl = tableByKey.get(nextTarget);
                                    updateField(activeTable.tableKey, f.sourceColumn, {
                                      targetTableKey: nextTarget || undefined,
                                      targetColumn: tbl?.primaryKeyColumn ?? 'id',
                                      fkSource: 'manual',
                                    });
                                  }}
                                  className="min-w-0 flex-1 cursor-pointer rounded-md border border-primary-200 bg-primary-50/60 px-1.5 py-1 text-[11px] font-medium text-primary-900 focus:border-primary-500 focus:outline-none dark:border-primary-500/30 dark:bg-primary-500/15 dark:text-primary-200"
                                >
                                  <option value="">Choose target form…</option>
                                  {selectableTargetTables.map((t) => (
                                    <option key={t.tableKey} value={t.tableKey}>
                                      ↗ {t.formTitle}{t.include ? '' : ' (excluded)'}
                                    </option>
                                  ))}
                                </select>
                                <label
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[10px] font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                  title="Allow choosing multiple related records"
                                >
                                  <input
                                    type="checkbox"
                                    checked={Boolean(f.allowMultiple)}
                                    onChange={(e) =>
                                      updateField(activeTable.tableKey, f.sourceColumn, {
                                        allowMultiple: e.target.checked,
                                      })
                                    }
                                    className="h-3 w-3 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                  />
                                  Multi
                                </label>
                              </div>
                            )}

                            {f.include && isTargetExcluded && targetTable && (
                              <button
                                type="button"
                                onClick={() => includeSingleTable(targetTable.tableKey)}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                              >
                                <Plus className="h-3 w-3" aria-hidden="true" />
                                Include &ldquo;{targetTable.formTitle}&rdquo; to activate select box
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-center align-top">
                          <input
                            type="checkbox"
                            checked={f.required}
                            disabled={!f.include}
                            aria-label={`Required for ${f.sourceColumn}`}
                            onChange={(e) =>
                              updateField(activeTable.tableKey, f.sourceColumn, {
                                required: e.target.checked,
                              })
                            }
                            className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      {/* Related-form select boxes overview */}
      {activeRelations.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <button
            type="button"
            onClick={() => setShowRelationsList((v) => !v)}
            aria-expanded={showRelationsList}
            className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3 text-left hover:bg-gray-50/70 dark:hover:bg-slate-800/40"
          >
            <span className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-slate-300">
              <Link2 className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              Related-form select boxes ({activeRelations.length})
              {stats.inferredFkCount > 0 && (
                <Badge variant="primary" size="sm">
                  {stats.inferredFkCount} auto-matched
                </Badge>
              )}
            </span>
            <ChevronDown
              className={cn('h-4 w-4 text-gray-400 transition-transform', showRelationsList && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
          {showRelationsList && (
            <div className="flex flex-wrap gap-2 border-t border-gray-200/80 px-4 py-3 dark:border-slate-800">
              {activeRelations.slice(0, 36).map((rel, idx) => (
                <button
                  key={`${rel.sourceTable.tableKey}-${rel.field.fieldId}-${idx}`}
                  type="button"
                  onClick={() => setSelectedKey(rel.sourceTable.tableKey)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] text-gray-800 transition hover:border-primary-300 hover:bg-primary-50/60 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:border-primary-500/40"
                >
                  <span className="font-semibold">{rel.sourceTable.formTitle}</span>
                  <span className="text-gray-400 dark:text-slate-500">·</span>
                  <span>{rel.field.label}</span>
                  <ArrowRight className="h-3 w-3 text-primary-500" aria-hidden="true" />
                  <span className="font-semibold text-primary-700 dark:text-primary-300">
                    {rel.targetTable.formTitle}
                  </span>
                  <span className="text-[10px] text-gray-500 dark:text-slate-400">
                    ({rel.targetDisplayPreview})
                  </span>
                </button>
              ))}
              {activeRelations.length > 36 && (
                <span className="inline-flex items-center px-2 text-xs text-gray-500 dark:text-slate-400">
                  +{activeRelations.length - 36} more select boxes
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Topological import order & FK relationship overview */}
      {importOrder.length > 0 && (
        <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-slate-400">
              <Database className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              Data import order (parents first so foreign keys link automatically)
            </h3>
            {cyclicLinks.length > 0 && (
              <Badge variant="info" size="sm">
                <RefreshCw className="mr-1 inline h-3 w-3" aria-hidden="true" />
                {cyclicLinks.length} self/cyclic {cyclicLinks.length === 1 ? 'link' : 'links'} handled in Pass 2
              </Badge>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {importOrder.map((t, idx) => (
              <div key={t.tableKey} className="inline-flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  <span className="text-[10px] font-bold text-primary-600 dark:text-primary-400">{idx + 1}.</span>
                  {t.formTitle}
                </span>
                {idx < importOrder.length - 1 && (
                  <ArrowRight className="h-3.5 w-3.5 text-gray-400 dark:text-slate-600" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
