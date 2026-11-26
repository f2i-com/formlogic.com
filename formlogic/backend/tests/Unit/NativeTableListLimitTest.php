<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A form bound to an app's table lists that table's rows. The record store reads a page of 25,
 * 50, 100 or 250 rows and no other, and the bridge made one read of it for every request: asked
 * for 1000 rows it gave 250, asked for 10 it gave 50, and said neither. The Responses page and
 * the API's clients page until a page comes back short, so a table of 600 rows showed 250. The
 * bridge now gives the rows it was asked for, up to the 1000 a form's own store gives.
 */
final class NativeTableListLimitTest extends TestCase
{
    private static function appDatabase(int $rows): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_name TEXT, submitted_by_user_id TEXT)');
        $insert = $db->prepare('INSERT INTO orders (id, customer_name, submitted_by_user_id) VALUES (?, ?, ?)');
        for ($i = 1; $i <= $rows; $i++) {
            $insert->execute([$i, 'Customer ' . $i, $i % 3 === 0 ? 'member-1' : 'member-2']);
        }
        return $db;
    }

    /** @return array<string, mixed> a binding as resolveBinding() gives it */
    private static function binding(): array
    {
        return [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'orders', 'primaryKey' => ['id'], 'columns' => ['f_name' => 'customer_name'],
            'createdAtColumn' => null, 'statusColumn' => null,
        ];
    }

    /** @param list<int> $reads the page size of each read the bridge makes of the store */
    private function bridge(PDO $appDb, array &$reads = [], ?int $failOnRead = null): NativeTableFormBridge
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static fn (): array => ['orders' => (new NativeRecordStore($appDb))->schema('orders')]);
        $native->method('records')->willReturnCallback(
            static function (string $appId, ?string $table, int $offset, ?int $generation, ?array $options) use ($appDb, &$reads, $failOnRead): array {
                $reads[] = $options['limit'] ?? null;
                if (count($reads) === $failOnRead) throw new \RuntimeException('The database is busy. Please try again.', 409);
                return (new NativeRecordStore($appDb))->browse((string) $table, $offset, $options ?? []);
            }
        );
        return new NativeTableFormBridge(new PDO('sqlite::memory:'), $native);
    }

    /** @param list<array<string, mixed>> $responses @return list<int> */
    private static function ids(array $responses): array
    {
        return array_map(static fn (array $r): int => (int) $r['id'], $responses);
    }

    public function testAListIsAsLongAsItWasAskedToBe(): void
    {
        $reads = [];
        $bridge = $this->bridge(self::appDatabase(600), $reads);

        // The Responses page's first request: every row, and short of 1000, so it is the last.
        self::assertSame(range(1, 600), self::ids($bridge->listResponses(self::binding(), ['limit' => 1000, 'offset' => 0])));
        self::assertSame([250, 250, 250], $reads);

        // Fewer than the store's smallest page, and a count that is none of its sizes.
        self::assertSame(range(1, 10), self::ids($bridge->listResponses(self::binding(), ['limit' => 10])));
        self::assertSame(range(251, 550), self::ids($bridge->listResponses(self::binding(), ['limit' => 300, 'offset' => 250])));
        self::assertSame([600], self::ids($bridge->listResponses(self::binding(), ['limit' => 1, 'offset' => 599])));
        self::assertSame([], $bridge->listResponses(self::binding(), ['limit' => 1, 'offset' => 600]));
        self::assertCount(50, $bridge->listResponses(self::binding()), 'the page a caller gets when it names no size');
    }

    public function testPagesOfAThousandReachEveryRow(): void
    {
        $bridge = $this->bridge(self::appDatabase(1200));

        $first = $bridge->listResponses(self::binding(), ['limit' => 1000, 'offset' => 0]);
        $second = $bridge->listResponses(self::binding(), ['limit' => 1000, 'offset' => 1000]);
        self::assertCount(1000, $first, 'a full page: there may be more');
        self::assertSame(range(1, 1200), [...self::ids($first), ...self::ids($second)]);

        // More than the routes let a client ask for is the most one list gives.
        self::assertCount(1000, $bridge->listResponses(self::binding(), ['limit' => 5000]));
    }

    public function testAnExportsPagesAreWhatTheyWere(): void
    {
        $reads = [];
        $bridge = $this->bridge(self::appDatabase(600), $reads);

        $counts = [];
        foreach ([0, 250, 500] as $offset) {
            $counts[] = count($bridge->listResponses(self::binding(), ['limit' => 250, 'offset' => $offset]));
        }
        self::assertSame([250, 250, 100], $counts);
        self::assertSame([250, 250, 250], $reads, 'one read of the store for each');
    }

    public function testAMembersOwnRowsAreListedToTheEnd(): void
    {
        $bridge = $this->bridge(self::appDatabase(900));

        $own = $bridge->listResponses(self::binding(), ['limit' => 1000, 'submittedByUserId' => 'member-1']);
        self::assertSame(range(3, 900, 3), self::ids($own));
    }

    public function testAPageThatFailsIsNotTheEndOfTheList(): void
    {
        // No database to read at all is no rows, as before.
        $reads = [];
        self::assertSame([], $this->bridge(self::appDatabase(600), $reads, 1)->listResponses(self::binding(), ['limit' => 1000]));

        $reads = [];
        $this->expectException(\RuntimeException::class);
        $this->bridge(self::appDatabase(600), $reads, 2)->listResponses(self::binding(), ['limit' => 1000]);
    }
}
