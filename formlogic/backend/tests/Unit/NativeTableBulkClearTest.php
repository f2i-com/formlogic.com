<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * "Clear all records" on a form bound to an app's table empties that table. It ran a bare DELETE
 * on a connection that had never turned foreign keys on (SQLite's default is off), so every row
 * that referenced the table was left behind, pointing at nothing, where deleting the same records
 * one at a time cascaded or was refused. It also took any table name the binding gave it. It now
 * goes through the record store, under the guards one delete has.
 */
final class NativeTableBulkClearTest extends TestCase
{
    /** An app database as the bridge is handed it: a plain connection, foreign keys never turned on. */
    private static function appDatabase(): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT)');
        $db->exec('CREATE TABLE order_lines (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, item TEXT)');
        $db->exec("INSERT INTO orders (customer_name) VALUES ('Alice'), ('Bob'), ('Cara')");
        $db->exec("INSERT INTO order_lines (order_id, item) VALUES (1, 'tea'), (1, 'milk'), (3, 'jam')");
        return $db;
    }

    private static function rows(PDO $db, string $table): int
    {
        return (int) $db->query('SELECT COUNT(*) FROM "' . $table . '"')->fetchColumn();
    }

    /** @return array<string, mixed> a binding as resolveBinding() gives it */
    private static function binding(string $table): array
    {
        return [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => $table, 'primaryKey' => ['id'], 'columns' => ['f_name' => 'customer_name'],
            'createdAtColumn' => null, 'statusColumn' => null,
        ];
    }

    private function bridge(PDO $appDb): NativeTableFormBridge
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($appDb));
        return new NativeTableFormBridge(new PDO('sqlite::memory:'), $native);
    }

    public function testClearingTakesTheRowsThatReferToTheTable(): void
    {
        $db = self::appDatabase();

        self::assertSame(3, $this->bridge($db)->deleteAllResponses(self::binding('orders')));

        self::assertSame(0, self::rows($db, 'orders'));
        self::assertSame(0, self::rows($db, 'order_lines'), 'no line is left pointing at an order that is gone');
        self::assertFalse($db->inTransaction());
    }

    public function testAClearTheSchemaForbidsDeletesNothing(): void
    {
        $db = self::appDatabase();
        // An invoice keeps its order: nothing says what happens to it when the order goes.
        $db->exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id))');
        $db->exec('INSERT INTO invoices (order_id) VALUES (2)');

        try {
            $this->bridge($db)->deleteAllResponses(self::binding('orders'));
            self::fail('orders an invoice refers to were deleted');
        } catch (\RuntimeException $refused) {
            self::assertSame(422, $refused->getCode());
        }

        self::assertSame(3, self::rows($db, 'orders'));
        self::assertSame(3, self::rows($db, 'order_lines'));
        self::assertSame(1, self::rows($db, 'invoices'));
        self::assertFalse($db->inTransaction());
    }

    public function testOnlyATableTheOwnerIsShownIsCleared(): void
    {
        $db = self::appDatabase();
        $db->exec('CREATE TABLE _formlogic_record_events (id TEXT PRIMARY KEY)');
        $db->exec("INSERT INTO _formlogic_record_events VALUES ('pending')");

        // SQLite's own table of row numbers, the host's queue, and a table that is not there.
        foreach (['sqlite_sequence', '_formlogic_record_events', 'missing'] as $table) {
            try {
                (new NativeRecordStore($db))->clear($table);
                self::fail($table . ' was cleared');
            } catch (\RuntimeException $refused) {
                self::assertSame(404, $refused->getCode(), $table);
            }
        }
        self::assertSame(1, self::rows($db, 'sqlite_sequence'), 'the next order still gets the next number');
        self::assertSame(1, self::rows($db, '_formlogic_record_events'));
        self::assertSame(3, self::rows($db, 'orders'));
    }

    public function testAClearQueuesNoRecordEvents(): void
    {
        $db = self::appDatabase();
        $store = new NativeRecordStore($db);

        self::assertSame(3, $store->clear('orders'));

        // One delete with a subscription makes the queue; a clear takes none and makes none.
        self::assertFalse($db->query("SELECT 1 FROM sqlite_master WHERE name = '_formlogic_record_events'")->fetchColumn());
        self::assertSame(0, $store->clear('orders'), 'an empty table is cleared of nothing');
    }
}
