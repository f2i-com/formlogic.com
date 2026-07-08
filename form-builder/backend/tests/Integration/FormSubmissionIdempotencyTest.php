<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Reserve-first, payload-hash-aware idempotency ledger for the CLASSIC public submission endpoint
 * (POST /api/forms/{formId}/responses; ResponseController::create()) — the form-scoped sibling of
 * AppSubmissionIdempotencyTest, against form_submission_idempotency (UNIQUE(form_id, key), no
 * app_id). Exercises the controller's private helpers directly; no form fixture is needed since the
 * ledger has no foreign keys and the helpers only touch $mysql. Skipped without a test DB.
 */
class FormSubmissionIdempotencyTest extends TestCase
{
    private static ?PDO $pdo = null;
    private ResponseController $controller;
    private string $formId = '';

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
        // The idempotency helpers only use $this->mysql, so build the controller WITHOUT its service
        // deps and inject the PDO directly.
        $this->controller = (new \ReflectionClass(ResponseController::class))->newInstanceWithoutConstructor();
        $prop = new \ReflectionProperty(ResponseController::class, 'mysql');
        $prop->setAccessible(true);
        $prop->setValue($this->controller, self::$pdo);

        $this->formId = 'test-form-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->formId !== '') {
            self::$pdo->prepare('DELETE FROM form_submission_idempotency WHERE form_id = :f')->execute(['f' => $this->formId]);
        }
    }

    /** Invoke a private controller method by reflection. */
    private function call(string $method, array $args): mixed
    {
        $m = new \ReflectionMethod(ResponseController::class, $method);
        $m->setAccessible(true);
        return $m->invoke($this->controller, ...$args);
    }

    public function testFirstReserveWinsAndReplaySamePayloadReturnsPendingRow(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', '{"a":1}');

        $first = $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]);
        $this->assertSame('owner', $first, 'first reservation should win the UNIQUE gate');

        $second = $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]);
        $this->assertIsArray($second, 'a duplicate key returns the existing row, not a second owner');
        $this->assertSame($hash, $second['payload_hash']);
        $this->assertNull($second['response_id'], 'still pending until completed => caller returns 409 processing');
    }

    /** Duplicate key + different payload must be surfaced as a 409 conflict, not silently accepted. */
    public function testSameKeyDifferentPayloadIsDetectableAsConflict(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $this->call('idempotencyReserve', [$this->formId, 'u1', $key, hash('sha256', 'A')]);

        $row = $this->call('idempotencyReserve', [$this->formId, 'u1', $key, hash('sha256', 'B')]);
        $this->assertIsArray($row);
        // The stored hash is the ORIGINAL payload's — the controller compares it to the new payload
        // hash in create() and returns 409 conflict when they differ.
        $this->assertSame(hash('sha256', 'A'), $row['payload_hash']);
        $this->assertNotSame(hash('sha256', 'B'), $row['payload_hash']);
    }

    /** Duplicate key + SAME payload, once completed, must replay the ORIGINAL response id — never a new one. */
    public function testCompleteThenReplayReturnsOriginalResponseIdNotANewOne(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', 'X');
        $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]);
        $this->call('idempotencyComplete', [$this->formId, $key, 'resp-123']);

        $found = $this->call('idempotencyFind', [$this->formId, $key]);
        $this->assertSame('resp-123', $found['response_id']);
        $this->assertSame('completed', $found['status']);

        // A replay (e.g. Workbox background-sync firing twice, or a manual client retry) now sees a
        // completed row; the controller's create() returns the ORIGINAL response id (200 idempotent)
        // instead of running the pipeline again and minting a second response row.
        $replay = $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]);
        $this->assertIsArray($replay);
        $this->assertSame('resp-123', $replay['response_id'], 'replay must surface the ORIGINAL response id, not create a new one');
    }

    /**
     * Mirrors the "abandoned/crashed reservation" trace: a request that reserves but never completes
     * (crash, or an uncaught \Error in the pipeline) leaves a 'pending' row; releasing it (as
     * create()'s catch-all now does on any failure) must let a genuine retry win the key again
     * immediately, rather than being stuck behind it.
     */
    public function testReleaseAllowsRetryAfterAFailedSubmission(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', 'Y');
        $this->assertSame('owner', $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]));

        // A failed submission releases its own pending reservation.
        $this->call('idempotencyRelease', [$this->formId, $key]);
        $this->assertNull($this->call('idempotencyFind', [$this->formId, $key]), 'released reservation is gone');

        // A genuine retry can win the reservation again (not poisoned by the stale row).
        $this->assertSame('owner', $this->call('idempotencyReserve', [$this->formId, 'u1', $key, $hash]));
    }
}
