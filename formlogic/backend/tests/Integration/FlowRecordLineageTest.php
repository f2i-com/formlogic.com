<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * A record a flow run writes carries that run (`flowRunId` on the write, or the run itself on the
 * cloud runner), and the runs the write starts (form.submitted bindings, ctx.flows.run intents)
 * are that run's children: the lineage depth ceiling (FlowService::RUN_LINEAGE_MAX_DEPTH) then
 * stops a flow that writes into the form it is bound to, which before started itself again
 * without end. A client may only name a run of its own account.
 * Skipped without a test database.
 */
class FlowRecordLineageTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static FlowService $flows;
    private static ResponseService $responses;
    private static ExternalApiController $api;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-lineage-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$flows = new FlowService($conn);
        // The flow service is wired in, as in the container: without it no write starts a run.
        self::$responses = new ResponseService($conn, self::$sqlite, null, null, null, null, self::$flows);
        self::$api = new ExternalApiController(self::$forms, self::$responses, new WebhookService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE e FROM flow_outcome_events e JOIN flow_definitions f ON f.id = e.flow_definition_id WHERE f.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE r FROM flow_run_logs r JOIN flow_definitions f ON f.id = r.flow_definition_id WHERE f.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE b FROM app_flow_bindings b JOIN flow_definitions f ON f.id = b.flow_definition_id WHERE f.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE v FROM flow_definition_versions v JOIN flow_definitions f ON f.id = v.flow_definition_id WHERE f.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM usage_meter WHERE user_id = ?')->execute([$uid]);
        }
        foreach ($this->appIds as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$aid]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── fixtures ──

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId, string $title = 'Notes'): string
    {
        $form = self::$forms->createForm([
            'userId' => $ownerId,
            'title' => $title,
            'status' => 'published',
            'fields' => [
                ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    /** A workspace flow that writes one record into $targetFormId (cloud-eligible). */
    private function writerFlow(string $ownerId, string $slug, string $targetFormId): array
    {
        return self::$flows->createWorkspaceFlow($ownerId, [
            'name' => 'Writer ' . $slug,
            'slug' => $slug,
            'flowJson' => [
                'nodes' => [
                    ['id' => 'in', 'type' => 'input'],
                    ['id' => 'write', 'type' => 'formlogic_submit_response', 'data' => ['form' => $targetFormId, 'answers' => ['note' => 'again']]],
                    ['id' => 'out', 'type' => 'output'],
                ],
                'edges' => [['source' => 'in', 'target' => 'write'], ['source' => 'write', 'target' => 'out']],
            ],
        ]);
    }

    private function cloudRunner(): CloudFlowRunner
    {
        $plans = new PlanService(self::$mysql, new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']), ['planEnforced' => false]);
        return new CloudFlowRunner(self::$mysql, self::$responses, new AIService(), $plans, new DesktopCommandService(self::$mysql), 'https://site.example');
    }

    private function request(?string $userId, array $body = []): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        return $req;
    }

    /** POST /api/v1/forms/{id}/responses as the key owner (FormLogic Desktop's write path). @return array{status:int, body:array} */
    private function apiWrite(string $userId, string $formId, array $body): array
    {
        $out = self::$api->submitResponse($this->request($userId, $body), new SlimResponse(), ['formId' => $formId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** @return array<int, array<string, mixed>> */
    private function runsOf(string $flowId): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_run_logs WHERE flow_definition_id = ? ORDER BY depth ASC, created_at ASC');
        $stmt->execute([$flowId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private function runRow(string $runId): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_run_logs WHERE id = ?');
        $stmt->execute([$runId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    private function recordCount(string $formId): int
    {
        return self::$responses->getResponseCount($formId);
    }

    /**
     * Play a runtime that claims each queued run of $owner and does what the flow does: write the
     * record it writes, naming the run, then complete it. Stops when nothing is queued, or after
     * $maxRounds. @param array<string,string> $targetOf flow id → the form its flow writes into
     * @return int rounds that found queued work
     */
    private function drainLikeARuntime(string $owner, array $targetOf, int $maxRounds): int
    {
        $rounds = 0;
        while ($rounds < $maxRounds) {
            $queued = self::$flows->listOwnerQueuedRuns($owner, 50);
            if ($queued === []) {
                break;
            }
            $rounds++;
            foreach ($queued as $run) {
                $claimed = self::$flows->claimOwnerRun($owner, $run['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-lineage']);
                $this->assertNotNull($claimed);
                $w = $this->apiWrite($owner, $targetOf[$run['flowDefinitionId']], [
                    'answers' => ['note' => 'again'],
                    'flowRunId' => $run['runId'],
                ]);
                $this->assertSame(201, $w['status'], json_encode($w['body']));
                self::$flows->completeOwnerRun($owner, $run['runId'], ['status' => 'done', 'result' => [], 'instanceId' => 'desk-lineage']);
            }
        }
        return $rounds;
    }

    // ── the loop ──

    public function testACloudFlowThatWritesIntoTheFormItIsBoundToStopsAtTheDepthCeiling(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $flow = $this->writerFlow($owner, 'self-writer', $formA);
        self::$flows->createFormBinding($owner, $formA, ['flow' => 'self-writer', 'event' => 'form.submitted', 'mode' => 'async']);

        $cloud = $this->cloudRunner()->run($flow, $owner, []);
        $this->assertSame('done', $cloud['status'] ?? null, json_encode($cloud));

        $queued = self::$flows->listOwnerQueuedRuns($owner, 50);
        $this->assertCount(1, $queued);
        $firstStarted = $queued[0];

        // Count the runs: a runtime takes each queued run and writes the record the flow writes.
        $max = FlowService::RUN_LINEAGE_MAX_DEPTH;
        $rounds = $this->drainLikeARuntime($owner, [$flow['id'] => $formA], $max + 10);
        $this->assertSame($max, $rounds, 'one round per run at depths 1..' . $max . ', then nothing is queued');

        // The run the cloud run's record started is the cloud run's child.
        $this->assertSame($cloud['runId'], $firstStarted['parentRunId'], 'the record the cloud run wrote carries the cloud run');
        $this->assertSame(1, $firstStarted['depth']);

        $runs = $this->runsOf($flow['id']);
        // The cloud run, the runs at depths 1..16, and the one that was not started.
        $this->assertCount($max + 2, $runs);
        $refused = $runs[count($runs) - 1];
        $this->assertSame('error', $refused['status']);
        $this->assertSame($max + 1, (int) $refused['depth']);
        $this->assertNull($refused['started_at'], 'it never ran');
        $error = json_decode((string) $refused['error_json'], true);
        $this->assertSame('invalid_flow', $error['code'] ?? null, 'a code from the frozen run-result set');
        $this->assertStringContainsString((string) $max, (string) ($error['message'] ?? ''));
        $parent = $this->runRow((string) $refused['parent_run_id']);
        $this->assertSame($max, (int) $parent['depth'], 'the error sits under the run that hit the ceiling');
        $this->assertSame('done', $parent['status']);

        // Every record was kept: the cloud run's and the one of each run at depths 1..16.
        $this->assertSame($max + 1, $this->recordCount($formA));
    }

    public function testTwoFlowsWritingIntoEachOthersFormsStopAtTheDepthCeiling(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner, 'A');
        $formB = $this->makeForm($owner, 'B');
        $toB = $this->writerFlow($owner, 'a-to-b', $formB);
        $toA = $this->writerFlow($owner, 'b-to-a', $formA);
        self::$flows->createFormBinding($owner, $formA, ['flow' => 'a-to-b', 'event' => 'form.submitted', 'mode' => 'async']);
        self::$flows->createFormBinding($owner, $formB, ['flow' => 'b-to-a', 'event' => 'form.submitted', 'mode' => 'async']);

        // A person's record (no run behind it) starts the chain at depth 0.
        $first = $this->apiWrite($owner, $formA, ['answers' => ['note' => 'hello']]);
        $this->assertSame(201, $first['status'], json_encode($first['body']));

        $max = FlowService::RUN_LINEAGE_MAX_DEPTH;
        $rounds = $this->drainLikeARuntime($owner, [$toB['id'] => $formB, $toA['id'] => $formA], $max + 10);
        $this->assertSame($max + 1, $rounds, 'depths 0..' . $max . ', then nothing is queued');

        $all = array_merge($this->runsOf($toB['id']), $this->runsOf($toA['id']));
        $refused = array_values(array_filter($all, static fn (array $r) => $r['status'] === 'error'));
        $this->assertCount(1, $refused);
        $this->assertSame($max + 1, (int) $refused[0]['depth']);
        $this->assertSame(0, (int) min(array_map(static fn (array $r) => (int) $r['depth'], $all)));
    }

    // ── who may name a run ──

    public function testAWriteMayNameOnlyARunOfTheCallersOwnAccount(): void
    {
        $alice = $this->makeUser();
        $bob = $this->makeUser();
        $aliceForm = $this->makeForm($alice);
        $bobForm = $this->makeForm($bob);
        $this->writerFlow($alice, 'alice-flow', $aliceForm);
        $aliceRun = self::$flows->reserveOwnerRun($alice, [
            'flowSlug' => 'alice-flow', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        $this->assertSame('running', $aliceRun['status']);

        // Bob names Alice's run on a write to his own form: refused, nothing stored.
        $w = $this->apiWrite($bob, $bobForm, ['answers' => ['note' => 'x'], 'flowRunId' => $aliceRun['runId']]);
        $this->assertSame(400, $w['status'], json_encode($w['body']));
        $this->assertSame(0, $this->recordCount($bobForm));

        // A run id that does not exist: refused the same way (no way to probe for ids).
        $w = $this->apiWrite($bob, $bobForm, ['answers' => ['note' => 'x'], 'flowRunId' => 'no-such-run']);
        $this->assertSame(400, $w['status']);
        $this->assertSame(0, $this->recordCount($bobForm));

        // Alice names her own running run: accepted.
        $w = $this->apiWrite($alice, $aliceForm, ['answers' => ['note' => 'x'], 'flowRunId' => $aliceRun['runId']]);
        $this->assertSame(201, $w['status'], json_encode($w['body']));

        // After it has finished, a write it made still arrives: one queued offline while the run
        // went on and sent later. Refused, that record was lost (the service worker drops a
        // request the server answered). It is stored, and still carries the run, so the runs it
        // starts are children of it and the depth ceiling holds as before.
        self::$flows->completeOwnerRun($alice, $aliceRun['runId'], ['status' => 'done', 'result' => []]);
        $w = $this->apiWrite($alice, $aliceForm, ['answers' => ['note' => 'x'], 'flowRunId' => $aliceRun['runId']]);
        $this->assertSame(201, $w['status'], json_encode($w['body']));
        $this->assertSame(2, $this->recordCount($aliceForm));
        $this->assertSame($aliceRun['runId'], self::$flows->runForRecordWrite($aliceRun['runId'], $alice));

        // Finished or not, Bob still cannot name it.
        $w = $this->apiWrite($bob, $bobForm, ['answers' => ['note' => 'x'], 'flowRunId' => $aliceRun['runId']]);
        $this->assertSame(400, $w['status']);
        $this->assertSame(0, $this->recordCount($bobForm));
    }

    public function testAnAppMemberCannotNameAnotherMembersRun(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formA = $this->makeForm($owner);
        [$appId, $slug] = $this->makeApp($owner, $formA, [$owner, $member]);
        self::$flows->createFlow($appId, $owner, [
            'name' => 'Triage', 'slug' => 'triage',
            'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']], 'edges' => [['source' => 'in', 'target' => 'out']]],
        ]);
        self::$flows->createBinding($appId, ['flow' => 'triage', 'event' => 'form.submitted', 'formId' => $formA, 'mode' => 'async']);
        $ctrl = $this->appController();

        // The owner's browser reserves a run and executes it now (the live binding path).
        $ownerRun = self::$flows->reserveRun($appId, $owner, [
            'flowSlug' => 'triage', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];

        $memberWrite = $ctrl->createResponse($this->request($member, ['answers' => ['note' => 'x'], 'flowRunId' => $ownerRun['runId']]), new SlimResponse(), ['slug' => $slug, 'formId' => $formA]);
        $this->assertSame(400, $memberWrite->getStatusCode(), (string) $memberWrite->getBody());
        $this->assertSame(0, $this->recordCount($formA));

        $ownerWrite = $ctrl->createResponse($this->request($owner, ['answers' => ['note' => 'x'], 'flowRunId' => $ownerRun['runId']]), new SlimResponse(), ['slug' => $slug, 'formId' => $formA]);
        $this->assertSame(201, $ownerWrite->getStatusCode(), (string) $ownerWrite->getBody());
        $started = self::$flows->listQueuedRuns($appId);
        $this->assertCount(1, $started);
        $this->assertSame($ownerRun['runId'], $started[0]['parentRunId']);
        $this->assertSame(1, $started[0]['depth']);

        // The member claims that queued run: from then on it is the member's to name.
        self::$flows->claimRun($appId, $started[0]['runId'], ['runtime' => 'browser'], $member);
        $claimedWrite = $ctrl->createResponse($this->request($member, ['answers' => ['note' => 'y'], 'flowRunId' => $started[0]['runId']]), new SlimResponse(), ['slug' => $slug, 'formId' => $formA]);
        $this->assertSame(201, $claimedWrite->getStatusCode(), (string) $claimedWrite->getBody());
        $next = self::$flows->listQueuedRuns($appId);
        $this->assertCount(1, $next);
        $this->assertSame(2, $next[0]['depth']);
    }

    public function testThePublicSubmitPathTakesTheRunOfTheSignedInCallerOnly(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $flow = $this->writerFlow($owner, 'ws-writer', $formA);
        self::$flows->createFormBinding($owner, $formA, ['flow' => 'ws-writer', 'event' => 'form.submitted', 'mode' => 'async']);
        $run = self::$flows->reserveOwnerRun($owner, [
            'flowSlug' => 'ws-writer', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        $ctrl = new ResponseController(self::$responses, self::$forms, self::$sqlite);

        // Anonymous: a public form takes anyone's answers, but no one's run.
        $anon = $ctrl->create($this->request(null, ['answers' => ['note' => 'x'], 'flowRunId' => $run['runId']]), new SlimResponse(), ['formId' => $formA]);
        $this->assertSame(400, $anon->getStatusCode(), (string) $anon->getBody());

        // The workspace runner writes as the signed-in owner.
        $signedIn = $ctrl->create($this->request($owner, ['answers' => ['note' => 'x'], 'flowRunId' => $run['runId']]), new SlimResponse(), ['formId' => $formA]);
        $this->assertSame(201, $signedIn->getStatusCode(), (string) $signedIn->getBody());
        $queued = self::$flows->listOwnerQueuedRuns($owner, 50);
        $this->assertCount(1, $queued);
        $this->assertSame($run['runId'], $queued[0]['parentRunId']);
        $this->assertSame($flow['id'], $queued[0]['flowDefinitionId']);
    }

    // ── stored data in the old shape ──

    public function testARunStoredBeforeTheUpgradeIsWrittenForWithoutLineage(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $this->writerFlow($owner, 'old-run', $formA);
        self::$flows->createFormBinding($owner, $formA, ['flow' => 'old-run', 'event' => 'form.submitted', 'mode' => 'async']);
        $run = self::$flows->reserveOwnerRun($owner, [
            'flowSlug' => 'old-run', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        // A row reserved before run_by_user_id existed holds NULL there.
        self::$pdo->prepare('UPDATE flow_run_logs SET run_by_user_id = NULL WHERE id = ?')->execute([$run['runId']]);

        $w = $this->apiWrite($owner, $formA, ['answers' => ['note' => 'x'], 'flowRunId' => $run['runId']]);
        $this->assertSame(201, $w['status'], json_encode($w['body']));
        $queued = self::$flows->listOwnerQueuedRuns($owner, 50);
        $this->assertCount(1, $queued);
        $this->assertNull($queued[0]['parentRunId'], 'who ran it is unknown, so the write starts a new chain as before');
        $this->assertSame(0, $queued[0]['depth']);
    }

    public function testTheMigrationAddsTheColumnAndKeepsRowsInTheOldShape(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        $flow = $this->writerFlow($owner, 'migrated', $formA);
        $runId = self::$flows->reserveOwnerRun($owner, [
            'flowSlug' => 'migrated', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run']['runId'];

        // The table as it was before this change: no run_by_user_id column.
        self::$pdo->exec('ALTER TABLE flow_run_logs DROP COLUMN run_by_user_id');
        try {
            self::$mysql->runMigrations();
        } finally {
            if (self::$pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'run_by_user_id'")->rowCount() === 0) {
                self::$pdo->exec('ALTER TABLE flow_run_logs ADD COLUMN run_by_user_id VARCHAR(36) NULL AFTER claimed_by');
                $this->fail('runMigrations did not add flow_run_logs.run_by_user_id');
            }
        }
        $row = $this->runRow($runId);
        $this->assertSame('running', $row['status']);
        $this->assertSame($flow['id'], $row['flow_definition_id']);
        $this->assertNull($row['run_by_user_id']);
    }

    // ── what the lineage does not change ──

    public function testAWriteIntoAnotherAccountsFormStartsItsRunWithoutLineage(): void
    {
        $alice = $this->makeUser();
        $bob = $this->makeUser();
        $aliceForm = $this->makeForm($alice);
        $bobForm = $this->makeForm($bob);
        $this->writerFlow($alice, 'alice-src', $aliceForm);
        $bobFlow = $this->writerFlow($bob, 'bob-moderates', $bobForm);
        self::$flows->createFormBinding($bob, $bobForm, ['flow' => 'bob-moderates', 'event' => 'form.submitted', 'mode' => 'async']);
        $aliceRun = self::$flows->reserveOwnerRun($alice, [
            'flowSlug' => 'alice-src', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        // Deep enough that one more level would be refused, were it carried.
        self::$pdo->prepare('UPDATE flow_run_logs SET depth = ? WHERE id = ?')->execute([FlowService::RUN_LINEAGE_MAX_DEPTH, $aliceRun['runId']]);

        // Alice's run writes into Bob's public form: Bob's binding runs as for any other record,
        // and Alice's chain can neither suppress it nor show up in Bob's run history.
        $ctrl = new ResponseController(self::$responses, self::$forms, self::$sqlite);
        $out = $ctrl->create($this->request($alice, ['answers' => ['note' => 'x'], 'flowRunId' => $aliceRun['runId']]), new SlimResponse(), ['formId' => $bobForm]);
        $this->assertSame(201, $out->getStatusCode(), (string) $out->getBody());
        $bobRuns = $this->runsOf($bobFlow['id']);
        $this->assertCount(1, $bobRuns);
        $this->assertSame('queued', $bobRuns[0]['status']);
        $this->assertNull($bobRuns[0]['parent_run_id']);
        $this->assertSame(0, (int) $bobRuns[0]['depth']);
    }

    public function testEachRunAWriteStartsKeepsItsOwnOutcomeHandlers(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        [$appId] = $this->makeApp($owner, $formA, [$owner]);
        $trivial = ['nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']], 'edges' => [['source' => 'in', 'target' => 'out']]];
        self::$flows->createFlow($appId, $owner, ['name' => 'Import', 'slug' => 'import', 'flowJson' => $trivial]);
        self::$flows->createFlow($appId, $owner, ['name' => 'Process', 'slug' => 'process', 'flowJson' => $trivial]);
        $notify = self::$flows->createFlow($appId, $owner, ['name' => 'Notify', 'slug' => 'notify', 'flowJson' => $trivial]);
        $processBinding = self::$flows->createBinding($appId, ['flow' => 'process', 'event' => 'form.submitted', 'formId' => $formA, 'mode' => 'async']);
        self::$flows->createBinding($appId, ['flow' => 'notify', 'event' => 'flow.succeeded', 'mode' => 'async']);

        // One run writes two records; each starts a 'process' run, and each of those that
        // succeeds starts its own 'notify' run, as when the two records came from anywhere else.
        $import = self::$flows->reserveRun($appId, $owner, [
            'flowSlug' => 'import', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        foreach (['r1', 'r2'] as $suffix) {
            $created = self::$responses->createResponse($formA, ['answers' => ['note' => $suffix]], null, $import['runId']);
            $this->assertIsArray($created);
        }
        $processRuns = array_values(array_filter(
            self::$flows->listQueuedRuns($appId),
            static fn (array $r) => $r['bindingId'] === $processBinding['id']
        ));
        $this->assertCount(2, $processRuns);
        foreach ($processRuns as $run) {
            $this->assertSame($import['runId'], $run['parentRunId']);
            self::$flows->claimRun($appId, $run['runId'], ['runtime' => 'browser'], $owner);
            self::$flows->completeRun($appId, $run['runId'], ['status' => 'done', 'result' => []]);
        }
        $notifyRuns = $this->runsOf($notify['id']);
        $this->assertCount(2, $notifyRuns, 'one handler run per succeeded run, not one per chain');
    }

    public function testTheRunThatIsNotStartedFeedsNoHandlerAndTheSweepStaysQuiet(): void
    {
        $owner = $this->makeUser();
        $formA = $this->makeForm($owner);
        [$appId] = $this->makeApp($owner, $formA, [$owner]);
        $trivial = ['nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']], 'edges' => [['source' => 'in', 'target' => 'out']]];
        self::$flows->createFlow($appId, $owner, ['name' => 'Src', 'slug' => 'src', 'flowJson' => $trivial]);
        $loop = self::$flows->createFlow($appId, $owner, ['name' => 'Loop', 'slug' => 'loop', 'flowJson' => $trivial]);
        $onFail = self::$flows->createFlow($appId, $owner, ['name' => 'On fail', 'slug' => 'on-fail', 'flowJson' => $trivial]);
        self::$flows->createBinding($appId, ['flow' => 'loop', 'event' => 'form.submitted', 'formId' => $formA, 'mode' => 'async']);
        self::$flows->createBinding($appId, ['flow' => 'on-fail', 'event' => 'flow.failed', 'mode' => 'async']);

        $src = self::$flows->reserveRun($appId, $owner, [
            'flowSlug' => 'src', 'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)), 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6)),
        ])['run'];
        self::$pdo->prepare('UPDATE flow_run_logs SET depth = ? WHERE id = ?')->execute([FlowService::RUN_LINEAGE_MAX_DEPTH, $src['runId']]);

        $created = self::$responses->createResponse($formA, ['answers' => ['note' => 'x']], null, $src['runId']);
        $this->assertIsArray($created, 'the record is kept');
        $this->assertSame(1, $this->recordCount($formA));
        $loopRuns = $this->runsOf($loop['id']);
        $this->assertCount(1, $loopRuns);
        $this->assertSame('error', $loopRuns[0]['status']);
        $this->assertSame($src['runId'], $loopRuns[0]['parent_run_id']);

        self::$flows->reconcileMissingOutcomeEvents();
        self::$flows->dispatchPendingOutcomeEvents();
        $this->assertSame([], $this->runsOf($onFail['id']), 'a flow.failed handler would be past the ceiling too');
    }

    // ── app fixture ──

    /** @param string[] $members @return array{0:string,1:string} [appId, slug] */
    private function makeApp(string $owner, string $formId, array $members): array
    {
        $appId = 'app' . bin2hex(random_bytes(10));
        $slug = 'lin' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Lineage', ?, 'published')")
            ->execute([$appId, $owner, $slug]);
        $this->appIds[] = $appId;
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'Notes', 0, 1, '{}')")
            ->execute(['af' . bin2hex(random_bytes(10)), $appId, $formId]);
        $role = 'role' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'R', 0, 0)")
            ->execute([$role, $appId]);
        self::$pdo->prepare('INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)')
            ->execute(['arp' . bin2hex(random_bytes(10)), $role, $formId, AppPermissions::SUBMIT_RESPONSES]);
        foreach ($members as $uid) {
            self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
                ->execute(['au' . bin2hex(random_bytes(10)), $appId, $uid, $role]);
        }
        return [$appId, $slug];
    }

    private function appController(): AppPublicController
    {
        $appResponses = new AppResponseService(self::$mysql, self::$sqlite, self::$responses, null, self::$forms);
        return new AppPublicController(
            new AppService(self::$mysql, self::$forms),
            new AppUserService(self::$mysql),
            $appResponses,
            self::$forms,
            self::$responses,
            self::$mysql,
            self::$sqlite,
            new AppDomainService(self::$mysql)
        );
    }
}
