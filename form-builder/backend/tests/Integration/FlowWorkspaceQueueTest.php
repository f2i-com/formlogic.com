<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowKvService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormLogicRuntime;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Flows v1 (docs/FORMLOGIC_FLOWS.md §8–§13): workspace-flow CRUD scoping (user A cannot see
 * user B), flow-KV caps, the queued→running claim gate (exactly once), form.submitted binding
 * enqueue on submission (cap 5), and ctx.flows.run script intents → queued rows (cap 3,
 * idempotent per slug). Follows the FlowRunLogTest fixture pattern; skipped without a test DB.
 */
class FlowWorkspaceQueueTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;

    private string $userA = '';
    private string $userB = '';
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
        $this->userA = 'u-' . bin2hex(random_bytes(12));
        $this->userB = 'u-' . bin2hex(random_bytes(12));
        foreach ([$this->userA, $this->userB] as $uid) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$uid, $uid . '@test.local']);
        }
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Flow App', ?, 'published')")
            ->execute([$this->appId, $this->userA, 'flowapp-' . bin2hex(random_bytes(6))]);
        $this->formId = 'f-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'Flow Form', 'published')")
            ->execute([$this->formId, $this->userA]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userA === '') {
            return;
        }
        foreach ([$this->userA, $this->userB] as $uid) {
            self::$pdo->prepare("
                DELETE r FROM flow_run_logs r JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE f.owner_user_id = ?
            ")->execute([$uid]);
            self::$pdo->prepare("
                DELETE b FROM app_flow_bindings b JOIN flow_definitions f ON f.id = b.flow_definition_id
                WHERE f.owner_user_id = ?
            ")->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_kv WHERE owner_user_id = ?')->execute([$uid]);
        }
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->userA, $this->userB] as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function makeWorkspaceFlow(string $owner, string $slug = 'triage'): array
    {
        return self::$flows->createWorkspaceFlow($owner, [
            'name' => 'Triage',
            'slug' => $slug,
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ]);
    }

    // ── Workspace flow CRUD scoping ─────────────────────────────────────────────────────────

    public function testWorkspaceFlowsAreOwnerScoped(): void
    {
        $flow = $this->makeWorkspaceFlow($this->userA);
        $this->assertNull($flow['appId'], 'workspace flows carry no app');

        // User B sees nothing and cannot read/update/delete A's flow.
        $this->assertSame([], self::$flows->listWorkspaceFlows($this->userB));
        $this->assertNull(self::$flows->getWorkspaceFlow($this->userB, $flow['id']));
        $this->assertNull(self::$flows->updateWorkspaceFlow($this->userB, $flow['id'], ['name' => 'stolen']));
        $this->assertFalse(self::$flows->deleteWorkspaceFlow($this->userB, $flow['id']));

        // A still owns it, unchanged.
        $mine = self::$flows->getWorkspaceFlow($this->userA, $flow['id']);
        $this->assertSame('Triage', $mine['name']);

        // B can reuse the same slug in THEIR workspace; A cannot duplicate it in theirs.
        $this->assertSame('triage', $this->makeWorkspaceFlow($this->userB)['slug']);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('already exists');
        $this->makeWorkspaceFlow($this->userA);
    }

    public function testWorkspaceSlugUpdateCollisionRejected(): void
    {
        $this->makeWorkspaceFlow($this->userA, 'first');
        $second = $this->makeWorkspaceFlow($this->userA, 'second');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('already exists');
        self::$flows->updateWorkspaceFlow($this->userA, $second['id'], ['slug' => 'first']);
    }

    // ── Flow KV caps ────────────────────────────────────────────────────────────────────────

    public function testFlowKvValueCapAndScoping(): void
    {
        $kv = new FlowKvService(self::$mysql);

        $entry = $kv->put($this->userA, null, 'flow:triage', 'counter', ['n' => 1]);
        $this->assertNull($entry['appId']);
        $this->assertSame(['n' => 1], $entry['v']);

        // Upsert overwrites; the workspace and app stores are separate.
        $kv->put($this->userA, null, 'flow:triage', 'counter', ['n' => 2]);
        $this->assertSame(['n' => 2], $kv->get($this->userA, null, 'flow:triage', 'counter')['v']);
        $this->assertNull($kv->get($this->userA, $this->appId, 'flow:triage', 'counter'));
        // …and other owners never see it.
        $this->assertNull($kv->get($this->userB, null, 'flow:triage', 'counter'));

        // 64 KiB value cap (encoded JSON).
        try {
            $kv->put($this->userA, null, 'flow:triage', 'big', str_repeat('x', 66000));
            $this->fail('oversized value must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('64KB', $e->getMessage());
        }

        // Invalid scope / key shapes are rejected.
        $this->expectException(\InvalidArgumentException::class);
        $kv->put($this->userA, null, 'NOT A SCOPE', 'k', 1);
    }

    public function testFlowKvKeysPerScopeCap(): void
    {
        $kv = new FlowKvService(self::$mysql, maxKeysPerScope: 3);
        for ($i = 1; $i <= 3; $i++) {
            $kv->put($this->userA, null, 'flow:triage', "k{$i}", $i);
        }
        // Updating an existing key still passes at the cap…
        $this->assertSame(99, $kv->put($this->userA, null, 'flow:triage', 'k1', 99)['v']);
        // …a DIFFERENT scope is unaffected…
        $this->assertSame(1, $kv->put($this->userA, null, 'flow:other', 'k4', 1)['v']);
        // …but a new key in the full scope is rejected.
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('maximum');
        $kv->put($this->userA, null, 'flow:triage', 'k4', 4);
    }

    // ── Queued runs + exactly-once claiming ─────────────────────────────────────────────────

    public function testClaimTransitionsQueuedExactlyOnce(): void
    {
        $flow = $this->makeWorkspaceFlow($this->userA);
        $result = self::$flows->enqueueRun($flow, [
            'triggerEvent' => 'manual',
            'correlationId' => 'c-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
            'inputSnapshot' => ['hello' => 'world'],
        ]);
        $this->assertTrue($result['created']);
        $run = $result['run'];
        $this->assertSame('queued', $run['status']);
        $this->assertNull($run['startedAt'], 'a queued run has not started');

        $queued = self::$flows->listOwnerQueuedRuns($this->userA);
        $this->assertContains($run['runId'], array_column($queued, 'runId'));

        // First claim wins: queued → running, stamped with runtime + claimer + started_at.
        $claimed = self::$flows->claimOwnerRun($this->userA, $run['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-1']);
        $this->assertSame('running', $claimed['status']);
        $this->assertSame('desktop', $claimed['runtime']);
        $this->assertSame('desk-1', $claimed['claimedBy']);
        $this->assertNotEmpty($claimed['startedAt']);

        // Second claim (another runtime racing) is rejected — the atomic UPDATE gate.
        try {
            self::$flows->claimOwnerRun($this->userA, $run['runId'], ['runtime' => 'browser']);
            $this->fail('double claim must be rejected');
        } catch (\RuntimeException $e) {
            $this->assertSame('already_claimed', $e->getMessage());
        }
        // The stored claim is unchanged.
        $this->assertSame('desktop', self::$flows->getOwnerRun($this->userA, $run['runId'])['runtime']);

        // A foreign owner can neither see nor claim it.
        $this->assertNull(self::$flows->getOwnerRun($this->userB, $run['runId']));
        $this->assertSame([], self::$flows->listOwnerQueuedRuns($this->userB));
        $this->assertNull(self::$flows->claimOwnerRun($this->userB, $run['runId'], ['runtime' => 'browser']));

        // The claimer completes it through the owner-scoped PATCH path.
        $done = self::$flows->completeOwnerRun($this->userA, $run['runId'], ['status' => 'done', 'result' => ['ok' => true]]);
        $this->assertSame('done', $done['status']);
    }

    public function testAppScopedClaimGate(): void
    {
        $flow = self::$flows->createFlow($this->appId, $this->userA, [
            'name' => 'App flow', 'slug' => 'app-triage',
            'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []],
        ]);
        $r = self::$flows->reserveRun($this->appId, $this->userA, [
            'flowSlug' => 'app-triage', 'triggerEvent' => 'manual', 'correlationId' => 'c',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)), 'queued' => true,
        ]);
        $this->assertSame('queued', $r['run']['status'], 'queued:true reserves without starting');

        $queued = self::$flows->listQueuedRuns($this->appId);
        $this->assertContains($r['run']['runId'], array_column($queued, 'runId'));

        $claimed = self::$flows->claimRun($this->appId, $r['run']['runId'], ['runtime' => 'browser']);
        $this->assertSame('running', $claimed['status']);
        $this->assertSame('browser', $claimed['runtime']);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('already_claimed');
        self::$flows->claimRun($this->appId, $r['run']['runId'], ['runtime' => 'desktop']);
    }

    public function testClaimValidatesRuntime(): void
    {
        $flow = $this->makeWorkspaceFlow($this->userA);
        $run = self::$flows->enqueueRun($flow, [
            'triggerEvent' => 'manual', 'correlationId' => 'c', 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        $this->expectException(\InvalidArgumentException::class);
        self::$flows->claimOwnerRun($this->userA, $run['runId'], ['runtime' => 'mainframe']);
    }

    // ── form.submitted binding enqueue ──────────────────────────────────────────────────────

    public function testSubmissionBindingEnqueuesQueuedRun(): void
    {
        $this->makeWorkspaceFlow($this->userA);
        $binding = self::$flows->createFormBinding($this->userA, $this->formId, [
            'flow' => 'triage', 'event' => 'form.submitted', 'mode' => 'async',
        ]);
        $this->assertNull($binding['appId'], 'form bindings live in the workspace scope');
        $this->assertSame($this->formId, $binding['formId']);

        $responseId = 'r-' . bin2hex(random_bytes(12));
        $answers = ['email' => 'a@b.co', 'score' => 7];
        $enqueued = self::$flows->enqueueSubmissionBindings($this->formId, $responseId, $answers);
        $this->assertSame(1, $enqueued);

        // Replay (e.g. a retried webhook-style hook) is a no-op thanks to the idempotency key.
        $this->assertSame(0, self::$flows->enqueueSubmissionBindings($this->formId, $responseId, $answers));

        $runs = self::$flows->listOwnerRuns($this->userA, ['status' => 'queued']);
        $this->assertSame(1, $runs['total']);
        $run = $runs['runs'][0];
        $this->assertSame('form.submitted', $run['triggerEvent']);
        $this->assertSame($responseId, $run['responseId']);
        $this->assertSame($binding['id'], $run['bindingId']);
        $this->assertNull($run['appId']);
        // The snapshot stores the RAW event; inputMap selectors resolve lazily in the executor.
        $this->assertSame('form.submitted', $run['inputSnapshot']['event']['name']);
        $this->assertSame($answers, $run['inputSnapshot']['event']['data']['answers']);
    }

    public function testSubmissionBindingEnqueueCappedAtFive(): void
    {
        $this->makeWorkspaceFlow($this->userA);
        for ($i = 0; $i < 7; $i++) {
            self::$flows->createFormBinding($this->userA, $this->formId, [
                'flow' => 'triage', 'event' => 'form.submitted', 'mode' => 'async', 'sortOrder' => $i,
            ]);
        }
        $responseId = 'r-' . bin2hex(random_bytes(12));
        $this->assertSame(
            FlowService::MAX_SUBMIT_BINDINGS_PER_SUBMISSION,
            self::$flows->enqueueSubmissionBindings($this->formId, $responseId, [])
        );
    }

    public function testDisabledBindingOrFlowDoesNotEnqueue(): void
    {
        $flow = $this->makeWorkspaceFlow($this->userA);
        $binding = self::$flows->createFormBinding($this->userA, $this->formId, [
            'flow' => 'triage', 'event' => 'form.submitted', 'mode' => 'async', 'enabled' => false,
        ]);
        $this->assertSame(0, self::$flows->enqueueSubmissionBindings($this->formId, 'r-' . bin2hex(random_bytes(12)), []));

        self::$flows->updateFormBinding($this->userA, $this->formId, $binding['id'], ['enabled' => true]);
        self::$flows->updateWorkspaceFlow($this->userA, $flow['id'], ['enabled' => false]);
        $this->assertSame(0, self::$flows->enqueueSubmissionBindings($this->formId, 'r-' . bin2hex(random_bytes(12)), []));
    }

    public function testFormBindingRequiresWorkspaceFlowOfSameOwner(): void
    {
        // A flow belonging to user B cannot be bound to A's form.
        $this->makeWorkspaceFlow($this->userB, 'foreign');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Unknown workspace flow');
        self::$flows->createFormBinding($this->userA, $this->formId, [
            'flow' => 'foreign', 'event' => 'form.submitted', 'mode' => 'async',
        ]);
    }

    // ── ctx.flows.run script intents → queued rows ──────────────────────────────────────────

    public function testScriptFlowRunIntentsEnqueueQueuedRows(): void
    {
        $this->makeWorkspaceFlow($this->userA, 'from-script');
        $responseId = 'r-' . bin2hex(random_bytes(12));

        // 4 intents: duplicate slug + unknown slug are dropped, the rest capped at 3.
        $intents = [
            ['slug' => 'from-script', 'input' => ['a' => 1]],
            ['slug' => 'from-script', 'input' => ['a' => 2]], // dup — dropped
            ['slug' => 'no-such-flow'],                        // unknown — dropped
            ['slug' => 'from-script'],                         // dup — dropped
        ];
        $this->assertSame(1, self::$flows->enqueueScriptFlowRuns($this->formId, $responseId, $intents));
        // Replay of the same submission is a no-op ('script:<responseId>:<slug>' key).
        $this->assertSame(0, self::$flows->enqueueScriptFlowRuns($this->formId, $responseId, $intents));

        $runs = self::$flows->listOwnerRuns($this->userA, ['status' => 'queued']);
        $this->assertSame(1, $runs['total']);
        $run = $runs['runs'][0];
        $this->assertSame('script.run', $run['triggerEvent']);
        $this->assertSame('script:' . $responseId . ':from-script', $run['idempotencyKey']);
        $this->assertSame(['a' => 1], $run['inputSnapshot'], 'the first intent input wins');
        $this->assertSame($responseId, $run['responseId']);
    }

    public function testPreludeFlowsRunIntentIsCapturedAndEnqueued(): void
    {
        $runtime = new FormLogicRuntime();
        $script = <<<'JS'
function onSubmit(ctx) {
  var first = ctx.flows.run("from-script", { lead: ctx.answers.email });
  var dup = ctx.flows.run("from-script");
  var bad = ctx.flows.run("NOT VALID");
  return { first: first.queued, dup: dup.queued, bad: bad.queued };
}
JS;
        $result = $runtime->execute($script, [
            'answers' => ['email' => 'x@y.z'],
            'responseId' => 'r-test',
            'formId' => $this->formId,
            'timestamp' => time(),
        ]);
        if (!$result->success && str_contains((string) $result->error, 'not available')) {
            $this->markTestSkipped('QuickJS runtime not available on this host');
        }
        $this->assertTrue($result->success, 'script failed: ' . ($result->error ?? ''));
        $this->assertSame(['first' => true, 'dup' => false, 'bad' => false], $result->computed);
        $this->assertSame([['slug' => 'from-script', 'input' => ['lead' => 'x@y.z']]], $result->flowRuns);

        // The captured intent round-trips into a queued run for the form owner's workspace flow.
        $this->makeWorkspaceFlow($this->userA, 'from-script');
        $responseId = 'r-' . bin2hex(random_bytes(12));
        $this->assertSame(1, self::$flows->enqueueScriptFlowRuns($this->formId, $responseId, $result->flowRuns));
        $queued = self::$flows->listOwnerQueuedRuns($this->userA);
        $this->assertSame(['lead' => 'x@y.z'], $queued[0]['inputSnapshot']);
    }
}
