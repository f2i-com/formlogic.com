<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ExternalApiController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * A form's `retentionDays` deletes its records once they are that old (the receptionist pack's
 * call and SMS forms keep 90 days). A form kept in an app's table was never purged: the purge
 * read the form's own file, which holds none of its records. Where the table was made for the
 * form (an app's Unified SQLite database, the form's own records moved there) they are now purged
 * there, each as one delete is, tombstone and all. A form bound to a table of an app's own is
 * not: those rows are the app's data. The API says which (`retention.applies`).
 *
 * The nightly job read such a form without the bridge and purged its own file: the copies it had
 * of its records from before it was bound, under the ids its live records have, so the live
 * records' links went with them. It no longer touches that file.
 */
final class NativeTableRetentionTest extends TestCase
{
    private string $dir;
    private PDO $db;
    private PDO $mysql;

    private const MANAGED = 'form-managed';
    private const LINKED = 'form-linked';

    private static function daysAgo(int $days): string
    {
        return gmdate('Y-m-d H:i:s', time() - $days * 86400);
    }

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-retain-' . bin2hex(random_bytes(5));
        FormEncryptionService::invalidateCache();
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // A table made for a form, as FormSqliteDatabaseService::syncSingleFormSchema makes one.
        $this->db->exec('CREATE TABLE calls ("id" TEXT PRIMARY KEY, "note" TEXT, "status" TEXT NOT NULL DEFAULT \'submitted\', "_submitted_by_user_id" TEXT NULL, '
            . '"created_at" TEXT NOT NULL DEFAULT (datetime(\'now\')), "updated_at" TEXT NOT NULL DEFAULT (datetime(\'now\')))');
        $call = $this->db->prepare('INSERT INTO calls (id, note, created_at, updated_at) VALUES (?, ?, ?, ?)');
        foreach (['old-1' => 200, 'old-2' => 91, 'new-1' => 2] as $id => $age) {
            $call->execute([$id, 'call ' . $id, self::daysAgo($age), self::daysAgo($age)]);
        }
        // A table of the app's own.
        $this->db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT)');
        $this->db->prepare("INSERT INTO jobs VALUES (1, 'Old job', ?), (2, 'New job', ?)")->execute([self::daysAgo(400), self::daysAgo(1)]);

        $this->mysql = new PDO('sqlite::memory:');
        $this->mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT, response_count INTEGER, updated_at TEXT)');
        $this->mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $this->mysql->exec('CREATE TABLE response_metadata (id TEXT, form_id TEXT, status TEXT, submitted_at TEXT)');
        $this->mysql->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $this->mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $add = $this->mysql->prepare("INSERT INTO forms (id, user_id, settings, response_count) VALUES (?, 'owner-1', ?, 3)");
        $add->execute([self::MANAGED, json_encode(['retentionDays' => 90, 'nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'calls', 'primaryKey' => ['id'], 'columns' => ['f_note' => 'note'],
            'createdAtColumn' => 'created_at', 'statusColumn' => 'status', 'managedByForm' => true,
        ]], JSON_THROW_ON_ERROR)]);
        $add->execute([self::LINKED, json_encode(['retentionDays' => 90, 'nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'jobs', 'primaryKey' => ['id'], 'columns' => ['f_title' => 'title'], 'createdAtColumn' => 'created_at',
        ]], JSON_THROW_ON_ERROR)]);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    private function responses(bool $withBridge = true): ResponseService
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
        $native->method('manageRecord')->willReturnCallback(
            static fn (string $appId, array $input, array $subscriptions = []): array => (new NativeRecordStore($db))->operate($input, $subscriptions)
        );
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($db));

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($this->mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        if ($withBridge) {
            $service->setNativeTableBridge(new NativeTableFormBridge($this->mysql, $native));
        }
        return $service;
    }

    /** @return list<string> */
    private function ids(string $table): array
    {
        return array_map('strval', $this->db->query("SELECT id FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testATableMadeForTheFormIsPurgedThere(): void
    {
        $responses = $this->responses();

        self::assertSame(2, $responses->purgeAllExpired(self::MANAGED), 'the records were never purged');

        self::assertSame(['new-1'], $this->ids('calls'));
        // Each as one delete is: a desktop hears they are gone, and the count goes down.
        self::assertSame(['old-1', 'old-2'], array_column($responses->getResponseTombstones(self::MANAGED, '2026-01-01 00:00:00')['deleted'], 'id'));
        self::assertSame(1, (int) $this->mysql->query("SELECT response_count FROM forms WHERE id = '" . self::MANAGED . "'")->fetchColumn());
        self::assertSame(0, $responses->purgeAllExpired(self::MANAGED));
    }

    public function testARecordMadeThereAgesTheOldOnesOut(): void
    {
        $responses = $this->responses();

        $responses->createResponse(self::MANAGED, ['answers' => ['f_note' => 'a new call']]);

        self::assertCount(2, $this->ids('calls'), 'the new call and new-1');
        self::assertNotContains('old-1', $this->ids('calls'));
    }

    public function testATableOfTheAppsOwnIsNeverPurged(): void
    {
        $responses = $this->responses();

        self::assertSame(0, $responses->purgeAllExpired(self::LINKED));
        $responses->createResponse(self::LINKED, ['answers' => ['f_title' => 'Another job']]);

        self::assertSame(['1', '2', '3'], $this->ids('jobs'), 'the app\'s own rows were deleted');
    }

    public function testWithoutTheBridgeTheFormsOwnFileIsLeftAlone(): void
    {
        // The copy the form's own file kept of old-1 from before it was bound, and old-1's link.
        $file = (new SQLiteConnection($this->dir))->getFormDatabase(self::MANAGED);
        $file->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES ('old-1', '{}', '{}', 'submitted', ?, ?)")
            ->execute([self::daysAgo(200), self::daysAgo(200)]);
        $this->mysql->exec("INSERT INTO response_links VALUES ('l1', '" . self::MANAGED . "', 'old-1', 'form-other', 'x', 'f_link')");

        self::assertSame(0, $this->responses(false)->purgeAllExpired(self::MANAGED));

        self::assertSame(1, (int) $this->mysql->query('SELECT COUNT(*) FROM response_links')->fetchColumn(), 'the live record\'s link was deleted');
        self::assertSame(3, (int) $this->mysql->query("SELECT response_count FROM forms WHERE id = '" . self::MANAGED . "'")->fetchColumn());
    }

    public function testTheApiSaysWhetherTheRetentionPeriodApplies(): void
    {
        $settings = fn (string $formId): array => json_decode((string) $this->mysql->query("SELECT settings FROM forms WHERE id = '{$formId}'")->fetchColumn(), true);
        $forms = $this->createStub(FormService::class);
        $forms->method('getForm')->willReturnCallback(static fn (string $formId): array => ['id' => $formId, 'userId' => 'owner-1', 'fields' => [], 'settings' => $settings($formId)]);
        $controller = new ExternalApiController($forms, $this->responses(), $this->createStub(WebhookService::class));
        $read = function (string $formId) use ($controller): array {
            $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/v1/forms/' . $formId)->withAttribute('userId', 'owner-1');
            return json_decode((string) $controller->getForm($request, (new ResponseFactory())->createResponse(), ['formId' => $formId])->getBody(), true)['form'];
        };

        self::assertSame(['days' => 90, 'applies' => true], $read(self::MANAGED)['retention']);
        $linked = $read(self::LINKED)['retention'];
        self::assertFalse($linked['applies']);
        self::assertStringContainsString('never deletes', $linked['reason']);
        self::assertFalse(ResponseService::retentionApplies($settings(self::LINKED)));
        self::assertTrue(ResponseService::retentionApplies(['retentionDays' => 30]));
    }
}
