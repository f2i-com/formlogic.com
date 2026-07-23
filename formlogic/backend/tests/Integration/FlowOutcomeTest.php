<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Canonical flow outcome events (extensible-flows plan §9/§14.5): exactly-once emission
 * coupled to the terminal transition, subscriber-gated outbox rows, handler runs enqueued
 * as independent durable runs with lineage, and the §9.2 loop guards. Skipped without a
 * test DB.
 */
class FlowOutcomeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;

    private string $userId = '';
    private string $appId = '';

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
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Outcome App', ?, 'published')")
            ->execute([$this->appId, $this->userId, 'outapp-' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare(
            'DELETE e FROM flow_outcome_events e JOIN flow_definitions f ON f.id = e.flow_definition_id WHERE f.app_id = ?'
        )->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare(
            'DELETE v FROM flow_definition_versions v JOIN flow_definitions f ON f.id = v.flow_definition_id WHERE f.app_id = ?'
        )->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function makeFlow(string $slug): array
    {
        return self::$flows->createFlow($this->appId, $this->userId, [
            'name' => "Flow {$slug}",
            'slug' => $slug,
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ]);
    }

    private function reserve(string $slug): array
    {
        return self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => $slug,
            'triggerEvent' => 'manual',
            'correlationId' => 'corr-' . bin2hex(random_bytes(6)),
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(8)),
        ])['run'];
    }

    /** @return array[] queued handler runs for a flow id + trigger event */
    private function handlerRuns(string $flowId, string $event): array
    {
        $stmt = self::$pdo->prepare(
            'SELECT * FROM flow_run_logs WHERE flow_definition_id = ? AND trigger_event = ? ORDER BY created_at ASC'
        );
        $stmt->execute([$flowId, $event]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function testFailureOutcomeEnqueuesHandlerExactlyOnceWithLineage(): void
    {
        $this->makeFlow('src-flow');
        $handler = $this->makeFlow('on-fail');
        self::$flows->createBinding($this->appId, [
            'flow' => 'on-fail',
            'event' => 'flow.failed',
            'mode' => 'async',
        ]);

        $source = $this->reserve('src-flow');
        self::$flows->completeRun($this->appId, $source['runId'], [
            'status' => 'error',
            'error' => ['code' => 'node_failed', 'message' => 'boom'],
        ]);

        // Exactly one outbox row, dispatched.
        $events = self::$pdo->prepare('SELECT * FROM flow_outcome_events WHERE run_id = ?');
        $events->execute([$source['runId']]);
        $rows = $events->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(1, $rows);
        $this->assertSame('flow.failed', $rows[0]['event_name']);
        $this->assertSame('done', $rows[0]['dispatch_status']);
        $payload = json_decode((string) $rows[0]['payload_json'], true);
        $this->assertSame('failed', $payload['status']);
        $this->assertSame('node_failed', $payload['error']['code']);
        $this->assertNull($payload['result'], 'failure events never carry a result');

        // One independent durable handler run, lineage-linked to the source.
        $handlers = $this->handlerRuns($handler['id'], 'flow.failed');
        $this->assertCount(1, $handlers);
        $run = $handlers[0];
        $this->assertSame('queued', $run['status']);
        $this->assertSame($source['runId'], $run['parent_run_id']);
        $this->assertSame($source['runId'], $run['root_run_id']);
        $this->assertSame(1, (int) $run['depth']);
        $snapshot = json_decode((string) $run['input_snapshot_json'], true);
        $this->assertSame('flow.failed', $snapshot['event']['name']);
        $this->assertSame($source['runId'], $snapshot['event']['data']['runId']);

        // Replays (recovery sweep, duplicate emission) are no-ops.
        self::$flows->emitRunOutcome($source['runId']);
        self::$flows->dispatchPendingOutcomeEvents();
        $this->assertCount(1, $this->handlerRuns($handler['id'], 'flow.failed'));
    }

    public function testOutboxInsertFailureRollsBackTheTerminalTransition(): void
    {
        // Audit FL-03: the outbox insert is FAIL-CLOSED — when it cannot be written, the
        // coupled terminal transition must roll back (the run stays retryable) rather than
        // committing a completion whose flow.* event is silently lost forever.
        $this->makeFlow('src-atomic');
        $handler = $this->makeFlow('on-atomic');
        self::$flows->createBinding($this->appId, ['flow' => 'on-atomic', 'event' => 'flow.succeeded', 'mode' => 'async']);

        $source = $this->reserve('src-atomic');

        // Fault injection: make the outbox INSERT fail hard (table temporarily absent).
        self::$pdo->exec('RENAME TABLE flow_outcome_events TO flow_outcome_events_flt');
        try {
            try {
                self::$flows->completeRun($this->appId, $source['runId'], ['status' => 'done', 'result' => ['ok' => true]]);
                $this->fail('completion must fail when the outcome outbox cannot be written');
            } catch (\PDOException) {
                // expected — the insertion failure propagates out of the finaliser
            }
        } finally {
            self::$pdo->exec('RENAME TABLE flow_outcome_events_flt TO flow_outcome_events');
        }

        $status = self::$pdo->prepare('SELECT status FROM flow_run_logs WHERE id = ?');
        $status->execute([$source['runId']]);
        $this->assertSame('running', $status->fetchColumn(), 'the terminal transition must have rolled back');

        // Retry completes normally and emits exactly one event + one handler run.
        self::$flows->completeRun($this->appId, $source['runId'], ['status' => 'done', 'result' => ['ok' => true]]);
        $events = self::$pdo->prepare('SELECT COUNT(*) FROM flow_outcome_events WHERE run_id = ?');
        $events->execute([$source['runId']]);
        $this->assertSame(1, (int) $events->fetchColumn());
        $this->assertCount(1, $this->handlerRuns($handler['id'], 'flow.succeeded'));
    }

    public function testReconcileReEmitsALostOutcomeEvent(): void
    {
        // Audit FL-03: the reconciliation sweep re-emits an outcome event that was lost
        // AFTER its run turned terminal (cloud-runner / reclaim emission failures), and
        // the replayed dispatch stays idempotent for already-enqueued handlers.
        $this->makeFlow('src-rec');
        $handler = $this->makeFlow('on-rec');
        self::$flows->createBinding($this->appId, ['flow' => 'on-rec', 'event' => 'flow.succeeded', 'mode' => 'async']);

        $source = $this->reserve('src-rec');
        self::$flows->completeRun($this->appId, $source['runId'], ['status' => 'done', 'result' => ['ok' => true]]);
        $this->assertCount(1, $this->handlerRuns($handler['id'], 'flow.succeeded'));

        // Simulate the lost emission.
        self::$pdo->prepare('DELETE FROM flow_outcome_events WHERE run_id = ?')->execute([$source['runId']]);

        self::$flows->reconcileMissingOutcomeEvents();

        $events = self::$pdo->prepare('SELECT COUNT(*) FROM flow_outcome_events WHERE run_id = ?');
        $events->execute([$source['runId']]);
        $this->assertSame(1, (int) $events->fetchColumn(), 'the sweep must restore the missing event');
        $this->assertCount(1, $this->handlerRuns($handler['id'], 'flow.succeeded'), 'handler replay must stay idempotent');
    }

    public function testNoSubscribersMeansNoOutboxRow(): void
    {
        $this->makeFlow('lonely-flow');
        $run = $this->reserve('lonely-flow');
        self::$flows->completeRun($this->appId, $run['runId'], ['status' => 'done', 'result' => ['ok' => true]]);

        $events = self::$pdo->prepare('SELECT COUNT(*) FROM flow_outcome_events WHERE run_id = ?');
        $events->execute([$run['runId']]);
        $this->assertSame(0, (int) $events->fetchColumn(), 'no consumers → no row; the run log stays the truth');
    }

    public function testSuccessOutcomeCarriesTheResult(): void
    {
        $this->makeFlow('src-ok');
        $handler = $this->makeFlow('on-ok');
        self::$flows->createBinding($this->appId, [
            'flow' => 'on-ok',
            'event' => 'flow.succeeded',
            'mode' => 'async',
        ]);

        $source = $this->reserve('src-ok');
        self::$flows->completeRun($this->appId, $source['runId'], ['status' => 'done', 'result' => ['total' => 42]]);

        $handlers = $this->handlerRuns($handler['id'], 'flow.succeeded');
        $this->assertCount(1, $handlers);
        $snapshot = json_decode((string) $handlers[0]['input_snapshot_json'], true);
        $this->assertSame(['total' => 42], $snapshot['event']['data']['result']);
        $this->assertSame('succeeded', $snapshot['event']['data']['status']);
    }

    public function testLoopGuardsStopSelfAndSameRootRetriggers(): void
    {
        $this->makeFlow('src-loop');
        $handlerA = $this->makeFlow('handler-a');
        $handlerB = $this->makeFlow('handler-b');
        self::$flows->createBinding($this->appId, ['flow' => 'handler-a', 'event' => 'flow.failed', 'mode' => 'async']);
        self::$flows->createBinding($this->appId, ['flow' => 'handler-b', 'event' => 'flow.failed', 'mode' => 'async']);

        // Source fails → BOTH handlers enqueue once (root = source).
        $source = $this->reserve('src-loop');
        self::$flows->completeRun($this->appId, $source['runId'], [
            'status' => 'error',
            'error' => ['code' => 'node_failed', 'message' => 'boom'],
        ]);
        $aRuns = $this->handlerRuns($handlerA['id'], 'flow.failed');
        $bRuns = $this->handlerRuns($handlerB['id'], 'flow.failed');
        $this->assertCount(1, $aRuns);
        $this->assertCount(1, $bRuns);

        // Handler A itself FAILS: its own binding must not re-trigger (self-loop guard),
        // and handler B must not fire again within the same root (§9.2 pair dedupe).
        // Queued handler runs are claimed before completion (audit FL-01).
        self::$flows->claimRun($this->appId, $aRuns[0]['id'], ['runtime' => 'browser']);
        self::$flows->completeRun($this->appId, $aRuns[0]['id'], [
            'status' => 'error',
            'error' => ['code' => 'node_failed', 'message' => 'handler broke too'],
        ]);
        $this->assertCount(1, $this->handlerRuns($handlerA['id'], 'flow.failed'), 'self-loop stopped');
        $this->assertCount(1, $this->handlerRuns($handlerB['id'], 'flow.failed'), 'same-root pair dedupe stopped escalation');
    }
}
