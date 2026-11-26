<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A form bound to an app's table takes a row's status from a column of it, and a column of
 * numbers can be that column (a stage, a priority). A row was listed with its status only when
 * the column held text, and as 'submitted' otherwise, while a list of one status compared the
 * column itself: every numbered row was listed as 'submitted' and was not in a list of
 * 'submitted', nor in a list of its own number. One rule now says what a row's status is, and a
 * list of one status lists the rows that rule gives it.
 */
final class NativeTableStatusTest extends TestCase
{
    private static function appDatabase(): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, stage INTEGER, score REAL, label TEXT)');
        $insert = $db->prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)');
        foreach ([
            [1, 'Alpha', 1, 1.5, 'open'],
            [2, 'Bravo', 2, 2.0, null],
            [3, 'Charlie', null, null, ''],
            [4, 'Delta', 1, 1.5, 'closed'],
            [5, 'Echo', 0, 0.0, 'submitted'],
            [6, 'Foxtrot', '', null, '7'],
            [7, 'Golf', 3, 3.25, 'open'],
        ] as $row) {
            $insert->execute($row);
        }
        // A number no shorter text gives back.
        $db->exec('UPDATE jobs SET score = 0.1 + 0.2 WHERE id = 6');
        return $db;
    }

    /** @return array<string, mixed> a binding as resolveBinding() gives it */
    private static function binding(string $statusColumn): array
    {
        return [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'jobs', 'primaryKey' => ['id'],
            'columns' => ['f_title' => 'title', 'f_stage' => 'stage', 'f_score' => 'score', 'f_label' => 'label'],
            'createdAtColumn' => null, 'statusColumn' => $statusColumn,
        ];
    }

    private function bridge(PDO $appDb): NativeTableFormBridge
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static fn (): array => ['jobs' => (new NativeRecordStore($appDb))->schema('jobs')]);
        $native->method('records')->willReturnCallback(
            static fn (string $appId, ?string $table, int $offset, ?int $generation, ?array $options): array => (new NativeRecordStore($appDb))->browse((string) $table, $offset, $options ?? [])
        );
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($appDb));
        return new NativeTableFormBridge(new PDO('sqlite::memory:'), $native);
    }

    /** @return list<int> */
    private function ids(string $statusColumn, string $status): array
    {
        return array_map(
            static fn (array $r): int => (int) $r['id'],
            $this->bridge(self::appDatabase())->listResponses(self::binding($statusColumn), ['status' => $status, 'limit' => 100])
        );
    }

    /** @return array<int, string> each row's listed status, by id */
    private function statuses(string $statusColumn): array
    {
        $listed = $this->bridge(self::appDatabase())->listResponses(self::binding($statusColumn), ['limit' => 100]);
        return array_combine(array_map(static fn (array $r): int => (int) $r['id'], $listed), array_column($listed, 'status'));
    }

    public function testANumberedRowIsListedByItsNumber(): void
    {
        self::assertSame([1 => '1', 2 => '2', 3 => 'submitted', 4 => '1', 5 => '0', 6 => 'submitted', 7 => '3'], $this->statuses('stage'));
        // A row with none is 'submitted', and a row with a number is not.
        self::assertSame([3, 6], $this->ids('stage', 'submitted'));
        self::assertSame([1, 4], $this->ids('stage', '1'));
        // '0' is a status like any other, never "no status asked for".
        self::assertSame([5], $this->ids('stage', '0'));
        // The column reads '01' as 1, and no row is listed as '01'.
        self::assertSame([], $this->ids('stage', '01'));
    }

    public function testAListOfOneStatusIsTheRowsListedWithIt(): void
    {
        foreach (['stage', 'score', 'label'] as $column) {
            $statuses = $this->statuses($column);
            foreach (array_unique($statuses) as $status) {
                $expected = array_keys(array_filter($statuses, static fn (string $s): bool => $s === $status));
                self::assertSame($expected, $this->ids($column, $status), "{$column}: status={$status}");
            }
        }
        // Numbers that are not whole, as they are written.
        self::assertSame([1 => '1.5', 2 => '2', 3 => 'submitted', 4 => '1.5', 5 => '0', 6 => '0.30000000000000004', 7 => '3.25'], $this->statuses('score'));
    }

    public function testOneRecordHasTheStatusItIsListedWith(): void
    {
        $bridge = $this->bridge(self::appDatabase());
        foreach ($this->statuses('stage') as $id => $status) {
            self::assertSame($status, $bridge->getResponse(self::binding('stage'), (string) $id)['status'], "record {$id}");
        }
    }
}
