<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeRecordStore;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The data manager's reads (NativeRecordStore::overview, browse, structure) on an in-memory
 * database: page sizes, sorting, search, filters, counts, cut previews, stamps and the structure
 * view, and that a hidden column takes part in none of them but a stamp's hash.
 */
final class NativeRecordBrowseTest extends TestCase
{
    private PDO $db;
    private NativeRecordStore $store;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("
            CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'new', api_key TEXT DEFAULT 'k-default');
            CREATE TABLE bookings(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE, room TEXT, starts_at TEXT, seats INTEGER, price REAL, notes TEXT, photo BLOB, session_token TEXT, UNIQUE(room, starts_at));
            CREATE INDEX idx_bookings_customer ON bookings(customer_id);
            CREATE TABLE payments(id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL REFERENCES bookings, amount REAL);
            CREATE TABLE _softn_migrations(id INTEGER PRIMARY KEY);
        ");
        $this->store = new NativeRecordStore($this->db);
    }

    /** @param list<array<string, int|string|null>> $rows */
    private function book(array $rows): void
    {
        foreach ($rows as $row) {
            $insert = $this->db->prepare('INSERT INTO bookings(' . implode(',', array_keys($row)) . ') VALUES (' . implode(',', array_fill(0, count($row), '?')) . ')');
            foreach (array_values($row) as $i => $value) $insert->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : (is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR));
            $insert->execute();
        }
    }

    /** @return list<int> the ids of a page's rows, in its order */
    private function ids(array $options, string $table = 'bookings'): array
    {
        return array_column($this->store->browse($table, 0, $options)['rows'], 'id');
    }

    private function refused(array $options, string $table = 'bookings'): string
    {
        try { $this->store->browse($table, 0, $options); }
        catch (\InvalidArgumentException $refusal) { return $refusal->getMessage(); }
        $this->fail('Accepted: ' . json_encode($options));
    }

    // ── The table list's summary ─────────────────────────────────────────────

    public function testTheOverviewCountsRowsShownColumnsAndTheTablesThatAreNotListed(): void
    {
        $this->db->exec("INSERT INTO customers(name) VALUES ('Ada'),('Bo'),('Cy'); INSERT INTO bookings(room) VALUES ('A'),('B'); INSERT INTO payments(booking_id, amount) VALUES (1, 9.5)");
        $this->assertSame([
            'tables' => [
                // session_token and api_key are not among the columns counted.
                ['name' => 'bookings', 'rows' => 2, 'columns' => 8],
                ['name' => 'customers', 'rows' => 3, 'columns' => 4],
                ['name' => 'payments', 'rows' => 1, 'columns' => 3],
            ],
            // _softn_migrations, and the sqlite_sequence that AUTOINCREMENT made.
            'hiddenTables' => 2,
        ], $this->store->overview());
        $this->assertSame(['bookings', 'customers', 'payments'], $this->store->tables());
    }

    // ── Page sizes ───────────────────────────────────────────────────────────

    public function testAPageIsFiftyRowsUnlessOneOfTheFourSizesIsAskedFor(): void
    {
        $this->db->exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO bookings(id, room) SELECT i, 'R' || i FROM n");
        foreach ([25, 50, 100, 250] as $size) {
            $page = $this->store->browse('bookings', 0, ['limit' => $size]);
            $this->assertSame([$size, $size, $size, $size, 'more', true], [$page['limit'], count($page['rows']), count($page['keys']), count($page['stamps']), $page['end'], $page['hasMore']], "limit $size");
            $this->assertSame($size, $page['rows'][$size - 1]['id']);
        }
        foreach ([null, 0, 1, 10, 51, 251, 1000, -25, 'all'] as $other) {
            $page = $this->store->browse('bookings', 0, $other === null ? [] : ['limit' => $other]);
            $this->assertSame([50, 50], [$page['limit'], count($page['rows'])], 'limit ' . var_export($other, true));
        }
        // The offset counts rows, whatever the size: the last page of 100 holds the 50 left.
        $last = $this->store->browse('bookings', 250, ['limit' => 100]);
        $this->assertSame([250, 100, 100000, 50, 'end', false], [$last['offset'], $last['limit'], $last['offsetLimit'], count($last['rows']), $last['end'], $last['hasMore']]);
        $this->assertSame([251, 300], [$last['rows'][0]['id'], $last['rows'][49]['id']]);
        $this->assertSame([300, 300], [$last['total'], $last['matching']]);
    }

    public function testAnAnswerKeepsEveryFieldItHadAndAddsTheDataManagers(): void
    {
        $this->book([['id' => 1, 'room' => 'A']]);
        $page = $this->store->browse('bookings');
        $this->assertSame(['tables', 'columns', 'rows', 'hasMore', 'end', 'schema', 'keys', 'offset', 'limit', 'offsetLimit', 'total', 'matching', 'sort', 'hiddenColumns', 'stamps', 'cut'], array_keys($page));
        $this->assertSame(['bookings', 'customers', 'payments'], $page['tables']);
        $this->assertSame(['id', 'customer_id', 'room', 'starts_at', 'seats', 'price', 'notes', 'photo'], $page['columns']);
        $this->assertSame([['id' => '1']], $page['keys']);
        $this->assertSame([1, 1, null, 1], [$page['total'], $page['matching'], $page['sort'], $page['hiddenColumns']]);
        $this->assertSame('{}', json_encode($page['cut']));
        foreach (['nowhere', '_softn_migrations', 'sqlite_sequence'] as $table) {
            try { $this->store->browse($table); $this->fail("$table was browsed"); }
            catch (\RuntimeException $missing) { $this->assertSame([404, 'Table not found'], [$missing->getCode(), $missing->getMessage()]); }
        }
    }

    // ── Sort ─────────────────────────────────────────────────────────────────

    public function testSortingBreaksTiesByThePrimaryKeyAscendingInEitherDirection(): void
    {
        $this->book([['id' => 1, 'room' => 'B'], ['id' => 2, 'room' => 'A'], ['id' => 3, 'room' => 'B'], ['id' => 4, 'room' => null], ['id' => 5, 'room' => 'A'], ['id' => 6, 'room' => 'C']]);
        $this->assertSame([1, 2, 3, 4, 5, 6], $this->ids([]));
        $this->assertSame([4, 2, 5, 1, 3, 6], $this->ids(['sort' => 'room']));
        $this->assertSame([4, 2, 5, 1, 3, 6], $this->ids(['sort' => 'room', 'dir' => 'asc']));
        // Descending by room; the two As and the two Bs still run 2, 5 and 1, 3.
        $this->assertSame([6, 1, 3, 2, 5, 4], $this->ids(['sort' => 'room', 'dir' => 'desc']));
        $this->assertSame([6, 5, 4, 3, 2, 1], $this->ids(['sort' => 'id', 'dir' => 'desc']));

        $page = $this->store->browse('bookings', 2, ['sort' => 'room', 'dir' => 'desc']);
        $this->assertSame([3, 2, 5, 4], array_column($page['rows'], 'id'), 'the next page carries on in the same order');
        $this->assertSame(['3', '2', '5', '4'], array_column($page['keys'], 'id'), 'keys stay in step with the sorted rows');
        $this->assertSame(['column' => 'room', 'dir' => 'desc'], $page['sort']);
        $this->assertSame(['column' => 'room', 'dir' => 'asc'], $this->store->browse('bookings', 0, ['sort' => 'room', 'dir' => 'sideways'])['sort']);
        $this->assertNull($this->store->browse('bookings', 0, ['dir' => 'desc'])['sort'], 'a direction with no column sorts nothing');
        $this->assertNull($this->store->browse('bookings', 0, ['sort' => ''])['sort']);
    }

    public function testSortingByAnUnknownOrHiddenColumnIsRefusedTheSameWay(): void
    {
        $this->book([['id' => 1, 'room' => 'A', 'session_token' => 'tok-1']]);
        foreach (['nope', 'session_token', 'room"; DROP TABLE bookings; --', 'rowid', ['room']] as $column) {
            $this->assertSame('Unknown column', $this->refused(['sort' => $column]), var_export($column, true));
        }
        $this->assertSame(1, (int) $this->db->query('SELECT count(*) FROM bookings')->fetchColumn());
    }

    // ── Search ───────────────────────────────────────────────────────────────

    public function testSearchFindsTextInAnyShownColumnAndTakesWildcardsLiterally(): void
    {
        $this->book([
            ['id' => 1, 'room' => 'Alpha', 'notes' => '100% sure'],
            ['id' => 2, 'room' => 'beta', 'notes' => 'a_b'],
            ['id' => 3, 'room' => 'gamma', 'notes' => 'axb 100 percent'],
            ['id' => 4, 'room' => 'delta', 'notes' => 'back\\slash'],
            ['id' => 5, 'room' => 'epsilon', 'notes' => null, 'seats' => 4242],
            ['id' => 6, 'room' => 'zeta', 'notes' => 'plain', 'session_token' => 'tok-secret-xyz'],
        ]);
        $this->db->exec("UPDATE bookings SET photo = CAST('needle in binary' AS BLOB) WHERE id = 6");

        $this->assertSame([1], $this->ids(['q' => '%']), '% is a character, not "anything"');
        $this->assertSame([2], $this->ids(['q' => '_']), '_ is a character, not "any one"');
        $this->assertSame([2], $this->ids(['q' => 'a_b']), 'axb is not a_b');
        $this->assertSame([4], $this->ids(['q' => '\\']), 'the escape character is itself searched for');
        $this->assertSame([1], $this->ids(['q' => '0% S']), 'ASCII letters match in either case');
        $this->assertSame([1, 3], $this->ids(['q' => '100']));
        $this->assertSame([5], $this->ids(['q' => '424']), 'a number is found by its digits');
        $this->assertSame([2, 3, 4], $this->ids(['q' => 'B']));
        $this->assertSame([], $this->ids(['q' => 'secret']), 'a hidden column is never searched');
        $this->assertSame([], $this->ids(['q' => 'needle']), 'nor is a binary value');
        $this->assertSame([], $this->ids(['q' => '[binary]']), 'nor the word a list shows in its place');

        $page = $this->store->browse('bookings', 0, ['q' => 'B', 'limit' => 25]);
        $this->assertSame([6, 3], [$page['total'], $page['matching']]);
        $this->assertSame(['2', '3', '4'], array_column($page['keys'], 'id'));
        $this->assertSame([6, 6], [$this->store->browse('bookings', 0, ['q' => ''])['total'], $this->store->browse('bookings', 0, ['q' => ''])['matching']]);

        $this->assertSame([], $this->ids(['q' => str_repeat('é', 200)]), 'two hundred characters, whatever their bytes');
        $this->assertSame('The search can be at most 200 characters.', $this->refused(['q' => str_repeat('x', 201)]));
        $this->assertSame('The search must be text.', $this->refused(['q' => ['x']]));
    }

    // ── Filters ──────────────────────────────────────────────────────────────

    public function testEveryFilterOperator(): void
    {
        $this->book([
            ['id' => 1, 'room' => 'A', 'seats' => 2, 'price' => '10.5', 'notes' => 'first'],
            ['id' => 2, 'room' => 'B', 'seats' => 10, 'price' => '9.0', 'notes' => ''],
            ['id' => 3, 'room' => 'B2', 'seats' => null, 'price' => null, 'notes' => null],
            ['id' => 4, 'room' => '50% off', 'seats' => 5, 'price' => '100', 'notes' => 'x'],
        ]);
        $one = fn(string $column, string $op, ?string $value = null): array => $this->ids(['filter' => json_encode([['column' => $column, 'op' => $op] + ($value === null ? [] : ['value' => $value])])]);

        $this->assertSame([2], $one('seats', 'eq', '10'), 'a text value equals the number an INTEGER column holds');
        $this->assertSame([2], $one('room', 'eq', 'B'));
        $this->assertSame([], $one('room', 'eq', 'b'), 'equality is exact');
        $this->assertSame([1, 3, 4], $one('room', 'ne', 'B'));
        $this->assertSame([1, 3, 4], $one('seats', 'ne', '10'), 'a row with no value is not equal to one either');
        $this->assertSame([2, 3], $one('room', 'contains', 'b'));
        $this->assertSame([4], $one('room', 'contains', '%'), '% is literal in a filter too');
        $this->assertSame([2, 3], $one('room', 'starts', 'B'));
        $this->assertSame([4], $one('room', 'starts', '50%'));
        $this->assertSame([], $one('room', 'starts', '_'));
        // Compared as numbers: as text, '5' would sort after '10'.
        $this->assertSame([2, 4], $one('seats', 'gt', '2'));
        $this->assertSame([1, 2, 4], $one('seats', 'gte', '2'));
        $this->assertSame([1, 4], $one('seats', 'lt', '10'));
        $this->assertSame([1, 2, 4], $one('seats', 'lte', '10'));
        $this->assertSame([1, 4], $one('price', 'gt', '9.5'));
        $this->assertSame([2], $one('price', 'lte', '9'));
        $this->assertSame([2, 3], $one('notes', 'empty'), 'NULL or the empty string');
        $this->assertSame([1, 4], $one('notes', 'notEmpty'));
        $this->assertSame([3], $one('seats', 'empty'));
        $this->assertSame([1, 2, 4], $one('seats', 'notEmpty'));
        $this->assertSame([2, 3], $this->ids(['filter' => '[{"column":"notes","op":"empty","value":"ignored"}]']), 'empty takes no value');

        // All of them must hold, and the search too.
        $both = [['column' => 'room', 'op' => 'starts', 'value' => 'B'], ['column' => 'seats', 'op' => 'notEmpty']];
        $this->assertSame([2], $this->ids(['filter' => json_encode($both)]));
        $this->assertSame([2], $this->ids(['filter' => $both]), 'a decoded list is the same filter');
        $this->assertSame([], $this->ids(['filter' => $both, 'q' => 'first']));
        $this->assertSame([1], $this->ids(['filter' => [['column' => 'seats', 'op' => 'lt', 'value' => '10']], 'q' => 'first']));
        $this->assertSame([2], $this->ids(['filter' => '[{"column":"seats","op":"eq","value":10}]']), 'a JSON number is its text');
        $page = $this->store->browse('bookings', 0, ['filter' => $both, 'sort' => 'room', 'dir' => 'desc']);
        $this->assertSame([4, 1], [$page['total'], $page['matching']]);
        $this->assertSame([1, 2, 3, 4], $this->ids(['filter' => '']));
        $this->assertSame([1, 2, 3, 4], $this->ids(['filter' => '[]']));
    }

    /** A column declared with no type keeps numbers as numbers and text as text: a number is compared with it as one. */
    public function testAColumnWithNoTypeComparesANumberAsANumber(): void
    {
        $this->db->exec("CREATE TABLE loose(id INTEGER PRIMARY KEY, v); INSERT INTO loose(id, v) VALUES (1, 3), (2, 5), (3, 10), (4, '7'), (5, 'word')");
        $one = fn(string $op, string $value): array => $this->ids(['filter' => [['column' => 'v', 'op' => $op, 'value' => $value]]], 'loose');
        $this->assertSame([2], $one('eq', '5'));
        $this->assertSame([5], $one('eq', 'word'));
        $this->assertSame([1, 2], $one('lte', '5'));
        $this->assertSame([1, 2, 4], $one('lt', '10'), "the text '7' counts as the number it spells");
    }

    public function testAFilterThatCannotBeReadIsRefusedWithASentenceThatSaysWhich(): void
    {
        $this->book([['id' => 1, 'room' => 'A', 'session_token' => 'tok-1']]);
        $this->assertSame('The filter is not valid JSON.', $this->refused(['filter' => '[{"column":"room"']));
        $this->assertSame('The filter is not valid JSON.', $this->refused(['filter' => 'room = A']));
        $many = 'The filter must be a list of at most 8 conditions.';
        $this->assertSame($many, $this->refused(['filter' => '{"column":"room","op":"empty"}']));
        $this->assertSame($many, $this->refused(['filter' => 'null']));
        $this->assertSame($many, $this->refused(['filter' => '"room"']));
        $this->assertSame($many, $this->refused(['filter' => json_encode(array_fill(0, 9, ['column' => 'room', 'op' => 'empty']))]));
        $this->assertSame([1], $this->ids(['filter' => json_encode(array_fill(0, 8, ['column' => 'room', 'op' => 'notEmpty']))]), 'eight are taken');

        $unknown = 'Filter 1 names an unknown column.';
        $this->assertSame($unknown, $this->refused(['filter' => '[{"column":"nope","op":"empty"}]']));
        $this->assertSame($unknown, $this->refused(['filter' => '[{"column":"session_token","op":"eq","value":"tok-1"}]']), 'a hidden column is refused as one that does not exist');
        $this->assertSame($unknown, $this->refused(['filter' => '[{"op":"empty"}]']));
        $this->assertSame($unknown, $this->refused(['filter' => '["room"]']));
        $this->assertSame('Filter 2 names an unknown column.', $this->refused(['filter' => '[{"column":"room","op":"empty"},{"column":"api_key","op":"empty"}]']));

        $this->assertSame('Filter 1 has an unknown op.', $this->refused(['filter' => '[{"column":"room","op":"like","value":"A"}]']));
        $this->assertSame('Filter 1 has an unknown op.', $this->refused(['filter' => '[{"column":"room","value":"A"}]']));
        $this->assertSame('Filter 2 has an unknown op.', $this->refused(['filter' => '[{"column":"room","op":"empty"},{"column":"room","op":"=","value":"A"}]']));

        foreach (['eq', 'ne', 'contains', 'starts', 'gt', 'gte', 'lt', 'lte'] as $op) {
            $this->assertSame('Filter 1 needs a value.', $this->refused(['filter' => json_encode([['column' => 'room', 'op' => $op]])]), $op);
        }
        $this->assertSame('Filter 1 needs a value.', $this->refused(['filter' => '[{"column":"room","op":"eq","value":null}]']));
        $this->assertSame('Filter 1 needs a value.', $this->refused(['filter' => '[{"column":"room","op":"eq","value":["A"]}]']));
        $this->assertSame('Filter 1 needs a value.', $this->refused(['filter' => '[{"column":"room","op":"eq","value":true}]']));
        $this->assertSame('Filter 1 has a value longer than 1000 bytes.', $this->refused(['filter' => json_encode([['column' => 'room', 'op' => 'eq', 'value' => str_repeat('x', 1001)]])]));
    }

    // ── Cut previews ─────────────────────────────────────────────────────────

    public function testCutNamesTheTextsShownAsTheirFirstFourHundredCharacters(): void
    {
        $this->book([
            ['id' => 1, 'room' => 'short', 'notes' => str_repeat('n', 400)],
            ['id' => 2, 'room' => str_repeat('r', 401), 'notes' => str_repeat('é', 399) . 'zz'],
            ['id' => 3, 'room' => 'short', 'notes' => 'short'],
            ['id' => 4, 'room' => 'short', 'notes' => str_repeat('✓', 5000)],
        ]);
        $page = $this->store->browse('bookings');
        $this->assertSame(['1' => ['room', 'notes'], '3' => ['notes']], (array) $page['cut']);
        $this->assertSame('{"1":["room","notes"],"3":["notes"]}', json_encode($page['cut']));
        $this->assertSame(str_repeat('n', 400), $page['rows'][0]['notes'], 'exactly 400 characters is the whole text');
        $this->assertSame(str_repeat('r', 400), $page['rows'][1]['room']);
        $this->assertSame(str_repeat('é', 399) . 'z', $page['rows'][1]['notes'], 'characters, not bytes');
        $this->assertSame(str_repeat('✓', 400), $page['rows'][3]['notes']);

        // Sparse, and still an object when the first row is the only one cut.
        $this->assertSame('{"0":["room","notes"],"2":["notes"]}', json_encode($this->store->browse('bookings', 1, ['limit' => 25])['cut']), 'by the row\'s place on its page');
        $this->assertSame('{"0":["room","notes"]}', json_encode($this->store->browse('bookings', 0, ['filter' => [['column' => 'id', 'op' => 'eq', 'value' => '2']]])['cut']));
        $this->assertSame('{}', json_encode($this->store->browse('bookings', 0, ['filter' => [['column' => 'id', 'op' => 'eq', 'value' => '3']]])['cut']));
    }

    /** A list asks for 401 characters to learn whether 400 cut the text; what it shows is still what substr(x,1,400) gave. */
    public function testAPreviewIsWhatSqlitesSubstrGivesForAnyBytes(): void
    {
        $texts = [
            str_repeat('a', 401),
            str_repeat("\u{1F600}", 401),
            // Not UTF-8: SQLite counts a lead byte and the continuation bytes after it as one character.
            str_repeat("\xC3", 450),
            str_repeat("\x80", 450),
            "\xC3" . str_repeat("\x80", 5000),
            str_repeat("ab\xFF\x80\x80", 200),
            str_repeat('x', 399) . "\xE2\x9C",
        ];
        $insert = $this->db->prepare('INSERT INTO bookings(id, notes) VALUES (?, ?)');
        foreach ($texts as $i => $text) $insert->execute([$i + 1, $text]);
        $page = $this->store->browse('bookings');
        foreach ($this->db->query('SELECT substr(notes, 1, 400) AS preview, length(notes) > 400 AS longer FROM bookings ORDER BY id')->fetchAll() as $i => $expected) {
            $shown = strlen($expected['preview']) > 4000 ? mb_strcut($expected['preview'], 0, 4000) . '…' : $expected['preview'];
            $this->assertSame(bin2hex($shown), bin2hex($page['rows'][$i]['notes']), "text $i");
            $this->assertSame((bool) $expected['longer'] || strlen($expected['preview']) > 4000, in_array('notes', ((array) $page['cut'])[$i] ?? [], true), "cut $i");
        }
    }

    // ── Stamps ───────────────────────────────────────────────────────────────

    public function testAStampStaysWhileItsRowDoesAndChangesWithAnythingAListShowsOfIt(): void
    {
        $this->db->exec("INSERT INTO bookings(id, room, notes, photo, session_token) VALUES (1, 'A', 'one', x'0102', 'tok-1'), (2, 'B', 'two', NULL, 'tok-2')");
        $first = $this->store->browse('bookings')['stamps'];
        $this->assertCount(2, $first);
        foreach ($first as $stamp) $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/D', $stamp);
        $this->assertNotSame($first[0], $first[1]);
        $this->assertSame($first, $this->store->browse('bookings')['stamps'], 'unchanged rows keep their stamps');
        // However the row is reached: another page size, order, search or filter.
        $this->assertSame(array_reverse($first), $this->store->browse('bookings', 0, ['sort' => 'room', 'dir' => 'desc', 'limit' => 250])['stamps']);
        $this->assertSame([$first[1]], $this->store->browse('bookings', 0, ['q' => 'two'])['stamps']);
        $this->assertSame([$first[1]], $this->store->browse('bookings', 1)['stamps']);

        $this->db->exec("UPDATE bookings SET notes = 'one, changed' WHERE id = 1");
        $second = $this->store->browse('bookings')['stamps'];
        $this->assertNotSame($first[0], $second[0], 'a shown value changed');
        $this->assertSame($first[1], $second[1], 'the other row did not');

        // A hidden value is part of the stamp, and of nothing else in the answer.
        $this->db->exec("UPDATE bookings SET session_token = 'tok-other' WHERE id = 2");
        $page = $this->store->browse('bookings');
        $this->assertNotSame($second[1], $page['stamps'][1]);
        $this->assertSame($second[0], $page['stamps'][0]);
        $this->assertStringNotContainsString('tok-', json_encode($page));
        $this->assertStringNotContainsString('session_token', json_encode($page));

        // A binary value is in the stamp by its length (its bytes are not read for a list).
        $this->db->exec("UPDATE bookings SET photo = x'010203' WHERE id = 1");
        $third = $this->store->browse('bookings')['stamps'];
        $this->assertNotSame($page['stamps'][0], $third[0]);
        // The same value stored as another kind (the text 5 for the number 5) is another row to a stamp.
        $this->db->exec("UPDATE bookings SET photo = 5 WHERE id = 2");
        $number = $this->store->browse('bookings')['stamps'][1];
        $this->db->exec("UPDATE bookings SET photo = '5' WHERE id = 2");
        $this->assertSame('text', $this->db->query('SELECT typeof(photo) FROM bookings WHERE id = 2')->fetchColumn(), 'a column typed BLOB keeps a value as it was given');
        $this->assertNotSame($number, $this->store->browse('bookings')['stamps'][1]);
        // NULL and the empty string differ too.
        $this->db->exec("UPDATE bookings SET notes = NULL WHERE id = 2");
        $null = $this->store->browse('bookings')['stamps'][1];
        $this->db->exec("UPDATE bookings SET notes = '' WHERE id = 2");
        $this->assertNotSame($null, $this->store->browse('bookings')['stamps'][1]);
    }

    public function testARowWithNoUsableKeyHasNoStamp(): void
    {
        // No primary key at all: no keys (as before), and a null stamp for each row.
        $this->db->exec("CREATE TABLE log(line TEXT); INSERT INTO log VALUES ('a'), ('b')");
        $page = $this->store->browse('log');
        $this->assertSame([[], [null, null], 2], [$page['keys'], $page['stamps'], count($page['rows'])]);
        // A key with a NULL part names no row.
        $this->db->exec("CREATE TABLE parts(a TEXT, b TEXT, v TEXT, PRIMARY KEY(a, b)); INSERT INTO parts VALUES ('x', 'y', '1'), ('x', NULL, '2')");
        $page = $this->store->browse('parts');
        $whole = array_search('1', array_column($page['rows'], 'v'), true);
        $this->assertSame(['a' => 'x', 'b' => 'y'], $page['keys'][$whole]);
        $this->assertIsString($page['stamps'][$whole]);
        $this->assertNull($page['keys'][1 - $whole]);
        $this->assertNull($page['stamps'][1 - $whole]);
        // A key that is a hidden column is not one an owner can use.
        $this->db->exec("CREATE TABLE sessions(session_token TEXT PRIMARY KEY, seen TEXT); INSERT INTO sessions VALUES ('tok-9', 'now')");
        $page = $this->store->browse('sessions');
        $this->assertSame([['seen'], [['seen' => 'now']], [], [null], 1], [$page['columns'], $page['rows'], $page['keys'], $page['stamps'], $page['hiddenColumns']]);
        // Nothing but hidden columns: nothing to show, and the counts are still exact.
        $this->db->exec("CREATE TABLE vault(secret_value TEXT); INSERT INTO vault VALUES ('s1'), ('s2')");
        $page = $this->store->browse('vault', 0, ['limit' => 25]);
        $this->assertSame([[], [], [], 2, 2, 1, 25, 'end'], [$page['columns'], $page['rows'], $page['stamps'], $page['total'], $page['matching'], $page['hiddenColumns'], $page['limit'], $page['end']]);
        $this->assertSame(0, $this->store->browse('vault', 0, ['q' => 's1'])['matching'], 'nothing shown, so nothing a search can find');
        $this->assertSame('{}', json_encode($page['cut']));
    }

    // ── Structure ────────────────────────────────────────────────────────────

    public function testTheStructureViewNamesColumnsIndexesAndForeignKeysBothWays(): void
    {
        $this->db->exec("INSERT INTO customers(name) VALUES ('Ada'); INSERT INTO bookings(customer_id, room) VALUES (1, 'A'), (1, 'B'), (1, 'C');
            CREATE TABLE _audit(id INTEGER PRIMARY KEY, booking_id INTEGER REFERENCES bookings(id))");
        $bookings = $this->store->structure('bookings');
        $this->assertSame(['table', 'rows', 'columns', 'indexes', 'foreignKeys', 'referencedBy'], array_keys($bookings));
        $this->assertSame(['bookings', 3], [$bookings['table'], $bookings['rows']]);
        $column = static fn(string $name, string $type, array $more = []): array => $more + ['name' => $name, 'type' => $type, 'notNull' => false, 'defaultValue' => null, 'primaryKey' => 0, 'hidden' => false, 'generated' => false];
        $sorted = static function (array $rows): array { foreach ($rows as &$row) ksort($row); usort($rows, static fn($a, $b) => strcmp($a['name'] ?? $a['table'], $b['name'] ?? $b['table'])); return $rows; };
        $this->assertEquals([
            $column('id', 'INTEGER', ['primaryKey' => 1]), $column('customer_id', 'INTEGER'), $column('room', 'TEXT'), $column('starts_at', 'TEXT'), $column('seats', 'INTEGER'),
            $column('price', 'REAL'), $column('notes', 'TEXT'), $column('photo', 'BLOB'),
            // Named and typed, flagged, and never among a list's columns.
            $column('session_token', 'TEXT', ['hidden' => true]),
        ], $bookings['columns']);
        $this->assertSame($sorted([
            ['name' => 'idx_bookings_customer', 'unique' => false, 'origin' => 'c', 'columns' => ['customer_id']],
            ['name' => 'sqlite_autoindex_bookings_1', 'unique' => true, 'origin' => 'u', 'columns' => ['room', 'starts_at']],
        ]), $sorted($bookings['indexes']));
        $this->assertSame([['columns' => ['customer_id'], 'table' => 'customers', 'to' => ['id'], 'onUpdate' => 'NO ACTION', 'onDelete' => 'CASCADE']], $bookings['foreignKeys']);
        // payments names no column of bookings, so it points at its primary key; _audit is not a shown table.
        $this->assertSame([['table' => 'payments', 'columns' => ['booking_id'], 'to' => ['id']]], $bookings['referencedBy']);

        $customers = $this->store->structure('customers');
        $this->assertEquals([
            $column('id', 'INTEGER', ['primaryKey' => 1]), $column('name', 'TEXT', ['notNull' => true]), $column('email', 'TEXT'),
            $column('status', 'TEXT', ['notNull' => true, 'defaultValue' => "'new'"]),
            // A hidden column's default is a value of it.
            $column('api_key', 'TEXT', ['hidden' => true]),
        ], $customers['columns']);
        $this->assertSame([[], [], [['table' => 'bookings', 'columns' => ['customer_id'], 'to' => ['id']]]], [$customers['indexes'], $customers['foreignKeys'], $customers['referencedBy']]);
        $this->assertSame([['columns' => ['booking_id'], 'table' => 'bookings', 'to' => ['id'], 'onUpdate' => 'NO ACTION', 'onDelete' => 'NO ACTION']], $this->store->structure('payments')['foreignKeys']);

        foreach (['nowhere', '_audit', 'sqlite_sequence'] as $table) {
            try { $this->store->structure($table); $this->fail("$table was described"); }
            catch (\RuntimeException $missing) { $this->assertSame(404, $missing->getCode()); }
        }
    }

    public function testTheStructureViewOfCompositeKeysGeneratedColumnsAndExpressionIndexes(): void
    {
        $this->db->exec("
            CREATE TABLE seats(room TEXT, n INTEGER, label TEXT, total INTEGER GENERATED ALWAYS AS (n + 1) VIRTUAL, PRIMARY KEY(room, n)) WITHOUT ROWID;
            CREATE INDEX idx_seats_label ON seats(lower(label), n);
            CREATE TABLE holds(id INTEGER PRIMARY KEY, room TEXT, n INTEGER, parent_id INTEGER REFERENCES holds(id), FOREIGN KEY(room, n) REFERENCES seats(room, n) ON UPDATE CASCADE ON DELETE SET NULL);
        ");
        $seats = $this->store->structure('seats');
        $this->assertSame([['room', 1, false], ['n', 2, false], ['label', 0, false], ['total', 0, true]], array_map(static fn($c) => [$c['name'], $c['primaryKey'], $c['generated']], $seats['columns']));
        $byName = array_column($seats['indexes'], null, 'name');
        $this->assertSame(['name' => 'sqlite_autoindex_seats_1', 'unique' => true, 'origin' => 'pk', 'columns' => ['room', 'n']], $byName['sqlite_autoindex_seats_1']);
        $this->assertSame(['name' => 'idx_seats_label', 'unique' => false, 'origin' => 'c', 'columns' => ['(expression)', 'n']], $byName['idx_seats_label']);
        $this->assertSame([['table' => 'holds', 'columns' => ['room', 'n'], 'to' => ['room', 'n']]], $seats['referencedBy']);

        $holds = $this->store->structure('holds');
        usort($holds['foreignKeys'], static fn($a, $b) => strcmp($a['table'], $b['table']));
        $this->assertSame([
            ['columns' => ['parent_id'], 'table' => 'holds', 'to' => ['id'], 'onUpdate' => 'NO ACTION', 'onDelete' => 'NO ACTION'],
            ['columns' => ['room', 'n'], 'table' => 'seats', 'to' => ['room', 'n'], 'onUpdate' => 'CASCADE', 'onDelete' => 'SET NULL'],
        ], $holds['foreignKeys']);
        $this->assertSame([], $holds['referencedBy'], 'a table that points at itself is in its own foreign keys, not among the others');
    }
}
