<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * Native /sync/batch surfaces processSubmission's idempotency distinctions (task #10): each per-item
 * result now carries status/conflict/processing/idempotent so the native offline queue can ACK, terminal-
 * FAIL, or KEEP each item precisely. The conflict + idempotent-replay branches of processSubmission return
 * BEFORE the full pipeline, so this drives the real syncBatch against a real idempotency ledger while
 * stubbing only the app-lookup + permission services (no form/app fixtures needed). Skipped without a DB.
 */
class AppSyncBatchIdempotencyTest extends TestCase
{
    private static ?PDO $pdo = null;
    private AppPublicController $controller;
    private string $appId = '';
    private string $formId = '';
    private string $userId = 'u1';
    private string $slug = 'demo-batch';

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
            self::$pdo = $conn->getConnection();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $this->appId = 'app-' . bin2hex(random_bytes(6));
        $this->formId = 'form-' . bin2hex(random_bytes(6));

        // syncBatch only needs the app lookup + permission services + the real $mysql for the idempotency
        // ledger; the conflict/idempotent branches return before runSubmissionPipeline, so the other five
        // service deps are never touched. Build the controller WITHOUT its constructor and inject the three.
        $appService = $this->createMock(AppService::class);
        $appService->method('getAppBySlug')->willReturn(['id' => $this->appId, 'status' => 'published', 'name' => 'Batch']);
        $appService->method('formBelongsToApp')->willReturn(true);

        $appUsers = $this->createMock(AppUserService::class);
        $appUsers->method('hasPermission')->willReturn(true);

        $this->controller = (new \ReflectionClass(AppPublicController::class))->newInstanceWithoutConstructor();
        $this->inject('appService', $appService);
        $this->inject('appUserService', $appUsers);
        $this->inject('mysql', self::$pdo);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->appId !== '') {
            self::$pdo->prepare('DELETE FROM app_submission_idempotency WHERE app_id = :a')->execute(['a' => $this->appId]);
        }
    }

    private function inject(string $prop, mixed $value): void
    {
        $p = new \ReflectionProperty(AppPublicController::class, $prop);
        $p->setAccessible(true);
        $p->setValue($this->controller, $value);
    }

    /** Seed a ledger row directly so processSubmission's reserve hits an existing (app,form,key). */
    private function seedLedger(string $key, string $payloadHash, ?string $responseId, string $status): void
    {
        self::$pdo->prepare(
            "INSERT INTO app_submission_idempotency (id, app_id, form_id, user_id, idempotency_key, response_id, payload_hash, status, created_at)
             VALUES (:id, :a, :f, :u, :k, :r, :h, :s, NOW())"
        )->execute([
            'id' => bin2hex(random_bytes(8)),
            'a' => $this->appId, 'f' => $this->formId, 'u' => $this->userId,
            'k' => $key, 'r' => $responseId, 'h' => $payloadHash, 's' => $status,
        ]);
    }

    /** The exact payload hash processSubmission computes for a batch item's answers. */
    private function hashOf(array $answers): string
    {
        return hash('sha256', (string) json_encode($answers));
    }

    /**
     * Drive the real syncBatch with the given batch items and return the decoded per-item results.
     *
     * @param array<int,array<string,mixed>> $items
     * @return array<int,array<string,mixed>>
     */
    private function runBatch(array $items): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn($n) => $n === 'userId' ? $this->userId : null);
        $req->method('getParsedBody')->willReturn(['items' => $items]);
        $req->method('getServerParams')->willReturn([]);
        $req->method('getHeaderLine')->willReturn('');

        $out = $this->controller->syncBatch($req, new SlimResponse(), ['slug' => $this->slug]);
        $body = json_decode((string) $out->getBody(), true);
        $this->assertIsArray($body);
        $this->assertArrayHasKey('results', $body);
        return $body['results'];
    }

    public function testDuplicateKeyDifferentPayloadReturnsConflict(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        // Ledger already holds this key bound to a DIFFERENT body.
        $this->seedLedger($key, $this->hashOf(['a' => 999]), 'resp-original', 'completed');

        $results = $this->runBatch([
            ['idempotencyKey' => $key, 'formId' => $this->formId, 'answers' => ['a' => 1]],
        ]);

        $this->assertCount(1, $results);
        $r = $results[0];
        $this->assertSame($key, $r['idempotencyKey']);
        $this->assertFalse($r['success']);
        $this->assertTrue($r['conflict'], 'a reused key with a different body is a conflict');
        $this->assertFalse($r['processing']);
        $this->assertFalse($r['idempotent']);
        $this->assertSame(409, $r['status']);
        $this->assertNull($r['responseId']);
    }

    public function testIdempotentReplayReturnsIdempotentAndOriginalResponseId(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $answers = ['a' => 1];
        // Ledger holds a COMPLETED reservation for this exact body.
        $this->seedLedger($key, $this->hashOf($answers), 'resp-xyz', 'completed');

        $results = $this->runBatch([
            ['idempotencyKey' => $key, 'formId' => $this->formId, 'answers' => $answers],
        ]);

        $this->assertCount(1, $results);
        $r = $results[0];
        $this->assertSame($key, $r['idempotencyKey']);
        $this->assertTrue($r['success'], 'a 200 idempotent replay counts as success (server holds it)');
        $this->assertTrue($r['idempotent'], 'a matching completed row is an idempotent replay');
        $this->assertFalse($r['conflict']);
        $this->assertFalse($r['processing']);
        $this->assertSame(200, $r['status']);
        $this->assertSame('resp-xyz', $r['responseId']);
    }

    public function testConflictAndIdempotentAreIndependentWithinOneBatch(): void
    {
        $conflictKey = 'kc-' . bin2hex(random_bytes(4));
        $idemKey = 'ki-' . bin2hex(random_bytes(4));
        $answers = ['a' => 1];
        $this->seedLedger($conflictKey, $this->hashOf(['a' => 999]), 'resp-c', 'completed');
        $this->seedLedger($idemKey, $this->hashOf($answers), 'resp-i', 'completed');

        $results = $this->runBatch([
            ['idempotencyKey' => $conflictKey, 'formId' => $this->formId, 'answers' => $answers],
            ['idempotencyKey' => $idemKey, 'formId' => $this->formId, 'answers' => $answers],
        ]);

        $this->assertCount(2, $results);
        $byKey = [];
        foreach ($results as $r) {
            $byKey[$r['idempotencyKey']] = $r;
        }
        $this->assertTrue($byKey[$conflictKey]['conflict']);
        $this->assertFalse($byKey[$conflictKey]['idempotent']);
        $this->assertFalse($byKey[$idemKey]['conflict']);
        $this->assertTrue($byKey[$idemKey]['idempotent']);
    }

    public function testUnknownFormResultHasUniformShape(): void
    {
        // formBelongsToApp is stubbed true, so force "unknown form" via an empty formId.
        $results = $this->runBatch([
            ['idempotencyKey' => 'k-none', 'formId' => '', 'answers' => ['a' => 1]],
        ]);

        $this->assertCount(1, $results);
        $r = $results[0];
        $this->assertFalse($r['success']);
        $this->assertSame('Unknown form', $r['error']);
        // The new fields are present on the early-continue results too (uniform shape for the client).
        $this->assertArrayHasKey('status', $r);
        $this->assertArrayHasKey('conflict', $r);
        $this->assertArrayHasKey('processing', $r);
        $this->assertArrayHasKey('idempotent', $r);
        $this->assertFalse($r['conflict']);
        $this->assertFalse($r['processing']);
        $this->assertFalse($r['idempotent']);
    }
}
