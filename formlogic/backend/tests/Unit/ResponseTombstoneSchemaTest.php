<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Every form database records its deletions (schema v5), so a client keeping a
 * copy of the records hears about a deletion instead of bringing the record
 * back. A form made before v5 gets the table on its next open, and says from
 * when its list of deletions is whole.
 */
class ResponseTombstoneSchemaTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-tombstones-' . bin2hex(random_bytes(5));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
    }

    private static function value(PDO $db, string $sql): mixed
    {
        return $db->query($sql)->fetchColumn();
    }

    public function testAnyDeleteLeavesATombstoneAndAPutBackTakesItAway(): void
    {
        $sqlite = new SQLiteConnection($this->dir);
        $db = $sqlite->getFormDatabase('form-new');
        $this->assertSame('1970-01-01 00:00:00', self::value($db, "SELECT value FROM form_data WHERE key = 'tombstones_since'"), 'a new form records every deletion');

        $db->exec("INSERT INTO responses (id, answers) VALUES ('r1', '{}'), ('r2', '{}'), ('r3', '{}')");
        $db->exec("DELETE FROM responses WHERE id = 'r1'");
        $db->exec('DELETE FROM responses'); // a bulk clear takes the same path
        $this->assertSame(['r1', 'r2', 'r3'], $db->query('SELECT id FROM response_tombstones ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));

        $db->exec("INSERT INTO responses (id, answers) VALUES ('r2', '{}')");
        $this->assertSame(['r1', 'r3'], $db->query('SELECT id FROM response_tombstones ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testAFormMadeBeforeTombstonesGetsThemOnItsNextOpen(): void
    {
        $sqlite = new SQLiteConnection($this->dir);
        $path = $sqlite->getFormDbPath('form-old');
        // A v4 form database, as one made before this change is on disk.
        $old = new PDO('sqlite:' . $path);
        $old->exec("CREATE TABLE form_data (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
        $old->exec("CREATE TABLE responses (id TEXT PRIMARY KEY, answers TEXT NOT NULL, metadata TEXT, status TEXT DEFAULT 'submitted', submitted_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
        $old->exec("INSERT INTO form_data (key, value) VALUES ('schema_version', '4')");
        $old->exec("INSERT INTO responses (id, answers) VALUES ('kept', '{}')");
        $old = null;

        $db = $sqlite->getFormDatabase('form-old');
        $this->assertSame('5', self::value($db, "SELECT value FROM form_data WHERE key = 'schema_version'"));
        $since = (string) self::value($db, "SELECT value FROM form_data WHERE key = 'tombstones_since'");
        $this->assertGreaterThanOrEqual(gmdate('Y-m-d H:i:s', time() - 60), $since, 'deletions before the upgrade were never recorded');
        $this->assertSame('1', (string) self::value($db, "SELECT COUNT(*) FROM responses"), 'the records are untouched');

        $db->exec("DELETE FROM responses WHERE id = 'kept'");
        $this->assertSame('kept', self::value($db, 'SELECT id FROM response_tombstones'));
    }

    public function testAnEtagMovesWithTheAnswersTheStatusAndTheTime(): void
    {
        $r = ['answers' => ['status' => 'requested'], 'status' => 'submitted', 'updatedAt' => '2026-09-29 10:00:00'];
        $same = ResponseService::etagOf($r);
        $this->assertSame($same, ResponseService::etagOf($r + ['computed' => ['x' => 1]]), 'only what a client writes counts');
        $this->assertNotSame($same, ResponseService::etagOf(['answers' => ['status' => 'confirmed']] + $r));
        $this->assertNotSame($same, ResponseService::etagOf(['status' => 'reviewed'] + $r));
        $this->assertNotSame($same, ResponseService::etagOf(['updatedAt' => '2026-09-29 10:00:01'] + $r));
    }
}
