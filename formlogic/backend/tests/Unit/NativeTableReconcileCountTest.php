<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ReconcileService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The store doctor (bin/reconcile.php --fix) sets each form's `response_count` to the records it
 * counts in the form's own SQLite file. A form kept in an app's table has none there (the file
 * holds its tombstones and the hour's purge marker, or the records it had before it was bound):
 * every run set its count to 0, or to the count before it was bound. It now counts the table, as
 * ResponseService keeps the count, and does not report such a form as one whose file is missing.
 */
final class NativeTableReconcileCountTest extends TestCase
{
    // Form ids as a form is given them: a form's file is named by its id, which the doctor reads back.
    private const BOUND = '11111111-1111-4111-8111-111111111111';
    private const BOUND_NO_FILE = '22222222-2222-4222-8222-222222222222';
    private const GONE_TABLE = '33333333-3333-4333-8333-333333333333';
    private const OWN = '44444444-4444-4444-8444-444444444444';

    private string $dir;
    private PDO $mysql;
    private SQLiteConnection $sqlite;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-recon-' . bin2hex(random_bytes(5));
        mkdir($this->dir);
        FormEncryptionService::invalidateCache();
        $this->sqlite = new SQLiteConnection($this->dir);
        $this->mysql = new PDO('sqlite::memory:');
        $this->mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT, response_count INTEGER, updated_at TEXT)');
        $this->mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $this->mysql->exec('CREATE TABLE response_metadata (id TEXT, form_id TEXT, status TEXT, submitted_at TEXT)');
        $this->mysql->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $this->mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $add = $this->mysql->prepare("INSERT INTO forms (id, user_id, settings, response_count, updated_at) VALUES (?, 'owner-1', ?, ?, '2026-01-01 00:00:00')");
        $bound = static fn (string $table): string => json_encode(['nativeTableBinding' => ['appId' => 'app-1', 'table' => $table, 'primaryKey' => ['id'], 'columns' => ['f_title' => 'title']]], JSON_THROW_ON_ERROR);
        // Kept in the table, which has three rows: a stale count, and a file of its own with none.
        $add->execute([self::BOUND, $bound('jobs'), 7]);
        $this->sqlite->getFormDatabase(self::BOUND);
        // Kept in the table too, its count right, and no file of its own.
        $add->execute([self::BOUND_NO_FILE, $bound('jobs'), 3]);
        // A table that cannot be read gives no count to set.
        $add->execute([self::GONE_TABLE, $bound('missing_table'), 5]);
        $this->sqlite->getFormDatabase(self::GONE_TABLE);
        // A form of its own store, with no file.
        $add->execute([self::OWN, '{}', 0]);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    private function reconcile(): ReconcileService
    {
        $app = new PDO('sqlite::memory:');
        $app->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $app->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT)');
        $app->exec("INSERT INTO jobs (title) VALUES ('Alpha'), ('Bravo'), ('Charlie')");
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($app));
        return new ReconcileService($this->mysql, $this->sqlite, $this->dir, $this->dir . '/uploads', null, new NativeTableFormBridge($this->mysql, $native));
    }

    /** @return array<string, int> */
    private function counts(): array
    {
        return array_map('intval', array_column($this->mysql->query('SELECT id, response_count FROM forms ORDER BY id')->fetchAll(), 'response_count', 'id'));
    }

    public function testTheFixCountsTheTable(): void
    {
        $recon = $this->reconcile();
        $drift = $recon->report()['countDrift'];
        self::assertSame([['formId' => self::BOUND, 'table' => 3, 'cached' => 7]], $drift);

        $fixed = $recon->fix();

        self::assertSame([self::BOUND], $fixed['responseCountsResynced']);
        self::assertSame([self::BOUND => 3, self::BOUND_NO_FILE => 3, self::GONE_TABLE => 5, self::OWN => 0], $this->counts(), 'the count was set to its own file\'s, 0');
        self::assertSame('2026-01-01 00:00:00', $this->mysql->query("SELECT updated_at FROM forms WHERE id = '" . self::BOUND . "'")->fetchColumn());
        self::assertSame([], $recon->report()['countDrift'], 'nothing left to fix');
    }

    public function testAFormKeptInATableHasNoFileToMiss(): void
    {
        self::assertSame([self::OWN], $this->reconcile()->fileDrift()['missingSqlite']);
    }
}
