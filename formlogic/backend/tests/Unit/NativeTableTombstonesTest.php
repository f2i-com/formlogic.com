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
 * A desktop that keeps a copy of a form's records asks what changed since its last sync, and is
 * told which records were deleted (`deleted`), whether that list is whole (`deletedComplete`) and
 * from when (`deletedSince`). The list is read from the tombstones in the form's own database,
 * which a form kept in an app's table never writes to: `deleted` was always empty and
 * `deletedComplete` always true, so a desktop kept every record deleted there.
 *
 * A record deleted through FormLogic (one delete, a clear) now leaves a tombstone, and the list
 * is never said to be whole, since the app deletes rows of its own that FormLogic cannot see.
 */
final class NativeTableTombstonesTest extends TestCase
{
    private string $dir;
    private PDO $db;
    private PDO $mysql;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-tomb-' . bin2hex(random_bytes(5));
        FormEncryptionService::invalidateCache();
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, updated_at TEXT)');
        $insert = $this->db->prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
        foreach ([1 => 'Alpha', 2 => 'Bravo', 3 => 'Charlie'] as $id => $title) {
            $insert->execute([$id, $title, 'note ' . $id, '2026-01-0' . $id . ' 09:00:00']);
        }
        $this->db->exec('CREATE TABLE pairs (a TEXT, b TEXT, title TEXT, PRIMARY KEY (a, b))');
        $this->db->exec("INSERT INTO pairs VALUES ('x', 'y z', 'Pair')");

        $this->mysql = new PDO('sqlite::memory:');
        $this->mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->mysql->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->mysql->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->mysql->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, settings TEXT, response_count INTEGER, updated_at TEXT)');
        $this->mysql->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT)');
        $this->mysql->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $this->mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $bind = $this->mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES (?, 'owner-1', ?)");
        $bind->execute(['form-1', json_encode(['nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'jobs', 'primaryKey' => ['id'], 'columns' => ['f_title' => 'title', 'f_notes' => 'notes'],
        ]], JSON_THROW_ON_ERROR)]);
        $bind->execute(['form-2', json_encode(['nativeTableBinding' => [
            'appId' => 'app-1', 'table' => 'pairs', 'primaryKey' => ['a', 'b'], 'columns' => ['f_title' => 'title'],
        ]], JSON_THROW_ON_ERROR)]);
    }

    protected function tearDown(): void
    {
        NativeAppService::clearSandboxRootOverrides();
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

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($this->mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge(new NativeTableFormBridge($this->mysql, $native));
        return $service;
    }

    /** @return list<string> */
    private static function ids(array $tombstones): array
    {
        return array_column($tombstones['deleted'], 'id');
    }

    public function testARecordDeletedThroughTheFormIsListedAsDeleted(): void
    {
        $responses = $this->responses();
        $before = gmdate('Y-m-d H:i:s');

        self::assertTrue($responses->deleteResponse('form-1', '2'));

        $gone = $responses->getResponseTombstones('form-1', '2026-01-01 00:00:00');
        self::assertSame(['2'], self::ids($gone), 'a desktop never heard the record was deleted');
        self::assertGreaterThanOrEqual($before, $gone['deleted'][0]['deletedAt']);
        // Rows the app deletes are not seen, so the list is never whole: a desktop compares its whole copy.
        self::assertFalse($gone['complete']);
        self::assertGreaterThanOrEqual($before, $gone['since']);
        // Only what was deleted since the time asked.
        self::assertSame([], self::ids($responses->getResponseTombstones('form-1', '2099-01-01 00:00:00')));
    }

    public function testAClearListsEveryRecordItTook(): void
    {
        $responses = $this->responses();

        self::assertSame(3, $responses->deleteAllResponses('form-1'));
        $gone = $responses->getResponseTombstones('form-1', '2026-01-01 00:00:00');
        self::assertSame(['1', '2', '3'], self::ids($gone));

        // A composite key is named as a list names it.
        $listed = $responses->getFormResponses('form-2');
        self::assertSame(1, $responses->deleteAllResponses('form-2'));
        self::assertSame([$listed[0]['id']], self::ids($responses->getResponseTombstones('form-2', '2026-01-01 00:00:00')));
        self::assertStringStartsWith('nk_', $listed[0]['id']);
    }

    public function testAKeyGivenToARowAgainIsNotListedAsDeleted(): void
    {
        $responses = $this->responses();
        self::assertTrue($responses->deleteResponse('form-1', '3'));
        self::assertTrue($responses->deleteResponse('form-1', '1'));
        // The app's own insert: SQLite numbers a whole-number key on from the largest, which is 3 again.
        $this->db->exec("INSERT INTO jobs (title, notes) VALUES ('Delta', 'new')");
        self::assertSame('Delta', $responses->getResponse('form-1', '3')['answers']['f_title']);

        // Told 3 is gone, a desktop would delete its copy of Delta and skip Delta itself.
        self::assertSame(['1'], self::ids($responses->getResponseTombstones('form-1', '2026-01-01 00:00:00')));
    }

    public function testWhatTheAppDeletesItselfIsNotClaimedComplete(): void
    {
        $responses = $this->responses();
        $this->db->exec('DELETE FROM jobs WHERE id = 1');

        $gone = $responses->getResponseTombstones('form-1', '2026-01-01 00:00:00');
        self::assertSame([], $gone['deleted']);
        self::assertFalse($gone['complete'], 'the desktop was told it had heard of every deletion');
    }

    public function testADemoVisitorsDeletionsAreNotTheForms(): void
    {
        $responses = $this->responses();
        NativeAppService::setSandboxRootOverride('app-1', $this->dir);
        self::assertTrue($responses->deleteResponse('form-1', '2'));
        $responses->deleteAllResponses('form-1');
        NativeAppService::clearSandboxRootOverrides();

        self::assertSame([], self::ids($responses->getResponseTombstones('form-1', '2026-01-01 00:00:00')));
    }

    public function testTheSyncListSaysSo(): void
    {
        $responses = $this->responses();
        self::assertTrue($responses->deleteResponse('form-1', '2'));

        $forms = $this->createStub(FormService::class);
        $forms->method('getForm')->willReturn(['id' => 'form-1', 'userId' => 'owner-1', 'fields' => [
            ['id' => 'f_title', 'type' => 'short_text', 'label' => 'Title'],
            ['id' => 'f_notes', 'type' => 'long_text', 'label' => 'Notes'],
        ]]);
        $controller = new ExternalApiController($forms, $responses, $this->createStub(WebhookService::class));
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/v1/forms/form-1/responses')
            ->withQueryParams(['updatedSince' => '2026-01-01 00:00:00'])
            ->withAttribute('userId', 'owner-1')->withAttribute('apiKeyScopes', ['responses:read', 'responses:manage']);
        $listed = $controller->listResponses($request, (new ResponseFactory())->createResponse(), ['formId' => 'form-1']);

        self::assertSame(200, $listed->getStatusCode());
        $body = json_decode((string) $listed->getBody(), true);
        self::assertSame(['1', '3'], array_column($body['responses'], 'id'));
        self::assertSame(['2'], array_column($body['deleted'], 'id'));
        self::assertFalse($body['deletedComplete']);
        self::assertLessThanOrEqual($body['deletedSince'], $body['serverTime'], 'a client whose last sync is older compares its whole copy');

        // The etag the list gives, sent back once the record has changed: 412, and nothing written.
        $etag = $body['responses'][0]['etag'];
        $this->db->exec("UPDATE jobs SET notes = 'changed by the app', updated_at = '2026-03-03 10:00:00' WHERE id = 1");
        $put = (new ServerRequestFactory())->createServerRequest('PUT', '/api/v1/forms/form-1/responses/1')
            ->withParsedBody(['answers' => ['f_notes' => 'stale write']])->withHeader('If-Match', '"' . $etag . '"')
            ->withAttribute('userId', 'owner-1')->withAttribute('apiKeyScopes', ['responses:read', 'responses:manage']);
        $stale = $controller->updateResponse($put, (new ResponseFactory())->createResponse(), ['formId' => 'form-1', 'id' => '1']);

        self::assertSame(412, $stale->getStatusCode(), (string) $stale->getBody());
        $conflict = json_decode((string) $stale->getBody(), true);
        self::assertSame('version_conflict', $conflict['code']);
        self::assertSame('changed by the app', $conflict['response']['answers']['f_notes']);
        self::assertSame('changed by the app', $this->db->query('SELECT notes FROM jobs WHERE id = 1')->fetchColumn());
    }
}
