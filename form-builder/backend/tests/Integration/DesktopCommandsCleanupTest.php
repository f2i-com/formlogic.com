<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * desktop_commands table cleanup (Tier-1 audit item #5).
 *
 * Two layers, mirroring IdempotencyCleanupTest:
 *   1. Pure parsing of the retention window (--days flag > DESKTOP_COMMANDS_RETENTION_DAYS env > 7
 *      default, clamped to >= 1). Always runs — no DB needed.
 *   2. The actual DELETE: an old terminal-status row is removed, a recent one is kept, and a live
 *      (non-expired) pending/claimed row is NEVER removed regardless of age. Skipped without a test DB.
 *
 * bin/desktop-commands-cleanup.php is require-able with DESKTOP_COMMANDS_CLEANUP_NO_RUN defined: the
 * guard returns before any env/settings/DB work, exposing only desktopCommandsRetentionDays().
 */
class DesktopCommandsCleanupTest extends TestCase
{
    private static ?PDO $pdo = null;

    public static function setUpBeforeClass(): void
    {
        if (!defined('DESKTOP_COMMANDS_CLEANUP_NO_RUN')) {
            define('DESKTOP_COMMANDS_CLEANUP_NO_RUN', true);
        }
        require_once dirname(__DIR__, 2) . '/bin/desktop-commands-cleanup.php';

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
            self::$pdo = null; // parsing tests still run; DB tests self-skip
        }
    }

    // --- Retention-days parsing (no DB) -----------------------------------------------------------

    public function testDefaultsTo7WhenNothingSet(): void
    {
        $this->assertSame(7, desktopCommandsRetentionDays([], []));
    }

    public function testEnvOverridesDefault(): void
    {
        $this->assertSame(14, desktopCommandsRetentionDays([], ['DESKTOP_COMMANDS_RETENTION_DAYS' => '14']));
    }

    public function testCliDaysFlagWinsOverEnv(): void
    {
        $this->assertSame(
            2,
            desktopCommandsRetentionDays(['--days=2'], ['DESKTOP_COMMANDS_RETENTION_DAYS' => '14'])
        );
    }

    public function testInvalidEnvFallsBackToDefault(): void
    {
        $this->assertSame(7, desktopCommandsRetentionDays([], ['DESKTOP_COMMANDS_RETENTION_DAYS' => 'abc']));
        $this->assertSame(7, desktopCommandsRetentionDays([], ['DESKTOP_COMMANDS_RETENTION_DAYS' => '']));
    }

    public function testZeroIsClampedToOneDay(): void
    {
        // A 0-day window would delete rows still inside their own grace period — clamp to a safe minimum.
        $this->assertSame(1, desktopCommandsRetentionDays(['--days=0'], []));
    }

    // --- Actual delete/keep against the table (needs a test DB) -----------------------------------

    public function testCleanupDeletesOldTerminalRowKeepsRecentAndNeverTouchesLivePending(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database available');
        }
        $pdo = self::$pdo;
        $days = 7;
        $cutoff = (new \DateTimeImmutable("-{$days} days"))->format('Y-m-d H:i:s');

        $userId = 'u-dc-' . bin2hex(random_bytes(8));
        $pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$userId, $userId . '@test.local']);

        $insert = $pdo->prepare(
            'INSERT INTO desktop_commands
                (id, owner_user_id, connector_id, command, idempotency_key, status, requested_by_user_id, created_at, expires_at)
             VALUES (:id, :owner, :connector, :command, :key, :status, :req, :created, :expires)'
        );

        // An OLD, terminal 'done' row (well past retention) — must be deleted.
        $oldDone = 'old-done-' . bin2hex(random_bytes(6));
        $insert->execute([
            'id' => $oldDone, 'owner' => $userId, 'req' => $userId, 'connector' => 'aokie', 'command' => 'call.hangup',
            'key' => 'k-' . $oldDone, 'status' => 'done',
            'created' => (new \DateTimeImmutable('-30 days'))->format('Y-m-d H:i:s'),
            'expires' => (new \DateTimeImmutable('-30 days +60 seconds'))->format('Y-m-d H:i:s'),
        ]);
        // A RECENT, terminal 'failed' row (inside retention) — must be kept.
        $newFailed = 'new-failed-' . bin2hex(random_bytes(6));
        $insert->execute([
            'id' => $newFailed, 'owner' => $userId, 'req' => $userId, 'connector' => 'aokie', 'command' => 'call.hangup',
            'key' => 'k-' . $newFailed, 'status' => 'failed',
            'created' => (new \DateTimeImmutable('-1 day'))->format('Y-m-d H:i:s'),
            'expires' => (new \DateTimeImmutable('-1 day +60 seconds'))->format('Y-m-d H:i:s'),
        ]);
        // An OLD 'pending' row whose expires_at is ALSO long past (stuck, never swept) — must be deleted.
        $oldPending = 'old-pending-' . bin2hex(random_bytes(6));
        $insert->execute([
            'id' => $oldPending, 'owner' => $userId, 'req' => $userId, 'connector' => 'aokie', 'command' => 'call.hangup',
            'key' => 'k-' . $oldPending, 'status' => 'pending',
            'created' => (new \DateTimeImmutable('-30 days'))->format('Y-m-d H:i:s'),
            'expires' => (new \DateTimeImmutable('-30 days +60 seconds'))->format('Y-m-d H:i:s'),
        ]);
        // A row whose created_at is old (past the retention cutoff) BUT expires_at is still in the
        // FUTURE (a still-live pending/claimed row) — must NEVER be deleted, regardless of age.
        $liveDespiteOld = 'live-' . bin2hex(random_bytes(6));
        $insert->execute([
            'id' => $liveDespiteOld, 'owner' => $userId, 'req' => $userId, 'connector' => 'aokie', 'command' => 'call.hangup',
            'key' => 'k-' . $liveDespiteOld, 'status' => 'pending',
            'created' => (new \DateTimeImmutable('-30 days'))->format('Y-m-d H:i:s'),
            'expires' => (new \DateTimeImmutable('+1 hour'))->format('Y-m-d H:i:s'),
        ]);

        try {
            // Same DELETE the script runs.
            $where = "created_at < :cutoff AND (status IN ('done', 'failed', 'expired') OR expires_at < NOW())";
            $del = $pdo->prepare("DELETE FROM desktop_commands WHERE owner_user_id = :owner AND {$where}");
            $del->execute(['owner' => $userId, 'cutoff' => $cutoff]);

            $exists = static function (string $id) use ($pdo): bool {
                $s = $pdo->prepare('SELECT 1 FROM desktop_commands WHERE id = :id');
                $s->execute(['id' => $id]);
                return $s->fetchColumn() !== false;
            };

            $this->assertFalse($exists($oldDone), 'old terminal (done) row should be deleted');
            $this->assertTrue($exists($newFailed), 'recent terminal (failed) row inside the window should be kept');
            $this->assertFalse($exists($oldPending), 'old + already-expired pending row should be swept');
            $this->assertTrue($exists($liveDespiteOld), 'a still-live (non-expired) row must never be deleted regardless of age');
        } finally {
            $pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = :owner')->execute(['owner' => $userId]);
            $pdo->prepare('DELETE FROM users WHERE id = :id')->execute(['id' => $userId]);
        }
    }
}
