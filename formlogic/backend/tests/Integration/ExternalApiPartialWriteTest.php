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
 * External API (/api/v1) programmatic writes — the path FormLogic Desktop uses headless with an
 * API key. Two behaviours proven by running the desktop locally and pinned here:
 *
 *  1. The API key OWNER can submit to their OWN DRAFT form (app-internal forms like the Aokie
 *     "Calls" store are draft at the form level); only an ARCHIVED form is refused. Public/anon
 *     endpoints still require 'published'.
 *  2. updateResponse uses PATCH semantics: a partial patch ({status, ended_at}) merges over the
 *     stored answers before validation, so it isn't rejected for omitting an unrelated required
 *     field. Blanking a required field explicitly still fails.
 *
 * Skipped unless a test database is reachable (same setup as the other Integration tests).
 */
class ExternalApiPartialWriteTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-extapi-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
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

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** A Calls-like DRAFT form: required phone + free machine fields. */
    private function makeCallsForm(string $ownerId, string $status = 'draft'): string
    {
        $form = self::$forms->createForm([
            'userId' => $ownerId,
            'title' => 'Calls',
            'status' => $status,
            'fields' => [
                ['id' => 'call_id', 'type' => 'short_text', 'label' => 'Call ID', 'required' => false, 'order' => 0, 'properties' => []],
                ['id' => 'caller_phone', 'type' => 'phone', 'label' => 'Caller Phone', 'required' => true, 'order' => 1, 'properties' => []],
                ['id' => 'status', 'type' => 'dropdown', 'label' => 'Status', 'required' => true, 'order' => 2, 'properties' => ['options' => [
                    ['id' => 'incoming', 'label' => 'Incoming', 'value' => 'incoming'],
                    ['id' => 'completed', 'label' => 'Completed', 'value' => 'completed'],
                ]]],
                ['id' => 'ended_at', 'type' => 'short_text', 'label' => 'Ended At', 'required' => false, 'order' => 3, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    /** Mocked API-key request: the owner (userId attr) with an optional parsed body. */
    private function request(string $ownerId, array $body = []): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $ownerId : null);
        $req->method('getParsedBody')->willReturn($body);
        return $req;
    }

    /** @return array{status:int, body:array} */
    private function invoke(string $method, ServerRequestInterface $req, array $args): array
    {
        $out = self::$ctrl->{$method}($req, new SlimResponse(), $args);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testOwnerCanSubmitToOwnDraftForm(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeCallsForm($owner, 'draft');
        $r = $this->invoke('submitResponse', $this->request($owner, [
            'answers' => ['call_id' => 'c1', 'caller_phone' => '+61400000001', 'status' => 'incoming'],
        ]), ['formId' => $formId]);
        $this->assertSame(201, $r['status'], json_encode($r['body']));
    }

    public function testArchivedFormStillRefused(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeCallsForm($owner, 'archived');
        $r = $this->invoke('submitResponse', $this->request($owner, [
            'answers' => ['caller_phone' => '+61400000001', 'status' => 'incoming'],
        ]), ['formId' => $formId]);
        $this->assertSame(403, $r['status'], json_encode($r['body']));
    }

    public function testPartialUpdateMergesOverStoredAnswers(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeCallsForm($owner, 'draft');
        $created = self::$responses->createResponse($formId, [
            'answers' => ['call_id' => 'c2', 'caller_phone' => '+61400000002', 'status' => 'incoming'],
        ]);
        $this->assertIsArray($created);
        $rid = (string) $created['id'];

        // Partial patch that omits the required caller_phone — must merge, not 400.
        $r = $this->invoke('updateResponse', $this->request($owner, [
            'answers' => ['status' => 'completed', 'ended_at' => '2026-07-07T03:00:00.000Z'],
        ]), ['formId' => $formId, 'id' => $rid]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));

        $after = self::$responses->getResponse($formId, $rid);
        $this->assertSame('completed', $after['answers']['status'] ?? null);
        $this->assertSame('+61400000002', $after['answers']['caller_phone'] ?? null); // preserved by the merge
    }

    public function testExplicitlyBlankingRequiredFieldStillFails(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeCallsForm($owner, 'draft');
        $created = self::$responses->createResponse($formId, [
            'answers' => ['caller_phone' => '+61400000003', 'status' => 'incoming'],
        ]);
        $rid = (string) $created['id'];
        $r = $this->invoke('updateResponse', $this->request($owner, [
            'answers' => ['caller_phone' => ''],
        ]), ['formId' => $formId, 'id' => $rid]);
        $this->assertSame(400, $r['status'], json_encode($r['body']));
    }
}
