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
 * A form kept in an app's table takes a record's status from a column of the table, which is
 * often also one of the form's fields. The CSV and batch imports sent every row with the status
 * 'submitted': a column of numbers (a stage) refused each row, so nothing was imported, and a
 * column of text that the import filled had its value replaced with the word 'submitted'.
 *
 * An import now writes a status only where it carries one, never over a value it imported for
 * the column, and never one the column cannot give back.
 */
final class NativeTableImportStatusTest extends TestCase
{
    private string $dir;
    private PDO $db;

    private const FIELDS = [
        ['id' => 'f_title', 'type' => 'short_text', 'label' => 'Title'],
        ['id' => 'f_state', 'type' => 'short_text', 'label' => 'State'],
        ['id' => 'f_stage', 'type' => 'number', 'label' => 'Stage'],
    ];

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-import-' . bin2hex(random_bytes(5));
        FormEncryptionService::invalidateCache();
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // A stage the app numbers, and a state it names.
        $this->db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, stage INTEGER)');
        $this->db->exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT, state TEXT)');
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    private function responses(): ResponseService
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

        $mysql = new PDO('sqlite::memory:');
        $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT, response_count INTEGER, updated_at TEXT)');
        $mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $mysql->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $bind = $mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES (?, 'owner-1', ?)");
        foreach ([
            // The stage is the status, and not one of the fields imported.
            'form-jobs' => ['table' => 'jobs', 'columns' => ['f_title' => 'title'], 'statusColumn' => 'stage'],
            // The stage is the status, and one of the fields imported.
            'form-staged' => ['table' => 'jobs', 'columns' => ['f_title' => 'title', 'f_stage' => 'stage'], 'statusColumn' => 'stage'],
            'form-tickets' => ['table' => 'tickets', 'columns' => ['f_title' => 'title', 'f_state' => 'state'], 'statusColumn' => 'state'],
        ] as $formId => $binding) {
            $bind->execute([$formId, json_encode(['nativeTableBinding' => $binding + ['appId' => 'app-1', 'primaryKey' => ['id']]], JSON_THROW_ON_ERROR)]);
        }

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge(new NativeTableFormBridge($mysql, $native));
        return $service;
    }

    /** @return list<array<string, mixed>> */
    private function rows(string $table): array
    {
        return $this->db->query("SELECT * FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
    }

    public function testACsvIntoATableThatNumbersItsStatusIsImported(): void
    {
        $result = $this->responses()->importResponses('form-jobs', [['Alpha'], ['Bravo']], [0 => 'f_title'], self::FIELDS);

        self::assertSame(['created' => 2, 'skipped' => 0, 'total' => 2, 'errors' => []], $result, 'every row was refused');
        self::assertSame([['id' => 1, 'title' => 'Alpha', 'stage' => null], ['id' => 2, 'title' => 'Bravo', 'stage' => null]], $this->rows('jobs'));
        // Listed as a row with no status is.
        self::assertSame(['submitted', 'submitted'], array_column($this->responses()->getFormResponses('form-jobs'), 'status'));
    }

    public function testACsvKeepsTheStatusItImports(): void
    {
        $result = $this->responses()->importResponses('form-tickets', [['Alpha', 'open'], ['Bravo', '']], [0 => 'f_title', 1 => 'f_state'], self::FIELDS);
        self::assertSame(2, $result['created']);
        self::assertSame(['open', ''], array_column($this->rows('tickets'), 'state'), 'the imported value was replaced with "submitted"');

        $staged = $this->responses()->importResponses('form-staged', [['Charlie', '2']], [0 => 'f_title', 1 => 'f_stage'], self::FIELDS);
        self::assertSame(1, $staged['created'], json_encode($staged['errors']));
        self::assertSame(2, $this->rows('jobs')[0]['stage']);
        self::assertSame('2', $this->responses()->getFormResponses('form-staged')[0]['status']);
    }

    public function testABatchWritesTheStatusItCarriesAndNoOther(): void
    {
        $result = $this->responses()->batchImportResponses('form-tickets', [
            ['clientKey' => 'kept', 'answers' => ['f_title' => 'Alpha', 'f_state' => 'open'], 'status' => 'reviewed'],
            ['clientKey' => 'carried', 'answers' => ['f_title' => 'Bravo'], 'status' => 'reviewed'],
            ['clientKey' => 'none', 'answers' => ['f_title' => 'Charlie']],
            ['clientKey' => 'default', 'answers' => ['f_title' => 'Delta'], 'status' => 'submitted'],
        ], self::FIELDS);

        self::assertSame(4, $result['created'], json_encode($result['results']));
        // What was imported for the column is the record's own; a status fills only an empty one.
        self::assertSame(['open', 'reviewed', null, null], array_column($this->rows('tickets'), 'state'));
        self::assertSame(['open', 'reviewed', 'submitted', 'submitted'], array_column($this->responses()->getFormResponses('form-tickets', ['sort' => 'f_title', 'sortDir' => 'asc']), 'status'));
    }

    public function testABatchIntoATableThatNumbersItsStatusIsImported(): void
    {
        $result = $this->responses()->batchImportResponses('form-jobs', [
            ['answers' => ['f_title' => 'Alpha'], 'status' => 'submitted'],
            ['answers' => ['f_title' => 'Bravo'], 'status' => 'reviewed'],
            ['answers' => ['f_title' => 'Charlie']],
        ], self::FIELDS);

        self::assertSame(3, $result['created'], json_encode($result['results']));
        self::assertSame([null, null, null], array_column($this->rows('jobs'), 'stage'), 'a word in a column of numbers');
    }
}
