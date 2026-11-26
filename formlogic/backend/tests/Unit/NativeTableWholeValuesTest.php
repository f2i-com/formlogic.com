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
 * A form bound to an app's table read its rows through a page of the data manager, which gives
 * the first 400 characters of a text: the form's lists, its CSV and JSON exports, its API and the
 * app's records all gave a longer answer cut short, and nothing said so. A form's own store gives
 * every answer whole on each of those routes. One record was read through the record editor's
 * read, which gives no value past 100 KB at all. Each is now read whole.
 */
final class NativeTableWholeValuesTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-whole-' . bin2hex(random_bytes(5));
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

    private static function long(): string
    {
        return 'Start. ' . str_repeat('A long note about the job. ', 200) . 'The end.';
    }

    private static function multibyte(): string
    {
        return str_repeat('✓é', 700) . '|end';
    }

    private static function appDatabase(): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, extra, amount INTEGER)');
        $insert = $db->prepare('INSERT INTO jobs (id, title, notes, amount) VALUES (?, ?, ?, ?)');
        $insert->execute([1, 'Short', 'brief', 5]);
        $insert->execute([2, 'Long', self::long(), 6]);
        $insert->execute([3, 'Wide', self::multibyte(), 7]);
        // Past the 100 KB the record editor will not make editable.
        $insert->execute([4, 'Huge', str_repeat('0123456789', 15000), 8]);
        return $db;
    }

    /** @return array<string, mixed> a binding as resolveBinding() gives it */
    private static function binding(): array
    {
        return [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'jobs', 'primaryKey' => ['id'],
            'columns' => ['f_title' => 'title', 'f_notes' => 'notes', 'f_extra' => 'extra', 'f_amount' => 'amount'],
            'createdAtColumn' => null, 'statusColumn' => null,
        ];
    }

    /** The app's database behind the calls the bridge makes of NativeAppService. */
    private function native(PDO $appDb): NativeAppService
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static function () use ($appDb): array {
            $store = new NativeRecordStore($appDb);
            return array_combine($store->tables(), array_map($store->schema(...), $store->tables()));
        });
        $native->method('records')->willReturnCallback(
            static fn (string $appId, ?string $table, int $offset, ?int $generation, ?array $options): array => (new NativeRecordStore($appDb))->browse((string) $table, $offset, $options ?? [])
        );
        $native->method('manageRecord')->willReturnCallback(
            static fn (string $appId, array $input, array $subscriptions = []): array => (new NativeRecordStore($appDb))->operate($input, $subscriptions)
        );
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($appDb));
        return $native;
    }

    private function bridge(PDO $appDb, ?PDO $mysql = null): NativeTableFormBridge
    {
        return new NativeTableFormBridge($mysql ?? new PDO('sqlite::memory:'), $this->native($appDb));
    }

    /** @param list<array<string, mixed>> $responses @return array<string, mixed> */
    private static function notesById(array $responses): array
    {
        return array_column(array_map(static fn (array $r): array => ['id' => $r['id'], 'notes' => $r['answers']['f_notes'] ?? null], $responses), 'notes', 'id');
    }

    public function testAListGivesEveryTextWhole(): void
    {
        $listed = $this->bridge(self::appDatabase())->listResponses(self::binding(), ['limit' => 100]);

        $notes = self::notesById($listed);
        self::assertSame('brief', $notes['1']);
        self::assertSame(self::long(), $notes['2'], 'a text past 400 characters was its first 400');
        self::assertSame(self::multibyte(), $notes['3']);
        self::assertSame(150000, strlen((string) $notes['4']));
        self::assertSame(6, $listed[1]['answers']['f_amount'], 'a number is a number');
    }

    public function testOneRecordIsReadWhole(): void
    {
        $bridge = $this->bridge(self::appDatabase());

        self::assertSame(self::long(), $bridge->getResponse(self::binding(), '2')['answers']['f_notes']);
        // The record editor's read gives no value past 100 KB: the answer was not there at all.
        $huge = $bridge->getResponse(self::binding(), '4');
        self::assertTrue(($huge['answers']['f_notes'] ?? null) === str_repeat('0123456789', 15000), 'the 150 KB answer is read whole');
        // As a list gives the same record, a number as a number.
        $listed = $bridge->listResponses(self::binding(), ['limit' => 100]);
        self::assertTrue($listed[3]['answers'] === $huge['answers'], 'one record reads as the list gives it');
        self::assertSame(8, $huge['answers']['f_amount']);
        self::assertNull($bridge->getResponse(self::binding(), '99'));
    }

    public function testBinaryAndBrokenTextStillRead(): void
    {
        $db = self::appDatabase();
        $db->exec("UPDATE jobs SET extra = X'00FF10' WHERE id = 1");
        $db->exec("UPDATE jobs SET notes = CAST(X'61FF62' AS TEXT) WHERE id = 1");
        $bridge = $this->bridge($db);

        $listed = $bridge->listResponses(self::binding(), ['limit' => 25])[0];
        $read = $bridge->getResponse(self::binding(), '1');
        foreach (['list' => $listed, 'read' => $read] as $how => $response) {
            self::assertSame('[binary]', $response['answers']['f_extra'], $how . ': a binary value is marked, never its bytes');
            self::assertSame('a?b', $response['answers']['f_notes'], $how . ': bytes that are not UTF-8 are replaced');
            self::assertNotFalse(json_encode($response), $how . ': the record still reads as JSON');
        }
    }

    public function testTheStoreStillGivesTheDataManagerPreviews(): void
    {
        $store = new NativeRecordStore(self::appDatabase());

        $page = $store->browse('jobs', 0, ['limit' => 25]);
        self::assertSame(400, mb_strlen($page['rows'][1]['notes']));
        self::assertSame(['notes'], ((array) $page['cut'])[1]);
        self::assertCount(4, $page['stamps']);

        $whole = $store->browse('jobs', 0, ['limit' => 25, 'whole' => true]);
        self::assertSame(self::long(), $whole['rows'][1]['notes']);
        self::assertSame('{}', json_encode($whole['cut']));
        self::assertSame([], $whole['stamps'], 'no stamps: a delete by stamp names the data manager\'s rows');
        self::assertSame(['id' => '2'], $whole['keys'][1]);
    }

    // The routes a form's records leave by, through ResponseService as each of them calls it.

    private function responses(PDO $appDb): ResponseService
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
        ]], JSON_THROW_ON_ERROR);
        $mysql->prepare("INSERT INTO forms (id, user_id, settings) VALUES ('form-1', 'owner-1', ?)")->execute([$settings]);
        $mysql->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");

        $connection = $this->createStub(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($mysql);
        $service = new ResponseService($connection, new SQLiteConnection($this->dir));
        $service->setNativeTableBridge($this->bridge($appDb, $mysql));
        return $service;
    }

    public function testEveryRouteGivesTheWholeAnswer(): void
    {
        $responses = $this->responses(self::appDatabase());

        // The owner's list, the JSON export and the API's list.
        self::assertSame(self::long(), self::notesById($responses->getFormResponses('form-1', ['limit' => 1000]))['2']);
        // The app's records.
        self::assertSame(self::long(), self::notesById($responses->getFormResponsesSearchable('form-1', '', [], ['limit' => 100])['responses'])['2']);
        // One record, as the API and the record view read it.
        self::assertSame(self::long(), $responses->getResponse('form-1', '2')['answers']['f_notes']);

        // The CSV export.
        $fields = [
            ['id' => 'f_title', 'type' => 'short_text', 'label' => 'Title'],
            ['id' => 'f_notes', 'type' => 'long_text', 'label' => 'Notes'],
        ];
        $csv = fopen('php://temp', 'w+b');
        self::assertSame(4, $responses->exportResponsesStreaming('form-1', $fields, $csv));
        rewind($csv);
        fgets($csv); // the header
        $rows = [];
        while (($cells = fgetcsv($csv, null, ',', '"', '')) !== false) {
            $rows[$cells[0]] = $cells[4];
        }
        fclose($csv);
        self::assertSame(self::long(), $rows['2']);
        self::assertSame(self::multibyte(), $rows['3']);
    }
}
