<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * desktop_commands table cleanup (Tier-1 audit item #5).
 *
 * Three layers, mirroring IdempotencyCleanupTest:
 *   1. Pure parsing of the retention window (--days flag > DESKTOP_COMMANDS_RETENTION_DAYS env > 7
 *      default, clamped to >= 1). Always runs — no DB needed.
 *   2. The actual DELETE: an old terminal-status row is removed, a recent one is kept, and a live
 *      (non-expired) pending/claimed row is NEVER removed regardless of age. Skipped without a test DB.
 *   3. The sweep the job runs first, on all three relay lanes and for every owner: what a poll only
 *      does for its own owner, so an owner who never polls again is still reaped. Skipped without a test DB.
 *
 * bin/desktop-commands-cleanup.php is require-able with DESKTOP_COMMANDS_CLEANUP_NO_RUN defined: the
 * guard returns before any env/settings/DB work, exposing only desktopCommandsRetentionDays() and
 * desktopRelaySweep().
 */
class DesktopCommandsCleanupTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $conn = null;

    /** @var list<string> owners the relay sweep tests created, removed again in tearDown() */
    private array $sweepOwners = [];
    private string $otherOwner = '';

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
            self::$conn = $conn;
            self::$pdo = $conn->getConnection();
        } catch (\Throwable $e) {
            self::$pdo = null; // parsing tests still run; DB tests self-skip
            self::$conn = null;
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->sweepOwners as $owner) {
            foreach (['desktop_commands', 'desktop_ai_requests', 'desktop_flow_runs', 'flow_definitions'] as $table) {
                self::$pdo->prepare("DELETE FROM {$table} WHERE owner_user_id = ?")->execute([$owner]);
            }
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$owner]);
        }
        $this->sweepOwners = [];
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

    // --- The sweep on all three relay lanes, for every owner (needs a test DB) ---------------------

    private function newSweepOwner(): string
    {
        $id = 'u-sw-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$id, $id . '@test.local']);
        $this->sweepOwners[] = $id;
        return $id;
    }

    /** A sealed AI request. The times are SQL expressions relative to NOW() (test constants, never input). */
    private function insertAiRequest(string $owner, string $status, string $expires, string $claimedAt = 'NULL', string $finishedAt = 'NULL'): string
    {
        $id = 'ai-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO desktop_ai_requests
                (id, owner_user_id, requesting_user_id, provider_id, kind, eph_pub, envelope, status, idempotency_key, claimed_at, finished_at, expires_at)
             VALUES (?, ?, ?, 'openai-api', 'chat', ?, 'sealed-body', ?, ?, {$claimedAt}, {$finishedAt}, {$expires})"
        )->execute([$id, $owner, $owner, base64_encode(random_bytes(32)), $status, 'k-' . $id]);
        return $id;
    }

    /** A sealed flow run, with an unread result when $result is true. */
    private function insertFlowRun(string $owner, string $flowId, string $status, string $expires, string $claimedAt = 'NULL', string $finishedAt = 'NULL', bool $result = false): string
    {
        $id = 'fl-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO desktop_flow_runs
                (id, owner_user_id, requesting_user_id, flow_id, eph_pub, envelope, result_envelope, status, idempotency_key, claimed_at, finished_at, expires_at)
             VALUES (?, ?, ?, ?, ?, 'sealed-body', ?, ?, ?, {$claimedAt}, {$finishedAt}, {$expires})"
        )->execute([$id, $owner, $owner, $flowId, base64_encode(random_bytes(32)), $result ? 'sealed-result' : null, $status, 'k-' . $id]);
        return $id;
    }

    private function insertCommand(string $owner, string $status, string $expires): string
    {
        $id = 'cmd-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            "INSERT INTO desktop_commands
                (id, owner_user_id, connector_id, command, idempotency_key, status, requested_by_user_id, expires_at)
             VALUES (?, ?, 'aokie', 'call.hangup', ?, ?, ?, {$expires})"
        )->execute([$id, $owner, 'k-' . $id, $status, $owner]);
        return $id;
    }

    /**
     * An owner who never polls again and one who is just another tenant, with every kind of row the
     * sweep has an opinion about. What the sweep must expire: 2 commands, 3 AI requests, 3 flow runs.
     *
     * @return array<string, string> row ids by name
     */
    private function seedRelayRows(): array
    {
        $idle = $this->newSweepOwner();
        $other = $this->otherOwner = $this->newSweepOwner();
        $flows = new FlowService(self::$conn);
        $idleFlow = $flows->createWorkspaceFlow($idle, ['name' => 'Sweep test flow', 'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []]])['id'];
        $otherFlow = $flows->createWorkspaceFlow($other, ['name' => 'Sweep test flow', 'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []]])['id'];

        $overdue = 'NOW() - INTERVAL 5 SECOND';
        $live = 'NOW() + INTERVAL 5 MINUTE';
        // Longer than any lane's silence limit (the flow lane's is the longest, at 15 minutes).
        $silentFor20Minutes = 'NOW() - INTERVAL 20 MINUTE';
        $activeJustNow = 'NOW() - INTERVAL 5 SECOND';
        $twoDaysAgo = 'NOW() - INTERVAL 2 DAY';
        $anHourAgo = 'NOW() - INTERVAL 1 HOUR';
        $done = 'NOW() - INTERVAL 1 HOUR';

        return [
            'cmdOverdue' => $this->insertCommand($idle, 'pending', $overdue),
            'cmdLive' => $this->insertCommand($idle, 'pending', $live),
            'cmdOtherOverdue' => $this->insertCommand($other, 'pending', $overdue),

            'aiOverdue' => $this->insertAiRequest($idle, 'pending', $overdue),
            'aiLive' => $this->insertAiRequest($idle, 'pending', $live),
            'aiSilentClaim' => $this->insertAiRequest($idle, 'claimed', $live, $silentFor20Minutes),
            'aiActiveStream' => $this->insertAiRequest($idle, 'streaming', $live, $activeJustNow),
            'aiOtherOverdue' => $this->insertAiRequest($other, 'pending', $overdue),

            'flowOverdue' => $this->insertFlowRun($idle, $idleFlow, 'pending', $overdue),
            'flowLive' => $this->insertFlowRun($idle, $idleFlow, 'pending', $live),
            'flowSilentClaim' => $this->insertFlowRun($idle, $idleFlow, 'claimed', $live, $silentFor20Minutes),
            'flowActiveStream' => $this->insertFlowRun($idle, $idleFlow, 'streaming', $live, $activeJustNow),
            'flowOtherOverdue' => $this->insertFlowRun($other, $otherFlow, 'pending', $overdue),
            // Terminal runs: an unread result past its retention is purged; a recent one is kept for its reader.
            'flowStaleResult' => $this->insertFlowRun($idle, $idleFlow, 'done', $done, 'NULL', $twoDaysAgo, true),
            'flowFreshResult' => $this->insertFlowRun($idle, $idleFlow, 'done', $done, 'NULL', $anHourAgo, true),
        ];
    }

    private function relayRow(string $table, string $id): array
    {
        $stmt = self::$pdo->prepare("SELECT * FROM {$table} WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertIsArray($row, "{$id} exists");
        return $row;
    }

    public function testTheSweepExpiresEveryOwnersOverdueRowsOnAllThreeLanes(): void
    {
        if (self::$conn === null) {
            $this->markTestSkipped('No test database available');
        }
        // Whatever other tests left overdue in this database goes first, so the counts below are exact.
        desktopRelaySweep(self::$conn, false);
        $ids = $this->seedRelayRows();

        $expired = desktopRelaySweep(self::$conn, false);

        $this->assertSame(['commands' => 2, 'ai' => 3, 'flow' => 3], $expired);

        $this->assertSame('expired', $this->relayRow('desktop_commands', $ids['cmdOverdue'])['status'], 'the idle owner\'s overdue command');
        $this->assertSame('expired', $this->relayRow('desktop_commands', $ids['cmdOtherOverdue'])['status'], 'and another tenant\'s');
        $this->assertSame('pending', $this->relayRow('desktop_commands', $ids['cmdLive'])['status']);

        foreach (['aiOverdue' => 'desktop_ai_requests', 'aiSilentClaim' => 'desktop_ai_requests', 'aiOtherOverdue' => 'desktop_ai_requests',
                  'flowOverdue' => 'desktop_flow_runs', 'flowSilentClaim' => 'desktop_flow_runs', 'flowOtherOverdue' => 'desktop_flow_runs'] as $name => $table) {
            $row = $this->relayRow($table, $ids[$name]);
            $this->assertSame('expired', $row['status'], $name);
            $this->assertNull($row['envelope'], $name . ': the sealed request leaves the database with it');
            $this->assertNotNull($row['finished_at'], $name);
        }
        $this->assertNull($this->relayRow('desktop_flow_runs', $ids['flowOverdue'])['result_envelope']);

        foreach (['aiLive' => ['desktop_ai_requests', 'pending'], 'aiActiveStream' => ['desktop_ai_requests', 'streaming'],
                  'flowLive' => ['desktop_flow_runs', 'pending'], 'flowActiveStream' => ['desktop_flow_runs', 'streaming']] as $name => [$table, $status]) {
            $row = $this->relayRow($table, $ids[$name]);
            $this->assertSame($status, $row['status'], $name . ' is still live');
            $this->assertNotNull($row['envelope'], $name . ' keeps its sealed body');
        }

        $this->assertNull($this->relayRow('desktop_flow_runs', $ids['flowStaleResult'])['result_envelope'], 'an unread result past its retention is purged');
        $this->assertNotNull($this->relayRow('desktop_flow_runs', $ids['flowFreshResult'])['result_envelope'], 'a recent one is kept for its reader');
    }

    public function testTheDryRunCountsWhatTheSweepThenExpiresAndChangesNothing(): void
    {
        if (self::$conn === null) {
            $this->markTestSkipped('No test database available');
        }
        desktopRelaySweep(self::$conn, false);
        $ids = $this->seedRelayRows();

        $wouldExpire = desktopRelaySweep(self::$conn, true);

        $this->assertSame(['commands' => 2, 'ai' => 3, 'flow' => 3], $wouldExpire);
        $this->assertSame('pending', $this->relayRow('desktop_commands', $ids['cmdOverdue'])['status'], 'counting expires nothing');
        $this->assertSame('pending', $this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['status']);
        $this->assertNotNull($this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['envelope']);
        $this->assertSame('claimed', $this->relayRow('desktop_flow_runs', $ids['flowSilentClaim'])['status']);
        $this->assertNotNull($this->relayRow('desktop_flow_runs', $ids['flowStaleResult'])['result_envelope'], 'and purges nothing');

        $this->assertSame($wouldExpire, desktopRelaySweep(self::$conn, false), 'the real sweep expires exactly what the dry run counted');
    }

    public function testAnOwnersOwnPollStillOnlyTouchesTheirRowsWhileTheSweepReachesEveryone(): void
    {
        if (self::$conn === null) {
            $this->markTestSkipped('No test database available');
        }
        desktopRelaySweep(self::$conn, false);
        $ids = $this->seedRelayRows();

        // The tenant's own poll, as it runs on the lanes, reaps their rows and nobody else's...
        (new DesktopAiRelayService(self::$conn))->expireStale($this->otherOwner);
        (new DesktopFlowRelayService(self::$conn))->expireStale($this->otherOwner);
        (new DesktopCommandService(self::$conn))->expireStale($this->otherOwner);

        $this->assertSame('expired', $this->relayRow('desktop_ai_requests', $ids['aiOtherOverdue'])['status']);
        $this->assertSame('pending', $this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['status'], 'the idle owner\'s row waits for their own poll...');
        $this->assertSame('pending', $this->relayRow('desktop_flow_runs', $ids['flowOverdue'])['status']);
        $this->assertNotNull($this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['envelope']);

        // ...or for the job, which is what reaches an owner who never polls again.
        desktopRelaySweep(self::$conn, false);
        $this->assertSame('expired', $this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['status']);
        $this->assertNull($this->relayRow('desktop_ai_requests', $ids['aiOverdue'])['envelope']);
        $this->assertSame('expired', $this->relayRow('desktop_flow_runs', $ids['flowOverdue'])['status']);
    }
}
