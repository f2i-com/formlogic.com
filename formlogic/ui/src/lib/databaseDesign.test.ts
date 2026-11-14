import { describe, expect, it } from 'vitest';
import {
  adoptIds, backendLogic, cleanName, designedBackend, designProblems, designRoutes, EMPTY_DESIGN, fixName, migrationSql,
  nameProblem, newField, newLink, newTable, readDesign, singular, snakeName, withJoin, withoutLink, withoutTable, type DatabaseDesign,
} from './databaseDesign';
import { readMermaid, toMermaid } from './mermaidErd';
import { backendProblem } from './nativeHosting';
import { withBackend } from './softnBackend';
import { importSql } from './sqlSchema';
import { BOOKINGS_SQLSERVER, POSTS_MERMAID, SHOP_MYSQL, TASKS_SQLITE } from './__fixtures__/schemas';

/** The designs the fixtures read as: one from each database, and one from Mermaid. */
const FROM_ELSEWHERE: Record<string, () => DatabaseDesign> = {
  shop: () => importSql(SHOP_MYSQL, 'members').design,
  bookings: () => importSql(BOOKINGS_SQLSERVER, 'members').design,
  tasks: () => importSql(TASKS_SQLITE, 'members').design,
  posts: () => readMermaid(POSTS_MERMAID, 'members').design!,
};

/** A design of named tables, each with the given fields, connected as `links` says (from → to). */
function design(tables: Record<string, ReturnType<typeof newField>[]>, links: [string, string, boolean?][] = []): DatabaseDesign {
  const made = Object.entries(tables).map(([name, fields]) => ({ ...newTable(name, 'members'), fields }));
  let out: DatabaseDesign = { version: 1, tables: made, links: [] };
  for (const [from, to, required] of links) out = { ...out, links: [...out.links, newLink(out, made.find(t => t.name === from)!, made.find(t => t.name === to)!, required ?? true)] };
  return out;
}
const field = (name: string, kind: Parameters<typeof newField>[1] = 'text', more: Partial<ReturnType<typeof newField>> = {}) => ({ ...newField(name, kind), ...more });

/** The functions an SQL text calls, as the runner's authorizer would see them (keywords before `(` left out). */
function calls(sql: string): string[] {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  const keywords = new Set(['in', 'check', 'unique', 'values', 'default', 'references', 'table', 'on', 'key', 'into', 'exists', 'and', 'or', 'not']);
  return [...code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1].toLowerCase())
    .filter((name, index, all) => !keywords.has(name) && all.indexOf(name) === index)
    .filter(name => !/^[a-z_]+$/.test(name) || !sql.match(new RegExp(`(TABLE|INDEX \\w+ ON|REFERENCES|INTO)\\s+${name}\\s*\\(`, 'i')));
}

describe('names', () => {
  it('makes a name of what a person types, and says why one cannot be', () => {
    expect(cleanName('Due date')).toBe('due_date');
    expect(cleanName('  Café Orders! ')).toBe('cafe_orders');
    expect(cleanName('Customer’s notes')).toBe('customers_notes');
    expect(cleanName('Straße')).toBe('strasse');
    expect(nameProblem('', 'table')).toBe('Give the table a name.');
    expect(nameProblem('2nd', 'detail')).toMatch(/starts with a letter/);
    expect(nameProblem('order', 'table')).toBe('“order” is a word the database keeps for itself: try “orders”.');
    expect(nameProblem('rowid', 'detail')).toMatch(/keeps for itself/);
    expect(nameProblem('sqlite_things', 'table')).toMatch(/database’s own/);
    expect(nameProblem('x'.repeat(41), 'table')).toMatch(/40 characters/);
    expect(nameProblem('orders', 'table')).toBeNull();
  });

  it('says one row of a table in words', () => {
    expect(['customers', 'categories', 'boxes', 'classes', 'statuses', 'people', 'order_lines', 'news', 'status', 'data'].map(singular))
      .toEqual(['customer', 'category', 'box', 'class', 'status', 'person', 'order_line', 'news', 'status', 'data']);
  });

  it('makes a name of one from elsewhere, and a name that can be one of a name that cannot', () => {
    expect(['OrderLines', 'HTTPServer', 'customerID', 'Due Date', 'ORDER_LINES'].map(snakeName)).toEqual(['order_lines', 'http_server', 'customer_id', 'due_date', 'order_lines']);
    const taken = new Set(['notes', 'notes_2']);
    expect(['order', 'group', 'from', 'notes', '2fa', '', 'sqlite_seq'].map(name => fixName(name, taken)))
      .toEqual(['orders', 'groupings', 'from_value', 'notes_3', 't_2fa', 'unnamed', 'my_sqlite_seq']);
    for (const name of ['orders', 'groupings', 'from_value', 't_2fa', 'my_sqlite_seq']) expect(nameProblem(name, 'table'), name).toBeNull();
  });
});

describe('what is wrong with a design', () => {
  it('asks for a table first, then names that are names', () => {
    expect(designProblems(EMPTY_DESIGN).map(p => p.text)).toEqual(['Add at least one thing for the app to keep.']);
    const twice = design({ notes: [], other: [] });
    twice.tables[1].name = 'notes';
    expect(designProblems(twice).map(p => [p.step, p.text])).toEqual([['things', 'Two tables are called notes.']]);
    expect(designProblems(design({ order: [] }))[0]).toMatchObject({ step: 'things', text: expect.stringContaining('try “orders”') });
  });

  it('holds details to their table: no id, no created_at, no name twice, choices and defaults that fit', () => {
    const problems = designProblems(design({
      items: [field('id'), field('created_at'), field('size', 'choice', { choices: [] }), field('colour', 'choice', { choices: ['red', 'red'] }),
        field('count', 'integer', { defaultValue: 'many' }), field('due', 'date', { defaultValue: '31/01/2026' }), field('ok', 'boolean', { defaultValue: 'yes' }),
        field('status', 'choice', { choices: ['new', 'done'], defaultValue: 'old' }), field('title'), field('title'), field('when')],
    })).map(p => p.text);
    expect(problems).toEqual([
      'items: every row is numbered by its id already; call this detail something else.',
      'items: created_at keeps when each row was added; call this detail something else.',
      'items, size: give at least one choice.',
      'items, colour: a choice is there twice.',
      'items, count: The default must be a whole number.',
      'items, due: Write the default date as 2026-01-31.',
      'items, status: The default must be one of the choices.',
      'items: two details or connections are called title.',
      'items, when: “when” is a word the database keeps for itself.',
    ]);
  });

  it('holds connections to what can be: a required one is never emptied, and a name is not taken twice', () => {
    const made = design({ customers: [], orders: [field('customer_id')] }, [['orders', 'customers']]);
    expect(designProblems(made).map(p => p.text)).toEqual([]);
    // newLink took the next free name.
    expect(made.links[0].column).toBe('customer_id_2');
    made.links[0].onDelete = 'setNull';
    expect(designProblems(made).map(p => [p.step, p.text])).toEqual([['connections', expect.stringContaining('every order must have a customer, so they cannot be kept without one')]]);
    const join = withJoin(design({ orders: [], products: [] }), { ...newTable('orders'), id: 'nope' }, { ...newTable('products'), id: 'gone' });
    expect(designProblems(join).filter(p => p.step === 'connections').map(p => p.text)).toContain('A connection is to a table that is no longer there.');
  });

  it('refuses connections no row could ever be added under: to itself and required, or round in a ring of required ones', () => {
    const made = design({ comments: [] });
    const self = newLink(made, made.tables[0], made.tables[0]);
    // Made from the diagram or the editor, one to itself starts optional.
    expect([self.required, self.onDelete]).toEqual([false, 'setNull']);
    const required = { ...made, links: [{ ...self, required: true, onDelete: 'cascade' as const }] };
    expect(designProblems(required).map(p => p.text)).toEqual(['comments: a comment that belongs to another cannot be required, or the first could never be added. Make it optional.']);
    const ring = design({ customers: [], addresses: [] }, [['customers', 'addresses'], ['addresses', 'customers']]);
    expect(designProblems(ring).map(p => p.text)).toEqual([
      'customers → addresses → customers: each must have a row of the next, so no row could be added first. Make one of these connections optional.',
      'customers → addresses → customers: removing a row of each removes rows of the next, round to the first. Let one of these connections keep its rows or refuse instead.',
    ]);
    ring.links[1] = { ...ring.links[1], required: false, onDelete: 'setNull' };
    expect(designProblems(ring)).toEqual([]);
  });

  it('finds rings among many tables at once, in a moment however they are chained', () => {
    // Each of 60 tables needs the two before it, round to the first: every path through them is a
    // different ring, far too many to walk, and one group of tables to say.
    const names = Array.from({ length: 60 }, (_, n) => `t${n}`);
    const chain = design(Object.fromEntries(names.map(name => [name, []])));
    const tables = chain.tables;
    chain.links = names.flatMap((_, n) => [1, 2].map(back => ({ ...newLink(chain, tables[n], tables[(n + 60 - back) % 60]), column: `t${(n + 60 - back) % 60}_id`, onDelete: 'restrict' as const })));
    const started = performance.now();
    const problems = designProblems(chain);
    expect(performance.now() - started).toBeLessThan(500);
    expect(problems.filter(p => p.text.includes('no row could be added first'))).toHaveLength(1);
  });

  it('refuses names the runner or the API’s code keep for themselves, and a table whose rows could not come back in one answer', () => {
    expect(nameProblem('pragma_list', 'table')).toBe('Names like this are the database’s own.');
    expect(nameProblem('dbstat', 'table')).toBe('Names like this are the database’s own.');
    expect(nameProblem('constructor', 'detail')).toBe('“constructor” is a word the API’s code keeps for itself.');
    expect(['pragma_list', 'dbstat', 'constructor'].map(name => fixName(name, new Set()))).toEqual(['my_pragma_list', 'dbstat_value', 'constructor_value']);
    const huge = design({ essays: Array.from({ length: 30 }, (_, n) => field(`part_${n}`, 'longText')) });
    expect(designProblems(huge).map(p => p.text)).toEqual(['essays: its long texts together can hold more than one answer of the API may carry. Use fewer long texts in one table.']);
  });

  it('never hangs on long names, and never loses a table to an empty one', () => {
    const long = design({ [`${'a'.repeat(23)}_certifications`]: [], [`${'b'.repeat(20)}_courses`]: [] });
    let joined = withJoin(long, long.tables[0], long.tables[1]);
    joined = withJoin(joined, long.tables[0], long.tables[1]);
    const names = joined.tables.slice(2).map(table => table.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(40);
    const parent = design({ [`${'c'.repeat(39)}s`]: [], kids: [] });
    let linked = { ...parent, links: [newLink(parent, parent.tables[1], parent.tables[0])] };
    linked = { ...linked, links: [...linked.links, newLink(linked, linked.tables[1], linked.tables[0])] };
    expect(new Set(linked.links.map(link => link.column)).size).toBe(2);
    // A name emptied while it is typed: the routes are still shown, and the problem said.
    const unnamed = design({ notes: [field('text')] });
    unnamed.tables[0].name = '';
    expect(() => designRoutes(unnamed)).not.toThrow();
    expect(designProblems(unnamed)[0].text).toBe('A table: Give the table a name.');
  });

  it('has nothing to say of a design read from any of the schemas', () => {
    for (const [name, read] of Object.entries(FROM_ELSEWHERE)) expect(designProblems(read()), name).toEqual([]);
  });
});

describe('what a design makes', () => {
  const shop = FROM_ELSEWHERE.shop();

  it('makes each table after the tables it names, with its checks, its connections and their indexes', () => {
    const sql = migrationSql(shop);
    expect(sql.indexOf('CREATE TABLE customers')).toBeLessThan(sql.indexOf('CREATE TABLE orders'));
    expect(sql.indexOf('CREATE TABLE orders')).toBeLessThan(sql.indexOf('CREATE TABLE order_lines'));
    expect(sql).toContain("status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped', 'cancelled'))");
    expect(sql).toContain('in_stock INTEGER NOT NULL DEFAULT 1 CHECK (in_stock IN (0, 1))');
    expect(sql).toContain('email TEXT UNIQUE,');
    const contacts = design({ people: [field('email', 'email'), field('site', 'url'), field('born', 'date'), field('seen', 'dateTime')] });
    expect(migrationSql(contacts)).toContain("email TEXT CHECK (email LIKE '%_@_%'),\n  site TEXT CHECK (site LIKE 'http://%' OR site LIKE 'https://%'),");
    expect(sql).toContain('customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT');
    expect(sql).toContain('order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE (order_id, product_id)');
    expect(sql).toContain('CREATE INDEX orders_customer_id ON orders(customer_id);');
    // The unique pair's own index serves its first column: only the second has one of its own.
    expect(sql).not.toContain('CREATE INDEX order_lines_order_id');
    expect(sql).toContain('CREATE INDEX order_lines_product_id ON order_lines(product_id);');
  });

  it('writes a migration of tables and indexes only, calling nothing but the clock in a default', () => {
    for (const [name, read] of Object.entries(FROM_ELSEWHERE)) {
      const sql = migrationSql(read());
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) expect(statement, name).toMatch(/^CREATE (TABLE|INDEX) /);
      expect(calls(sql).filter(call => call !== 'datetime'), name).toEqual([]);
      expect(sql).not.toMatch(/--|PRAGMA|TRIGGER|VIEW/);
    }
  });

  it('serves a route for each thing the page may do, one handler each', () => {
    const routes = designRoutes(shop).filter(route => route.path === '/api/orders');
    expect(routes.map(route => `${route.method} ${route.handler}`)).toEqual(['GET listOrders', 'POST addOrder', 'PUT changeOrder', 'DELETE removeOrder']);
    const handlers = designRoutes(shop).map(route => route.handler);
    expect(new Set(handlers).size).toBe(handlers.length);
    // Read-only, nothing, and a table with nothing to change: no PUT for it.
    const narrow = design({ notes: [field('text')], marks: [], quiet: [field('x')] });
    narrow.tables[0].api = { read: true, add: false, change: false, remove: false };
    narrow.tables[2].api = { read: false, add: false, change: false, remove: false };
    expect(designRoutes(narrow).map(route => `${route.method} ${route.path}`)).toEqual(['GET /api/notes', 'GET /api/marks', 'POST /api/marks', 'DELETE /api/marks']);
    expect(backendLogic(narrow)).toContain('INSERT INTO marks DEFAULT VALUES');
    expect(backendLogic(narrow)).not.toContain('function quietFields');
  });

  it('gives tables whose rows share a name handlers of their own, and no two functions one name', () => {
    const twins = design({ box: [field('a')], boxes: [field('b')] });
    const handlers = designRoutes(twins).map(route => route.handler);
    expect(new Set(handlers).size).toBe(handlers.length);
    expect(handlers).toContain('addToBoxes');
    for (const tables of [{ fields: [field('a')], list: [field('b')] }, { item_2: [field('a')], item2: [field('b')] }]) {
      const logic = backendLogic(design(tables));
      const declared = [...logic.matchAll(/^function (\w+)\(/gm)].map(match => match[1]);
      expect(new Set(declared).size, Object.keys(tables).join(' and ')).toBe(declared.length);
    }
  });

  it('checks what a removal would take with it, down the connections that remove their rows too', () => {
    // A customer's orders go with it, but an order may not lose its lines: removing the customer is refused first.
    const chain = FROM_ELSEWHERE.shop();
    const [customers, , orders] = chain.tables;
    chain.links = chain.links.map(link => link.to === customers.id ? { ...link, onDelete: 'cascade' } : link.to === orders.id ? { ...link, onDelete: 'restrict' } : link);
    const logic = backendLogic(chain);
    expect(logic).toContain('softn.sql.first("SELECT id FROM order_lines WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ?) LIMIT 1", [id])) return {status: 409, body: {error: "This customer still has order lines, through its orders: remove those first"}};');
  });

  it('checks a whole tree that removes its own rows, so a row that may not go anywhere below is found first', () => {
    const shelf = design({ categories: [], products: [] });
    const [categories, products] = shelf.tables;
    shelf.links = [
      { ...newLink(shelf, categories, categories), column: 'parent_id', required: false, onDelete: 'cascade' },
      { ...newLink(shelf, products, categories), column: 'category_id', required: true, onDelete: 'restrict' },
    ];
    expect(designProblems(shelf)).toEqual([]);
    const logic = backendLogic(shelf);
    expect(logic).toContain('softn.sql.first("SELECT id FROM products WHERE category_id IN (WITH RECURSIVE gone_1(id) AS (SELECT ? UNION SELECT categories.id FROM categories JOIN gone_1 ON categories.parent_id = gone_1.id) SELECT id FROM gone_1) LIMIT 1", [id])) return {status: 409');
  });

  it('keeps one-to-one connections unique, in the database and in the API', () => {
    const people = design({ users: [field('name')], profiles: [field('bio', 'longText')] }, [['profiles', 'users']]);
    people.links[0] = { ...people.links[0], unique: true };
    const sql = migrationSql(people);
    expect(sql).toContain('user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE');
    expect(sql).not.toContain('CREATE INDEX profiles_user_id');
    expect(backendLogic(people)).toContain('if (values["user_id"] !== null && softn.sql.first("SELECT id FROM profiles WHERE user_id = ? AND id <> ?", [values["user_id"], id])) return {status: 409, body: {error: "user_id: that user has a profile already"}};');
  });

  it('pages a table of long texts in fewer rows, so a page always fits in one answer', () => {
    const logic = backendLogic(FROM_ELSEWHERE.tasks());
    // projects has a long text (20,000 characters, three bytes each at most): 24 rows a page at most;
    // tasks has three short texts (1,000 each): 170. The comment above each says the same.
    expect(logic).toContain('let page = paging(query, 24);');
    expect(logic).toContain('// GET /api/projects: the newest first, 24 at a time (?limit= up to 24, ?offset=)');
    expect(logic).toContain('let page = paging(query, 170);');
    expect(logic).toContain('// GET /api/tasks: the newest first, 50 at a time (?limit= up to 170, ?offset=)');
    expect(logic).toContain('let limit = query.limit === undefined ? (most < 50 ? most : 50) : wholeNumber(query.limit);');
  });

  it('checks every row a write names and every unique value before it writes, and what a removal would break', () => {
    const logic = backendLogic(shop);
    expect(logic).toContain('if (!softn.sql.first("SELECT id FROM customers WHERE id = ?", [values["customer_id"]])) return {status: 422');
    expect(logic).toContain('softn.sql.first("SELECT id FROM customers WHERE email = ? AND id <> ?", [values["email"], id])) return {status: 409');
    expect(logic).toContain('softn.sql.first("SELECT id FROM order_lines WHERE order_id = ? AND product_id = ?", [values["order_id"], values["product_id"]])');
    expect(logic).toContain('if (softn.sql.first("SELECT id FROM orders WHERE customer_id = ? LIMIT 1", [id])) return {status: 409, body: {error: "This customer still has orders: remove those first"}};');
    // An optional connection is checked only when given.
    const tasks = backendLogic(FROM_ELSEWHERE.tasks());
    expect(tasks).toContain('if (values["project_id"] !== null && !softn.sql.first("SELECT id FROM projects WHERE id = ?"');
    // The SQL it runs calls none of the functions a request may not.
    for (const match of logic.matchAll(/softn\.sql\.(?:query|first|execute)\("([^"]*)"/g)) expect(calls(match[1]), match[1]).toEqual([]);
    expect(logic).not.toMatch(/RETURNING|\/\^/);
  });

  it('is a backend this host runs, added to a page that has none', () => {
    const page = { version: 3, files: { 'manifest.json': '{"id":"app.one","main":"index.html"}', 'index.html': '<App/>' }, assets: {} };
    const next = withBackend(page, designedBackend(shop));
    const manifest = JSON.parse(next.files['manifest.json']);
    expect(backendProblem(manifest, next.files)).toBeNull();
    expect(manifest.server.database.migrations).toEqual(['server/migrations/001.sql']);
    expect(manifest.server.routes).toContainEqual({ path: '/api/orders', method: 'PUT', handler: 'changeOrder', transaction: 'write', authorization: 'anonymous' });
    expect(manifest.server.routes).toContainEqual({ path: '/api/orders', method: 'GET', handler: 'listOrders', transaction: 'read', authorization: 'anonymous' });
    expect(manifest.config.server.allowedOrigins).toEqual(['https://app.example']);
    expect(next.files['index.html']).toBe('<App/>');
  });

  it('makes nothing of a design with something to fix: no name or default reaches SQL unchecked', () => {
    const bad = design({ notes: [field('size', 'integer', { defaultValue: '1); DROP TABLE notes; --' })] });
    expect(() => designedBackend(bad)).toThrow('notes, size: The default must be a whole number.');
    const named = design({ notes: [] });
    named.tables[0].name = 'notes(id); --';
    expect(() => designedBackend(named)).toThrow('starts with a letter');
  });
});

describe('changing a design', () => {
  it('joins two tables whose rows each have many of the other, at most once each', () => {
    const made = design({ students: [], courses: [] });
    const joined = withJoin(made, made.tables[0], made.tables[1], 'application');
    const join = joined.tables[2];
    expect(join).toMatchObject({ name: 'students_courses', uniqueLinks: true, api: { read: true, add: true, change: false, remove: true } });
    expect(joined.links.map(link => [link.from, link.to, link.column, link.required, link.onDelete])).toEqual([
      [join.id, made.tables[0].id, 'student_id', true, 'cascade'], [join.id, made.tables[1].id, 'course_id', true, 'cascade'],
    ]);
    expect(withJoin(joined, made.tables[0], made.tables[1]).tables[3].name).toBe('students_courses_2');
    // A join left with one connection keeps no pairs: there is nothing to keep once.
    const left = withoutTable(joined, made.tables[0].id);
    expect(left.links.map(link => link.column)).toEqual(['course_id']);
    expect(left.tables.find(table => table.name === 'students_courses')!.uniqueLinks).toBe(false);
    expect(withoutLink(joined, joined.links[0].id).tables[2].uniqueLinks).toBe(false);
    expect(designProblems(left)).toEqual([]);
  });

  it('gives a new table the API that fits who can open the app', () => {
    expect(newTable('notes', 'members').api).toEqual({ read: true, add: true, change: true, remove: true });
    expect(newTable('notes', 'application').api).toEqual({ read: true, add: true, change: false, remove: false });
  });

  it('reads back a kept design, and nothing that is not one', () => {
    const kept = JSON.parse(JSON.stringify(FROM_ELSEWHERE.bookings()));
    expect(readDesign(kept)).toEqual(kept);
    expect(readDesign({ ...kept, version: 2 })).toBeNull();
    expect(readDesign({ ...kept, tables: [{ ...kept.tables[0], fields: [{ ...kept.tables[0].fields[0], kind: 'money' }] }] })).toBeNull();
    // A flag that is not true or false would be written into the API's code as it is.
    expect(readDesign({ ...kept, tables: [{ ...kept.tables[0], fields: [{ ...kept.tables[0].fields[0], required: 'true}; evil(); {' }] }] })).toBeNull();
    expect(readDesign({ ...kept, links: [{ ...kept.links[0], required: 1 }] })).toBeNull();
    expect(readDesign('{}')).toBeNull();
    expect(readDesign(null)).toBeNull();
  });

  it('keeps a table renamed in the text as the same table, with all it had', () => {
    const shop = FROM_ELSEWHERE.shop();
    const orders = shop.tables[2];
    const kept = { ...shop, tables: shop.tables.map(table => table.id === orders.id ? { ...table, at: { x: 5, y: 9 }, api: { read: true, add: true, change: false, remove: false } } : table) };
    const renamed = adoptIds(kept, readMermaid(toMermaid(kept).replace(/\borders\b/g, 'purchases'), 'members').design!, true);
    const purchases = renamed.tables.find(table => table.name === 'purchases')!;
    expect(purchases).toMatchObject({ id: orders.id, at: { x: 5, y: 9 }, api: { read: true, add: true, change: false, remove: false } });
    // Its connection to customers still refuses a removal, as the design said: Mermaid cannot say it.
    expect(renamed.links.find(link => link.from === orders.id)!.onDelete).toBe('restrict');
  });
});
