import { describe, expect, it } from 'vitest';
import { adoptIds, designedBackend, designProblems, mergeDesigns } from './databaseDesign';
import { importSql } from './sqlSchema';
import { BOOKINGS_SQLSERVER, SHOP_MYSQL, summary, TASKS_SQLITE } from './__fixtures__/schemas';

describe('a schema from MySQL', () => {
  const read = importSql(SHOP_MYSQL, 'members');

  it('reads each table, its key as its id, its foreign keys as connections and its columns as details', () => {
    expect(read.dialect).toBe('MySQL');
    expect(summary(read.design)).toEqual([
      { name: 'customers', fields: ['name:text!', 'email:text unique'], links: [], stamped: true },
      { name: 'products', fields: ['name:text!', 'price:decimal! =0.00', 'in_stock:boolean! =yes', 'description:longText'], links: [] },
      { name: 'orders', fields: ['status:choice! =new [new|paid|shipped|cancelled]', 'placed_on:date'], links: ['customer_id→customers! restrict'] },
      { name: 'order_lines', fields: ['quantity:integer! =1'], links: ['order_id→orders! cascade', 'product_id→products! restrict'], pairs: true },
    ]);
  });

  it('says what it left out, and makes a backend this host runs', () => {
    expect(read.notes).toEqual(['products.photo: MEDIUMBLOB (binary data) is left out.', 'Passed over: 2 DROP, 1 INSERT.']);
    expect(designProblems(read.design)).toEqual([]);
    expect(designedBackend(read.design).files['server/migrations/001.sql']).toContain("status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped', 'cancelled'))");
    expect(read.design.tables.every(table => table.api.remove)).toBe(true);
  });
});

describe('a schema from SQL Server', () => {
  const read = importSql(BOOKINGS_SQLSERVER, 'application');

  it('reads its scripts: brackets, dbo., IDENTITY, GO, and the defaults, keys and unique index added after the tables', () => {
    expect(read.dialect).toBe('SQL Server');
    expect(summary(read.design)).toEqual([
      { name: 'people', fields: ['full_name:text!', 'email:text', 'bio:longText'], links: [], stamped: true },
      { name: 'sessions', fields: ['title:text!', 'starts_at:dateTime!', 'places:integer! =10', 'is_open:boolean! =yes'], links: [] },
      { name: 'bookings', fields: ['notes:text'], links: ['person_id→people! cascade', 'session_id→sessions! cascade'], pairs: true },
    ]);
    expect(read.notes).toEqual(['people: its key PersonID is its id here.', 'sessions: its key SessionID is its id here.', 'bookings: its key BookingID is its id here.']);
    // An app anyone may open starts with the narrower API.
    expect(read.design.tables[0].api).toEqual({ read: true, add: true, change: false, remove: false });
    expect(designProblems(read.design)).toEqual([]);
  });
});

describe('a schema from SQLite', () => {
  it('reads INTEGER PRIMARY KEY, a CHECK of 0 and 1 as yes or no, a CHECK of words as a list, and REFERENCES on the column', () => {
    const read = importSql(TASKS_SQLITE);
    expect(read.dialect).toBe('SQLite');
    expect(summary(read.design)).toEqual([
      { name: 'projects', fields: ['name:text!', 'notes:longText'], links: [], stamped: true },
      { name: 'tasks', fields: ['title:text!', 'done:boolean! =no', 'due_on:text', 'priority:choice! =normal [low|normal|high]'], links: ['project_id→projects setNull'], stamped: true },
    ]);
    expect(read.notes).toEqual(['Passed over: 1 CREATE VIEW.']);
  });
});

describe('what a schema says that a design cannot', () => {
  it('renames what may not be a name, and says so', () => {
    const read = importSql('CREATE TABLE "Order" ("ID" INT PRIMARY KEY, "From" TEXT, "2nd" TEXT, "Group" INT);\nCREATE TABLE OrderLines (OrderLineID INT IDENTITY(1,1) PRIMARY KEY, UnitPrice MONEY, OrderID INT NOT NULL REFERENCES [Order](ID));');
    expect(summary(read.design)).toEqual([
      { name: 'orders', fields: ['from_value:text', 't_2nd:text', 'groupings:integer'], links: [] },
      { name: 'order_lines', fields: ['unit_price:decimal'], links: ['order_id→orders! restrict'] },
    ]);
    expect(read.notes).toContain('Order is called orders here: its name is a word the database keeps for itself.');
    expect(read.notes).toContain('orders.From is called from_value here.');
    expect(designProblems(read.design)).toEqual([]);
  });

  it('keeps a key that is not a number as a detail no two rows share, and a connection to it as a connection', () => {
    const read = importSql('CREATE TABLE accounts (code VARCHAR(20) PRIMARY KEY, name TEXT);\nCREATE TABLE payments (id INTEGER PRIMARY KEY, account_code VARCHAR(20) REFERENCES accounts(code), amount REAL);');
    expect(summary(read.design)).toEqual([
      { name: 'accounts', fields: ['code:text! unique', 'name:text'], links: [] },
      { name: 'payments', fields: ['amount:decimal'], links: ['account_code→accounts restrict'] },
    ]);
    expect(read.notes).toEqual([
      'accounts: its key code is not a number; it is kept as a detail no two rows share, and each row is numbered by its id.',
      'payments.account_code: refers to accounts.code; here it holds the accounts row’s id, a number.',
    ]);
  });

  it('says what it leaves out: a connection of two columns, one to a table it does not create, a computed column, a default worked out', () => {
    const read = importSql(`CREATE TABLE a (id INT PRIMARY KEY, x INT, y INT, total INT GENERATED ALWAYS AS (x + y) STORED, stamp INT DEFAULT (strftime('%s','now')), code TEXT DEFAULT (lower('A')),
      FOREIGN KEY (x, y) REFERENCES b (p, q), owner_id INT REFERENCES users(id));`);
    expect(summary(read.design)).toEqual([{ name: 'a', fields: ['x:integer', 'y:integer', 'stamp:integer', 'code:text', 'owner_id:integer'], links: [] }]);
    expect(read.notes).toEqual([
      'a: a connection of 2 columns (x, y) is left out; its columns are kept as details.',
      'a.total: a column the database works out is left out.',
      'a.stamp: its default, the time a row is added, is left out (a table keeps that in created_at).',
      'a.code: its default lower(\'A\') is worked out by the database, and is left out.',
      'a.owner_id: refers to users, which the schema does not create; it is kept as a whole number.',
    ]);
  });

  it('turns a required connection that would be emptied into one that refuses, and says so', () => {
    const read = importSql('CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (id INT PRIMARY KEY, p_id INT NOT NULL, FOREIGN KEY (p_id) REFERENCES p(id) ON DELETE SET NULL);');
    expect(summary(read.design)[1].links).toEqual(['p_id→p! restrict']);
    expect(read.notes).toEqual(['c.p_id: it is required, so ON DELETE SET NULL is read as not allowing the removal.']);
    expect(designProblems(read.design)).toEqual([]);
  });

  it('reads columns without types, quoted text with quotes inside, and comments of each kind', () => {
    // The # comment says MySQL, whose TEXT holds long text.
    const read = importSql(`# a MySQL comment\n/* a block\n comment */ CREATE TABLE t (a, b TEXT DEFAULT 'it''s', c VARCHAR(10) DEFAULT N'x') -- the end`);
    expect(read.dialect).toBe('MySQL');
    expect(summary(read.design)).toEqual([{ name: 't', fields: ['a:text', "b:longText =it's", 'c:text =x'], links: [] }]);
  });

  it('says plainly when there is no CREATE TABLE to read', () => {
    const read = importSql('INSERT INTO t VALUES (1);');
    expect(read.design.tables).toEqual([]);
    expect(read.notes[0]).toBe('No CREATE TABLE statement was found. Paste the statements that create the tables.');
  });
});

describe('each database read as it reads its own', () => {
  it('reads a backslash as itself in SQL Server and SQLite, so no table after one is lost', () => {
    const server = importSql("CREATE TABLE [Paths] ([PathID] INT IDENTITY(1,1) PRIMARY KEY, [Sep] NVARCHAR(1) DEFAULT N'\\');\nGO\nCREATE TABLE [Files] ([FileID] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(200));");
    expect(summary(server.design)).toEqual([
      { name: 'paths', fields: ['sep:text =\\'], links: [] },
      { name: 'files', fields: ['name:text'], links: [] },
    ]);
    const lite = importSql("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, sep TEXT DEFAULT '\\');\nCREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT);");
    expect(summary(lite.design).map(table => table.name)).toEqual(['a', 'b']);
  });

  it('reads MySQL’s backslashes, # comments and text in double quotes as MySQL does', () => {
    const read = importSql("CREATE TABLE `notes` (\n  `id` int NOT NULL AUTO_INCREMENT, # its number\n  `body` text,\n  `mark` varchar(5) DEFAULT 'it\\'s',\n  `state` varchar(10) DEFAULT \"new\",\n  PRIMARY KEY (`id`)\n);#done\nCREATE TABLE `tags` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `label` varchar(20) NOT NULL DEFAULT _utf8mb4'none');");
    expect(summary(read.design)).toEqual([
      { name: 'notes', fields: ['body:longText', "mark:text =it's", 'state:text =new'], links: [] },
      { name: 'tags', fields: ['label:text! =none'], links: [] },
    ]);
  });

  it('passes over routines whole in MySQL, its DELIMITER lines, temporary tables and what they hold', () => {
    const read = importSql([
      'CREATE TABLE `a` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `n` int);',
      'CREATE TEMPORARY TABLE `scratch` (`x` int);',
      'DELIMITER $$',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `make_report`()',
      'BEGIN',
      '  CREATE TEMPORARY TABLE report (total INT);',
      '  IF (SELECT COUNT(*) FROM a) > 0 THEN',
      '    CREATE TABLE IF NOT EXISTS kept_report (total INT);',
      '  END IF;',
      'END$$',
      'DELIMITER ;',
      'DELIMITER ;;',
      'CREATE TRIGGER `a_count` BEFORE INSERT ON `a` FOR EACH ROW BEGIN',
      '  IF NEW.n IS NULL THEN SET NEW.n = 0; END IF;',
      'END ;;',
      'DELIMITER ;',
      'CREATE TABLE `b` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `a_id` int, FOREIGN KEY (`a_id`) REFERENCES `a` (`id`));',
    ].join('\n'));
    expect(summary(read.design).map(table => table.name)).toEqual(['a', 'b']);
    expect(read.notes).toEqual(['Passed over: 1 CREATE TEMPORARY TABLE, 1 CREATE PROCEDURE, 1 CREATE TRIGGER.']);
  });

  it('reads a SQLite trigger to its END, and leaves SQLite’s own tables and a search index’s out', () => {
    const read = importSql([
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, changed TEXT);',
      'CREATE TRIGGER items_changed AFTER UPDATE ON items BEGIN',
      "  UPDATE items SET changed = datetime('now') WHERE id = NEW.id;",
      '  SELECT CASE WHEN NEW.name IS NULL THEN RAISE(ABORT, \'a name\') END;',
      'END;',
      'CREATE TABLE sqlite_sequence(name,seq);',
      'CREATE VIRTUAL TABLE items_search USING fts5(name);',
      "CREATE TABLE 'items_search_data'(id INTEGER PRIMARY KEY, block BLOB);",
      "CREATE TABLE 'items_search_config'(k PRIMARY KEY, v) WITHOUT ROWID;",
      'CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);',
    ].join('\n'));
    expect(summary(read.design).map(table => table.name)).toEqual(['items', 'tags']);
    expect(read.notes).toEqual(['Passed over: 1 CREATE TRIGGER, 1 CREATE VIRTUAL TABLE.']);
  });

  it('reads a SQL Server routine to its GO, and passes over #temporary tables', () => {
    const read = importSql([
      'CREATE TABLE dbo.Orders (OrderID INT IDENTITY(1,1) PRIMARY KEY, Total MONEY);',
      'GO',
      'CREATE OR ALTER PROCEDURE dbo.Archive AS',
      'BEGIN',
      '  CREATE TABLE #old (OrderID INT);',
      '  CREATE TABLE dbo.Archived (OrderID INT);',
      'END',
      'GO',
      'CREATE TABLE #scratch (x INT);',
      'CREATE TABLE dbo.Notes (NoteID INT IDENTITY(1,1) PRIMARY KEY, OrderID INT NOT NULL FOREIGN KEY REFERENCES dbo.Orders(OrderID), Body NVARCHAR(MAX));',
    ].join('\n'));
    expect(summary(read.design)).toEqual([
      { name: 'orders', fields: ['total:decimal'], links: [] },
      { name: 'notes', fields: ['body:longText'], links: ['order_id→orders! restrict'] },
    ]);
    expect(read.notes).toEqual(['orders: its key OrderID is its id here.', 'notes: its key NoteID is its id here.', 'Passed over: 1 CREATE PROCEDURE, 1 CREATE TEMPORARY TABLE.']);
  });

  it('reads a column called key as a column, and KEY name (…) as an index', () => {
    const lite = importSql('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);');
    expect(summary(lite.design)[0].fields).toEqual(['key_value:text! unique', 'value:text']);
    const mysql = importSql('CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, `key` varchar(20) NOT NULL, `k2` int, PRIMARY KEY (`id`), KEY `t_key` (`key`), UNIQUE KEY `t_k2` (`k2`), KEY k3 (k2) USING BTREE, KEY date (k2), FULLTEXT KEY `ft` (`key`));');
    expect(summary(mysql.design)).toEqual([{ name: 't', fields: ['key_value:text!', 'k2:integer unique'], links: [] }]);
  });

  it('numbers rows by the column that counts them when the key is something else', () => {
    const read = importSql('CREATE TABLE `countries` (`seq` int NOT NULL AUTO_INCREMENT, `code` char(2) NOT NULL, `name` varchar(80) NOT NULL, PRIMARY KEY (`code`), UNIQUE KEY (`seq`));');
    expect(summary(read.design)).toEqual([{ name: 'countries', fields: ['code:text! unique', 'name:text!'], links: [] }]);
    expect(read.notes).toEqual([
      'countries: its numbering seq is its id here.',
      'countries: its key code is not a number; it is kept as a detail no two rows share, and each row is numbered by its id.',
    ]);
  });

  it('reads a connection that is its table’s key, or unique, as one to one', () => {
    const read = importSql([
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
      'CREATE TABLE profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, about TEXT);',
      'CREATE TABLE badges (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id), shown TEXT);',
      'CREATE TABLE cards (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), CONSTRAINT one_card UNIQUE (user_id));',
    ].join('\n'));
    expect(summary(read.design)).toEqual([
      { name: 'users', fields: ['name:text'], links: [] },
      { name: 'profiles', fields: ['about:text'], links: ['user_id→users! cascade one'] },
      { name: 'badges', fields: ['shown:text'], links: ['user_id→users restrict one'] },
      { name: 'cards', fields: [], links: ['user_id→users! restrict one'] },
    ]);
    expect(read.notes).toEqual(['profiles: its key user_id is its connection, one each; each row is numbered by its id.']);
    expect(designProblems(read.design)).toEqual([]);
  });

  it('keeps each pair of connections once only when that is what the key says, and says what it leaves out', () => {
    const read = importSql([
      'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      'CREATE TABLE b (id INTEGER PRIMARY KEY);',
      'CREATE TABLE c (id INTEGER PRIMARY KEY);',
      'CREATE TABLE ab (a_id INTEGER NOT NULL REFERENCES a(id), b_id INTEGER NOT NULL REFERENCES b(id), PRIMARY KEY (a_id, b_id));',
      'CREATE TABLE abc (a_id INTEGER NOT NULL REFERENCES a(id), b_id INTEGER NOT NULL REFERENCES b(id), c_id INTEGER REFERENCES c(id), slot INTEGER, PRIMARY KEY (a_id, b_id), UNIQUE (a_id, slot));',
    ].join('\n'));
    expect(summary(read.design).slice(3)).toEqual([
      { name: 'ab', fields: [], links: ['a_id→a! restrict', 'b_id→b! restrict'], pairs: true },
      { name: 'abc', fields: ['slot:integer'], links: ['a_id→a! restrict', 'b_id→b! restrict', 'c_id→c restrict'] },
    ]);
    expect(read.notes).toEqual([
      'abc: its key (a_id, b_id) is left out; each row is numbered by its id.',
      'abc: its rule that no two rows share (a_id, slot) is left out.',
    ]);
  });

  it('reads the lists of choices SQL Server and MySQL keep, and says which other checks it leaves out', () => {
    const server = importSql([
      'CREATE TABLE [dbo].[Orders] ([OrderID] INT IDENTITY(1,1) NOT NULL, [Status] NVARCHAR(10) NOT NULL, [Total] MONEY NOT NULL, CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([OrderID]));',
      'GO',
      "ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_Orders_Status] CHECK (([Status]=N'new' OR [Status]=N'paid'));",
      'GO',
      'ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [CK_Orders_Total] CHECK (([Total]>=(0)));',
      'GO',
    ].join('\n'));
    expect(summary(server.design)[0].fields).toEqual(['status:choice! [new|paid]', 'total:decimal!']);
    expect(server.notes).toEqual(['orders: its key OrderID is its id here.', 'orders: its check (Total >= (0)) is left out.']);
    const mysql = importSql([
      'CREATE TABLE `orders` (',
      '  `id` int NOT NULL AUTO_INCREMENT,',
      '  `status` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,',
      '  `qty` int NOT NULL CHECK (`qty` > -1),',
      '  PRIMARY KEY (`id`),',
      "  CONSTRAINT `orders_chk_1` CHECK ((`status` in (_utf8mb4'new',_utf8mb4'paid')))",
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
    ].join('\n'));
    expect(summary(mysql.design)[0].fields).toEqual(['status:choice! [new|paid]', 'qty:integer!']);
    expect(mysql.notes).toEqual(['orders.qty: its check qty > -1 is left out.']);
  });
});

describe('a schema with a design already there', () => {
  it('adds its tables beside the design’s, renaming one whose name is taken', () => {
    const first = importSql(TASKS_SQLITE).design;
    const { design, renamed } = mergeDesigns(first, importSql('CREATE TABLE projects (id INTEGER PRIMARY KEY, title TEXT);').design);
    expect(design.tables.map(table => table.name)).toEqual(['projects', 'tasks', 'projects_2']);
    expect(renamed).toEqual(['projects is added as projects_2: the design has a projects already.']);
  });

  it('read again in its place, keeps each table’s place on the diagram and what the page may do', () => {
    const first = importSql(TASKS_SQLITE).design;
    first.tables[0] = { ...first.tables[0], at: { x: 40, y: 80 }, api: { read: true, add: false, change: false, remove: false } };
    const again = adoptIds(first, importSql(TASKS_SQLITE).design, false);
    expect(again.tables[0]).toMatchObject({ id: first.tables[0].id, at: { x: 40, y: 80 }, api: { read: true, add: false, change: false, remove: false } });
    expect(again.links[0].from).toBe(first.tables[1].id);
  });
});
