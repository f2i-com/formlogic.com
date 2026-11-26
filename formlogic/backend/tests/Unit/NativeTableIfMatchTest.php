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
use FormLogic\Services\ResponseVersionConflict;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A client sends back the etag it read (`If-Match`) so that its write lands only on that version
 * of the record: anything else is a 412 with the record as it now is. A form kept in an app's
 * table dropped the etag on the way to the table, so a stale write overwrote whatever had changed
 * since, and an edit merged over a record (ResponseService::mergeEdit, which every partial update
 * goes through) lost the edit that landed before it. The bridge now compares the etag a list or a
 * read gives the row, inside the write's own transaction.
 */
final class NativeTableIfMatchTest extends TestCase
{
    private string $dir;
    private PDO $db;
    /** @var null|\Closure(string): void run before the store's read or update, by action */
    private ?\Closure $before = null;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-ifmatch-' . bin2hex(random_bytes(5));
        FormEncryptionService::invalidateCache();
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, state TEXT, created_at TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO jobs VALUES (1, 'Alpha', 'first', 'open', '2026-01-01 09:00:00', '2026-01-01 09:00:00')");
        $this->db->exec("INSERT INTO jobs VALUES (2, 'Bravo', 'second', 'open', '2026-01-02 09:00:00', '2026-01-02 09:00:00')");
        // A table that says nothing of when a row was made or changed.
        $this->db->exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        $this->db->exec("INSERT INTO notes VALUES (1, 'Remember the milk')");
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    /** @return array<string, mixed> a binding as resolveBinding() gives it */
    private static function binding(string $table = 'jobs'): array
    {
        return $table === 'jobs' ? [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'jobs', 'primaryKey' => ['id'],
            'columns' => ['f_title' => 'title', 'f_notes' => 'notes'],
            'createdAtColumn' => 'created_at', 'statusColumn' => 'state',
        ] : [
            'formId' => 'form-2', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'notes', 'primaryKey' => ['id'], 'columns' => ['f_body' => 'body'],
            'createdAtColumn' => null, 'statusColumn' => null,
        ];
    }

    private function native(): NativeAppService
    {
        $db = $this->db;
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static function () use ($db): array {
            $store = new NativeRecordStore($db);
            return array_combine($store->tables(), array_map($store->schema(...), $store->tables()));
        });
        $native->method('records')->willReturnCallback(
            static fn (string $appId, ?string $table, int $offset, ?int $generation, ?array $options): array => (new NativeRecordStore($db))->browse((string) $table, $offset, $options ?? [])
        );
        // As NativeAppService::manageRecord runs it: the store's own operation, one at a time.
        $native->method('manageRecord')->willReturnCallback(function (string $appId, array $input, array $subscriptions = []) use ($db): array {
            if ($this->before !== null) {
                ($this->before)((string) ($input['action'] ?? ''));
            }
            return (new NativeRecordStore($db))->operate($input, $subscriptions);
        });
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($db));
        return $native;
    }

    private function bridge(): NativeTableFormBridge
    {
        return new NativeTableFormBridge(new PDO('sqlite::memory:'), $this->native());
    }

    /** Another writer's change to job 1, straight into the table (the app itself, another member). */
    private function changedElsewhere(): void
    {
        $this->db->exec("UPDATE jobs SET notes = 'changed by the app', updated_at = '2026-03-03 10:00:00' WHERE id = 1");
    }

    private function notes(int $id = 1): string
    {
        return (string) $this->db->query('SELECT notes FROM jobs WHERE id = ' . $id)->fetchColumn();
    }

    public function testAStaleEtagIsAConflictAndNothingIsWritten(): void
    {
        $bridge = $this->bridge();
        // The etag a list gives the record, as the API sends it.
        $listed = $bridge->listResponses(self::binding(), ['limit' => 10]);
        $read = ResponseService::etagOf($listed[0]);
        self::assertSame($read, ResponseService::etagOf($bridge->getResponse(self::binding(), '1')), 'a list and a read give one version');

        $this->changedElsewhere();
        try {
            $bridge->updateResponse(self::binding(), '1', ['answers' => ['f_notes' => 'stale write']], $read);
            self::fail('A write over a version the client never read was made.');
        } catch (ResponseVersionConflict $conflict) {
            self::assertSame('changed by the app', $conflict->current()['answers']['f_notes'], 'the record as it is now travels with the refusal');
            self::assertNotSame($read, ResponseService::etagOf($conflict->current()));
        }
        self::assertSame('changed by the app', $this->notes(), 'the stale write overwrote the change');
    }

    public function testTheVersionReadIsWritten(): void
    {
        $bridge = $this->bridge();
        $version = ResponseService::etagOf($bridge->getResponse(self::binding(), '1'));

        $updated = $bridge->updateResponse(self::binding(), '1', ['answers' => ['f_notes' => 'mine']], $version);

        self::assertSame('mine', $updated['answers']['f_notes']);
        self::assertSame('mine', $this->notes());
        self::assertNotSame($version, ResponseService::etagOf($updated), 'a new version');
        // Without an etag a write is made as before.
        self::assertSame('anyone', $bridge->updateResponse(self::binding(), '1', ['answers' => ['f_notes' => 'anyone']])['answers']['f_notes']);
    }

    public function testAChangeBetweenTheReadAndTheWriteIsNotWrittenOver(): void
    {
        $bridge = $this->bridge();
        $version = ResponseService::etagOf($bridge->getResponse(self::binding(), '1'));
        // The other write lands after the bridge has read the record, before it writes.
        $this->before = function (string $action): void {
            if ($action === 'update') {
                $this->before = null;
                $this->changedElsewhere();
            }
        };

        try {
            $bridge->updateResponse(self::binding(), '1', ['answers' => ['f_notes' => 'stale write']], $version);
            self::fail('The write went over a change made after it was checked.');
        } catch (ResponseVersionConflict $conflict) {
            self::assertSame('changed by the app', $conflict->current()['answers']['f_notes']);
        }
        self::assertSame('changed by the app', $this->notes());
        self::assertFalse($this->db->inTransaction());
    }

    public function testAnEtagForARecordThatIsGoneIsNotFound(): void
    {
        $bridge = $this->bridge();
        $version = ResponseService::etagOf($bridge->getResponse(self::binding(), '2'));
        $this->before = function (string $action): void {
            if ($action === 'update') {
                $this->db->exec('DELETE FROM jobs WHERE id = 2');
            }
        };

        self::assertNull($bridge->updateResponse(self::binding(), '2', ['answers' => ['f_notes' => 'late']], $version));
    }

    public function testNothingToWriteStillChecksTheVersion(): void
    {
        $bridge = $this->bridge();
        $version = ResponseService::etagOf($bridge->getResponse(self::binding(), '1'));
        $this->changedElsewhere();

        $this->expectException(ResponseVersionConflict::class);
        $bridge->updateResponse(self::binding(), '1', ['answers' => ['f_unknown' => 'x']], $version);
    }

    public function testARowWithNoTimeHasOneVersionWhenEverItIsRead(): void
    {
        $bridge = $this->bridge();
        $read = $bridge->getResponse(self::binding('notes'), '1');
        self::assertTrue($read['metadata']['timeUnknown'] ?? false, 'the time shown is the time of the read');
        // A client that read it in another second holds this copy of it.
        $earlier = ['submittedAt' => '2026-01-01 00:00:00', 'updatedAt' => '2026-01-01 00:00:00'] + $read;
        self::assertSame(ResponseService::etagOf($read), ResponseService::etagOf($earlier));

        $updated = $bridge->updateResponse(self::binding('notes'), '1', ['answers' => ['f_body' => 'Remember the bread']], ResponseService::etagOf($earlier));
        self::assertSame('Remember the bread', $updated['answers']['f_body']);
        // A row whose time is its own is versioned by it.
        self::assertArrayNotHasKey('timeUnknown', $bridge->getResponse(self::binding(), '1')['metadata']);
    }

    // Through ResponseService, as the API and the app's routes reach the table.

    private function responses(): ResponseService
    {
        $mysql = new PDO('sqlite::memory:');
        $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT, response_count INTEGER, updated_at TEXT)');
        $mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $binding = self::binding();
        $settings = json_encode(['nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'jobs', 'primaryKey' => ['id'], 'columns' => $binding['columns'],
            'createdAtColumn' => 'created_at', 'statusColumn' => 'state',
        ]], JSON_THROW_ON_ERROR);
        $mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES ('form-1', 'owner-1', ?)")->execute([$settings]);
        $mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge(new NativeTableFormBridge($mysql, $this->native()));
        return $service;
    }

    public function testTheEtagAClientSendsReachesTheTable(): void
    {
        $responses = $this->responses();
        $version = ResponseService::etagOf($responses->getResponse('form-1', '1'));
        $this->changedElsewhere();

        $this->expectException(ResponseVersionConflict::class);
        $responses->updateResponse('form-1', '1', ['answers' => ['f_title' => 'Alpha', 'f_notes' => 'stale write']], $version);
    }

    public function testAMergedEditKeepsTheEditThatLandedFirst(): void
    {
        $responses = $this->responses();
        // Another edit lands after this one has read the record, before the bridge reads it to write.
        $this->before = function (string $action): void {
            if ($action === 'read') {
                $this->before = null;
                $this->db->exec("UPDATE jobs SET title = 'Alpha (renamed)', updated_at = '2026-03-03 10:00:00' WHERE id = 1");
            }
        };
        $attempts = 0;
        $merged = $responses->mergeEdit('form-1', '1', function (array $stored, string $version) use ($responses, &$attempts): ?array {
            $attempts++;
            return $responses->updateResponse('form-1', '1', ['answers' => ['f_notes' => 'merged note'] + $stored['answers']], $version);
        });

        self::assertSame(2, $attempts, 'merged again over the record as it then was');
        self::assertSame(['f_title' => 'Alpha (renamed)', 'f_notes' => 'merged note'], $merged['answers']);
        self::assertSame('Alpha (renamed)', $this->db->query('SELECT title FROM jobs WHERE id = 1')->fetchColumn(), 'the edit that landed first was lost');
    }
}
