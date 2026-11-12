<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeRecordStore;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * NativeRecordStore::export on an in-memory database: both formats, with NULL, quotes, line
 * breaks and a binary column; every table at once; the search, filters and sort a list takes;
 * and the two limits, which leave a file that still reads.
 */
final class NativeRecordExportTest extends TestCase
{
    private PDO $db;
    private NativeRecordStore $store;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec("
            CREATE TABLE things(id INTEGER PRIMARY KEY, label TEXT, qty INTEGER, ratio REAL, raw BLOB, secret_note TEXT);
            CREATE TABLE tags(name TEXT PRIMARY KEY, thing_id INTEGER);
            CREATE TABLE _softn_migrations(id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO _softn_migrations VALUES (1, 'host-only');
            INSERT INTO tags VALUES ('b', 2), ('a', 1);
        ");
        $insert = $this->db->prepare('INSERT INTO things(id, label, qty, ratio, raw, secret_note) VALUES (?, ?, ?, ?, ?, ?)');
        foreach ([
            [1, 'plain', 3, 1.5, null, 'never-exported-1'],
            [2, 'has "quotes", and commas', null, 2.0, null, 'never-exported-2'],
            [3, "line\nbreak and\r\nanother", -4, null, null, null],
            [4, null, 0, 0.1, null, null],
            [5, '', 5, -7.25, null, null],
            [6, 'ünïcödé ✓ / slash', 9007199254740993, 1.0e25, null, null],
        ] as $row) {
            foreach ($row as $i => $value) $insert->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : (is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR));
            $insert->execute();
        }
        $this->db->exec("UPDATE things SET raw = x'00ff10' WHERE id IN (1, 3)");
        $this->store = new NativeRecordStore($this->db);
    }

    /** @return array{0: string, 1: bool} the file, and whether a limit cut it */
    private function export(?string $table, string $format, array $options = [], ?int $maxRows = null, ?int $maxBytes = null): array
    {
        $out = fopen('php://memory', 'w+b');
        $cut = $this->store->export($out, $table, $format, $options, $maxRows ?? NativeRecordStore::EXPORT_ROWS, $maxBytes ?? NativeRecordStore::EXPORT_BYTES);
        rewind($out);
        $file = stream_get_contents($out);
        fclose($out);
        return [$file, $cut];
    }

    public function testCsvIsUtf8BehindAByteOrderMarkQuotedAsRfc4180Says(): void
    {
        [$file, $cut] = $this->export('things', 'csv');
        $this->assertFalse($cut);
        $this->assertSame(
            "\xEF\xBB\xBF" . "id,label,qty,ratio,raw\r\n"
            // A binary value is an empty cell, and so is NULL.
            . "1,plain,3,1.5,\r\n"
            . "2,\"has \"\"quotes\"\", and commas\",,2.0,\r\n"
            . "3,\"line\nbreak and\r\nanother\",-4,,\r\n"
            . "4,,0,0.1,\r\n"
            . "5,,5,-7.25,\r\n"
            . "6,ünïcödé ✓ / slash,9007199254740993,1.0e+25,\r\n",
            $file
        );
        $this->assertStringNotContainsString('never-exported', $file);
        $this->assertStringNotContainsString('secret_note', $file);

        // What a spreadsheet reads back is what was stored.
        $read = fopen('php://memory', 'w+b');
        fwrite($read, substr($file, 3));
        rewind($read);
        $rows = [];
        while (($row = fgetcsv($read, null, ',', '"', '')) !== false) $rows[] = $row;
        fclose($read);
        $this->assertSame(['id', 'label', 'qty', 'ratio', 'raw'], $rows[0]);
        $this->assertSame('has "quotes", and commas', $rows[2][1]);
        $this->assertSame("line\nbreak and\r\nanother", $rows[3][1]);
        $this->assertCount(7, $rows);
    }

    /** These are values an app's visitors typed, opened by its owner in a spreadsheet: as the responses export does. */
    public function testACsvTextASpreadsheetWouldRunAsAFormulaIsWrittenAsText(): void
    {
        $this->db->exec("DELETE FROM things; CREATE TABLE \"=calc\"(id INTEGER PRIMARY KEY, \"+risky\" TEXT)");
        $insert = $this->db->prepare('INSERT INTO things(id, label, qty) VALUES (?, ?, ?)');
        foreach ([[1, '=HYPERLINK("http://example.test","x")', -5], [2, '+61 400 000 000', 2], [3, '  @SUM(A1)', 3], [4, '-dash', 4], [5, "it's fine = really", 5]] as $row) $insert->execute($row);
        $lines = explode("\r\n", substr($this->export('things', 'csv')[0], 3));
        $this->assertSame('1,"\'=HYPERLINK(""http://example.test"",""x"")",-5,,', $lines[1], 'the text is held, the number -5 is a number');
        $this->assertSame(["2,'+61 400 000 000,2,,", "3,'  @SUM(A1),3,,", "4,'-dash,4,,", "5,it's fine = really,5,,"], array_slice($lines, 2, 4));
        $this->assertSame("\xEF\xBB\xBF" . "id,'+risky\r\n", $this->export('=calc', 'csv')[0], 'a column\'s name too');
        // JSON is read by programs: the values are exact.
        $this->assertSame('+61 400 000 000', json_decode($this->export('things', 'json')[0], true)[1]['label']);
    }

    public function testJsonIsAListOfRowsWithNullsKept(): void
    {
        [$file, $cut] = $this->export('things', 'json');
        $this->assertFalse($cut);
        $rows = json_decode($file, false, 8, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        $this->assertCount(6, $rows);
        $this->assertSame(['id' => 1, 'label' => 'plain', 'qty' => 3, 'ratio' => 1.5, 'raw' => null], (array) $rows[0]);
        $this->assertSame(['id' => 2, 'label' => 'has "quotes", and commas', 'qty' => null, 'ratio' => 2.0, 'raw' => null], (array) $rows[1]);
        $this->assertSame("line\nbreak and\r\nanother", $rows[2]->label);
        $this->assertNull($rows[2]->raw, 'a binary value is left out');
        $this->assertSame([null, ''], [$rows[3]->label, $rows[4]->label], 'NULL stays null, and is not the empty string');
        $this->assertSame(9007199254740993, $rows[5]->qty, 'a whole number is written whole');
        $this->assertStringContainsString('"qty":9007199254740993,', $file);
        // Written as it is read: letters as letters, 2.0 still a decimal.
        $this->assertStringContainsString('{"id":2,"label":"has \"quotes\", and commas","qty":null,"ratio":2.0,"raw":null}', $file);
        $this->assertStringContainsString('"label":"ünïcödé ✓ / slash"', $file);
        $this->assertStringNotContainsString('secret_note', $file);
        $this->assertStringNotContainsString('never-exported', $file);
        $this->assertSame('[]', $this->export('things', 'json', ['q' => 'no such text'])[0]);
    }

    public function testTextIsExportedWholeAndBytesThatAreNotUtf8StillMakeAFile(): void
    {
        $long = str_repeat('long text, well past a preview. ', 400);
        $this->db->prepare("UPDATE things SET label = ? WHERE id = 1")->execute([$long]);
        $this->db->prepare("UPDATE things SET label = ? WHERE id = 2")->execute(["broken \xC3\x28 bytes"]);
        $this->db->exec("UPDATE things SET ratio = 9e999 WHERE id = 3");
        $rows = json_decode($this->export('things', 'json')[0], true, 8, JSON_THROW_ON_ERROR);
        $this->assertSame($long, $rows[0]['label']);
        $this->assertSame("broken \u{FFFD}( bytes", $rows[1]['label']);
        $this->assertNull($rows[2]['ratio'], 'JSON has no infinity');
        $csv = $this->export('things', 'csv')[0];
        $this->assertStringContainsString('1,"' . $long . '",3,1.5,', $csv);
        $this->assertTrue(mb_check_encoding($csv, 'UTF-8'));
        $this->assertStringContainsString("another\",-4,INF,\r\n", $csv);
    }

    public function testAnExportTakesTheSearchFiltersAndSortAListTakes(): void
    {
        $ids = fn(array $options): array => array_column(json_decode($this->export('things', 'json', $options)[0], true), 'id');
        $this->assertSame([1, 2, 3, 4, 5, 6], $ids([]));
        $this->assertSame([6, 5, 1, 4, 3, 2], $ids(['sort' => 'qty', 'dir' => 'desc']));
        $this->assertSame([2, 3], $ids(['q' => 'AND']));
        $this->assertSame([5, 6], $ids(['filter' => '[{"column":"qty","op":"gte","value":"5"}]']));
        $this->assertSame([6, 5], $ids(['filter' => [['column' => 'qty', 'op' => 'gte', 'value' => '5']], 'sort' => 'id', 'dir' => 'desc']));
        $this->assertSame([], $ids(['q' => 'never-exported']), 'a hidden column is not searched');
        $this->assertSame("\xEF\xBB\xBF" . "name,thing_id\r\nb,2\r\n", $this->export('tags', 'csv', ['q' => 'b'])[0]);
        foreach ([['sort' => 'secret_note'], ['sort' => 'nope']] as $options) {
            try { $this->export('things', 'csv', $options); $this->fail('Sorted by ' . $options['sort']); }
            catch (\InvalidArgumentException $refused) { $this->assertSame('Unknown column', $refused->getMessage()); }
        }
        try { $this->export('things', 'json', ['filter' => '[{"column":"secret_note","op":"notEmpty"}]']); $this->fail('Filtered by a hidden column'); }
        catch (\InvalidArgumentException $refused) { $this->assertSame('Filter 1 names an unknown column.', $refused->getMessage()); }
    }

    public function testEveryShownTableIsOneJsonFile(): void
    {
        $this->db->exec('CREATE TABLE "2024"("0" TEXT, "1" TEXT); INSERT INTO "2024" VALUES (\'zero\', \'one\'); CREATE TABLE empty_one(id INTEGER PRIMARY KEY)');
        [$file, $cut] = $this->export(null, 'json');
        $this->assertFalse($cut);
        $all = json_decode($file, true, 8, JSON_THROW_ON_ERROR);
        $this->assertSame(['tables'], array_keys($all));
        // Shown tables only, by name; a table named with digits is still a name, and its row still an object.
        $this->assertSame(['2024', 'empty_one', 'tags', 'things'], array_map('strval', array_keys($all['tables'])));
        $this->assertStringStartsWith('{"tables":{"2024":[{"0":"zero","1":"one"}],"empty_one":[],"tags":[{"name":"a","thing_id":1},{"name":"b","thing_id":2}],"things":[{"id":1,', $file);
        $this->assertCount(6, $all['tables']['things']);
        $this->assertStringNotContainsString('host-only', $file);
        $this->assertStringNotContainsString('never-exported', $file);
        $this->assertSame(json_decode($this->export('things', 'json')[0], true), $all['tables']['things']);

        foreach (['csv' => 'Every table at once is exported as json.', 'xml' => 'Export as csv or json.'] as $format => $message) {
            try { $this->export(null, $format); $this->fail("Every table as $format"); }
            catch (\InvalidArgumentException $refused) { $this->assertSame($message, $refused->getMessage()); }
        }
        // A search names one table's columns: dropping it here would hand over every row.
        foreach ([['q' => 'plain'], ['sort' => 'id'], ['filter' => '[{"column":"id","op":"eq","value":"1"}]']] as $options) {
            try { $this->export(null, 'json', $options); $this->fail('Every table with ' . json_encode($options)); }
            catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('for one table', $refused->getMessage()); }
        }
        $this->assertSame($file, $this->export(null, 'json', ['q' => '', 'filter' => '[]', 'dir' => 'desc'])[0]);
    }

    public function testATableThatIsNotShownIsNotExported(): void
    {
        foreach (['nowhere', '_softn_migrations', 'sqlite_master'] as $table) {
            foreach (['csv', 'json'] as $format) {
                try { $this->export($table, $format); $this->fail("$table was exported"); }
                catch (\RuntimeException $missing) { $this->assertSame([404, 'Table not found'], [$missing->getCode(), $missing->getMessage()]); }
            }
        }
        try { $this->export('things', 'sql'); $this->fail('Exported as sql'); }
        catch (\InvalidArgumentException $refused) { $this->assertSame('Export as csv or json.', $refused->getMessage()); }
        // Nothing but hidden columns: a file with no values in it.
        $this->db->exec("CREATE TABLE vault(secret_value TEXT); INSERT INTO vault VALUES ('s1')");
        $this->assertSame(["\xEF\xBB\xBF\r\n", '[]'], [$this->export('vault', 'csv')[0], $this->export('vault', 'json')[0]]);
    }

    public function testTheRowLimitCutsATableAndSaysSo(): void
    {
        [$csv, $cut] = $this->export('things', 'csv', [], 4);
        $this->assertTrue($cut);
        $this->assertSame(5, substr_count($csv, "\r\n") - 1, 'the column names and four rows (one holds a line break of its own)');
        $this->assertStringEndsWith("4,,0,0.1,\r\n", $csv);
        [$json, $cut] = $this->export('things', 'json', [], 4);
        $this->assertTrue($cut);
        $this->assertSame([1, 2, 3, 4], array_column(json_decode($json, true, 8, JSON_THROW_ON_ERROR), 'id'));
        // Exactly as many rows as the limit is not a cut.
        $this->assertFalse($this->export('things', 'json', [], 6)[1]);
        $this->assertFalse($this->export('things', 'csv', ['q' => 'plain'], 1)[1]);
        // The limit is each table's: one cut table does not stop the next.
        [$all, $cut] = $this->export(null, 'json', [], 2);
        $this->assertTrue($cut);
        $tables = json_decode($all, true, 8, JSON_THROW_ON_ERROR)['tables'];
        $this->assertSame([2, 2], [count($tables['tags']), count($tables['things'])]);
    }

    public function testTheSizeLimitStopsAtTheEndOfARowAndTheFileStillReads(): void
    {
        $whole = $this->export('things', 'json')[0];
        foreach ([40, 90, 200, strlen($whole) - 1] as $bytes) {
            [$json, $cut] = $this->export('things', 'json', [], null, $bytes);
            $this->assertTrue($cut, "$bytes bytes");
            $this->assertLessThanOrEqual($bytes, strlen($json));
            $rows = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
            $this->assertSame(array_slice(json_decode($whole, true), 0, count($rows)), $rows, 'whole rows, from the first');
        }
        $this->assertSame([$whole, false], $this->export('things', 'json', [], null, strlen($whole)), 'a file that fits is not cut');

        // Room for the column names, two rows and a little of the third: the file is the first two, whole.
        $complete = $this->export('things', 'csv')[0];
        $twoRows = strpos($complete, '3,"line');
        [$csv, $cut] = $this->export('things', 'csv', [], null, $twoRows + 5);
        $this->assertSame([substr($complete, 0, $twoRows), true], [$csv, $cut]);
        $this->assertStringEndsWith("2.0,\r\n", $csv);
        $this->assertSame([$complete, false], $this->export('things', 'csv', [], null, strlen($complete)));

        // Every table: the one being written stops at a row, the tables after it are left out, the file closes.
        $everything = $this->export(null, 'json')[0];
        foreach ([30, 60, 120, strlen($everything) - 1] as $bytes) {
            [$json, $cut] = $this->export(null, 'json', [], null, $bytes);
            $this->assertTrue($cut, "$bytes bytes");
            $this->assertLessThanOrEqual($bytes, strlen($json));
            $tables = json_decode($json, true, 8, JSON_THROW_ON_ERROR)['tables'];
            $this->assertContains(array_keys($tables), [[], ['tags'], ['tags', 'things']]);
        }
        $this->assertSame('{"tables":{"tags":[]}}', $this->export(null, 'json', [], null, 30)[0], 'no room for a row of tags, nor for the next table\'s name');
        $this->assertSame([$everything, false], $this->export(null, 'json', [], null, strlen($everything)));
    }
}
