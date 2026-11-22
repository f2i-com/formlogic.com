import type { FieldType } from '../../types/form';

export type SqlDialect =
  | 'auto'
  | 'mysql'
  | 'postgresql'
  | 'mssql'
  | 'sqlite'
  | 'oracle'
  | 'prisma'
  | 'json'
  | 'csv';

export type ResolvedDialect = Exclude<SqlDialect, 'auto'>;

export type ForeignKeySource = 'explicit' | 'inferred' | 'manual';

export interface ImportedForeignKey {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete?: string;
  source?: ForeignKeySource;
}

export interface ImportedColumn {
  name: string;
  rawType: string;
  normalizedType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  defaultValue?: string;
  enumValues?: string[];
  foreignKey?: ImportedForeignKey;
  comment?: string;
}

export interface ImportedTable {
  /** Normalized identifier used as stable key within this import session. */
  key: string;
  /** Original table name from the source schema. */
  name: string;
  /** Optional DB schema / namespace (e.g. dbo, public). */
  schemaName?: string;
  columns: ImportedColumn[];
  primaryKeys: string[];
  foreignKeys: ImportedForeignKey[];
  /** Rows extracted inline (from SQL INSERT/COPY, .sqlite binary, CSV, JSON, or preview). */
  rows: Array<Record<string, unknown>>;
  /** Total known row count (may exceed rows.length when streaming via local bridge). */
  totalRowCount?: number;
  sourceNote?: string;
}

export interface ImportedSchema {
  dialect: ResolvedDialect;
  sourceLabel: string;
  tables: ImportedTable[];
  warnings: string[];
  /** Present when schema came from a live local loopback bridge so Step 4 can stream batches. */
  localBridge?: LocalBridgeSession;
}

export interface FieldMapping {
  /** Original DB column name. */
  sourceColumn: string;
  /** Safe FormLogic field ID (unique within form, not reserved). */
  fieldId: string;
  /** Human-readable form field label. */
  label: string;
  /** Raw SQL/source type shown for reference. */
  rawType: string;
  /** Mapped FormLogic field type. */
  fieldType: FieldType;
  /** Whether to include this column as a field on the generated form. */
  include: boolean;
  /** Whether the field is required on the form. */
  required: boolean;
  /** Whether this column is the source table's primary key. */
  isPrimaryKey: boolean;
  /** Whether this column is auto-increment/identity. */
  isAutoIncrement: boolean;
  /** Choice options for dropdown / multiple_choice / checkboxes. */
  options?: Array<{ id: string; label: string; value: string }>;
  /** Target table key when fieldType === 'linked_record'. */
  targetTableKey?: string;
  /** Target primary key column name when fieldType === 'linked_record'. */
  targetColumn?: string;
  /** How this foreign-key relationship was discovered ('explicit' SQL FK, 'inferred' naming match, or 'manual'). */
  fkSource?: ForeignKeySource;
  /** Whether linked_record allows multiple selections. */
  allowMultiple?: boolean;
}

export interface TableMapping {
  tableKey: string;
  sourceName: string;
  schemaName?: string;
  formTitle: string;
  description: string;
  include: boolean;
  /** True for migration/internal tables (e.g. _phinxlog, sysdiagrams, __EFMigrationsHistory). */
  isSystemTable?: boolean;
  /** Source column acting as legacy PK for FK remapping during data import. */
  primaryKeyColumn: string | null;
  /** FormLogic field IDs used as display labels when another form links here. */
  displayFieldIds: string[];
  fields: FieldMapping[];
  /** Rows already loaded into memory (from SQL dump, .sqlite, CSV/JSON). */
  initialRows: Array<Record<string, unknown>>;
  totalRowCount?: number;
}

export interface MaterializedTable {
  tableKey: string;
  sourceName: string;
  formId: string;
  formTitle: string;
  primaryKeyColumn: string | null;
  fields: FieldMapping[];
  /** Target form ID map for each linked_record field on this form. */
  linkedFieldTargets: Record<string, { targetTableKey: string; targetFormId: string; allowMultiple: boolean }>;
}

export interface MaterializedMigration {
  mode: 'new_app' | 'existing_app' | 'standalone_forms';
  appId?: string;
  appSlug?: string;
  appName?: string;
  unifiedSqliteEnabled?: boolean;
  published?: boolean;
  tables: MaterializedTable[];
}

export type LocalBridgeDriver = 'mysql' | 'postgresql' | 'mssql' | 'sqlite';

export interface LocalBridgeConnection {
  bridgeUrl: string;
  token: string;
  driver: LocalBridgeDriver;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  filePath: string;
  ssl: boolean;
  /** MSSQL Windows Integrated Authentication (optional). */
  trustedConnection?: boolean;
}

export interface LocalBridgeSession {
  bridgeUrl: string;
  token: string;
  driver: LocalBridgeDriver;
  connectionPayload: Record<string, unknown>;
}

export interface SampleSchemaPreset {
  id: string;
  name: string;
  dialect: ResolvedDialect;
  badge: string;
  summary: string;
  sql: string;
}

export const SAMPLE_SCHEMAS: readonly SampleSchemaPreset[] = [
  {
    id: 'mysql-ecommerce',
    name: 'MySQL E-Commerce Store',
    dialect: 'mysql',
    badge: 'MySQL',
    summary: '4 linked tables (customers, categories, products, orders) + sample INSERT rows',
    sql: `-- MySQL 8.0 Schema + Sample Data
CREATE TABLE \`customers\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`full_name\` VARCHAR(120) NOT NULL,
  \`email\` VARCHAR(190) NOT NULL,
  \`phone\` VARCHAR(32) NULL,
  \`tier\` ENUM('Standard', 'Silver', 'Gold', 'VIP') NOT NULL DEFAULT 'Standard',
  \`marketing_opt_in\` TINYINT(1) NOT NULL DEFAULT 0,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_customers_email\` (\`email\`)
) ENGINE=InnoDB;

CREATE TABLE \`categories\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(80) NOT NULL,
  \`description\` TEXT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;

CREATE TABLE \`products\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`sku\` VARCHAR(40) NOT NULL,
  \`name\` VARCHAR(160) NOT NULL,
  \`category_id\` INT UNSIGNED NOT NULL,
  \`unit_price\` DECIMAL(10, 2) NOT NULL,
  \`stock_qty\` INT NOT NULL DEFAULT 0,
  \`active\` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`fk_products_category\` FOREIGN KEY (\`category_id\`) REFERENCES \`categories\` (\`id\`)
) ENGINE=InnoDB;

CREATE TABLE \`orders\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`order_number\` VARCHAR(32) NOT NULL,
  \`customer_id\` INT UNSIGNED NOT NULL,
  \`product_id\` INT UNSIGNED NOT NULL,
  \`quantity\` INT NOT NULL DEFAULT 1,
  \`total_amount\` DECIMAL(10, 2) NOT NULL,
  \`status\` ENUM('Pending', 'Paid', 'Shipped', 'Delivered', 'Cancelled') NOT NULL DEFAULT 'Pending',
  \`order_date\` DATE NOT NULL,
  \`notes\` TEXT NULL,
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`fk_orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`),
  CONSTRAINT \`fk_orders_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`)
) ENGINE=InnoDB;

INSERT INTO \`customers\` (\`id\`, \`full_name\`, \`email\`, \`phone\`, \`tier\`, \`marketing_opt_in\`, \`created_at\`) VALUES
  (1, 'Ada Lovelace', 'ada@analytical.example', '+1-555-0101', 'VIP', 1, '2026-01-14 09:30:00'),
  (2, 'Grace Hopper', 'grace@compiler.example', '+1-555-0102', 'Gold', 1, '2026-02-02 14:15:00'),
  (3, 'Alan Turing', 'alan@bletchley.example', '+1-555-0103', 'Silver', 0, '2026-03-10 11:00:00');

INSERT INTO \`categories\` (\`id\`, \`name\`, \`description\`) VALUES
  (10, 'Hardware', 'Precision field sensors and compact controllers'),
  (11, 'Accessories', 'Cables, cases, and mounting kits');

INSERT INTO \`products\` (\`id\`, \`sku\`, \`name\`, \`category_id\`, \`unit_price\`, \`stock_qty\`, \`active\`) VALUES
  (100, 'SEN-400', 'Environmental Sensor Pro', 10, 149.00, 42, 1),
  (101, 'HUB-210', 'Edge Gateway Mini', 10, 289.50, 18, 1),
  (102, 'MNT-015', 'Weatherproof Pole Mount', 11, 34.95, 110, 1);

INSERT INTO \`orders\` (\`id\`, \`order_number\`, \`customer_id\`, \`product_id\`, \`quantity\`, \`total_amount\`, \`status\`, \`order_date\`, \`notes\`) VALUES
  (1000, 'ORD-2026-001', 1, 100, 2, 298.00, 'Delivered', '2026-04-01', 'Priority courier delivery'),
  (1001, 'ORD-2026-002', 2, 101, 1, 289.50, 'Shipped', '2026-04-05', 'Include calibration sheet'),
  (1002, 'ORD-2026-003', 3, 102, 4, 139.80, 'Paid', '2026-04-08', NULL);
`,
  },
  {
    id: 'postgres-crm',
    name: 'PostgreSQL SaaS CRM',
    dialect: 'postgresql',
    badge: 'PostgreSQL',
    summary: '3 tables with custom ENUMs, self-referencing manager link, and COPY rows',
    sql: `-- PostgreSQL 16 Schema + COPY data
CREATE TYPE deal_stage AS ENUM ('Lead', 'Qualified', 'Proposal', 'Won', 'Lost');

CREATE TABLE public.accounts (
  id BIGSERIAL PRIMARY KEY,
  company_name VARCHAR(160) NOT NULL,
  website VARCHAR(255),
  industry VARCHAR(80),
  annual_revenue NUMERIC(12, 2),
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE public.team_members (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  role_title VARCHAR(80) NOT NULL,
  manager_id BIGINT REFERENCES public.team_members(id)
);

CREATE TABLE public.deals (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  account_id BIGINT NOT NULL REFERENCES public.accounts(id),
  owner_id BIGINT REFERENCES public.team_members(id),
  stage deal_stage NOT NULL DEFAULT 'Lead',
  deal_value NUMERIC(12, 2) NOT NULL,
  expected_close DATE,
  summary TEXT
);

COPY public.accounts (id, company_name, website, industry, annual_revenue, is_active) FROM stdin;
1	Northwind Logistics	https://northwind.example	Supply Chain	4800000.00	t
2	Helios Solar Grid	https://helios.example	Clean Energy	12500000.00	t
\\.

COPY public.team_members (id, full_name, email, role_title, manager_id) FROM stdin;
10	Maya Lin	maya@crm.example	VP Sales	\\N
11	Liam Patel	liam@crm.example	Account Executive	10
\\.

COPY public.deals (id, title, account_id, owner_id, stage, deal_value, expected_close, summary) FROM stdin;
501	Fleet Telemetry Rollout	1	11	Proposal	84000.00	2026-06-30	Multi-depot sensor deployment
502	Substation Monitoring Annual	2	10	Won	142500.00	2026-05-15	3-year enterprise license
\\.
`,
  },
  {
    id: 'mssql-helpdesk',
    name: 'SQL Server IT Helpdesk',
    dialect: 'mssql',
    badge: 'MSSQL',
    summary: '3 T-SQL tables ([dbo], IDENTITY, NVARCHAR, CHECK constraints) + INSERTs',
    sql: `-- Microsoft SQL Server (T-SQL) Schema + Sample Rows
CREATE TABLE [dbo].[Departments] (
  [DepartmentID] INT IDENTITY(1,1) NOT NULL,
  [DepartmentName] NVARCHAR(100) NOT NULL,
  [CostCenter] NVARCHAR(24) NULL,
  CONSTRAINT [PK_Departments] PRIMARY KEY CLUSTERED ([DepartmentID])
);
GO

CREATE TABLE [dbo].[Agents] (
  [AgentID] INT IDENTITY(1,1) NOT NULL,
  [FullName] NVARCHAR(120) NOT NULL,
  [Email] NVARCHAR(190) NOT NULL,
  [DepartmentID] INT NOT NULL,
  [OnCall] BIT NOT NULL DEFAULT 0,
  CONSTRAINT [PK_Agents] PRIMARY KEY CLUSTERED ([AgentID])
);
GO

CREATE TABLE [dbo].[Tickets] (
  [TicketID] INT IDENTITY(1,1) NOT NULL,
  [Subject] NVARCHAR(200) NOT NULL,
  [Description] NVARCHAR(MAX) NULL,
  [Priority] NVARCHAR(20) NOT NULL CHECK ([Priority] IN ('Low', 'Medium', 'High', 'Critical')),
  [Status] NVARCHAR(24) NOT NULL CHECK ([Status] IN ('Open', 'In Progress', 'Waiting', 'Resolved')),
  [DepartmentID] INT NOT NULL,
  [AssignedAgentID] INT NULL,
  [DueDate] DATE NULL,
  CONSTRAINT [PK_Tickets] PRIMARY KEY CLUSTERED ([TicketID])
);
GO

ALTER TABLE [dbo].[Agents] WITH CHECK ADD CONSTRAINT [FK_Agents_Departments]
  FOREIGN KEY ([DepartmentID]) REFERENCES [dbo].[Departments] ([DepartmentID]);
GO

ALTER TABLE [dbo].[Tickets] WITH CHECK ADD CONSTRAINT [FK_Tickets_Departments]
  FOREIGN KEY ([DepartmentID]) REFERENCES [dbo].[Departments] ([DepartmentID]);
GO

ALTER TABLE [dbo].[Tickets] WITH CHECK ADD CONSTRAINT [FK_Tickets_Agents]
  FOREIGN KEY ([AssignedAgentID]) REFERENCES [dbo].[Agents] ([AgentID]);
GO

INSERT INTO [dbo].[Departments] ([DepartmentID], [DepartmentName], [CostCenter]) VALUES
  (1, N'Infrastructure', N'CC-100'),
  (2, N'Workplace Apps', N'CC-200');
GO

INSERT INTO [dbo].[Agents] ([AgentID], [FullName], [Email], [DepartmentID], [OnCall]) VALUES
  (10, N'Sam Rivera', N'sam@helpdesk.example', 1, 1),
  (11, N'Priya Nair', N'priya@helpdesk.example', 2, 0);
GO

INSERT INTO [dbo].[Tickets] ([TicketID], [Subject], [Description], [Priority], [Status], [DepartmentID], [AssignedAgentID], [DueDate]) VALUES
  (500, N'VPN latency on Sydney gateway', N'Packet loss spikes above 4% during morning standup.', N'High', N'In Progress', 1, 10, '2026-05-20'),
  (501, N'Provision onboarding forms for HR', N'Create digital intake workflow for Q3 hires.', N'Medium', N'Open', 2, 11, '2026-05-25');
GO
`,
  },
];
