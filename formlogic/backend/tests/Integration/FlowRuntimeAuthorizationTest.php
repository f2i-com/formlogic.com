<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FlowController;
use FormLogic\Controllers\FlowKvController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowKvService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Audit FL-AUTH-001 — the runtime flow surface requires the execute_flows permission, not mere
 * membership: definitions, reserve, queued listing, claim, complete and the shared flow-KV store.
 * Also covers snapshot minimization (queued listings never carry input snapshots for non-owners,
 * form-tied runs are invisible without view_all_responses), claimant-bound completion
 * (claimed_elsewhere → 409) and the one-time execute_flows role backfill migration.
 * Skipped without a test DB.
 */
class FlowRuntimeAuthorizationTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;
    private static AppUserService $appUsers;
    private static FlowController $ctrl;
    private static FlowKvController $kvCtrl;

    private string $ownerId = '';
    private string $memberId = '';
    private string $appId = '';
    private string $slug = '';
    private string $roleId = '';
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-flow-auth-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$flows = new FlowService($conn);
        self::$appUsers = new AppUserService($conn);
        self::$ctrl = new FlowController(self::$flows, $apps, self::$appUsers, null);
        self::$kvCtrl = new FlowKvController(new FlowKvService($conn), $apps, self::$appUsers);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        $this->memberId = 'u-' . bin2hex(random_bytes(12));
        foreach ([$this->ownerId, $this->memberId] as $uid) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$uid, $uid . '@test.local']);
        }
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        $this->slug = 'flowauth-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Flow Auth App', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);

        // Owner membership (resolveRuntime requires an active app_users row even for the owner).
        $ownerRole = $this->makeRole('Owner-x');
        $this->addMember($this->ownerId, $ownerRole);

        // Member with a grant-less role — tests grant permissions as needed.
        $this->roleId = $this->makeRole('Member-x');
        $this->addMember($this->memberId, $this->roleId);

        // A form attached to the app (for form-tied queued runs).
        $this->formId = 'f-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'Flow Form', 'published')")
            ->execute([$this->formId, $this->ownerId]);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name) VALUES (UUID(), ?, ?, 'Flow Form')")
            ->execute([$this->appId, $this->formId]);

        self::$flows->createFlow($this->appId, $this->ownerId, [
            'name' => 'Triage',
            'slug' => 'triage',
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->appId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_kv WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE p FROM app_role_permissions p JOIN app_roles r ON r.id = p.role_id WHERE r.app_id = ?')
            ->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->ownerId, $this->memberId] as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── Fixture helpers ─────────────────────────────────────────────────────────────────────

    private function makeRole(string $name): string
    {
        $id = 'r-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 9)")
            ->execute([$id, $this->appId, $name]);
        return $id;
    }

    private function addMember(string $userId, string $roleId): void
    {
        self::$pdo->prepare("
            INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
            VALUES (UUID(), ?, ?, ?, 'active', NOW())
        ")->execute([$this->appId, $userId, $roleId]);
    }

    private function grant(string $roleId, string $permission, ?string $formId = null): void
    {
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (UUID(), ?, ?, ?)")
            ->execute([$roleId, $formId, $permission]);
    }

    /** @param array<string, mixed>|null $body */
    private function call(string $method, string $userId, callable $handler, ?array $body = null, array $query = []): array
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, 'http://localhost/api/test')
            ->withAttribute('userId', $userId);
        if ($body !== null) {
            $req = $req->withParsedBody($body);
        }
        if ($query !== []) {
            $req = $req->withQueryParams($query);
        }
        /** @var ResponseInterface $res */
        $res = $handler($req, new Response());
        $payload = json_decode((string) $res->getBody(), true) ?? [];
        return [$res->getStatusCode(), $payload];
    }

    private function reserveQueued(?string $formId = null, ?string $key = null): array
    {
        $data = [
            'flowSlug' => 'triage',
            'triggerEvent' => 'form.submitted',
            'correlationId' => 'c-' . bin2hex(random_bytes(6)),
            'idempotencyKey' => $key ?? 'k-' . bin2hex(random_bytes(10)),
            'queued' => true,
            'inputSnapshot' => ['event' => ['name' => 'form.submitted', 'data' => ['answers' => ['secret' => 'value']]]],
        ];
        if ($formId !== null) {
            $data['formId'] = $formId;
        }
        return self::$flows->reserveRun($this->appId, $this->ownerId, $data)['run'];
    }

    // ── execute_flows gates the whole runtime surface ───────────────────────────────────────

    public function testMemberWithoutExecuteFlowsIsRejectedAcrossTheRuntimeSurface(): void
    {
        $slugArgs = ['slug' => $this->slug];

        [$code] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$ctrl->runtimeFlows($rq, $rs, $slugArgs));
        $this->assertSame(403, $code, 'runtime definitions require execute_flows');

        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->reserveRun($rq, $rs, $slugArgs), [
            'flowSlug' => 'triage',
            'triggerEvent' => 'form.submitted',
            'correlationId' => 'c1',
            'idempotencyKey' => 'k-denied-' . bin2hex(random_bytes(6)),
        ]);
        $this->assertSame(403, $code, 'reserve requires execute_flows');

        [$code] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs));
        $this->assertSame(403, $code, 'queued listing requires execute_flows');

        $run = $this->reserveQueued();
        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), ['runtime' => 'browser']);
        $this->assertSame(403, $code, 'claim requires execute_flows');

        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), ['status' => 'done']);
        $this->assertSame(403, $code, 'complete requires execute_flows');

        [$code] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$kvCtrl->runtimeGet($rq, $rs, $slugArgs), null, ['scope' => 'flow:triage']);
        $this->assertSame(403, $code, 'flow-KV read requires execute_flows');

        [$code] = $this->call('PUT', $this->memberId, fn ($rq, $rs) => self::$kvCtrl->runtimePut($rq, $rs, $slugArgs), [
            'scope' => 'flow:triage', 'k' => 'x', 'v' => 1,
        ]);
        $this->assertSame(403, $code, 'flow-KV write requires execute_flows');
    }

    public function testExecuteFlowsGrantOpensTheRuntimeSurface(): void
    {
        $this->grant($this->roleId, 'execute_flows');
        $slugArgs = ['slug' => $this->slug];

        [$code, $payload] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$ctrl->runtimeFlows($rq, $rs, $slugArgs));
        $this->assertSame(200, $code);
        $this->assertCount(1, $payload['flows']);

        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->reserveRun($rq, $rs, $slugArgs), [
            'flowSlug' => 'triage',
            'triggerEvent' => 'form.submitted',
            'correlationId' => 'c2',
            'idempotencyKey' => 'k-granted-' . bin2hex(random_bytes(6)),
        ]);
        $this->assertSame(201, $code);

        [$code] = $this->call('PUT', $this->memberId, fn ($rq, $rs) => self::$kvCtrl->runtimePut($rq, $rs, $slugArgs), [
            'scope' => 'flow:triage', 'k' => 'x', 'v' => 1,
        ]);
        $this->assertSame(200, $code);
    }

    public function testOwnerIsAlwaysAllowed(): void
    {
        [$code] = $this->call('GET', $this->ownerId, fn ($rq, $rs) => self::$ctrl->runtimeFlows($rq, $rs, ['slug' => $this->slug]));
        $this->assertSame(200, $code, 'the app owner needs no explicit grant');
    }

    // ── Snapshot minimization + form visibility ─────────────────────────────────────────────

    public function testQueuedListingHidesSnapshotsAndInvisibleFormRuns(): void
    {
        $this->grant($this->roleId, 'execute_flows');
        $formRun = $this->reserveQueued($this->formId);
        $freeRun = $this->reserveQueued(null);
        $slugArgs = ['slug' => $this->slug];

        // Without view_all_responses: only the form-less run is listed, and without a snapshot.
        [, $payload] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs));
        $ids = array_column($payload['runs'], 'runId');
        $this->assertContains($freeRun['runId'], $ids);
        $this->assertNotContains($formRun['runId'], $ids, 'a form-tied run is hidden without view_all_responses');
        foreach ($payload['runs'] as $r) {
            $this->assertNull($r['inputSnapshot'], 'listings never carry snapshots for non-owners');
        }

        // Claiming the invisible run is a non-enumerating 404.
        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $formRun['runId']]), ['runtime' => 'browser']);
        $this->assertSame(404, $code);

        // With view_all_responses on the form the run appears (still snapshot-less in the list)
        // and the claim delivers the authoritative run WITH its snapshot.
        $this->grant($this->roleId, 'view_all_responses', $this->formId);
        [, $payload] = $this->call('GET', $this->memberId, fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs));
        $ids = array_column($payload['runs'], 'runId');
        $this->assertContains($formRun['runId'], $ids);

        [$code, $payload] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $formRun['runId']]), [
            'runtime' => 'browser', 'instanceId' => 'tab-1',
        ]);
        $this->assertSame(200, $code);
        $this->assertSame('value', $payload['run']['inputSnapshot']['event']['data']['answers']['secret']);

        // The owner's listing keeps snapshots (their own data).
        [, $payload] = $this->call('GET', $this->ownerId, fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs));
        $byId = array_column($payload['runs'], null, 'runId');
        $this->assertNotNull($byId[$freeRun['runId']]['inputSnapshot']);
    }

    // ── Completion visibility (audit FL-02) ─────────────────────────────────────────────────

    public function testHiddenFormRunCannotBeCompletedByRunId(): void
    {
        // Completion re-applies the exact claim visibility predicate: an execute-only
        // member who cannot list/claim a form-tied run must not be able to complete it
        // by UUID either (result-action injection + outcome triggers ride completion).
        // Invisible runs are a non-enumerating 404, identical to claimRun.
        $this->grant($this->roleId, 'execute_flows');
        $formRun = $this->reserveQueued($this->formId);
        $slugArgs = ['slug' => $this->slug];

        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $formRun['runId']]), ['status' => 'done', 'instanceId' => 'tab-x']);
        $this->assertSame(404, $code, 'an invisible run must not be completable');

        $row = self::$pdo->prepare('SELECT status FROM flow_run_logs WHERE id = ?');
        $row->execute([$formRun['runId']]);
        $this->assertSame('queued', $row->fetchColumn(), 'the hidden run must be untouched');

        // Granting form visibility opens the normal claim → complete path (audit FL-01:
        // queued, never-claimed work is not directly completable).
        $this->grant($this->roleId, 'view_all_responses', $this->formId);
        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $formRun['runId']]), [
            'runtime' => 'browser', 'instanceId' => 'tab-x',
        ]);
        $this->assertSame(200, $code);
        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $formRun['runId']]), ['status' => 'done', 'instanceId' => 'tab-x']);
        $this->assertSame(200, $code);
    }

    public function testQueuedNeverClaimedRunCannotBeCompleted(): void
    {
        // Audit FL-01: a bare run UUID must not terminate work no runtime owns yet —
        // queued rows must be CLAIMED (queued→running) before they can be finalised.
        $this->grant($this->roleId, 'execute_flows');
        $run = $this->reserveQueued();
        $slugArgs = ['slug' => $this->slug];

        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), ['status' => 'done', 'instanceId' => 'tab-q']);
        $this->assertSame(409, $code, 'queued, never-claimed work is not completable');

        $row = self::$pdo->prepare('SELECT status FROM flow_run_logs WHERE id = ?');
        $row->execute([$run['runId']]);
        $this->assertSame('queued', $row->fetchColumn());
    }

    // ── Claimant-bound completion ───────────────────────────────────────────────────────────

    public function testClaimedRunCanOnlyBeCompletedByItsClaimant(): void
    {
        $this->grant($this->roleId, 'execute_flows');
        $run = $this->reserveQueued();
        $slugArgs = ['slug' => $this->slug];

        [$code] = $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'runtime' => 'browser', 'instanceId' => 'tab-a',
        ]);
        $this->assertSame(200, $code);

        // Another instance cannot finalize the lease.
        [$code, $payload] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'status' => 'done', 'instanceId' => 'tab-b',
        ]);
        $this->assertSame(409, $code);
        $this->assertSame('claimed_elsewhere', $payload['code'] ?? null);

        // The claimant can.
        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'status' => 'done', 'instanceId' => 'tab-a',
        ]);
        $this->assertSame(200, $code);

        // Re-completion is the ordinary already_finalized 409 (no claimed_elsewhere code).
        [$code, $payload] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'status' => 'done', 'instanceId' => 'tab-a',
        ]);
        $this->assertSame(409, $code);
        $this->assertArrayNotHasKey('code', $payload);
    }

    public function testOmittedInstanceIdNeverBypassesTheClaimantLease(): void
    {
        // Audit FL-01 (reverses the earlier legacy allowance): a run claimed WITH an
        // identity may only be completed by that identity — omitting instanceId is no
        // longer a bypass. Runs claimed WITHOUT an identity stay completable (legacy).
        $this->grant($this->roleId, 'execute_flows');
        $run = $this->reserveQueued();
        $slugArgs = ['slug' => $this->slug];

        $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'runtime' => 'browser', 'instanceId' => 'tab-a',
        ]);
        [$code, $payload] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'status' => 'done',
        ]);
        $this->assertSame(409, $code, 'an anonymous completion must not bypass the lease');
        $this->assertSame('claimed_elsewhere', $payload['code'] ?? null);

        // The claimant still lands normally.
        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $run['runId']]), [
            'status' => 'done', 'instanceId' => 'tab-a',
        ]);
        $this->assertSame(200, $code);

        // A run claimed WITHOUT an identity (legacy runtimes) remains completable.
        $legacy = $this->reserveQueued();
        $this->call('POST', $this->memberId, fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $legacy['runId']]), [
            'runtime' => 'browser',
        ]);
        [$code] = $this->call('PATCH', $this->memberId, fn ($rq, $rs) => self::$ctrl->completeRun($rq, $rs, $slugArgs + ['runId' => $legacy['runId']]), [
            'status' => 'done',
        ]);
        $this->assertSame(200, $code);
    }

    // ── One-time execute_flows backfill migration ───────────────────────────────────────────

    public function testBackfillGrantsExecuteFlowsToExistingRolesExactlyOnce(): void
    {
        $bare = $this->makeRole('Legacy');
        self::$pdo->exec("DELETE FROM system_meta WHERE meta_key = 'execute_flows_backfilled'");
        self::$mysql->runMigrations();

        $has = fn (): bool => (bool) self::$pdo
            ->query("SELECT COUNT(*) FROM app_role_permissions WHERE role_id = '{$bare}' AND permission = 'execute_flows'")
            ->fetchColumn();
        $this->assertTrue($has(), 'existing roles are backfilled');

        // Revoke, re-run migrations: the flag stops a silent re-grant.
        self::$pdo->exec("DELETE FROM app_role_permissions WHERE role_id = '{$bare}' AND permission = 'execute_flows'");
        self::$mysql->runMigrations();
        $this->assertFalse($has(), 'a revoked grant is never re-applied by later migrations');
    }
}
