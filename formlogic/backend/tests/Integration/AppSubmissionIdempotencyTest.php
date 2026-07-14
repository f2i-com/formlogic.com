<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Services\SubmissionIdempotencyService;
use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Reserve-first, payload-hash-aware idempotency ledger (review #3). Exercises the controller's private
 * helpers directly against the real app_submission_idempotency table (UNIQUE(app_id,form_id,key)); no
 * form/app fixture is needed since the ledger has no foreign keys and the helpers only touch $mysql.
 * Skipped without a test DB.
 */
class AppSubmissionIdempotencyTest extends TestCase
{
    private static ?PDO $pdo = null;
    private AppPublicController $controller;
    private string $appId = '';
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
        // The idempotency helpers only use $this->mysql, so build the controller WITHOUT its 8 service
        // deps and inject the PDO directly.
        $this->controller = (new \ReflectionClass(AppPublicController::class))->newInstanceWithoutConstructor();
        $prop = new \ReflectionProperty(AppPublicController::class, 'mysql');
        $prop->setAccessible(true);
        $prop->setValue($this->controller, self::$pdo);

        $this->appId = 'test-app-' . bin2hex(random_bytes(4));
        $this->formId = 'test-form-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->appId !== '') {
            self::$pdo->prepare('DELETE FROM app_submission_idempotency WHERE app_id = :a')->execute(['a' => $this->appId]);
        }
    }

    /**
     * Legacy-shaped adapter over the consolidated SubmissionIdempotencyService (FL-IDEM-001) —
     * see FormSubmissionIdempotencyTest::call() for the convention mapping.
     * @var array<string,string> */
    private array $leases = [];

    private function call(string $method, array $args): mixed
    {
        $svc = new SubmissionIdempotencyService(self::$pdo);
        $table = 'app_submission_idempotency';
        switch ($method) {
            case 'idempotencyReserve': {
                [$appId, $formId, $userId, $key, $hash] = $args;
                $r = $svc->reserve($table, ['app_id' => $appId, 'form_id' => $formId], $userId, $key, $hash);
                if ($r['state'] === 'owner') {
                    $this->leases[$key] = $r['lease'];
                    return 'owner';
                }
                if ($r['state'] === 'unavailable') {
                    return 'unavailable';
                }
                unset($r['state']);
                return $r;
            }
            case 'idempotencyComplete': {
                [$appId, $formId, $key, $respId] = $args;
                $svc->complete($table, ['app_id' => $appId, 'form_id' => $formId], $key, $this->leases[$key] ?? '', $respId);
                return null;
            }
            case 'idempotencyRelease': {
                [$appId, $formId, $key] = $args;
                $svc->release($table, ['app_id' => $appId, 'form_id' => $formId], $key, $this->leases[$key] ?? '');
                return null;
            }
            case 'idempotencyFind': {
                [$appId, $formId, $key] = $args;
                $r = $svc->find($table, ['app_id' => $appId, 'form_id' => $formId], $key);
                if ($r !== null) {
                    unset($r['state']);
                }
                return $r;
            }
        }
        throw new \RuntimeException("unknown method {$method}");
    }

    public function testFirstReserveWinsAndReplaySamePayloadReturnsPendingRow(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', '{"a":1}');

        $first = $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]);
        $this->assertSame('owner', $first, 'first reservation should win the UNIQUE gate');

        $second = $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]);
        $this->assertIsArray($second, 'a duplicate key returns the existing row, not a second owner');
        $this->assertSame($hash, $second['payload_hash']);
        $this->assertNull($second['response_id'], 'still pending until completed → caller returns 409 processing');
    }

    public function testSameKeyDifferentPayloadIsDetectableAsConflict(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, hash('sha256', 'A')]);

        $row = $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, hash('sha256', 'B')]);
        $this->assertIsArray($row);
        // The stored hash is the ORIGINAL payload's — the controller compares it to the new payload hash
        // and returns 409 when they differ.
        $this->assertSame(hash('sha256', 'A'), $row['payload_hash']);
        $this->assertNotSame(hash('sha256', 'B'), $row['payload_hash']);
    }

    public function testCompleteThenReplayReturnsOriginalResponseId(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', 'X');
        $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]);
        $this->call('idempotencyComplete', [$this->appId, $this->formId, $key, 'resp-123']);

        $found = $this->call('idempotencyFind', [$this->appId, $this->formId, $key]);
        $this->assertSame('resp-123', $found['response_id']);
        $this->assertSame('completed', $found['status']);

        // A replay now sees a completed row → the controller returns the original response (200 idempotent).
        $replay = $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]);
        $this->assertIsArray($replay);
        $this->assertSame('resp-123', $replay['response_id']);
    }

    /**
     * The 600s-takeover regression guard: a completed row must not be overwritten by a LATER
     * completing writer (a slow original that lost its reservation to a takeover). Without the
     * status='pending' guard the ledger would regress to the duplicate response id.
     */
    public function testCompleteDoesNotRegressAnAlreadyCompletedRow(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', 'Z');
        $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]);

        $this->call('idempotencyComplete', [$this->appId, $this->formId, $key, 'resp-winner']);
        $this->call('idempotencyComplete', [$this->appId, $this->formId, $key, 'resp-loser']);

        $found = $this->call('idempotencyFind', [$this->appId, $this->formId, $key]);
        $this->assertSame('resp-winner', $found['response_id'], 'a completed row must not regress to a later writer');
        $this->assertSame('completed', $found['status']);
    }

    public function testReleaseAllowsRetryAfterAFailedSubmission(): void
    {
        $key = 'k-' . bin2hex(random_bytes(4));
        $hash = hash('sha256', 'Y');
        $this->assertSame('owner', $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]));

        // A failed submission releases its own pending reservation.
        $this->call('idempotencyRelease', [$this->appId, $this->formId, $key]);
        $this->assertNull($this->call('idempotencyFind', [$this->appId, $this->formId, $key]), 'released reservation is gone');

        // A genuine retry can win the reservation again (not poisoned by the stale row).
        $this->assertSame('owner', $this->call('idempotencyReserve', [$this->appId, $this->formId, 'u1', $key, $hash]));
    }
}
