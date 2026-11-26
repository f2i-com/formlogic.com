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
 * The app's records page a form's rows and say how many there are (`total`). For a form bound to
 * an app's table that was the table's every row whatever the list was filtered by, and with a
 * search the length of the page: a records page of one status counted the whole table, and a
 * search of 30 matches said 20. It is now how many rows match, counted once in the table under
 * the conditions the rows are read by, as a form's own store counts its own.
 */
final class NativeTableListTotalTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-total-' . bin2hex(random_bytes(5));
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

    /** 30 jobs: every third closed, the rest open; ten of them Alpha; members 1 and 2 by turns. */
    private static function appDatabase(int $rows = 30): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, state TEXT, submitted_by_user_id TEXT)');
        $insert = $db->prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
        for ($i = 1; $i <= $rows; $i++) {
            $insert->execute([$i, ($i % 3 === 1 ? 'Alpha ' : 'Bravo ') . $i, $i % 3 === 0 ? 'closed' : 'open', 'member-' . (1 + $i % 2)]);
        }
        return $db;
    }

    private const COLUMNS = ['f_title' => 'title', 'f_state' => 'state'];

    /** @param list<array<string, mixed>> $reads the options of each read the bridge makes of the store */
    private function bridge(PDO $appDb, PDO $mysql, array &$reads = []): NativeTableFormBridge
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static fn (): array => ['jobs' => (new NativeRecordStore($appDb))->schema('jobs')]);
        $native->method('records')->willReturnCallback(
            static function (string $appId, ?string $table, int $offset, ?int $generation, ?array $options) use ($appDb, &$reads): array {
                $reads[] = $options ?? [];
                return (new NativeRecordStore($appDb))->browse((string) $table, $offset, $options ?? []);
            }
        );
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($appDb));
        return new NativeTableFormBridge($mysql, $native);
    }

    /** @param list<array<string, mixed>> $reads */
    private function responses(PDO $appDb, array &$reads = []): ResponseService
    {
        $mysql = new PDO('sqlite::memory:');
        $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT)');
        $mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $settings = json_encode(['nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'jobs', 'primaryKey' => ['id'], 'columns' => self::COLUMNS, 'statusColumn' => 'state',
        ]], JSON_THROW_ON_ERROR);
        $mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES ('form-1', 'owner-1', ?)")->execute([$settings]);
        $mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge($this->bridge($appDb, $mysql, $reads));
        return $service;
    }

    /** @param array<string, mixed> $options @return array{ids: list<int>, total: int} */
    private function page(array $options, string $search = '', ?PDO $db = null): array
    {
        $result = $this->responses($db ?? self::appDatabase())->getFormResponsesSearchable('form-1', $search, [], $options);
        return ['ids' => array_map(static fn (array $r): int => (int) $r['id'], $result['responses']), 'total' => $result['total']];
    }

    public function testTheTotalIsWhatTheListIsFilteredBy(): void
    {
        self::assertSame(30, $this->page(['limit' => 5])['total']);
        // Ten of the thirty are closed; the first page of them is five.
        $closed = $this->page(['limit' => 5, 'status' => 'closed']);
        self::assertSame([3, 6, 9, 12, 15], $closed['ids']);
        self::assertSame(10, $closed['total'], 'the whole table was counted');
        self::assertSame(1, $this->page(['limit' => 5, 'answersEq' => ['f_title' => 'Alpha 4']])['total']);
        // A member's own: fifteen are member-1's, five of those closed.
        self::assertSame(15, $this->page(['limit' => 5, 'submittedByUserId' => 'member-1'])['total']);
        self::assertSame(5, $this->page(['limit' => 5, 'submittedByUserId' => 'member-1', 'status' => 'closed'])['total']);
        // Nothing can match a field with no column: none, never the table.
        self::assertSame(['ids' => [], 'total' => 0], $this->page(['limit' => 5, 'answersEq' => ['f_missing' => 'x']]));
    }

    public function testASearchCountsEveryRowItFindsNotThePage(): void
    {
        $found = $this->page(['limit' => 4], 'Alpha');
        self::assertSame([1, 4, 7, 10], $found['ids']);
        self::assertSame(10, $found['total'], 'the length of the page');
        // Past the last of them: no rows, and still the number there are.
        self::assertSame(['ids' => [], 'total' => 10], $this->page(['limit' => 4, 'offset' => 40], 'Alpha'));
        // Bravo 2, 20, 21, 23, 24, 26, 27 and 29; of them 21, 24 and 27 are closed.
        self::assertSame(['ids' => [21, 24], 'total' => 3], $this->page(['limit' => 2, 'status' => 'closed'], 'Bravo 2'));
    }

    public function testTheTableIsCountedOnceAList(): void
    {
        // A long list reads the table a page at a time; one of the reads counts.
        $reads = [];
        $result = $this->responses(self::appDatabase(600), $reads)->getFormResponsesSearchable('form-1', '', [], ['limit' => 1000, 'status' => 'open']);
        self::assertCount(400, $result['responses']);
        self::assertSame(400, $result['total']);
        self::assertSame([true, false], array_map(static fn (array $read): bool => ($read['count'] ?? true) !== false, $reads));

        // A list that gives no total, an export's page among them, counts nothing.
        $reads = [];
        $this->responses(self::appDatabase(600), $reads)->getFormResponses('form-1', ['limit' => 1000]);
        self::assertCount(3, $reads);
        self::assertSame([false, false, false], array_map(static fn (array $read): bool => ($read['count'] ?? true) !== false, $reads));
    }
}
