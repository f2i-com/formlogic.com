<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\SubmissionIdempotencyService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-IDEM-001 — every idempotency reservation is a LEASE: after a stale takeover, the
 * dispossessed original request can neither complete nor release the successor's reservation
 * (previously both predicates matched "the current pending row", so the old owner could stamp
 * its duplicate response over the successor's row or delete it and let a replay double-submit).
 * Covers both ledgers (form_submission_idempotency + app_submission_idempotency).
 * Skipped without a test DB.
 */
class SubmissionIdempotencyLeaseTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SubmissionIdempotencyService $idem;

    private string $formId = '';
    private string $appId = '';
    private string $userId = '';

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
        self::$idem = new SubmissionIdempotencyService(self::$pdo);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->formId = 'f-' . bin2hex(random_bytes(12));
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        $this->userId = 'u-' . bin2hex(random_bytes(12));
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->formId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM form_submission_idempotency WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM app_submission_idempotency WHERE form_id = ?')->execute([$this->formId]);
    }

    private function ageRow(string $table, string $key, int $seconds): void
    {
        self::$pdo->prepare("UPDATE {$table} SET created_at = (NOW() - INTERVAL {$seconds} SECOND) WHERE idempotency_key = ?")
            ->execute([$key]);
    }

    /** @return array{status: string, response_id: ?string, id: string}|null */
    private function row(string $table, string $key): ?array
    {
        $stmt = self::$pdo->prepare("SELECT id, status, response_id FROM {$table} WHERE idempotency_key = ? LIMIT 1");
        $stmt->execute([$key]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($r) ? $r : null;
    }

    public function testReserveCompleteReplayRoundTrip(): void
    {
        $scope = ['form_id' => $this->formId];
        $key = 'k-' . bin2hex(random_bytes(8));
        $hash = hash('sha256', 'payload-a');

        $r = self::$idem->reserve('form_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertSame('owner', $r['state']);

        // A concurrent duplicate sees the pending row.
        $dup = self::$idem->reserve('form_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertSame('existing', $dup['state']);
        $this->assertSame('pending', $dup['status']);

        self::$idem->complete('form_submission_idempotency', $scope, $key, $r['lease'], 'resp-1');

        $replay = self::$idem->reserve('form_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertSame('existing', $replay['state']);
        $this->assertSame('resp-1', $replay['response_id'], 'a completed replay returns the original response');
    }

    public function testDispossessedOwnerCannotCompleteTheSuccessorsLease(): void
    {
        $scope = ['form_id' => $this->formId];
        $key = 'k-' . bin2hex(random_bytes(8));
        $hash = hash('sha256', 'payload-a');

        // Original reserves, then stalls past the takeover window.
        $original = self::$idem->reserve('form_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertSame('owner', $original['state']);
        $this->ageRow('form_submission_idempotency', $key, 700);

        // A retry takes the reservation over and gets its own lease.
        $successorLease = self::$idem->takeOver('form_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertNotNull($successorLease);
        $this->assertNotSame($original['lease'], $successorLease);

        // The slow original finally finishes and tries to record ITS (duplicate) response —
        // its lease is gone, so the successor's pending row must be untouched.
        self::$idem->complete('form_submission_idempotency', $scope, $key, $original['lease'], 'resp-old');
        $row = $this->row('form_submission_idempotency', $key);
        $this->assertSame('pending', $row['status'], "the old owner's complete must not touch the successor's row");
        $this->assertNull($row['response_id']);

        // ...and its release must not delete the successor's reservation either.
        self::$idem->release('form_submission_idempotency', $scope, $key, $original['lease']);
        $this->assertNotNull($this->row('form_submission_idempotency', $key), "the old owner's release must not free the successor's row");

        // The successor completes normally with its own lease.
        self::$idem->complete('form_submission_idempotency', $scope, $key, $successorLease, 'resp-new');
        $row = $this->row('form_submission_idempotency', $key);
        $this->assertSame('completed', $row['status']);
        $this->assertSame('resp-new', $row['response_id']);
    }

    public function testTakeoverRefusesYoungRowsAndAppScopeIsEnforced(): void
    {
        $scope = ['app_id' => $this->appId, 'form_id' => $this->formId];
        $key = 'k-' . bin2hex(random_bytes(8));
        $hash = hash('sha256', 'payload-b');

        $r = self::$idem->reserve('app_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertSame('owner', $r['state']);

        // A young pending row is a live request — takeover must refuse.
        $this->assertNull(self::$idem->takeOver('app_submission_idempotency', $scope, $this->userId, $key, $hash));

        // A mismatched scope never touches the row (defensive: wrong columns → no-op).
        $this->assertNull(self::$idem->takeOver('app_submission_idempotency', ['form_id' => $this->formId], $this->userId, $key, $hash));

        // Aged out → takeover succeeds with a fresh lease bound to the same scope.
        $this->ageRow('app_submission_idempotency', $key, 700);
        $lease = self::$idem->takeOver('app_submission_idempotency', $scope, $this->userId, $key, $hash);
        $this->assertNotNull($lease);
        self::$idem->complete('app_submission_idempotency', $scope, $key, $lease, 'resp-app');
        $this->assertSame('resp-app', $this->row('app_submission_idempotency', $key)['response_id']);
    }

    public function testUnknownTableIsRefused(): void
    {
        $r = self::$idem->reserve('users', ['form_id' => $this->formId], null, 'k', 'h');
        $this->assertSame('unavailable', $r['state'], 'only the two known ledgers are accepted');
    }
}
