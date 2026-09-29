<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FlowService;
use FormLogic\Tests\Support\CountsSweeps;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * A held long-poll on one of the three desktop lanes (connector commands, sealed AI, sealed flow
 * runs) reads the database every 500 ms for up to 25 s. It used to run the expiry sweep — a
 * transaction, two UPDATEs, and on the AI lane a frame purge — on every one of those rounds, per
 * lane, per linked desktop. It now sweeps once as it starts and then at most once per sweep
 * interval, while everything a poll DELIVERS still comes from a read that filters on expires_at
 * itself.
 *
 * The three lanes run the same scenarios through one data provider. Skipped without a test DB.
 */
final class DesktopRelayPollLoadTest extends TestCase
{
    private const TABLES = [
        'commands' => 'desktop_commands',
        'ai' => 'desktop_ai_requests',
        'flow' => 'desktop_flow_runs',
    ];

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;

    private string $ownerId = '';
    private string $flowId = '';

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
        self::$flows = new FlowService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->flowId = self::$flows->createWorkspaceFlow($this->ownerId, [
            'name' => 'Poll load test flow',
            'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []],
        ])['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_flow_runs WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    /** @return array<string, array{string}> */
    public static function lanes(): array
    {
        return ['connector commands' => ['commands'], 'sealed AI lane' => ['ai'], 'sealed flow lane' => ['flow']];
    }

    // ── helpers ──

    /** The lane's service, counting (and optionally skipping) its sweeps. */
    private function service(string $lane, float $sweepInterval = 5.0): object
    {
        return match ($lane) {
            'commands' => new class(self::$mysql, $sweepInterval) extends DesktopCommandService { use CountsSweeps; },
            'ai' => new class(self::$mysql, $sweepInterval) extends DesktopAiRelayService { use CountsSweeps; },
            'flow' => new class(self::$mysql, $sweepInterval) extends DesktopFlowRelayService { use CountsSweeps; },
        };
    }

    /** One pending row for the owner, optionally aimed at a desktop instance; returns its id. */
    private function enqueue(string $lane, object $service, ?string $target = null): string
    {
        $aimed = $target !== null ? ['targetInstanceId' => $target] : [];
        $sealed = ['ephPub' => base64_encode(random_bytes(32)), 'envelope' => base64_encode('sealed')];
        return match ($lane) {
            'commands' => $service->enqueue($this->ownerId, $this->ownerId, null, [
                'connectorId' => 'test-connector', 'command' => 'services.list',
            ] + $aimed)['command']['commandId'],
            'ai' => $service->enqueue($this->ownerId, $this->ownerId, [
                'kind' => 'chat', 'providerId' => 'openai-api',
            ] + $sealed + $aimed)['request']['requestId'],
            'flow' => $service->enqueue($this->ownerId, $this->ownerId, [
                'flowId' => $this->flowId,
            ] + $sealed + $aimed)['request']['requestId'],
        };
    }

    private function poll(string $lane, object $service, int $waitMs, ?string $instanceId = null): array
    {
        return $service->pollPending($this->ownerId, null, $waitMs, 50, $instanceId);
    }

    /** @param array<int, array<string, mixed>> $rows */
    private function ids(string $lane, array $rows): array
    {
        return array_map(static fn (array $row) => $row[$lane === 'commands' ? 'commandId' : 'requestId'], $rows);
    }

    private function rowStatus(string $lane, string $id): string
    {
        $stmt = self::$pdo->prepare('SELECT status FROM ' . self::TABLES[$lane] . ' WHERE id = ?');
        $stmt->execute([$id]);
        return (string) $stmt->fetchColumn();
    }

    private function setExpiry(string $lane, string $id, string $sqlExpression): void
    {
        self::$pdo->prepare('UPDATE ' . self::TABLES[$lane] . ' SET expires_at = ' . $sqlExpression . ' WHERE id = ?')->execute([$id]);
    }

    // ── the load: one sweep up front, not one per round ──

    #[DataProvider('lanes')]
    public function testAHeldPollSweepsOnceUpFrontNotOnEveryRound(string $lane): void
    {
        $service = $this->service($lane);

        $started = microtime(true);
        $found = $this->poll($lane, $service, 1300);
        $held = microtime(true) - $started;

        $this->assertSame([], $found);
        // 500 ms between rounds: a 1.3 s hold is at least three rounds, and used to be three sweeps.
        $this->assertGreaterThanOrEqual(1.2, $held, 'the poll was held through several rounds');
        $this->assertSame(1, $service->sweeps, 'and swept once, as it started');
    }

    #[DataProvider('lanes')]
    public function testAHeldPollSweepsAgainOnlyWhenTheIntervalHasPassed(string $lane): void
    {
        $service = $this->service($lane, 0.9);
        // Aimed at another desktop, so this poller never sees it — and it runs out one second in.
        $aimedElsewhere = $this->enqueue($lane, $service, 'other-desktop');
        $this->setExpiry($lane, $aimedElsewhere, 'DATE_ADD(NOW(), INTERVAL 1 SECOND)');
        $service->sweeps = 0;

        $found = $this->poll($lane, $service, 2400, 'desk-1');

        $this->assertSame([], $found);
        // Rounds at about 0, 0.5, 1.0, 1.5 and 2.0 s: swept as it started, and again at about 1.0 and
        // 2.0 s, but not on the rounds in between.
        $this->assertGreaterThanOrEqual(2, $service->sweeps);
        $this->assertLessThanOrEqual(3, $service->sweeps);
        $this->assertSame('expired', $this->rowStatus($lane, $aimedElsewhere), 'a row that ran out while the poll was held is still expired by it');
    }

    // ── what a poll still does ──

    #[DataProvider('lanes')]
    public function testAPollThatFindsWorkReturnsAtOnceAfterOneSweep(string $lane): void
    {
        $service = $this->service($lane);
        $id = $this->enqueue($lane, $service);
        $service->sweeps = 0;

        $started = microtime(true);
        $found = $this->poll($lane, $service, 5000);
        $took = microtime(true) - $started;

        $this->assertSame([$id], $this->ids($lane, $found));
        $this->assertLessThan(0.45, $took, 'a poll that finds work does not sleep a round first');
        $this->assertSame(1, $service->sweeps);
    }

    #[DataProvider('lanes')]
    public function testAnOverdueRowIsSweptAsAPollStartsAndNeverHandedOut(string $lane): void
    {
        $service = $this->service($lane);
        $id = $this->enqueue($lane, $service);
        $this->setExpiry($lane, $id, 'DATE_SUB(NOW(), INTERVAL 5 SECOND)');
        $service->sweeps = 0;

        $found = $this->poll($lane, $service, 0);

        $this->assertSame([], $found, 'nothing is delivered after its TTL');
        $this->assertSame('expired', $this->rowStatus($lane, $id), 'and the poll that skipped it expired it');
        $this->assertSame(1, $service->sweeps);
    }

    #[DataProvider('lanes')]
    public function testNothingIsHandedOutAfterItsTtlWhetherOrNotASweepRan(string $lane): void
    {
        $service = $this->service($lane)->neverSweeping();
        $overdue = $this->enqueue($lane, $service);
        $this->setExpiry($lane, $overdue, 'DATE_SUB(NOW(), INTERVAL 5 SECOND)');
        $live = $this->enqueue($lane, $service);

        // Rounds between sweeps see the table as it is: the overdue row is still 'pending' here...
        $found = $this->poll($lane, $service, 0);

        $this->assertSame('pending', $this->rowStatus($lane, $overdue));
        // ...and it is still not delivered, because the read filters on expires_at itself.
        $this->assertSame([$live], $this->ids($lane, $found));
    }

    // ── the housekeeping that rides the sweep still happens ──

    private function scalar(string $sql, string $id): mixed
    {
        $stmt = self::$pdo->prepare($sql);
        $stmt->execute([$id]);
        return $stmt->fetchColumn();
    }

    public function testAHeldPollOnTheAiLaneStillPurgesSealedFramesOnceTheirGraceHasPassed(): void
    {
        $service = $this->service('ai');
        $id = $this->enqueue('ai', $service);
        $service->claim($id, $this->ownerId, ['instanceId' => 'desk-1']);
        $service->appendFrame($id, $this->ownerId, base64_encode('sealed-delta'), 'desk-1');
        $service->complete($id, $this->ownerId, ['status' => 'done', 'instanceId' => 'desk-1']);
        $frames = 'SELECT COUNT(*) FROM desktop_ai_frames WHERE request_id = ?';

        // Inside the drain window the reply stream can still read the frame: a poll leaves it be.
        $this->poll('ai', $service, 0);
        $this->assertSame(1, (int) $this->scalar($frames, $id));

        // Once the grace has passed, the sweep that starts the next poll reaps every sealed byte.
        self::$pdo->prepare('UPDATE desktop_ai_requests SET finished_at = (NOW() - INTERVAL 120 SECOND) WHERE id = ?')->execute([$id]);
        $service->sweeps = 0;
        $this->poll('ai', $service, 600);
        $this->assertSame(0, (int) $this->scalar($frames, $id));
        $this->assertSame(1, $service->sweeps, 'by the one sweep the held poll ran as it started');
    }

    public function testAHeldPollOnTheFlowLaneStillPurgesAnUnreadResultOnceItsRetentionHasPassed(): void
    {
        $service = $this->service('flow');
        $id = $this->enqueue('flow', $service);
        $service->claim($id, $this->ownerId, ['instanceId' => 'desk-1']);
        $service->complete($id, $this->ownerId, ['status' => 'done', 'instanceId' => 'desk-1', 'resultEnvelope' => base64_encode('sealed-result')]);
        $result = 'SELECT result_envelope FROM desktop_flow_runs WHERE id = ?';

        $this->poll('flow', $service, 0);
        $this->assertNotNull($this->scalar($result, $id), 'a fresh result is kept for its requester');

        $stale = DesktopFlowRelayService::RESULT_RETENTION_SECONDS + 60;
        self::$pdo->prepare("UPDATE desktop_flow_runs SET finished_at = (NOW() - INTERVAL {$stale} SECOND) WHERE id = ?")->execute([$id]);
        $service->sweeps = 0;
        $this->poll('flow', $service, 600);
        $this->assertNull($this->scalar($result, $id), 'an unread one is bounded by retention');
        $this->assertSame(1, $service->sweeps, 'by the one sweep the held poll ran as it started');
    }

    #[DataProvider('lanes')]
    public function testListPendingStillSweepsBeforeItReads(string $lane): void
    {
        $service = $this->service($lane);
        $id = $this->enqueue($lane, $service);
        $this->setExpiry($lane, $id, 'DATE_SUB(NOW(), INTERVAL 5 SECOND)');

        $this->assertSame([], $service->listPending($this->ownerId));
        $this->assertSame('expired', $this->rowStatus($lane, $id));
    }
}
