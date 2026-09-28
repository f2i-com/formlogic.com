<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ExternalApiController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * What a client keeping its own copy of a form's records needs from /api/v1
 * (OAIY's calendar keeps the Aokie pack's appointments this way, and works
 * offline in between):
 *
 *  1. ?updatedSince= lists what changed since its last sync, oldest change first,
 *     paged by (updatedAt, id) with ?afterId=, and says which records were
 *     deleted since then, so a deletion is not undone by the copy.
 *  2. Each record carries an etag, and PUT with If-Match: <etag> writes only
 *     over the version the client read (412 with the record as it is now).
 *  3. Without either, the API answers exactly as before.
 *
 * Skipped unless a test database is reachable (same setup as the other Integration tests).
 */
class ExternalApiSyncTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static ExternalApiController $ctrl;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-extsync-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$ctrl = new ExternalApiController(self::$forms, self::$responses, new WebhookService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function makeUser(): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** An appointments-like form, as the Aokie receptionist pack makes it. */
    private function makeAppointmentsForm(string $ownerId): string
    {
        $form = self::$forms->createForm([
            'userId' => $ownerId,
            'title' => 'Appointments',
            'status' => 'draft',
            'fields' => [
                ['id' => 'service', 'type' => 'short_text', 'label' => 'Service', 'required' => true, 'order' => 0, 'properties' => []],
                ['id' => 'date', 'type' => 'short_text', 'label' => 'Date', 'required' => true, 'order' => 1, 'properties' => []],
                ['id' => 'status', 'type' => 'short_text', 'label' => 'Status', 'required' => true, 'order' => 2, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    private function record(string $formId, string $service, string $status = 'requested'): string
    {
        $created = self::$responses->createResponse($formId, ['answers' => ['service' => $service, 'date' => '2026-10-01', 'status' => $status]]);
        $this->assertIsArray($created);
        return (string) $created['id'];
    }

    /** Set a record's updatedAt, so the order of changes does not hang on the clock. */
    private function touch(string $formId, string $id, string $at): void
    {
        self::$sqlite->getFormDatabase($formId)->prepare('UPDATE responses SET updated_at = :at WHERE id = :id')->execute(['at' => $at, 'id' => $id]);
    }

    /**
     * A mocked API-key request from the owner, holding responses:read.
     *
     * @param array<string, string> $query
     * @param array<string, string> $headers
     */
    private function request(string $ownerId, array $query = [], array $body = [], array $headers = []): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => match ($n) {
            'userId' => $ownerId,
            'apiKeyScopes' => ['responses:read', 'responses:manage'],
            default => null,
        });
        $req->method('getQueryParams')->willReturn($query);
        $req->method('getParsedBody')->willReturn($body);
        $req->method('getHeaderLine')->willReturnCallback(fn ($h) => $headers[$h] ?? '');
        return $req;
    }

    /** @return array{status:int, body:array} */
    private function invoke(string $method, ServerRequestInterface $req, array $args): array
    {
        $out = self::$ctrl->{$method}($req, new SlimResponse(), $args);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testChangesSinceATimeComeOldestFirstWithTheDeletions(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $a = $this->record($form, 'Cut');
        $b = $this->record($form, 'Colour');
        $c = $this->record($form, 'Trim');
        $this->touch($form, $a, '2026-09-01 10:00:00');
        $this->touch($form, $b, '2026-09-03 10:00:00');
        $this->touch($form, $c, '2026-09-02 10:00:00');

        $r = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => '2026-09-02 00:00:00', 'limit' => '100']), ['formId' => $form]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $this->assertSame([$c, $b], array_column($r['body']['responses'], 'id'), 'changed since, oldest change first');
        $this->assertSame([], $r['body']['deleted']);
        $this->assertTrue($r['body']['deletedComplete']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $r['body']['serverTime']);
        $this->assertNotEmpty($r['body']['responses'][0]['etag']);

        // A record deleted any way at all is reported as deleted, once, with its time.
        $since = gmdate('Y-m-d H:i:s', time() - 5);
        $this->assertTrue(self::$responses->deleteResponse($form, $a));
        $r = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => $since]), ['formId' => $form]);
        $this->assertSame([$a], array_column($r['body']['deleted'], 'id'));
        $this->assertGreaterThanOrEqual($since, $r['body']['deleted'][0]['deletedAt']);
        $this->assertLessThanOrEqual($since, $r['body']['deletedSince'], 'this form has recorded deletions since before the client last looked');
        $this->assertSame([], $r['body']['responses'], 'nothing else changed');
    }

    public function testAClientPagesByUpdatedAtAndIdWithoutSkippingARecord(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $ids = [$this->record($form, 'One'), $this->record($form, 'Two'), $this->record($form, 'Three')];
        foreach ($ids as $id) {
            $this->touch($form, $id, '2026-09-05 08:00:00');
        }
        sort($ids);

        $first = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => '2026-09-05 08:00:00', 'limit' => '2']), ['formId' => $form]);
        $this->assertSame(array_slice($ids, 0, 2), array_column($first['body']['responses'], 'id'));
        $last = end($first['body']['responses']);
        $next = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => $last['updatedAt'], 'afterId' => $last['id'], 'limit' => '2']), ['formId' => $form]);
        $this->assertSame([$ids[2]], array_column($next['body']['responses'], 'id'), 'the same second is paged by id');
    }

    public function testUpdatedSinceTakesIso8601AndRefusesNonsense(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $id = $this->record($form, 'Cut');
        $this->touch($form, $id, '2026-09-05 08:00:00');

        $iso = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => '2026-09-05T18:00:00+10:00']), ['formId' => $form]);
        $this->assertSame([$id], array_column($iso['body']['responses'], 'id'), '18:00 at +10:00 is 08:00 UTC');
        $later = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => '2026-09-05T08:00:01Z']), ['formId' => $form]);
        $this->assertSame([], $later['body']['responses']);

        $bad = $this->invoke('listResponses', $this->request($owner, ['updatedSince' => 'yesterday']), ['formId' => $form]);
        $this->assertSame(400, $bad['status']);
    }

    public function testWithoutUpdatedSinceTheListIsAnsweredAsBefore(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $this->record($form, 'Cut');
        $r = $this->invoke('listResponses', $this->request($owner), ['formId' => $form]);
        $this->assertSame(200, $r['status']);
        $this->assertSame(['responses'], array_keys($r['body']));
    }

    public function testARecordPutBackUnderItsIdIsNoLongerReportedDeleted(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $id = $this->record($form, 'Cut');
        $db = self::$sqlite->getFormDatabase($form);
        $row = $db->query('SELECT * FROM responses WHERE id = ' . $db->quote($id))->fetch(PDO::FETCH_ASSOC);
        $this->assertTrue(self::$responses->deleteResponse($form, $id));
        $this->assertSame(1, (int) $db->query('SELECT COUNT(*) FROM response_tombstones')->fetchColumn());

        $db->prepare('INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (:id, :a, :m, :s, :sub, :up)')
            ->execute(['id' => $row['id'], 'a' => $row['answers'], 'm' => $row['metadata'], 's' => $row['status'], 'sub' => $row['submitted_at'], 'up' => $row['updated_at']]);
        $this->assertSame(0, (int) $db->query('SELECT COUNT(*) FROM response_tombstones')->fetchColumn());
    }

    public function testIfMatchWritesOnlyOverTheVersionThatWasRead(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $id = $this->record($form, 'Cut');
        $read = $this->invoke('getResponse', $this->request($owner), ['formId' => $form, 'id' => $id]);
        $etag = $read['body']['response']['etag'];

        // Someone else confirms it in the meantime.
        $this->invoke('updateResponse', $this->request($owner, [], ['answers' => ['status' => 'confirmed']]), ['formId' => $form, 'id' => $id]);
        $this->touch($form, $id, '2026-09-06 09:00:00');

        // The client's change, made on the version it read, is refused, and it is told what is there now.
        $stale = $this->invoke('updateResponse', $this->request($owner, [], ['answers' => ['status' => 'cancelled']], ['If-Match' => '"' . $etag . '"']), ['formId' => $form, 'id' => $id]);
        $this->assertSame(412, $stale['status'], json_encode($stale['body']));
        $this->assertSame('version_conflict', $stale['body']['code']);
        $this->assertSame('confirmed', $stale['body']['response']['answers']['status']);
        $this->assertSame('confirmed', self::$responses->getResponse($form, $id)['answers']['status'], 'nothing was written');

        // With the version it now holds, the same change goes through, and the version moves on.
        $now = $stale['body']['response']['etag'];
        $ok = $this->invoke('updateResponse', $this->request($owner, [], ['answers' => ['status' => 'cancelled']], ['If-Match' => $now]), ['formId' => $form, 'id' => $id]);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame('cancelled', $ok['body']['response']['answers']['status']);
        $this->assertNotSame($now, $ok['body']['response']['etag']);
    }

    public function testAPutWithoutIfMatchIsWrittenAsBefore(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeAppointmentsForm($owner);
        $id = $this->record($form, 'Cut');
        $r = $this->invoke('updateResponse', $this->request($owner, [], ['answers' => ['status' => 'done']]), ['formId' => $form, 'id' => $id]);
        $this->assertSame(200, $r['status']);
        $this->assertSame('done', $r['body']['response']['answers']['status']);
    }
}
