import type { FieldType } from '../../types/form';
import type { PackData } from '../api';
import { isReservedExpressionName } from '../utils';
import { normalizeTableKey } from './sqlParser';
import type {
  FieldMapping,
  ForeignKeySource,
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
  placeholder?: string;
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

const SYSTEM_TABLE_KEYS = new Set([
  'phinxlog',
  'sysdiagrams',
  'efmigrationshistory',
  'flyway_schema_history',
  'schema_migrations',
  'knex_migrations',
  'knex_migrations_lock',
  'alembic_version',
  'django_migrations',
  'dtproperties',
  'ar_internal_metadata',
  'migrations',
  'typeorm_metadata',
  'prisma_migrations',
  'sequelize_meta',
  'sequelizemeta',
]);

/** Return true for database migration or engine-internal tables that should default to excluded. */
export function isSystemOrMigrationTable(tableName: string): boolean {
  const key = normalizeTableKey(tableName);
  if (SYSTEM_TABLE_KEYS.has(key)) return true;
  if (/^(?:sys_|__ef|sqlite_|pg_|msdb_|dbo_sys)/.test(key)) return true;
  return false;
}

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
      if (['ID', 'SKU', 'URL', 'API', 'IP', 'VIP', 'SSN', 'DOB', 'PO', 'QR', 'USD', 'AUD', 'EUR', 'GPS', 'DXF'].includes(upper)) {
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

/** Convert a camelCase or PascalCase identifier into snake_case without regex lookbehinds. */
function toSnakeLower(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const IRREGULAR_SINGULARS: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  geese: 'goose',
  indices: 'index',
  statuses: 'status',
  companies: 'company',
  categories: 'category',
  facilities: 'facility',
  families: 'family',
  activities: 'activity',
  entries: 'entry',
  inventories: 'inventory',
  priorities: 'priority',
  histories: 'history',
};

/** Best-effort singular form of an English snake_case identifier. */
function singularizeSnake(name: string): string {
  const parts = name.split('_').filter(Boolean);
  if (parts.length === 0) return name;
  const last = parts[parts.length - 1];
  let singular = last;
  if (IRREGULAR_SINGULARS[last]) {
    singular = IRREGULAR_SINGULARS[last];
  } else if (last.length > 4 && last.endsWith('ies')) {
    singular = `${last.slice(0, -3)}y`;
  } else if (last.length > 4 && /(?:ses|xes|zes|ches|shes)$/.test(last)) {
    singular = last.slice(0, -2);
  } else if (last.length > 2 && last.endsWith('s') && !/(?:ss|us|is|os)$/.test(last)) {
    singular = last.slice(0, -1);
  }
  parts[parts.length - 1] = singular;
  return parts.join('_');
}

type ColumnTypeFamily = 'int' | 'uuid' | 'string' | 'unknown';

function getColumnTypeFamily(col: ImportedColumn): ColumnTypeFamily {
  const upper = `${col.rawType} ${col.normalizedType}`.toUpperCase();
  if (/\b(?:UUID|UNIQUEIDENTIFIER|GUID)\b/.test(upper)) return 'uuid';
  if (/\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL|SMALLSERIAL|NUMERIC|DECIMAL|NUMBER)\b/.test(upper)) {
    return 'int';
  }
  if (/\b(?:VARCHAR|NVARCHAR|CHAR|NCHAR|TEXT|CLOB|CHARACTER|STRING)\b/.test(upper)) {
    return 'string';
  }
  return 'unknown';
}

function areTypeFamiliesCompatible(fkCol: ImportedColumn, pkCol: ImportedColumn | undefined): boolean {
  if (!pkCol) return true;
  const a = getColumnTypeFamily(fkCol);
  const b = getColumnTypeFamily(pkCol);
  if (a === 'unknown' || b === 'unknown') return true;
  if (a === b) return true;
  if ((a === 'uuid' && b === 'string') || (a === 'string' && b === 'uuid')) return true;
  return false;
}

const GENERIC_SUFFIX_STOPWORDS = new Set([
  'id',
  'key',
  'code',
  'type',
  'status',
  'name',
  'record',
  'item',
  'data',
  'value',
  'number',
  'num',
  'ref',
]);

/** Domain role aliases used ONLY when the target table exists AND PK types are compatible. */
const ROLE_TARGET_ALIASES: ReadonlyArray<{ stems: readonly string[]; targets: readonly string[] }> = [
  {
    stems: [
      'truck',
      'haul_truck',
      'excavator',
      'shovel',
      'loader',
      'dozer',
      'drill',
      'grader',
      'machine',
      'vehicle',
      'unit',
      'rig',
      'equipment_a',
      'equipment_b',
      'source_excavator',
      'to_equipment',
    ],
    targets: ['equipment', 'vehicles', 'vehicle', 'machines', 'machine', 'assets', 'asset'],
  },
  {
    stems: [
      'origin',
      'destination',
      'current_location',
      'destination_location',
      'dump_location',
      'load_location',
      'shovel_location',
      'fuel_location',
      'from_location',
      'to_location',
      'source_location',
      'parent_region',
    ],
    targets: ['locations', 'location', 'sites', 'site'],
  },
  {
    stems: [
      'manager',
      'owner',
      'assignee',
      'assignee_user',
      'assigned_to',
      'created_by',
      'updated_by',
      'approved_by',
      'reported_by',
      'closed_by',
      'performed_by',
      'submitted_by',
      'issued_by',
      'changed_by',
      'recorded_by',
      'from_user',
    ],
    targets: ['users', 'user', 'auth_user', 'team_members', 'employees', 'employee', 'person', 'people'],
  },
  {
    stems: ['operator', 'driver', 'employee', 'supervisor', 'issued_to', 'to_person'],
    targets: ['person', 'people', 'operators', 'operator', 'employees', 'employee', 'users', 'user'],
  },
  {
    stems: ['load_record', 'haul_load'],
    targets: ['shift_loads', 'haul_load', 'haul_loads', 'loads'],
  },
  {
    stems: ['reason', 'delay_reason', 'reason_code'],
    targets: ['reason_codes', 'reason_code', 'delay_reason', 'delay_reasons'],
  },
  {
    stems: ['org', 'organization', 'company'],
    targets: ['organization', 'organizations', 'company', 'companies', 'accounts', 'account'],
  },
  {
    stems: ['route', 'haul_route'],
    targets: ['haul_route', 'haul_routes', 'routes', 'route'],
  },
  {
    stems: ['component', 'equipment_component'],
    targets: ['equipment_component', 'equipment_components', 'components', 'component'],
  },
  {
    stems: ['family', 'equipment_family'],
    targets: ['equipment_family', 'equipment_families', 'families', 'family'],
  },
  {
    stems: ['pile', 'inventory_pile'],
    targets: ['inventory_pile', 'inventory_piles', 'piles', 'pile'],
  },
  {
    stems: ['rotation', 'crew_rotation'],
    targets: ['crew_rotation', 'crew_rotations', 'rotations', 'rotation'],
  },
];

interface TargetTableIndex {
  byKey: Map<string, ImportedTable>;
  bySingular: Map<string, ImportedTable>;
  pkColByKey: Map<string, ImportedColumn | undefined>;
}

function buildTargetTableIndex(tables: ImportedTable[]): TargetTableIndex {
  const byKey = new Map<string, ImportedTable>();
  const bySingular = new Map<string, ImportedTable>();
  const pkColByKey = new Map<string, ImportedColumn | undefined>();

  for (const t of tables) {
    if (isSystemOrMigrationTable(t.name)) continue;
    byKey.set(t.key, t);
    const sing = singularizeSnake(t.key);
    if (!bySingular.has(sing)) {
      bySingular.set(sing, t);
    }
    const pkName =
      t.primaryKeys[0] ??
      t.columns.find((c) => c.isPrimaryKey)?.name ??
      t.columns.find((c) => c.name.toLowerCase() === 'id')?.name;
    const pkCol = pkName
      ? t.columns.find((c) => c.name.toLowerCase() === pkName.toLowerCase())
      : undefined;
    pkColByKey.set(t.key, pkCol);
  }

  return { byKey, bySingular, pkColByKey };
}

/**
 * Infer an implicit foreign key when a database omits formal FOREIGN KEY constraints
 * (e.g. `equipment_type_id -> equipment_types.id`, `current_location_id -> locations.id`,
 * `truck_id -> equipment.id`). Guarded by strict PK data-type compatibility so false
 * positives are avoided.
 */
export function inferImplicitForeignKey(
  table: ImportedTable,
  col: ImportedColumn,
  index: TargetTableIndex,
): { targetTableKey: string; targetColumn: string } | null {
  if (col.foreignKey) return null;
  const snake = toSnakeLower(col.name);
  if (!snake || snake === 'id' || (col.isPrimaryKey && col.isAutoIncrement)) {
    return null;
  }

  // Only consider columns that look like reference keys (`*_id`, `*_fk`, or `*_by` / `assigned_to` / `issued_to`).
  let stem: string | null = null;
  if (snake.endsWith('_id') && snake.length > 3) {
    stem = snake.slice(0, -3);
  } else if (snake.endsWith('_fk') && snake.length > 3) {
    stem = snake.slice(0, -3);
  } else if (
    /^(?:created_by|updated_by|approved_by|reported_by|closed_by|performed_by|submitted_by|issued_by|changed_by|recorded_by|assigned_to|issued_to)$/.test(
      snake,
    )
  ) {
    stem = snake;
  }
  if (!stem) return null;

  // Never treat `<table>_id` on the same table as a self-FK when it's the table's own primary key.
  const ownSingular = singularizeSnake(table.key);
  if (col.isPrimaryKey && (stem === table.key || stem === ownSingular)) {
    return null;
  }

  const acceptTarget = (candidate: ImportedTable | undefined): { targetTableKey: string; targetColumn: string } | null => {
    if (!candidate) return null;
    if (col.isPrimaryKey && candidate.key === table.key) return null;
    const targetPk = index.pkColByKey.get(candidate.key);
    if (!targetPk) return null;
    if (!areTypeFamiliesCompatible(col, targetPk)) return null;
    return { targetTableKey: candidate.key, targetColumn: targetPk.name };
  };

  // 1. Direct match on full stem or its singular form (e.g. `equipment_type` -> `equipment_types`).
  const stemSing = singularizeSnake(stem);
  const direct = acceptTarget(index.byKey.get(stem) ?? index.bySingular.get(stemSing));
  if (direct) return direct;

  // 2. Role alias match (e.g. `truck_id` -> `equipment`, `load_record_id` -> `shift_loads`).
  for (const rule of ROLE_TARGET_ALIASES) {
    if (rule.stems.includes(stem) || rule.stems.includes(stemSing)) {
      for (const targetName of rule.targets) {
        const hit = acceptTarget(index.byKey.get(targetName) ?? index.bySingular.get(singularizeSnake(targetName)));
        if (hit) return hit;
      }
    }
  }

  // 3. Progressive suffix match for role-prefixed FKs (e.g. `current_location_id` -> `location` -> `locations`,
  //    `parent_category_id` -> `category` -> `categories`, `assigned_agent_id` -> `agent` -> `agents`).
  const parts = stem.split('_').filter(Boolean);
  for (let start = 1; start < parts.length; start++) {
    const suffix = parts.slice(start).join('_');
    const suffixSing = singularizeSnake(suffix);
    if (parts.length - start === 1 && GENERIC_SUFFIX_STOPWORDS.has(suffixSing)) {
      continue;
    }
    const hit = acceptTarget(index.byKey.get(suffix) ?? index.bySingular.get(suffixSing));
    if (hit) return hit;
  }

  // 4. Self-reference pattern like `parent_id` -> own table when own table has a compatible PK.
  if (stem === 'parent') {
    const selfHit = acceptTarget(table);
    if (selfHit) return selfHit;
  }

  return null;
}

/** Map a database column + name heuristics + FK info to a FormLogic FieldType & options. */
export function inferFieldMapping(
  col: ImportedColumn,
  allTableKeys: Set<string>,
  usedFieldIds: Set<string>,
  inferredFk?: { targetTableKey: string; targetColumn: string } | null,
): FieldMapping {
  const lowerName = col.name.toLowerCase();
  const typeUpper = col.rawType.toUpperCase();
  const baseType = col.normalizedType.toLowerCase();

  // Explicit SQL FK or smart inferred FK -> linked_record (related-form select box)!
  if (col.foreignKey) {
    const targetKey = normalizeTableKey(col.foreignKey.targetTable);
    if (allTableKeys.has(targetKey)) {
      const cleanedLabel = col.name.replace(/_?id$/i, '').trim() || col.foreignKey.targetTable;
      const fkSource: ForeignKeySource = col.foreignKey.source ?? 'explicit';
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
        fkSource,
        allowMultiple: false,
      };
    }
  } else if (inferredFk && allTableKeys.has(inferredFk.targetTableKey)) {
    const cleanedLabel = col.name.replace(/_?(?:id|fk)$/i, '').trim() || inferredFk.targetTableKey;
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
      targetTableKey: inferredFk.targetTableKey,
      targetColumn: inferredFk.targetColumn,
      fkSource: 'inferred',
      allowMultiple: false,
    };
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
  let isBooleanCheckbox = false;

  // Booleans (MySQL TINYINT(1), MSSQL BIT, PostgreSQL BOOLEAN/BOOL)
  if (
    baseType === 'boolean' ||
    baseType === 'bool' ||
    baseType === 'bit' ||
    /^TINYINT\s*\(\s*1\s*\)/.test(typeUpper)
  ) {
    fieldType = 'checkboxes';
    options = YES_CHECKBOX_OPTION;
    isBooleanCheckbox = true;
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

  // Never mark server-defaulted timestamps (created_at/updated_at) or single-option boolean checkboxes
  // as required — otherwise unchecked `false`/`0` values fail FormLogic's required check!
  const isAuditTimestamp =
    /^(created_at|updated_at|deleted_at|modified_at|createdat|updatedat)$/.test(lowerName) &&
    (!!col.defaultValue || col.nullable);

  return {
    sourceColumn: col.name,
    fieldId: makeSafeFieldId(col.name, usedFieldIds),
    label: isSurrogateAutoPk ? `${humanizeIdentifier(col.name)} (Legacy)` : humanizeIdentifier(col.name),
    rawType: col.rawType,
    fieldType,
    include: !isSurrogateAutoPk,
    required: !isBooleanCheckbox && !col.nullable && !col.isAutoIncrement && !isAuditTimestamp,
    isPrimaryKey: col.isPrimaryKey,
    isAutoIncrement: col.isAutoIncrement,
    options,
  };
}

/**
 * Pick the best human-readable display field(s) (1 or 2) when another form links to this form
 * via a related-form select box.
 */
export function pickDefaultDisplayFieldIds(
  fields: FieldMapping[],
  primaryKeyColumn?: string | null,
): string[] {
  const active = fields.filter((f) => f.include && f.fieldType !== 'linked_record');
  if (active.length === 0) return [];

  const nonBool = active.filter((f) => f.fieldType !== 'checkboxes');
  const pool = nonBool.length > 0 ? nonBool : active;

  // 1. Paired person name (`first_name` + `last_name`) -> "Sarah Chen"
  const firstName = pool.find((f) => /^(?:first_name|firstname|given_name)$/.test(toSnakeLower(f.sourceColumn)));
  const lastName = pool.find((f) => /^(?:last_name|lastname|surname|family_name)$/.test(toSnakeLower(f.sourceColumn)));
  if (firstName && lastName && firstName.fieldId !== lastName.fieldId) {
    return [firstName.fieldId, lastName.fieldId];
  }

  // 2. Primary human title / name column (avoiding secondary attributes like `operator_name` or `reason_name`)
  const exactNameRe = /^(?:full_name|display_name|name|title|company_name|department_name|site_name|location_name|shift_name|product_name|customer_name|equipment_name|subject|label|username)$/;
  const exactName = pool.find((f) => exactNameRe.test(toSnakeLower(f.sourceColumn)));

  // Concise code / external ID / date qualifier (paired nicely with a name or model)
  const codeRe = /^(?:code|sku|external_id|order_number|ticket_number|asset_tag|unit_code|shift_date)$/;
  const codeField = pool.find((f) => codeRe.test(toSnakeLower(f.sourceColumn)));

  if (codeField && exactName && codeField.fieldId !== exactName.fieldId) {
    return [codeField.fieldId, exactName.fieldId];
  }
  if (exactName) {
    return [exactName.fieldId];
  }

  // 3. Code + model (e.g. `pit_software.equipment`: `external_id` + `model` -> "T-412 - Komatsu 830E")
  const modelField = pool.find((f) => /^(?:model|category|type|slug)$/.test(toSnakeLower(f.sourceColumn)));
  if (codeField && modelField && codeField.fieldId !== modelField.fieldId) {
    return [codeField.fieldId, modelField.fieldId];
  }
  if (codeField) {
    return [codeField.fieldId];
  }

  // 4. Natural non-auto-increment text PK (e.g. `mine_management.equipment.id = 'DT-1042'`)
  if (primaryKeyColumn) {
    const pkField = pool.find(
      (f) =>
        f.sourceColumn.toLowerCase() === primaryKeyColumn.toLowerCase() &&
        !f.isAutoIncrement &&
        f.fieldType === 'short_text',
    );
    if (pkField) {
      return [pkField.fieldId];
    }
  }

  // 5. General title / email / first short text fallback
  const secondaryName = pool.find((f) => /(?:title|subject|number|code|sku|model|email)/.test(toSnakeLower(f.sourceColumn)));
  if (secondaryName) return [secondaryName.fieldId];

  const textField = pool.find((f) => f.fieldType === 'short_text' || f.fieldType === 'email');
  return [textField ? textField.fieldId : pool[0].fieldId];
}

/**
 * Transitively expand a set of selected table keys to include all parent/lookup tables
 * referenced by active `linked_record` fields so zero foreign-key select boxes break.
 */
export function expandRelatedTableKeys(
  tables: TableMapping[],
  seedKeys: Set<string>,
  maxCount = 50,
): Set<string> {
  const byKey = new Map(tables.map((t) => [t.tableKey, t]));
  const selected = new Set<string>(seedKeys);
  const queue = Array.from(seedKeys);

  while (queue.length > 0 && selected.size < maxCount) {
    const key = queue.shift()!;
    const tbl = byKey.get(key);
    if (!tbl) continue;
    for (const f of tbl.fields) {
      if (!f.include || f.fieldType !== 'linked_record' || !f.targetTableKey) continue;
      if (selected.has(f.targetTableKey)) continue;
      if (!byKey.has(f.targetTableKey)) continue;
      if (selected.size >= maxCount) break;
      selected.add(f.targetTableKey);
      queue.push(f.targetTableKey);
    }
  }
  return selected;
}

/** Build initial editable TableMapping[] from an ImportedSchema, with explicit + implicit FKs. */
export function buildInitialTableMappings(schema: ImportedSchema): TableMapping[] {
  const allKeys = new Set(schema.tables.map((t) => t.key));
  const targetIndex = buildTargetTableIndex(schema.tables);

  const mappings: TableMapping[] = schema.tables.map((tbl: ImportedTable) => {
    const usedFieldIds = new Set<string>();
    const isSystem = isSystemOrMigrationTable(tbl.name);
    const fields = tbl.columns.map((col) => {
      const inferred = isSystem ? null : inferImplicitForeignKey(tbl, col, targetIndex);
      return inferFieldMapping(col, allKeys, usedFieldIds, inferred);
    });

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
      schemaName: tbl.schemaName,
      formTitle: humanizeIdentifier(tbl.name),
      description: `Imported from ${tbl.schemaName ? `${tbl.schemaName}.` : ''}${tbl.name} (${schema.dialect})`,
      include: !isSystem,
      isSystemTable: isSystem,
      primaryKeyColumn: pkCol,
      displayFieldIds: pickDefaultDisplayFieldIds(fields, pkCol),
      fields,
      initialRows: tbl.rows,
      totalRowCount: tbl.totalRowCount ?? (tbl.rows.length > 0 ? tbl.rows.length : undefined),
    };
  });

  // For large databases (> 50 non-system tables), auto-pick an intelligent starter set <= 50
  // prioritizing populated operational tables + all of their transitive FK lookup tables!
  const nonSystem = mappings.filter((m) => !m.isSystemTable);
  if (nonSystem.length > 50) {
    const incomingRefCount = new Map<string, number>();
    for (const m of nonSystem) {
      for (const f of m.fields) {
        if (f.include && f.fieldType === 'linked_record' && f.targetTableKey) {
          incomingRefCount.set(f.targetTableKey, (incomingRefCount.get(f.targetTableKey) ?? 0) + 1);
        }
      }
    }

    const scored = [...nonSystem].sort((a, b) => {
      const rowsA = a.totalRowCount ?? a.initialRows.length;
      const rowsB = b.totalRowCount ?? b.initialRows.length;
      const score = (m: TableMapping, rows: number): number => {
        let s = 0;
        if (rows > 0) s += 1000;
        if (rows > 25_000) s -= 400; // deprioritize giant telemetry archive tables in starter selection
        s += Math.min(500, (incomingRefCount.get(m.tableKey) ?? 0) * 60);
        if (m.fields.some((f) => f.include && f.fieldType === 'linked_record')) s += 80;
        return s;
      };
      return score(b, rowsB) - score(a, rowsA);
    });

    const seeds = new Set(scored.slice(0, 32).map((m) => m.tableKey));
    const chosen = expandRelatedTableKeys(mappings, seeds, 50);
    for (const m of scored) {
      if (chosen.size >= 50) break;
      chosen.add(m.tableKey);
    }
    for (const m of mappings) {
      m.include = !m.isSystemTable && chosen.has(m.tableKey);
    }
  }

  return mappings;
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
  const tableByKey = new Map(included.map((t) => [t.tableKey, t]));

  // Pre-compute final safe field IDs for each table so displayFieldIds / searchFieldIds / relatedColumnFieldIds match 100%.
  const resolvedFieldIdsByTable = new Map<string, Map<string, string>>();
  for (const t of included) {
    const usedIds = new Set<string>();
    const map = new Map<string, string>();
    for (const f of t.fields.filter((x) => x.include).slice(0, 200)) {
      const safeId =
        ID_RE.test(f.fieldId) && !isReservedExpressionName(f.fieldId) && !usedIds.has(f.fieldId)
          ? (usedIds.add(f.fieldId), f.fieldId)
          : makeSafeFieldId(f.fieldId || f.sourceColumn, usedIds);
      map.set(f.sourceColumn, safeId);
    }
    resolvedFieldIdsByTable.set(t.tableKey, map);
  }

  const getTargetDisplayAndSearch = (targetTableKey: string): { displayIds: string[]; searchIds: string[] } => {
    const target = tableByKey.get(targetTableKey);
    const idMap = resolvedFieldIdsByTable.get(targetTableKey);
    if (!target || !idMap) return { displayIds: [], searchIds: [] };
    const validIds = new Set(idMap.values());
    const displayIds = target.displayFieldIds.filter((id) => validIds.has(id));
    if (displayIds.length === 0) {
      const fallback = pickDefaultDisplayFieldIds(target.fields, target.primaryKeyColumn).filter((id) => validIds.has(id));
      displayIds.push(...fallback);
    }
    const searchableTypes = new Set<FieldType>(['short_text', 'email', 'phone', 'url', 'number', 'dropdown']);
    const searchSet = new Set<string>(displayIds);
    for (const f of target.fields) {
      if (searchSet.size >= 4) break;
      if (!f.include || !searchableTypes.has(f.fieldType)) continue;
      const fid = idMap.get(f.sourceColumn);
      if (fid) searchSet.add(fid);
    }
    return { displayIds, searchIds: Array.from(searchSet) };
  };

  const packForms: MigrationPackForm[] = included.map((t) => {
    const idMap = resolvedFieldIdsByTable.get(t.tableKey)!;
    const activeFields = t.fields.filter((f) => f.include).slice(0, 200);
    const childRelatedCols = activeFields
      .filter((f) => f.fieldType !== 'long_text' && f.fieldType !== 'linked_record')
      .slice(0, 4)
      .map((f) => idMap.get(f.sourceColumn)!)
      .filter(Boolean);

    const packFields: MigrationPackField[] = activeFields.map((f, idx) => {
      const safeId = idMap.get(f.sourceColumn)!;
      const cleanLabel = f.label.trim() || humanizeIdentifier(f.sourceColumn);
      const properties: Record<string, unknown> = {};
      let placeholder: string | undefined;

      if (f.fieldType === 'linked_record' && f.targetTableKey && includedKeys.has(f.targetTableKey)) {
        const target = tableByKey.get(f.targetTableKey);
        const { displayIds, searchIds } = getTargetDisplayAndSearch(f.targetTableKey);
        properties.targetFormId = `@pack:${f.targetTableKey}`;
        if (displayIds.length > 0) {
          properties.displayFieldIds = displayIds;
        }
        if (searchIds.length > 0) {
          properties.searchFieldIds = searchIds;
        }
        if (f.allowMultiple) {
          properties.allowMultiple = true;
        }
        properties.relatedAllowAdd = true;
        properties.relatedAllowDelete = true;
        if (childRelatedCols.length > 0) {
          properties.relatedColumnFieldIds = childRelatedCols;
        }
        placeholder = `Select ${target?.formTitle ?? cleanLabel}...`;
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
        label: cleanLabel,
        ...(placeholder ? { placeholder } : {}),
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
      // Top row: KPI record count cards for up to 4 main tables (prefer populated tables first).
      const rankedTables = [...included].sort((a, b) => {
        const ra = a.totalRowCount ?? a.initialRows.length;
        const rb = b.totalRowCount ?? b.initialRows.length;
        if (rb !== ra) return rb - ra;
        return 0;
      });
      const kpiTables = rankedTables.slice(0, 4);
      const colWidth = kpiTables.length > 0 ? Math.floor(12 / kpiTables.length) : 12;
      kpiTables.forEach((t, idx) => {
        widgets.push({
          id: `kpi_${t.tableKey}`,
          kind: 'report',
          title: t.formTitle,
          layout: { x: idx * colWidth, y: 0, w: colWidth, h: 2 },
          spec: {
            formId: `@pack:${t.tableKey}`,
            viz: 'kpi',
            measure: { fn: 'count' },
          },
        });
      });

      // Second row: categorical breakdown chart (dropdown field, or linked_record FK fallback) + recent records list.
      let chartTable: { table: TableMapping; field: FieldMapping } | null = null;
      for (const t of rankedTables) {
        const drop = t.fields.find((f) => f.include && f.fieldType === 'dropdown');
        if (drop) {
          chartTable = { table: t, field: drop };
          break;
        }
      }
      if (!chartTable) {
        for (const t of rankedTables) {
          const fk = t.fields.find(
            (f) => f.include && f.fieldType === 'linked_record' && f.targetTableKey && includedKeys.has(f.targetTableKey),
          );
          if (fk) {
            chartTable = { table: t, field: fk };
            break;
          }
        }
      }

      if (chartTable) {
        const chartFieldId =
          resolvedFieldIdsByTable.get(chartTable.table.tableKey)?.get(chartTable.field.sourceColumn) ??
          chartTable.field.fieldId;
        const reportSpec = {
          formId: `@pack:${chartTable.table.tableKey}`,
          viz: 'bar',
          groupBy: { field: chartFieldId },
          measure: { fn: 'count' },
          seriesSort: 'value',
          sort: 'desc',
          limit: 10,
        };
        reports.push({
          reportId: `rep_${chartTable.table.tableKey}_${chartFieldId}`,
          kind: 'chart',
          name: `${chartTable.table.formTitle} by ${chartTable.field.label}`,
          spec: reportSpec,
        });
        widgets.push({
          id: `chart_${chartTable.table.tableKey}`,
          kind: 'report',
          title: `${chartTable.table.formTitle} by ${chartTable.field.label}`,
          layout: { x: 0, y: 2, w: 6, h: 4 },
          spec: reportSpec,
        });
      }

      const listTable = rankedTables[0] ?? included[included.length - 1];
      const listIdMap = resolvedFieldIdsByTable.get(listTable.tableKey);
      const nonFkListFields = listTable.fields.filter(
        (f) => f.include && f.fieldType !== 'long_text' && f.fieldType !== 'linked_record',
      );
      const listSourceFields = nonFkListFields.length > 0
        ? nonFkListFields
        : listTable.fields.filter((f) => f.include && f.fieldType !== 'long_text');
      const listCols = listSourceFields
        .slice(0, 3)
        .map((f) => listIdMap?.get(f.sourceColumn) ?? f.fieldId);
      widgets.push({
        id: `list_${listTable.tableKey}`,
        kind: 'list',
        title: `Recent ${listTable.formTitle}`,
        layout: { x: chartTable ? 6 : 0, y: 2, w: chartTable ? 6 : 12, h: 4 },
        list: {
          formId: `@pack:${listTable.tableKey}`,
          ...(listCols[0] ? { titleField: listCols[0] } : {}),
          ...(listCols[1] ? { subtitleField: listCols[1] } : {}),
          ...(listCols[2] ? { metaField: listCols[2] } : {}),
          limit: 8,
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
              enabled: true,
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

/** Coerce a serialized Node Buffer (`{ type: 'Buffer', data: [1] }`) if received from a local bridge. */
function unwrapBufferLike(val: unknown): unknown {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const rec = val as { type?: unknown; data?: unknown };
    if (rec.type === 'Buffer' && Array.isArray(rec.data)) {
      if (rec.data.length === 1 && typeof rec.data[0] === 'number') {
        return rec.data[0];
      }
      return rec.data.map((b) => Number(b).toString(16).padStart(2, '0')).join('');
    }
  }
  return val;
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

    const rawVal = unwrapBufferLike(readVal(sourceCol));
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

    if (field.fieldType === 'datetime') {
      const s = String(rawVal).trim();
      const isoDt = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
      answers[fieldId] = isoDt ? `${isoDt[1]}T${isoDt[2]}` : s;
      continue;
    }

    if (field.fieldType === 'time') {
      const s = String(rawVal).trim();
      const timeMatch = s.match(/^(\d{2}:\d{2})/);
      answers[fieldId] = timeMatch ? timeMatch[1] : s;
      continue;
    }

    answers[fieldId] = typeof rawVal === 'object' ? JSON.stringify(rawVal) : rawVal;
  }

  return { clientKey, answers, deferredLinks };
}
