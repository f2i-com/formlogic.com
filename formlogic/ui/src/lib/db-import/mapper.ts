import type { FieldType } from '../../types/form';
import type { PackData } from '../api';
import { isReservedExpressionName } from '../utils';
import { normalizeTableKey } from './sqlParser';
import type {
  FieldMapping,
  ImportedColumn,
  ImportedSchema,
  ImportedTable,
  MaterializedTable,
  TableMapping,
} from './types';

interface MigrationPackField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  order: number;
  properties: Record<string, unknown>;
}

interface MigrationPackForm {
  packFormId: string;
  title: string;
  description: string;
  fields: MigrationPackField[];
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  [key: string]: unknown;
}

const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Convert `snake_case`, `camelCase`, or `PascalCase` into a crisp human title. */
export function humanizeIdentifier(raw: string): string {
  const spaced = raw
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spaced) return 'Field';
  return spaced
    .split(' ')
    .map((word) => {
      const upper = word.toUpperCase();
      if (['ID', 'SKU', 'URL', 'API', 'IP', 'VIP', 'SSN', 'DOB', 'PO', 'QR', 'USD', 'AUD', 'EUR'].includes(upper)) {
        return upper;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Generate a safe FormLogic field ID matching backend `FormService::fieldIdError`. */
export function makeSafeFieldId(sourceName: string, used: Set<string>): string {
  let base = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 48);
  if (!base) base = 'field';
  if (/^\d/.test(base)) base = `f_${base}`;
  if (base.startsWith('__')) base = `f_${base.replace(/^_+/, '')}`;

  let candidate = base;
  let n = 1;
  while (used.has(candidate) || isReservedExpressionName(candidate) || !ID_RE.test(candidate)) {
    candidate = `${base}_${n++}`;
  }
  used.add(candidate);
  return candidate;
}

function makeChoiceOptions(values: string[]): Array<{ id: string; label: string; value: string }> {
  const seen = new Set<string>();
  return values.slice(0, 50).map((val, i) => {
    const clean = val.trim() || `Option ${i + 1}`;
    let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `opt_${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { id, label: clean, value: clean };
  });
}

const YES_CHECKBOX_OPTION = [{ id: 'yes', label: 'Yes', value: 'yes' }];

/** Map a database column + name heuristics + FK info to a FormLogic FieldType & options. */
export function inferFieldMapping(
  col: ImportedColumn,
  allTableKeys: Set<string>,
  usedFieldIds: Set<string>,
): FieldMapping {
  const lowerName = col.name.toLowerCase();
  const typeUpper = col.rawType.toUpperCase();
  const baseType = col.normalizedType.toLowerCase();

  // Foreign key -> linked_record if target table is in this schema!
  if (col.foreignKey) {
    const targetKey = normalizeTableKey(col.foreignKey.targetTable);
    if (allTableKeys.has(targetKey)) {
      const cleanedLabel = col.name.replace(/_?id$/i, '').trim() || col.foreignKey.targetTable;
      return {
        sourceColumn: col.name,
        fieldId: makeSafeFieldId(col.name, usedFieldIds),
        label: humanizeIdentifier(cleanedLabel),
        rawType: col.rawType,
        fieldType: 'linked_record',
        include: true,
        required: !col.nullable,
        isPrimaryKey: col.isPrimaryKey,
        isAutoIncrement: col.isAutoIncrement,
        targetTableKey: targetKey,
        targetColumn: col.foreignKey.targetColumn,
        allowMultiple: false,
      };
    }
  }

  // Enum / CHECK IN choices -> dropdown
  if (col.enumValues && col.enumValues.length > 0) {
    return {
      sourceColumn: col.name,
      fieldId: makeSafeFieldId(col.name, usedFieldIds),
      label: humanizeIdentifier(col.name),
      rawType: col.rawType,
      fieldType: 'dropdown',
      include: true,
      required: !col.nullable && !col.isAutoIncrement,
      isPrimaryKey: col.isPrimaryKey,
      isAutoIncrement: col.isAutoIncrement,
      options: makeChoiceOptions(col.enumValues),
    };
  }

  let fieldType: FieldType = 'short_text';
  let options: Array<{ id: string; label: string; value: string }> | undefined;

  // Booleans (MySQL TINYINT(1), MSSQL BIT, PostgreSQL BOOLEAN/BOOL)
  if (
    baseType === 'boolean' ||
    baseType === 'bool' ||
    baseType === 'bit' ||
    /^TINYINT\s*\(\s*1\s*\)/.test(typeUpper)
  ) {
    fieldType = 'checkboxes';
    options = YES_CHECKBOX_OPTION;
  } else if (
    baseType === 'datetime' ||
    baseType === 'datetime2' ||
    baseType === 'smalldatetime' ||
    baseType === 'datetimeoffset' ||
    baseType === 'timestamp' ||
    baseType === 'timestamptz' ||
    typeUpper.startsWith('TIMESTAMP')
  ) {
    fieldType = 'datetime';
  } else if (baseType === 'date') {
    fieldType = 'date';
  } else if (baseType === 'time' || baseType === 'timetz') {
    fieldType = 'time';
  } else if (
    /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL|SMALLSERIAL|DECIMAL|NUMERIC|NUMBER|FLOAT|DOUBLE|REAL|MONEY|SMALLMONEY)\b/.test(
      typeUpper,
    )
  ) {
    fieldType = 'number';
  } else if (
    /\b(?:TEXT|MEDIUMTEXT|LONGTEXT|TINYTEXT|CLOB|NCLOB|NTEXT|JSON|JSONB|XML)\b/.test(typeUpper) ||
    /\(\s*MAX\s*\)/i.test(typeUpper)
  ) {
    fieldType = 'long_text';
  } else {
    // Check explicit VARCHAR length > 255 -> long_text
    const lenMatch = typeUpper.match(/\(\s*(\d+)\s*\)/);
    if (lenMatch && Number(lenMatch[1]) > 255) {
      fieldType = 'long_text';
    } else if (/email|e_mail/.test(lowerName)) {
      fieldType = 'email';
    } else if (/phone|mobile|tel$|telephone|fax/.test(lowerName)) {
      fieldType = 'phone';
    } else if (/url|website|homepage|link$|avatar_url|image_url/.test(lowerName)) {
      fieldType = 'url';
    } else if (/notes|description|summary|comment|bio|body|details|address|remarks|message/.test(lowerName)) {
      fieldType = 'long_text';
    }
  }

  // Surrogate auto-increment PKs (e.g., `id`) default to excluded from form inputs so users
  // don't manually type auto-increment IDs — they can still toggle them on as a Legacy ID field!
  // We always keep `primaryKeyColumn` on the TableMapping so FK remapping works regardless.
  const isSurrogateAutoPk = col.isPrimaryKey && col.isAutoIncrement && /^id$|_id$/i.test(lowerName);

  // Also never mark server-defaulted timestamps (created_at/updated_at) required by default.
  const isAuditTimestamp =
    /^(created_at|updated_at|deleted_at|modified_at|createdat|updatedat)$/.test(lowerName) &&
    !!col.defaultValue;

  return {
    sourceColumn: col.name,
    fieldId: makeSafeFieldId(col.name, usedFieldIds),
    label: isSurrogateAutoPk ? `${humanizeIdentifier(col.name)} (Legacy)` : humanizeIdentifier(col.name),
    rawType: col.rawType,
    fieldType,
    include: !isSurrogateAutoPk,
    required: !col.nullable && !col.isAutoIncrement && !isAuditTimestamp,
    isPrimaryKey: col.isPrimaryKey,
    isAutoIncrement: col.isAutoIncrement,
    options,
  };
}

/** Pick the best human-readable display field(s) when another table links to this table. */
export function pickDefaultDisplayFieldIds(fields: FieldMapping[]): string[] {
  const active = fields.filter((f) => f.include && f.fieldType !== 'linked_record');
  if (active.length === 0) return [];

  const preferred = [
    /^(full_name|display_name|name|title|company_name|department_name|subject|label)$/,
    /name|title|subject|number|code|sku/,
    /email/,
  ];
  for (const re of preferred) {
    const match = active.find((f) => re.test(f.sourceColumn.toLowerCase()));
    if (match) return [match.fieldId];
  }
  const textField = active.find((f) => f.fieldType === 'short_text' || f.fieldType === 'email');
  return [textField ? textField.fieldId : active[0].fieldId];
}

/** Build initial editable TableMapping[] from an ImportedSchema. */
export function buildInitialTableMappings(schema: ImportedSchema): TableMapping[] {
  const allKeys = new Set(schema.tables.map((t) => t.key));

  return schema.tables.map((tbl: ImportedTable) => {
    const usedFieldIds = new Set<string>();
    const fields = tbl.columns.map((col) => inferFieldMapping(col, allKeys, usedFieldIds));

    // Guarantee at least one included field if all columns were surrogate PKs.
    if (!fields.some((f) => f.include) && fields.length > 0) {
      fields[0].include = true;
    }

    const pkCol =
      tbl.primaryKeys[0] ??
      tbl.columns.find((c) => c.isPrimaryKey)?.name ??
      tbl.columns.find((c) => c.name.toLowerCase() === 'id')?.name ??
      null;

    return {
      tableKey: tbl.key,
      sourceName: tbl.name,
      formTitle: humanizeIdentifier(tbl.name),
      description: `Imported from ${tbl.schemaName ? `${tbl.schemaName}.` : ''}${tbl.name} (${schema.dialect})`,
      include: true,
      primaryKeyColumn: pkCol,
      displayFieldIds: pickDefaultDisplayFieldIds(fields),
      fields,
      initialRows: tbl.rows,
      totalRowCount: tbl.totalRowCount ?? (tbl.rows.length > 0 ? tbl.rows.length : undefined),
    };
  });
}

export interface CyclicLinkInfo {
  tableKey: string;
  fieldId: string;
  targetTableKey: string;
}

/**
 * Topologically sort selected tables so parent/referenced tables are imported before child tables.
 * Any self-referencing or mutual cycle edges are collected into `cyclicLinks` so data import
 * runs Pass 1 (with cyclic links deferred) followed by Pass 2 (`PATCH /responses/batch-links`).
 */
export function topologicalSortTables(tables: TableMapping[]): {
  order: TableMapping[];
  cyclicLinks: CyclicLinkInfo[];
} {
  const included = tables.filter((t) => t.include);
  const byKey = new Map(included.map((t) => [t.tableKey, t]));
  const cyclicLinks: CyclicLinkInfo[] = [];

  // Build adjacency: parent -> Set<child>
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const t of included) {
    deps.set(t.tableKey, new Set());
    dependents.set(t.tableKey, new Set());
  }

  for (const t of included) {
    for (const f of t.fields) {
      if (!f.include || f.fieldType !== 'linked_record' || !f.targetTableKey) continue;
      if (!byKey.has(f.targetTableKey)) continue;
      if (f.targetTableKey === t.tableKey) {
        cyclicLinks.push({ tableKey: t.tableKey, fieldId: f.fieldId, targetTableKey: f.targetTableKey });
        continue;
      }
      deps.get(t.tableKey)!.add(f.targetTableKey);
      dependents.get(f.targetTableKey)!.add(t.tableKey);
    }
  }

  const inDegree = new Map<string, number>();
  for (const t of included) {
    inDegree.set(t.tableKey, deps.get(t.tableKey)!.size);
  }

  const queue: string[] = [];
  for (const t of included) {
    if ((inDegree.get(t.tableKey) ?? 0) === 0) queue.push(t.tableKey);
  }

  const orderedKeys: string[] = [];
  const placed = new Set<string>();

  while (queue.length > 0) {
    const k = queue.shift()!;
    orderedKeys.push(k);
    placed.add(k);
    for (const child of dependents.get(k) ?? []) {
      const nextDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, nextDeg);
      if (nextDeg === 0) queue.push(child);
    }
  }

  // Remaining tables belong to a multi-table cycle — break deterministically and defer back-edges.
  const remaining = included.filter((t) => !placed.has(t.tableKey));
  for (const t of remaining) {
    orderedKeys.push(t.tableKey);
    placed.add(t.tableKey);
  }

  const position = new Map(orderedKeys.map((k, idx) => [k, idx]));
  for (const t of remaining) {
    for (const f of t.fields) {
      if (!f.include || f.fieldType !== 'linked_record' || !f.targetTableKey) continue;
      const targetPos = position.get(f.targetTableKey);
      const ownPos = position.get(t.tableKey);
      if (targetPos !== undefined && ownPos !== undefined && targetPos >= ownPos) {
        const already = cyclicLinks.some((c) => c.tableKey === t.tableKey && c.fieldId === f.fieldId);
        if (!already) {
          cyclicLinks.push({ tableKey: t.tableKey, fieldId: f.fieldId, targetTableKey: f.targetTableKey });
        }
      }
    }
  }

  return {
    order: orderedKeys.map((k) => byKey.get(k)!),
    cyclicLinks,
  };
}

export interface BuildMigrationPackOptions {
  mode: 'new_app' | 'standalone_forms';
  appName: string;
  appDescription: string;
  includeDashboard: boolean;
  dialectLabel: string;
}

/**
 * Assemble an atomic FormLogic PackData payload for `POST /api/packs/import`.
 * Always sets `packMeta.id = 'custom'` so repeat migrations are never rejected as duplicate packs,
 * and encodes all cross-table `linked_record` targets with `@pack:<tableKey>` so forward, self,
 * and cyclic FKs resolve atomically inside one MySQL transaction.
 */
export function buildMigrationPack(
  tables: TableMapping[],
  options: BuildMigrationPackOptions,
): PackData {
  const included = tables.filter((t) => t.include);
  if (included.length === 0) {
    throw new Error('Select at least one table to create.');
  }
  if (included.length > 50) {
    throw new Error('FormLogic imports up to 50 tables at once. Deselect extra tables or split into two imports.');
  }

  const includedKeys = new Set(included.map((t) => t.tableKey));
  const displayFieldsByTable = new Map(included.map((t) => [t.tableKey, t.displayFieldIds]));

  const packForms: MigrationPackForm[] = included.map((t) => {
    const usedIds = new Set<string>();
    const activeFields = t.fields.filter((f) => f.include).slice(0, 200);
    const packFields: MigrationPackField[] = activeFields.map((f, idx) => {
      const safeId =
        ID_RE.test(f.fieldId) && !isReservedExpressionName(f.fieldId) && !usedIds.has(f.fieldId)
          ? (usedIds.add(f.fieldId), f.fieldId)
          : makeSafeFieldId(f.fieldId || f.sourceColumn, usedIds);

      const properties: Record<string, unknown> = {};
      if (f.fieldType === 'linked_record' && f.targetTableKey && includedKeys.has(f.targetTableKey)) {
        const targetDisplay = displayFieldsByTable.get(f.targetTableKey) ?? [];
        properties.targetFormId = `@pack:${f.targetTableKey}`;
        if (targetDisplay.length > 0) {
          properties.displayFieldIds = targetDisplay;
          properties.searchFieldIds = targetDisplay;
        }
        if (f.allowMultiple) {
          properties.allowMultiple = true;
        }
      } else if (f.fieldType === 'dropdown' || f.fieldType === 'multiple_choice' || f.fieldType === 'checkboxes') {
        properties.options = f.options && f.options.length > 0 ? f.options : YES_CHECKBOX_OPTION;
      }

      // If a linked_record pointed to an excluded table, gracefully downgrade to short_text.
      const resolvedType: FieldType =
        f.fieldType === 'linked_record' && (!f.targetTableKey || !includedKeys.has(f.targetTableKey))
          ? 'short_text'
          : f.fieldType;

      return {
        id: safeId,
        type: resolvedType,
        label: f.label.trim() || humanizeIdentifier(f.sourceColumn),
        required: f.required,
        order: idx,
        properties,
      };
    });

    return {
      packFormId: t.tableKey,
      title: t.formTitle.trim() || humanizeIdentifier(t.sourceName),
      description: t.description.trim(),
      fields: packFields,
      settings: {},
      theme: {},
    };
  });

  const apps: Array<Record<string, unknown>> = [];
  if (options.mode === 'new_app') {
    const widgets: Array<Record<string, unknown>> = [];
    const reports: Array<Record<string, unknown>> = [];

    if (options.includeDashboard) {
      // Top row: KPI record count cards for up to 4 main tables.
      const kpiTables = included.slice(0, 4);
      const colWidth = kpiTables.length > 0 ? Math.floor(12 / kpiTables.length) : 12;
      kpiTables.forEach((t, idx) => {
        const spec = {
          version: 1,
          formId: `@pack:${t.tableKey}`,
          measure: { op: 'count' },
        };
        widgets.push({
          id: `kpi_${t.tableKey}`,
          kind: 'report',
          title: t.formTitle,
          layout: { x: idx * colWidth, y: 0, w: colWidth, h: 2 },
          spec: spec as never,
          viz: { kind: 'kpi' },
        });
      });

      // Second row: categorical breakdown chart if any table has a dropdown field, plus recent records list.
      let chartTable: { table: TableMapping; field: FieldMapping } | null = null;
      for (const t of included) {
        const drop = t.fields.find((f) => f.include && f.fieldType === 'dropdown');
        if (drop) {
          chartTable = { table: t, field: drop };
          break;
        }
      }

      if (chartTable) {
        const reportSpec = {
          version: 1,
          formId: `@pack:${chartTable.table.tableKey}`,
          groupBy: { field: chartTable.field.fieldId },
          measure: { op: 'count' },
        };
        reports.push({
          id: `rep_${chartTable.table.tableKey}_${chartTable.field.fieldId}`,
          name: `${chartTable.table.formTitle} by ${chartTable.field.label}`,
          spec: reportSpec,
          viz: { kind: 'bar' },
        });
        widgets.push({
          id: `chart_${chartTable.table.tableKey}`,
          kind: 'report',
          title: `${chartTable.table.formTitle} by ${chartTable.field.label}`,
          layout: { x: 0, y: 2, w: 6, h: 4 },
          spec: reportSpec as never,
          viz: { kind: 'bar' },
        });
      }

      const listTable = included[included.length - 1];
      widgets.push({
        id: `list_${listTable.tableKey}`,
        kind: 'list',
        title: `Recent ${listTable.formTitle}`,
        layout: { x: chartTable ? 6 : 0, y: 2, w: chartTable ? 6 : 12, h: 4 },
        list: {
          formId: `@pack:${listTable.tableKey}`,
          limit: 8,
          columns: listTable.fields
            .filter((f) => f.include && f.fieldType !== 'long_text')
            .slice(0, 4)
            .map((f) => f.fieldId),
        },
      });
    }

    apps.push({
      packAppId: 'migrated_app',
      name: options.appName.trim() || 'Imported Database App',
      description:
        options.appDescription.trim() ||
        `CRUD forms & records migrated from ${options.dialectLabel} (${included.length} ${included.length === 1 ? 'table' : 'tables'}).`,
      settings: {
        landingPage: options.includeDashboard ? 'dashboard' : `@pack:${included[0].tableKey}`,
      },
      theme: {},
      forms: included.map((t, i) => ({
        packFormId: t.tableKey,
        displayName: t.formTitle.trim() || humanizeIdentifier(t.sourceName),
        sortOrder: i,
        isVisible: true,
      })),
      ...(reports.length > 0 ? { reports } : {}),
      ...(options.includeDashboard && widgets.length > 0
        ? {
            customScreen: {
              kind: 'dashboard',
              dashboard: {
                version: 1,
                cols: 12,
                widgets,
              },
            },
          }
        : {}),
    });
  }

  return {
    formatVersion: 1,
    packMeta: {
      // CRITICAL: 'custom' prevents PackService::isPackInstalled() from rejecting subsequent migrations.
      id: 'custom',
      name: options.appName.trim() || 'Database Import',
      description: options.appDescription.trim() || `Schema imported from ${options.dialectLabel}`,
      version: '1.0.0',
      author: 'FormLogic Database Importer',
      tags: ['database-import', options.dialectLabel.toLowerCase()],
    },
    forms: packForms,
    apps,
  };
}

/** Normalize a raw legacy PK value into a deterministic string key for FK lookup maps. */
export function normalizePkKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Prepare one source row for `POST /api/forms/{formId}/responses/batch-import`,
 * remapping parent foreign keys into FormLogic response IDs and isolating any
 * deferred cyclic FK values for Pass-2 patching.
 */
export function prepareBatchImportRow(
  rawRow: Record<string, unknown>,
  table: MaterializedTable,
  columnToFieldId: Record<string, string>,
  pkColumn: string | null,
  pkMaps: Map<string, Map<string, string>>,
  deferredFieldIds: Set<string>,
): {
  clientKey?: string;
  answers: Record<string, unknown>;
  deferredLinks: Record<string, string>;
} {
  const fieldsById = new Map(table.fields.map((f) => [f.fieldId, f]));
  const answers: Record<string, unknown> = {};
  const deferredLinks: Record<string, string> = {};

  // Case-insensitive lookup helper for source row keys.
  const rowLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rawRow)) {
    rowLower.set(k.toLowerCase(), v);
  }
  const readVal = (col: string): unknown => {
    if (col in rawRow) return rawRow[col];
    return rowLower.get(col.toLowerCase());
  };

  const clientKey = pkColumn ? normalizePkKey(readVal(pkColumn)) ?? undefined : undefined;

  for (const [sourceCol, fieldId] of Object.entries(columnToFieldId)) {
    if (!fieldId || fieldId === '__skip__') continue;
    const field = fieldsById.get(fieldId);
    if (!field) continue;

    const rawVal = readVal(sourceCol);
    if (rawVal === null || rawVal === undefined || rawVal === '') continue;

    if (field.fieldType === 'linked_record') {
      const targetInfo = table.linkedFieldTargets[fieldId];
      const legacyKey = normalizePkKey(rawVal);
      if (!legacyKey || !targetInfo) continue;

      if (deferredFieldIds.has(fieldId)) {
        deferredLinks[fieldId] = legacyKey;
        continue;
      }

      const targetMap = pkMaps.get(targetInfo.targetTableKey);
      const mappedId = targetMap?.get(legacyKey);
      if (mappedId) {
        answers[fieldId] = targetInfo.allowMultiple ? [mappedId] : mappedId;
      }
      continue;
    }

    if (field.fieldType === 'checkboxes') {
      if (typeof rawVal === 'boolean') {
        answers[fieldId] = rawVal;
      } else if (Array.isArray(rawVal)) {
        answers[fieldId] = rawVal.map(String);
      } else {
        answers[fieldId] = String(rawVal);
      }
      continue;
    }

    if (field.fieldType === 'number') {
      const num = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).replace(/,/g, '').trim());
      answers[fieldId] = Number.isFinite(num) ? num : rawVal;
      continue;
    }

    if (field.fieldType === 'date') {
      const s = String(rawVal).trim();
      const isoDate = s.match(/^(\d{4}-\d{2}-\d{2})/);
      answers[fieldId] = isoDate ? isoDate[1] : s;
      continue;
    }

    answers[fieldId] = typeof rawVal === 'object' ? JSON.stringify(rawVal) : rawVal;
  }

  return { clientKey, answers, deferredLinks };
}
