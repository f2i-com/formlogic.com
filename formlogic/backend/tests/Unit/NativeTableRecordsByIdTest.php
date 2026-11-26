<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Linked records' labels, related lists and a lookup of the ids a client names read a form's
 * records by id (ResponseService::getResponsesByIds), which gives every one asked for. A form kept
 * in an app's table read the first 250 ids one at a time and left the rest out without a word:
 * the 251st linked record showed no label. It now reads all of them, in one read of the table.
 */
final class NativeTableRecordsByIdTest extends TestCase
{
    private string $dir;
    /** How many times the bridge opened the app's database. */
    private int $opened = 0;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-byid-' . bin2hex(random_bytes(5));
        FormEncryptionService::invalidateCache();
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    private function responses(int $rows): ResponseService
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, notes TEXT)');
        $db->exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {$rows}) INSERT INTO jobs SELECT i, 'Job ' || i, printf('%0500d', i) FROM n");

        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static fn (): array => ['jobs' => (new NativeRecordStore($db))->schema('jobs')]);
        $native->method('withDatabase')->willReturnCallback(function (string $appId, callable $use) use ($db): mixed {
            $this->opened++;
            return $use($db);
        });

        $mysql = new PDO('sqlite::memory:');
        $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT)');
        $mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES ('form-1', 'owner-1', ?)")->execute([json_encode(['nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'jobs', 'primaryKey' => ['id'], 'columns' => ['f_title' => 'title', 'f_notes' => 'notes'],
        ]], JSON_THROW_ON_ERROR)]);
        $mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge(new NativeTableFormBridge($mysql, $native));
        return $service;
    }

    public function testEveryIdAskedForIsRead(): void
    {
        $responses = $this->responses(600);
        $ids = array_map('strval', range(600, 1, -1));

        $this->opened = 0;
        $found = $responses->getResponsesByIds('form-1', $ids);

        self::assertCount(600, $found, 'the first 250 were read, and the rest left out');
        self::assertSame($ids, array_column($found, 'id'), 'in the order asked');
        self::assertSame('Job 1', $found[599]['answers']['f_title']);
        self::assertSame(str_pad('1', 500, '0', STR_PAD_LEFT), $found[599]['answers']['f_notes'], 'each value whole');
        self::assertSame(1, $this->opened, 'one read of the table');
        // As one record is read.
        self::assertSame($responses->getResponse('form-1', '42'), $found[558]);
    }

    public function testAnIdTwiceIsOneRecordAndAnIdOfNoRowIsNone(): void
    {
        $found = $this->responses(10)->getResponsesByIds('form-1', ['5', '5', '9999', 7, 'nk_not-a-key', '3']);

        self::assertSame(['5', '3'], array_column($found, 'id'));
    }
}
