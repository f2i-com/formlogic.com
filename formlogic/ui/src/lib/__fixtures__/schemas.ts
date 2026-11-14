// Schemas made elsewhere, as each database's own tools write them, for the database designer's tests
// (lib/sqlSchema, lib/mermaidErd) and its run on a real runner (fl-design-check). Made-up tables only.
import { tableById, type DatabaseDesign } from '../databaseDesign';

/** A design in words, for a test to compare: each table's details (name:kind, ! required, = default, [choices]), connections (one: one to one) and flags. */
export function summary(design: DatabaseDesign) {
  return design.tables.map(table => ({
    name: table.name,
    fields: table.fields.map(f => `${f.name}:${f.kind}${f.required ? '!' : ''}${f.unique ? ' unique' : ''}${f.defaultValue ? ` =${f.defaultValue}` : ''}${f.kind === 'choice' ? ` [${f.choices.join('|')}]` : ''}`),
    links: design.links.filter(link => link.from === table.id).map(link => `${link.column}→${tableById(design, link.to)?.name}${link.required ? '!' : ''} ${link.onDelete}${link.unique ? ' one' : ''}`),
    ...(table.stamped ? { stamped: true } : {}),
    ...(table.uniqueLinks ? { pairs: true } : {}),
  }));
}

/** As mysqldump writes it: backticks, AUTO_INCREMENT, ENUM, TINYINT(1), indexes and keys at the end, rows after. */
export const SHOP_MYSQL = `-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
DROP TABLE IF EXISTS \`customers\`;
CREATE TABLE \`customers\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(120) NOT NULL,
  \`email\` varchar(255) DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`customers_email\` (\`email\`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS \`products\`;
CREATE TABLE \`products\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(200) NOT NULL,
  \`price\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`in_stock\` tinyint(1) NOT NULL DEFAULT '1',
  \`description\` text,
  \`photo\` mediumblob,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE \`orders\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`customer_id\` int unsigned NOT NULL,
  \`status\` enum('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
  \`placed_on\` date DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`orders_customer\` (\`customer_id\`),
  CONSTRAINT \`orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE \`order_lines\` (
  \`order_id\` int NOT NULL,
  \`product_id\` int NOT NULL,
  \`quantity\` int NOT NULL DEFAULT 1,
  PRIMARY KEY (\`order_id\`,\`product_id\`),
  CONSTRAINT \`lines_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`lines_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`)
) ENGINE=InnoDB;

LOCK TABLES \`customers\` WRITE;
INSERT INTO \`customers\` VALUES (1,'Ann Example','ann@example.test','2026-01-01 00:00:00');
UNLOCK TABLES;
`;

/** As SQL Server Management Studio scripts it: [brackets], dbo., IDENTITY, GO lines, defaults and keys added after. */
export const BOOKINGS_SQLSERVER = `USE [Bookings]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[People](
	[PersonID] [int] IDENTITY(1,1) NOT NULL,
	[FullName] [nvarchar](100) NOT NULL,
	[Email] [nvarchar](255) NULL,
	[Bio] [nvarchar](max) NULL,
	[CreatedAt] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_People] PRIMARY KEY CLUSTERED
(
	[PersonID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
CREATE TABLE [dbo].[Sessions](
	[SessionID] [int] IDENTITY(1,1) NOT NULL,
	[Title] [nvarchar](200) NOT NULL,
	[StartsAt] [datetime2](7) NOT NULL,
	[Places] [int] NOT NULL,
	[IsOpen] [bit] NOT NULL,
 CONSTRAINT [PK_Sessions] PRIMARY KEY CLUSTERED ([SessionID] ASC)
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Bookings](
	[BookingID] [int] IDENTITY(1,1) NOT NULL,
	[PersonID] [int] NOT NULL,
	[SessionID] [int] NOT NULL,
	[Notes] [nvarchar](500) NULL,
 CONSTRAINT [PK_Bookings] PRIMARY KEY CLUSTERED ([BookingID] ASC)
) ON [PRIMARY]
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_Bookings_Person_Session] ON [dbo].[Bookings]
(
	[PersonID] ASC,
	[SessionID] ASC
)
GO
ALTER TABLE [dbo].[People] ADD  CONSTRAINT [DF_People_CreatedAt]  DEFAULT (getdate()) FOR [CreatedAt]
GO
ALTER TABLE [dbo].[Sessions] ADD  CONSTRAINT [DF_Sessions_Places]  DEFAULT ((10)) FOR [Places]
GO
ALTER TABLE [dbo].[Sessions] ADD  CONSTRAINT [DF_Sessions_IsOpen]  DEFAULT ((1)) FOR [IsOpen]
GO
ALTER TABLE [dbo].[Bookings]  WITH CHECK ADD  CONSTRAINT [FK_Bookings_People] FOREIGN KEY([PersonID])
REFERENCES [dbo].[People] ([PersonID])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[Bookings] CHECK CONSTRAINT [FK_Bookings_People]
GO
ALTER TABLE [dbo].[Bookings]  WITH CHECK ADD  CONSTRAINT [FK_Bookings_Sessions] FOREIGN KEY([SessionID])
REFERENCES [dbo].[Sessions] ([SessionID])
ON DELETE CASCADE
GO
`;

/** As SQLite keeps it (sqlite3 .schema): INTEGER PRIMARY KEY, CHECK (… IN …), REFERENCES on the column. */
export const TASKS_SQLITE = `PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE "tasks" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "done" INTEGER NOT NULL DEFAULT 0 CHECK ("done" IN (0, 1)),
  "due_on" TEXT,
  "project_id" INTEGER REFERENCES "projects"("id") ON DELETE SET NULL,
  "priority" TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX tasks_project ON tasks(project_id);
CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE done = 0;
`;

/** As someone writes one by hand in Mermaid's editor: singular names in capitals, its own types, labels that are verbs. */
export const POSTS_MERMAID = `erDiagram
    %% A blog: authors write posts, readers comment on them.
    AUTHOR ||--|{ POST : writes
    POST ||--o{ COMMENT : has
    AUTHOR {
        int author_id PK
        string name "required"
        string email UK
    }
    POST {
        int id PK
        string title "required"
        text body
        bool published "default: no"
        int author_id FK
    }
    COMMENT {
        int id PK
        string name
        string message "required"
        int post_id FK
    }
`;
