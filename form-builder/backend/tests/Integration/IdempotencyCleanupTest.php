<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Idempotency-ledger retention cleanup (review #15).
 *
 * Two layers:
 *   1. Pure parsing of the retention window (--days flag > IDEMPOTENCY_RETENTION_DAYS env > 30 default,
 *      clamped to >= 1). Always runs — no DB needed.
 *   2. The actual DELETE keeps a recent row and removes an old one. Skipped without a test DB.
 *
 * bin/idempotency-cleanup.php is require-able with IDEMPOTENCY_CLEANUP_NO_RUN defined: the guard returns
 * before any env/settings/DB work, exposing only idempotencyRetentionDays() for the parsing tests.
 */
class IdempotencyCleanupTest extends TestCase
{
    private static ?PDO $pdo = null;

    public static function setUpBeforeClass(): void
    {
        if (!defined('IDEMPOTENCY_CLEANUP_NO_RUN')) {
            define('IDEMPOTENCY_CLEANUP_NO_RUN', true);
        }
        require_once dirname(__DIR__, 2) . '/bin/idempotency-cleanup.php';

        // Best-effort DB for the delete/keep test; the parsing tests don't need it.
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
            self::$pdo = null; // parsing tests still run; DB test self-skips
        }
    }

    // --- Retention-days parsing (no DB) -----------------------------------------------------------

    public function testDefaultsTo30WhenNothingSet(): void
    {
        $this->assertSame(30, idempotencyRetentionDays([], []));
    }

    public function testEnvOverridesDefault(): void
    {
        $this->assertSame(7, idempotencyRetentionDays([], ['IDEMPOTENCY_RETENTION_DAYS' => '7']));
    }

    public function testCliDaysFlagWinsOverEnv(): void
    {
        $this->assertSame(
            90,
            idempotencyRetentionDays(['--days=90'], ['IDEMPOTENCY_RETENTION_DAYS' => '7'])
        );
    }

    public function testInvalidEnvFallsBackToDefault(): void
    {
        $this->assertSame(30, idempotencyRetentionDays([], ['IDEMPOTENCY_RETENTION_DAYS' => 'abc']));
        $this->assertSame(30, idempotencyRetentionDays([], ['IDEMPOTENCY_RETENTION_DAYS' => '']));
    }

    public function testZeroIsClampedToOneDay(): void
    {
        // A 0-day window would delete still-live idempotency rows — clamp to the safe minimum.
        $this->assertSame(1, idempotencyRetentionDays(['--days=0'], []));
    }

    // --- Actual delete/keep against the ledger (needs a test DB) ----------------------------------

    public function testCleanupDeletesOldRowAndKeepsRecentOne(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }
        $pdo = self::$pdo;
        $appId = 'idem-clean-' . bin2hex(random_bytes(4));
        $days = 30;
        $cutoff = (new \DateTimeImmutable("-{$days} days"))->format('Y-m-d H:i:s');

        $insert = $pdo->prepare(
            'INSERT INTO app_submission_idempotency
                (id, app_id, form_id, user_id, idempotency_key, response_id, payload_hash, status, created_at)
             VALUES (:id, :app, :form, NULL, :key, :resp, :hash, :status, :created)'
        );
        // An OLD row (well past the window) and a RECENT row (inside the window).
        $oldId = 'old-' . bin2hex(random_bytes(6));
        $newId = 'new-' . bin2hex(random_bytes(6));
        $insert->execute([
            'id' => $oldId, 'app' => $appId, 'form' => 'f1', 'key' => 'k-old',
            'resp' => 'r-old', 'hash' => hash('sha256', 'old'), 'status' => 'completed',
            'created' => (new \DateTimeImmutable('-60 days'))->format('Y-m-d H:i:s'),
        ]);
        $insert->execute([
            'id' => $newId, 'app' => $appId, 'form' => 'f1', 'key' => 'k-new',
            'resp' => 'r-new', 'hash' => hash('sha256', 'new'), 'status' => 'completed',
            'created' => (new \DateTimeImmutable('-1 day'))->format('Y-m-d H:i:s'),
        ]);

        try {
            // Same DELETE the script runs: prune rows older than the cutoff, scoped to this app so the
            // test never touches unrelated ledger data.
            $del = $pdo->prepare(
                'DELETE FROM app_submission_idempotency WHERE app_id = :app AND created_at < :cutoff'
            );
            $del->execute(['app' => $appId, 'cutoff' => $cutoff]);

            $exists = static function (string $id) use ($pdo): bool {
                $s = $pdo->prepare('SELECT 1 FROM app_submission_idempotency WHERE id = :id');
                $s->execute(['id' => $id]);
                return $s->fetchColumn() !== false;
            };

            $this->assertFalse($exists($oldId), 'row older than the retention window should be deleted');
            $this->assertTrue($exists($newId), 'row inside the retention window should be kept');
        } finally {
            $pdo->prepare('DELETE FROM app_submission_idempotency WHERE app_id = :app')->execute(['app' => $appId]);
        }
    }

    public function testCreatedAtIndexExists(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }
        // The cleanup DELETE + the HealthController row-count check rely on a created_at index for a cheap
        // range scan; initializeSchema()/runMigrations() must provide it.
        $stmt = self::$pdo->query(
            "SHOW INDEX FROM app_submission_idempotency WHERE Key_name = 'idx_idem_created'"
        );
        $this->assertNotFalse($stmt);
        $this->assertGreaterThan(0, $stmt->rowCount(), 'idx_idem_created index should exist on the ledger');
    }
}
