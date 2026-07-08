<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Flow run log: reserve-first idempotency (UNIQUE idempotency_key is the atomic gate), the
 * running→terminal complete transition, invalid-transition rejection, test-run recording, and
 * flow/binding CRUD basics against the real flow tables. Skipped without a test DB.
 */
class FlowRunLogTest extends TestCase
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
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Flow App', ?, 'published')")
            ->execute([$this->appId, $this->userId, 'flowapp-' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function makeFlow(string $slug = 'call-triage'): array
    {
        return self::$flows->createFlow($this->appId, $this->userId, [
            'name' => 'Call triage',
            'slug' => $slug,
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ]);
    }

    // ── Flow CRUD basics ─────────────────────────────────────────────────────────────────────

    public function testCreateFlowAndDuplicateSlugRejected(): void
    {
        $flow = $this->makeFlow();
        $this->assertSame('call-triage', $flow['slug']);
        $this->assertSame(1, $flow['version']);
        $this->assertTrue($flow['enabled']);
        $this->assertCount(2, $flow['flowJson']['nodes']);

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('already exists');
        $this->makeFlow(); // same slug in the same app
    }

    public function testUpdateFlowBumpsVersionOnGraphChange(): void
    {
        $flow = $this->makeFlow();
        $updated = self::$flows->updateFlow($this->appId, $flow['id'], [
            'flowJson' => ['nodes' => [['id' => 'solo', 'type' => 'input']], 'edges' => []],
        ]);
        $this->assertSame(2, $updated['version']);
        $this->assertCount(1, $updated['flowJson']['nodes']);
    }

    public function testBindingCrudAndRuntimeShapeHidesOwnerFields(): void
    {
        $this->makeFlow();
        $binding = self::$flows->createBinding($this->appId, [
            'flow' => 'call-triage',
            'event' => 'aokie.call.ended',
            'mode' => 'async',
            'outputActions' => [['type' => 'formlogic.toast', 'message' => 'done']],
        ]);
        $this->assertSame('call-triage', $binding['flow']);
        $this->assertSame(30000, $binding['timeoutMs']);

        $runtime = self::$flows->getRuntimeFlows($this->appId);
        $this->assertCount(1, $runtime['flows']);
        $this->assertCount(1, $runtime['bindings']);
        $this->assertArrayNotHasKey('ownerUserId', $runtime['flows'][0], 'runtime payload must not carry owner fields');
        $this->assertArrayNotHasKey('id', $runtime['flows'][0], 'runtime flows are addressed by slug');

        // Disabled flows/bindings drop out of the runtime payload.
        self::$flows->updateBinding($this->appId, $binding['id'], ['enabled' => false]);
        $this->assertCount(0, self::$flows->getRuntimeFlows($this->appId)['bindings']);
    }

    // ── Reserve-first idempotency ────────────────────────────────────────────────────────────

    public function testReserveIsIdempotentOnDuplicateKey(): void
    {
        $this->makeFlow();
        $payload = [
            'flowSlug' => 'call-triage',
            'triggerEvent' => 'aokie.call.ended',
            'correlationId' => 'corr-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
            'inputSnapshot' => ['callerPhone' => '+15550100'],
        ];

        $first = self::$flows->reserveRun($this->appId, $this->userId, $payload);
        $this->assertTrue($first['created'], 'first reserve wins');
        $this->assertSame('running', $first['run']['status']);
        $this->assertNotEmpty($first['run']['startedAt']);

        $replay = self::$flows->reserveRun($this->appId, $this->userId, $payload);
        $this->assertFalse($replay['created'], 'duplicate key is an idempotent replay');
        $this->assertSame($first['run']['runId'], $replay['run']['runId'], 'replay returns the SAME run');

        // Still idempotent after the run completes.
        self::$flows->completeRun($this->appId, $first['run']['runId'], ['status' => 'done', 'result' => ['ok' => true]]);
        $afterDone = self::$flows->reserveRun($this->appId, $this->userId, $payload);
        $this->assertFalse($afterDone['created']);
        $this->assertSame('done', $afterDone['run']['status']);
    }

    public function testReserveRejectsUnknownOrDisabledFlow(): void
    {
        $flow = $this->makeFlow();
        self::$flows->updateFlow($this->appId, $flow['id'], ['enabled' => false]);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('disabled flow');
        self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c', 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);
    }

    public function testCompleteTransitionsAndRejectsDoubleFinalize(): void
    {
        $this->makeFlow();
        $r = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);
        $runId = $r['run']['runId'];

        $done = self::$flows->completeRun($this->appId, $runId, [
            'status' => 'done',
            'result' => ['summary' => 'booked'],
            'outputActions' => [['type' => 'formlogic.toast', 'message' => 'Booked!']],
        ]);
        $this->assertSame('done', $done['status']);
        $this->assertSame(['summary' => 'booked'], $done['result']);
        $this->assertNotEmpty($done['finishedAt'], 'complete stamps finished_at');

        // A second finalize is rejected (running/queued only).
        try {
            self::$flows->completeRun($this->appId, $runId, ['status' => 'error', 'error' => ['code' => 'node_failed', 'message' => 'x']]);
            $this->fail('double finalize must be rejected');
        } catch (\RuntimeException $e) {
            $this->assertSame('already_finalized', $e->getMessage());
        }
        // …and the stored terminal state is unchanged.
        $this->assertSame('done', self::$flows->getRun($this->appId, $runId)['status']);
    }

    public function testCompleteValidatesStatusAndErrorShape(): void
    {
        $this->makeFlow();
        $r = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c2',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);

        try {
            self::$flows->completeRun($this->appId, $r['run']['runId'], ['status' => 'running']);
            $this->fail('non-terminal status must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('status', $e->getMessage());
        }

        try {
            self::$flows->completeRun($this->appId, $r['run']['runId'], ['status' => 'error', 'error' => ['code' => 'made_up', 'message' => 'x']]);
            $this->fail('unknown error code must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('error', $e->getMessage());
        }

        // A valid error completes fine.
        $err = self::$flows->completeRun($this->appId, $r['run']['runId'], [
            'status' => 'timeout',
            'error' => ['code' => 'timeout', 'message' => 'exceeded 4s', 'nodeId' => 'llm_chat-1'],
        ]);
        $this->assertSame('timeout', $err['status']);
        $this->assertSame('llm_chat-1', $err['error']['nodeId']);
    }

    public function testCompleteUnknownRunReturnsNull(): void
    {
        $this->assertNull(self::$flows->completeRun($this->appId, 'no-such-run', ['status' => 'done']));
    }

    // ── Stuck-run reclaim (a claiming instance crashed/lost connectivity before completing) ────

    /** Backdate a run's started_at, simulating a run that has been 'running' for $secondsAgo seconds. */
    private function backdateStartedAt(string $runId, int $secondsAgo): void
    {
        self::$pdo->prepare('UPDATE flow_run_logs SET started_at = DATE_SUB(NOW(), INTERVAL ' . (int) $secondsAgo . ' SECOND) WHERE id = ?')
            ->execute([$runId]);
    }

    public function testReclaimStuckRunsRevertsOldRunningToErrorAndLeavesFreshRunAlone(): void
    {
        $this->makeFlow();

        // Stuck: claimed 700s ago (past the 600s threshold), never completed — the claiming instance
        // crashed or lost connectivity.
        $stuck = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'stuck-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);
        $this->backdateStartedAt($stuck['run']['runId'], 700);

        // Fresh: reserved just now, still genuinely in flight — must never be touched.
        $fresh = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'fresh-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);

        $reclaimed = self::$flows->reclaimStuckRuns(600);
        $this->assertGreaterThanOrEqual(1, $reclaimed, 'at least the seeded stuck run must be reclaimed');

        $stuckAfter = self::$flows->getRun($this->appId, $stuck['run']['runId']);
        $this->assertSame('error', $stuckAfter['status'], 'a run stuck past the threshold reverts to error');
        $this->assertNotEmpty($stuckAfter['finishedAt'], 'reclaim stamps finished_at');
        $this->assertSame('runner_unavailable', $stuckAfter['error']['code']);
        $this->assertStringContainsString('crashed', $stuckAfter['error']['message']);
        $this->assertStringContainsString('never completed', $stuckAfter['error']['message']);

        $freshAfter = self::$flows->getRun($this->appId, $fresh['run']['runId']);
        $this->assertSame('running', $freshAfter['status'], 'a run younger than the threshold must never be touched');
        $this->assertEmpty($freshAfter['finishedAt']);
    }

    public function testReclaimStuckRunsDryRunReportsWithoutMutating(): void
    {
        $this->makeFlow();
        $stuck = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'stuck-2',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ]);
        $this->backdateStartedAt($stuck['run']['runId'], 700);

        $wouldReclaim = self::$flows->reclaimStuckRuns(600, true);
        $this->assertGreaterThanOrEqual(1, $wouldReclaim);

        // Still running — a dry run must never mutate state.
        $stillRunning = self::$flows->getRun($this->appId, $stuck['run']['runId']);
        $this->assertSame('running', $stillRunning['status']);
        $this->assertEmpty($stillRunning['finishedAt']);

        // The real sweep still reclaims it afterward — the dry run didn't consume/mark the row.
        $reclaimed = self::$flows->reclaimStuckRuns(600);
        $this->assertGreaterThanOrEqual(1, $reclaimed);
        $this->assertSame('error', self::$flows->getRun($this->appId, $stuck['run']['runId'])['status']);
    }

    public function testReclaimStuckRunsNeverTouchesQueuedRows(): void
    {
        $this->makeFlow();
        $queued = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'queued-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)), 'queued' => true,
        ]);
        $this->assertSame('queued', $queued['run']['status']);
        $this->assertNull($queued['run']['startedAt'], 'a queued run has no started_at until claimed');

        self::$flows->reclaimStuckRuns(600);

        $this->assertSame('queued', self::$flows->getRun($this->appId, $queued['run']['runId'])['status'],
            'a queued row (started_at IS NULL) must never be touched by the running-only reclaim sweep');
    }

    public function testTestRunRecordsRunningRowWithTestTrigger(): void
    {
        $flow = $this->makeFlow();
        $run = self::$flows->createTestRun($this->appId, $flow['id']);
        $this->assertSame('running', $run['status']);
        $this->assertSame('test', $run['triggerEvent']);
        $this->assertNotEmpty($run['idempotencyKey']);
    }

    public function testListRunsNewestFirstWithStatusFilter(): void
    {
        $flow = $this->makeFlow();
        $first = self::$flows->createTestRun($this->appId, $flow['id']);
        $second = self::$flows->createTestRun($this->appId, $flow['id']);
        self::$flows->completeRun($this->appId, $first['runId'], ['status' => 'done']);

        $all = self::$flows->listRuns($this->appId);
        $this->assertSame(2, $all['total']);
        $ids = array_column($all['runs'], 'runId');
        $this->assertContains($first['runId'], $ids);
        $this->assertContains($second['runId'], $ids);

        $doneOnly = self::$flows->listRuns($this->appId, ['status' => 'done']);
        $this->assertSame(1, $doneOnly['total']);
        $this->assertSame($first['runId'], $doneOnly['runs'][0]['runId']);

        $byFlow = self::$flows->listRuns($this->appId, ['flowId' => $flow['id']]);
        $this->assertSame(2, $byFlow['total']);
    }

    public function testIdempotencyKeyReusedByAnotherAppIsRejectedWithoutLeaking(): void
    {
        $this->makeFlow();
        $key = 'k-' . bin2hex(random_bytes(6));
        self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c', 'idempotencyKey' => $key,
        ]);

        // A second app of the same user reusing the key must NOT receive the first app's run.
        $otherApp = 'a-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Other', ?, 'published')")
            ->execute([$otherApp, $this->userId, 'flowapp-' . bin2hex(random_bytes(6))]);
        try {
            self::$flows->createFlow($otherApp, $this->userId, ['name' => 'Other flow', 'slug' => 'call-triage']);
            self::$flows->reserveRun($otherApp, $this->userId, [
                'flowSlug' => 'call-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c', 'idempotencyKey' => $key,
            ]);
            $this->fail('cross-app key reuse must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('already used', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$otherApp]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$otherApp]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$otherApp]);
        }
    }
}
