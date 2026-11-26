<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ResponseController;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ResponseListRefused;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * A form bound to an app's table lists that table's rows, and read none of what a list is asked
 * for beyond a search, an owner and an equal answer: a status, a date range, `gte`, `lte`, a phone
 * number, an order, "changed since" and the page after a record were all left out, so whoever
 * asked for some rows was given all of them. The Responses page, an export, an automation's
 * lookup and a sync each took that for the answer.
 *
 * Each is now answered from the table or refused, and never left out.
 */
final class NativeTableListFiltersTest extends TestCase
{
    private static function at(string $time): int
    {
        return (new \DateTimeImmutable($time, new \DateTimeZone('UTC')))->getTimestamp();
    }

    private static function jobs(): PDO
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT, state TEXT, created_at INTEGER, made_on TEXT,
            updated_at TEXT, phone TEXT, due_date TEXT, amount REAL, submitted_by_user_id TEXT)');
        $insert = $db->prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        foreach ([
            [1, 'Alpha', 'open', '2026-01-01 12:00:00', '2026-01-10 08:00:00', '+61 491 570 156', '2026-02-01', 10],
            [2, 'Bravo', null, '2026-01-02 12:00:00', null, '0491570157', null, 200],
            [3, 'Charlie', '', '2026-01-03 12:00:00', '2026-01-12 09:00:00', '(04) 9157-0156', '2026-03-15', 30],
            [4, 'Delta', 'closed', '2026-01-04 12:00:00', '2026-01-11 10:00:00', '0400 000 000', '2026-01-20', 5],
            [5, 'Echo', 'submitted', '2026-01-05 12:00:00', '2026-01-13 11:00:00', null, '2026-02-10', 9],
            [6, 'Foxtrot', 'open', '2026-01-06 12:00:00', '2026-01-09 07:00:00', '0491 570 156', '2026-02-01', null],
        ] as [$id, $title, $state, $made, $updated, $phone, $due, $amount]) {
            $insert->execute([$id, $title, $state, self::at($made), $made, $updated, $phone, $due, $amount, $id % 2 === 0 ? 'member-1' : 'member-2']);
        }
        return $db;
    }

    /**
     * A binding as resolveBinding() gives it.
     *
     * @param array<string, mixed> $over
     * @return array<string, mixed>
     */
    private static function binding(array $over = []): array
    {
        return $over + [
            'formId' => 'form-1', 'ownerId' => 'owner-1', 'appId' => 'app-1', 'databaseAppId' => 'app-1',
            'table' => 'jobs', 'primaryKey' => ['id'],
            'columns' => ['f_title' => 'title', 'f_phone' => 'phone', 'f_due' => 'due_date', 'f_amount' => 'amount'],
            'createdAtColumn' => 'created_at', 'statusColumn' => 'state',
        ];
    }

    /** @param list<array<string, mixed>> $asked what the bridge asked of the store, read by read */
    private function bridge(PDO $appDb, array &$asked = []): NativeTableFormBridge
    {
        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('tableSchemas')->willReturnCallback(static function () use ($appDb): array {
            $store = new NativeRecordStore($appDb);
            return array_combine($store->tables(), array_map($store->schema(...), $store->tables()));
        });
        $native->method('records')->willReturnCallback(
            static function (string $appId, ?string $table, int $offset, ?int $generation, ?array $options) use ($appDb, &$asked): array {
                $asked[] = ['offset' => $offset] + ($options ?? []);
                return (new NativeRecordStore($appDb))->browse((string) $table, $offset, $options ?? []);
            }
        );
        return new NativeTableFormBridge(new PDO('sqlite::memory:'), $native);
    }

    /**
     * @param array<string, mixed> $options
     * @param array<string, mixed> $binding
     * @return list<int>
     */
    private function ids(array $options, array $binding = [], ?PDO $db = null): array
    {
        $responses = $this->bridge($db ?? self::jobs())->listResponses(self::binding($binding), $options + ['limit' => 1000]);
        return array_map(static fn (array $r): int => (int) $r['id'], $responses);
    }

    /** @param array<string, mixed> $options @param array<string, mixed> $binding */
    private function refusal(array $options, array $binding = [], ?PDO $db = null): ResponseListRefused
    {
        try {
            $listed = $this->ids($options, $binding, $db);
        } catch (ResponseListRefused $e) {
            return $e;
        }
        self::fail('The list was answered, with ' . count($listed) . ' rows, where it had to be refused.');
    }

    public function testAStatusListsTheRowsOfThatStatus(): void
    {
        self::assertSame([1, 6], $this->ids(['status' => 'open']));
        self::assertSame([4], $this->ids(['status' => 'closed']));
        self::assertSame([], $this->ids(['status' => 'archived']));
        // A row with no status is listed as 'submitted', so that is what finds it.
        self::assertSame([2, 3, 5], $this->ids(['status' => 'submitted']));
        self::assertSame(['submitted', 'submitted', 'submitted'], array_column(
            $this->bridge(self::jobs())->listResponses(self::binding(), ['status' => 'submitted']),
            'status'
        ));
    }

    public function testWithNoStatusColumnEveryRowIsSubmittedAndNothingElse(): void
    {
        self::assertSame([1, 2, 3, 4, 5, 6], $this->ids(['status' => 'submitted'], ['statusColumn' => null]));
        self::assertSame([], $this->ids(['status' => 'open'], ['statusColumn' => null]));
    }

    public function testADateRangeListsTheRowsMadeInIt(): void
    {
        // The column holds seconds: the bounds are read as UTC times.
        self::assertSame([3, 4, 5, 6], $this->ids(['from' => '2026-01-03']));
        self::assertSame([1, 2], $this->ids(['to' => '2026-01-03']), 'a day is its first moment, as a form\'s own store compares it');
        self::assertSame([2, 3, 4], $this->ids(['from' => '2026-01-02 12:00:00', 'to' => '2026-01-04T12:00:00Z']));
        // A column of text is compared as text, as a form's own store compares its own.
        self::assertSame([3, 4, 5, 6], $this->ids(['from' => '2026-01-03'], ['createdAtColumn' => 'made_on']));
        self::assertSame([2, 3, 4], $this->ids(['from' => '2026-01-02 12:00:00', 'to' => '2026-01-04 12:00:00'], ['createdAtColumn' => 'made_on']));
    }

    public function testADateRangeIsRefusedWhereNoColumnSaysWhenARowWasMade(): void
    {
        $refused = $this->refusal(['from' => '2026-01-03'], ['createdAtColumn' => null]);
        self::assertSame(ResponseListRefused::UNSUPPORTED, $refused->errorCode);
        self::assertStringContainsString('`from`', $refused->getMessage());
        self::assertStringContainsString('`to`', $this->refusal(['to' => '2026-01-03'], ['createdAtColumn' => null])->getMessage());
        // Seconds cannot be compared with something that is no time.
        self::assertStringContainsString('UTC date or time', $this->refusal(['from' => 'last tuesday'])->getMessage());
    }

    public function testRangeBoundsListTheRowsWithinThem(): void
    {
        self::assertSame([1, 3, 5, 6], $this->ids(['answersGte' => ['f_due' => '2026-02-01']]));
        // A row with no value passes `lte`, as it does in a form's own store.
        self::assertSame([1, 2, 4, 6], $this->ids(['answersLte' => ['f_due' => '2026-02-01']]));
        self::assertSame([1, 6], $this->ids(['answersGte' => ['f_due' => '2026-02-01'], 'answersLte' => ['f_due' => '2026-02-09']]));
        // Numbers compare as numbers: 200 and 30 are not below 10.
        self::assertSame([1, 2, 3], $this->ids(['answersGte' => ['f_amount' => '10']]));
        self::assertSame([4, 5, 6], $this->ids(['answersLte' => ['f_amount' => '9.5']]));
        // A field the table has no column for has no value in any row.
        self::assertSame([], $this->ids(['answersGte' => ['f_missing' => '1']]));
        self::assertSame([1, 2, 3, 4, 5, 6], $this->ids(['answersLte' => ['f_missing' => '1']]));
    }

    public function testAPhoneNumberListsTheRowsThatHoldItHoweverItIsWritten(): void
    {
        self::assertSame([1, 3, 6], $this->ids(['answersPhoneEq' => ['f_phone' => '0491 570 156']]));
        self::assertSame([2], $this->ids(['answersPhoneEq' => ['f_phone' => '+61491570157']]));
        // Too short to be a number, and a field with no column: nothing, never everything.
        self::assertSame([], $this->ids(['answersPhoneEq' => ['f_phone' => '0156']]));
        self::assertSame([], $this->ids(['answersPhoneEq' => ['f_missing' => '0491 570 156']]));
    }

    public function testAnEqualAnswerOnAFieldWithNoColumnMatchesNothing(): void
    {
        self::assertSame([4], $this->ids(['answersEq' => ['f_title' => 'Delta']]));
        self::assertSame([], $this->ids(['answersEq' => ['f_missing' => 'Delta']]), 'it listed every row');
        self::assertSame([6], $this->ids(['answersEq' => ['f_title' => 'Foxtrot'], 'status' => 'open', 'from' => '2026-01-02']));
    }

    public function testTheRowsAreNarrowedBeforeTheLimit(): void
    {
        // The rows that match are the table's last: a list of five that read the first five rows
        // and checked those would find none of them.
        $db = self::jobs();
        $db->exec("DELETE FROM jobs");
        $insert = $db->prepare('INSERT INTO jobs (id, title, phone, due_date, created_at) VALUES (?, ?, ?, ?, 0)');
        for ($i = 1; $i <= 400; $i++) {
            $insert->execute([$i, 'Job ' . $i, $i > 398 ? '0491 570 156' : '0400 000 ' . str_pad((string) $i, 3, '0', STR_PAD_LEFT), $i > 397 ? '2026-06-0' . ($i - 397) : '2026-01-01']);
        }
        $asked = [];
        $bridge = $this->bridge($db, $asked);

        $byPhone = $bridge->listResponses(self::binding(), ['answersPhoneEq' => ['f_phone' => '+61 491 570 156'], 'limit' => 5]);
        self::assertSame([399, 400], array_map(static fn (array $r): int => (int) $r['id'], $byPhone));
        $inWindow = $bridge->listResponses(self::binding(), ['answersGte' => ['f_due' => '2026-06-01'], 'answersLte' => ['f_due' => '2026-06-02'], 'limit' => 5]);
        self::assertSame([398, 399], array_map(static fn (array $r): int => (int) $r['id'], $inWindow));
        self::assertCount(2, $asked, 'one read of the store for each');
    }

    public function testAnOrderIsTheTablesOwn(): void
    {
        self::assertSame([2, 3, 1, 5, 4, 6], $this->ids(['sort' => 'f_amount', 'sortDir' => 'desc']));
        self::assertSame([6, 4, 5, 1, 3, 2], $this->ids(['sort' => 'f_amount', 'sortDir' => 'asc']));
        self::assertSame([6, 5, 4, 3, 2, 1], $this->ids(['sort' => 'f_title']), 'largest first unless asked otherwise');
        self::assertSame([6, 5, 4, 3, 2, 1], $this->ids(['sort' => 'submittedAt', 'sortDir' => 'desc']));
        self::assertSame([2, 3, 4, 1, 6, 5], $this->ids(['sort' => 'status', 'sortDir' => 'asc']));
        // Nothing to order by: every row has the one value, and the order is the table's.
        self::assertSame([1, 2, 3, 4, 5, 6], $this->ids(['sort' => 'f_missing']));
        self::assertSame([1, 2, 3, 4, 5, 6], $this->ids(['sort' => 'submittedAt'], ['createdAtColumn' => null]));
        // A sorted list pages in that order.
        self::assertSame([1, 5], $this->ids(['sort' => 'f_amount', 'sortDir' => 'desc', 'offset' => 2, 'limit' => 2]));
    }

    public function testChangedSinceListsWhatChangedOldestFirst(): void
    {
        // Row 2 has no updated_at: when it changed is not known, so a sync is not left without it.
        self::assertSame([2, 4, 3, 5], $this->ids(['updatedSince' => '2026-01-11 10:00:00']));
        self::assertSame([2], $this->ids(['updatedSince' => '2026-02-01 00:00:00']));
        // The order asked for gives way to it, as in a form's own store.
        self::assertSame([2, 4, 3, 5], $this->ids(['updatedSince' => '2026-01-11 10:00:00', 'sort' => 'f_title']));
    }

    public function testChangedSinceIsRefusedWhereTheTableCannotSay(): void
    {
        $db = self::jobs();
        $db->exec('ALTER TABLE jobs DROP COLUMN updated_at');
        $refused = $this->refusal(['updatedSince' => '2026-01-11 10:00:00'], [], $db);
        self::assertSame(ResponseListRefused::UNSUPPORTED, $refused->errorCode);
        self::assertStringContainsString('`updated_at`', $refused->getMessage());
    }

    public function testThePageAfterARecordIsRefused(): void
    {
        // A sync pages "changed since" by the last record's time and id. Unread, every such page
        // was the first one again.
        $refused = $this->refusal(['updatedSince' => '2026-01-11 10:00:00', 'afterId' => '4']);
        self::assertSame(ResponseListRefused::UNSUPPORTED, $refused->errorCode);
        self::assertStringContainsString('`afterId`', $refused->getMessage());
        // An export's own cursor, likewise.
        self::assertStringContainsString('`before`', $this->refusal(['before' => ['submittedAt' => '2026-01-04 12:00:00', 'id' => '4']])->getMessage());
        // With nothing to page, `afterId` says nothing, as in a form's own store.
        self::assertSame([1, 2, 3, 4, 5, 6], $this->ids(['afterId' => '4']));
    }

    public function testAConditionTheStoreRefusesIsARefusalNotAnError(): void
    {
        $refused = $this->refusal(['answersEq' => ['f_title' => str_repeat('x', NativeRecordStore::FILTER_VALUE_LENGTH + 1)]]);
        self::assertSame(ResponseListRefused::UNSUPPORTED, $refused->errorCode);
        self::assertStringContainsString('longer than', $refused->getMessage());
    }

    public function testAnOffsetPastWhatTheStoreReadsIsRefusedNotRepeated(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT)');
        $rows = NativeRecordStore::OFFSET_LIMIT + 300;
        $db->exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {$rows}) INSERT INTO jobs SELECT i, 'Job ' || i FROM n");
        $binding = ['columns' => ['f_title' => 'title'], 'createdAtColumn' => null, 'statusColumn' => null];
        $limit = NativeRecordStore::OFFSET_LIMIT;

        // As far in as the store reads: the page there, and the one row an export asks for to
        // learn whether it stopped short.
        self::assertSame(range($limit + 1, $limit + 250), $this->ids(['offset' => $limit, 'limit' => 250], $binding, $db));
        self::assertSame([$limit + 1], $this->ids(['offset' => $limit, 'limit' => 1], $binding, $db));

        // Past it the store answered with that same page, for every later page asked for.
        $refused = $this->refusal(['offset' => $limit + 250, 'limit' => 250], $binding, $db);
        self::assertSame(ResponseListRefused::PAST_OFFSET_LIMIT, $refused->errorCode);
        self::assertStringContainsString('100,000', $refused->getMessage());

        // A page that begins within it and ends past it: a short one would be taken for the end.
        self::assertSame(ResponseListRefused::PAST_OFFSET_LIMIT, $this->refusal(['offset' => $limit, 'limit' => 1000], $binding, $db)->errorCode);

        // Where the table itself ends there, the short page is the end.
        $db->exec('DELETE FROM jobs WHERE id > ' . ($limit + 100));
        self::assertSame(range($limit + 1, $limit + 100), $this->ids(['offset' => $limit, 'limit' => 1000], $binding, $db));
    }

    public function testARowsIdIsItsKeyWhenTheBindingNamesNoKey(): void
    {
        // The key's columns are in the answer's schema. Read from where they never were, a
        // binding with none of its own gave each row an id that was not the one it is read,
        // changed and deleted by.
        $listed = $this->bridge(self::jobs())->listResponses(self::binding(['primaryKey' => []]), ['limit' => 3]);
        self::assertSame(['1', '2', '3'], array_column($listed, 'id'));
    }

    public function testTheStoreTakesAlternativesFromACallerInPhp(): void
    {
        $store = new NativeRecordStore(self::jobs());
        $ids = static fn (array $options): array => array_map('intval', array_column($store->browse('jobs', 0, $options)['keys'], 'id'));

        $openOrNone = [['column' => 'state', 'op' => 'eq', 'value' => 'open'], ['column' => 'state', 'op' => 'empty']];
        self::assertSame([1, 2, 3, 6], $ids(['anyOf' => [$openOrNone]]));
        // Beside a filter and another group, a row passes all three.
        self::assertSame([2, 6], $ids([
            'filter' => [['column' => 'id', 'op' => 'gte', 'value' => '2']],
            'anyOf' => [$openOrNone, [['column' => 'title', 'op' => 'starts', 'value' => 'B'], ['column' => 'title', 'op' => 'starts', 'value' => 'F']]],
        ]));
        self::assertSame(4, $store->browse('jobs', 0, ['anyOf' => [$openOrNone]])['matching']);

        foreach ([
            'not a list of groups' => ['anyOf' => $openOrNone[0]],
            'an empty group' => ['anyOf' => [[]]],
            'a column that is not shown' => ['anyOf' => [[['column' => 'no_such_column', 'op' => 'empty']]]],
            'an unknown op' => ['anyOf' => [[['column' => 'state', 'op' => 'regexp', 'value' => '.*']]]],
        ] as $what => $options) {
            try {
                $store->browse('jobs', 0, $options);
                self::fail("The store took {$what}.");
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testTheResponsesRouteAnswersARefusalWithItsReason(): void
    {
        $forms = $this->createStub(FormService::class);
        $forms->method('getForm')->willReturn(['id' => 'form-1', 'userId' => 'owner-1', 'fields' => []]);
        $responses = $this->createMock(ResponseService::class);
        $responses->expects($this->once())->method('getFormResponses')
            ->with('form-1', $this->callback(static fn (array $options): bool => $options['status'] === 'open' && $options['from'] === '2026-01-03' && $options['offset'] === 500))
            ->willThrowException(new ResponseListRefused('This form\'s records are kept in an app\'s table with no column that says when a row was made, so they cannot be listed by `from`.'));
        $controller = new ResponseController($responses, $forms, $this->createStub(SQLiteConnection::class));

        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/forms/form-1/responses')
            ->withQueryParams(['status' => 'open', 'from' => '2026-01-03', 'offset' => '500'])->withAttribute('userId', 'owner-1');
        $response = $controller->index($request, (new ResponseFactory())->createResponse(), ['formId' => 'form-1']);

        self::assertSame(400, $response->getStatusCode());
        $body = json_decode((string) $response->getBody(), true);
        self::assertSame(ResponseListRefused::UNSUPPORTED, $body['code']);
        self::assertStringContainsString('`from`', $body['message']);
        self::assertArrayNotHasKey('responses', $body);
    }
}
