<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Owner-scoped reserve (POST /api/v1/flow-runs) + owner app-logic reads (GET /api/v1/app-logic) —
 * the API-key surface FormLogic Desktop's headless dispatcher uses (docs/FORMLOGIC_FLOWS.md §13).
 * The core invariant: a desktop reserve and a browser reserve of the SAME event (same
 * idempotency key) dedupe to exactly one run, whichever surface got there first.
 * Follows the FlowWorkspaceQueueTest fixture pattern; skipped without a test DB.
 */
class FlowOwnerReserveTest extends TestCase
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
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Reserve App', ?, 'published')")
            ->execute([$this->appId, $this->userA, 'resapp-' . bin2hex(random_bytes(6))]);
        $this->formId = 'f-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'Reserve Form', 'published')")
            ->execute([$this->formId, $this->userA]);
        self::$pdo->prepare('INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order) VALUES (?, ?, ?, ?, 0)')
            ->execute(['af-' . bin2hex(random_bytes(12)), $this->appId, $this->formId, 'Calls']);
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
        }
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->userA, $this->userB] as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function graph(): array
    {
        return [
            'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
            'edges' => [['source' => 'in', 'target' => 'out']],
        ];
    }

    private function reservePayload(array $overrides = []): array
    {
        return array_merge([
            'flowSlug' => 'desk',
            'triggerEvent' => 'aokie.call.incoming',
            'correlationId' => 'call_1',
            'idempotencyKey' => 'flow:b1:aokie:call_1:incoming:v1-' . bin2hex(random_bytes(6)),
        ], $overrides);
    }

    public function testWorkspaceReserveRunsAndRepliesIdempotently(): void
    {
        self::$flows->createWorkspaceFlow($this->userA, ['name' => 'Desk', 'slug' => 'desk', 'flowJson' => $this->graph()]);

        $payload = $this->reservePayload();
        $first = self::$flows->reserveOwnerRun($this->userA, $payload);
        $this->assertTrue($first['created']);
        $this->assertSame('running', $first['run']['status']);
        $this->assertNull($first['run']['appId'], 'workspace reserve stores app_id NULL');

        // Replay with the same key: same run back, created=false.
        $second = self::$flows->reserveOwnerRun($this->userA, $payload);
        $this->assertFalse($second['created']);
        $this->assertSame($first['run']['runId'], $second['run']['runId']);

        // queued:true reserves without starting.
        $queued = self::$flows->reserveOwnerRun($this->userA, $this->reservePayload(['queued' => true]));
        $this->assertTrue($queued['created']);
        $this->assertSame('queued', $queued['run']['status']);
        $this->assertNull($queued['run']['startedAt']);
    }

    public function testAppScopedReserveDedupesAgainstBrowserReserve(): void
    {
        self::$flows->createFlow($this->appId, $this->userA, ['name' => 'Desk', 'slug' => 'desk', 'flowJson' => $this->graph()]);

        // Browser runtime reserved first (app-runtime surface)…
        $key = 'flow:b9:aokie:call_7:incoming:v1';
        $browser = self::$flows->reserveRun($this->appId, $this->userA, $this->reservePayload(['idempotencyKey' => $key]));
        $this->assertTrue($browser['created']);

        // …then the desktop reserve with the SAME key is an idempotent replay, not a new run.
        $desktop = self::$flows->reserveOwnerRun($this->userA, $this->reservePayload(['idempotencyKey' => $key, 'appId' => $this->appId]));
        $this->assertFalse($desktop['created']);
        $this->assertSame($browser['run']['runId'], $desktop['run']['runId']);
    }

    public function testForeignFlowsAndForeignKeysAreRejected(): void
    {
        self::$flows->createFlow($this->appId, $this->userA, ['name' => 'Desk', 'slug' => 'desk', 'flowJson' => $this->graph()]);

        // User B has no such flow — app scope or workspace.
        try {
            self::$flows->reserveOwnerRun($this->userB, $this->reservePayload(['appId' => $this->appId]));
            $this->fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Unknown or disabled flow', $e->getMessage());
        }

        // A key already held by user A's run must not leak to user B.
        $key = 'flow:bx:aokie:call_9:incoming:v1';
        self::$flows->reserveOwnerRun($this->userA, $this->reservePayload(['idempotencyKey' => $key, 'appId' => $this->appId]));
        self::$flows->createWorkspaceFlow($this->userB, ['name' => 'Desk', 'slug' => 'desk', 'flowJson' => $this->graph()]);
        try {
            self::$flows->reserveOwnerRun($this->userB, $this->reservePayload(['idempotencyKey' => $key]));
            $this->fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('already used', $e->getMessage());
        }
    }

    public function testReserveValidatesBindingOwnershipAndPayload(): void
    {
        self::$flows->createFlow($this->appId, $this->userA, ['name' => 'Desk', 'slug' => 'desk', 'flowJson' => $this->graph()]);
        $binding = self::$flows->createBinding($this->appId, ['flow' => 'desk', 'event' => 'aokie.call.incoming', 'mode' => 'async']);

        // A real binding of the flow passes and lands on the run row.
        $ok = self::$flows->reserveOwnerRun($this->userA, $this->reservePayload([
            'appId' => $this->appId,
            'bindingId' => $binding['id'],
        ]));
        $this->assertSame($binding['id'], $ok['run']['bindingId']);

        // A bogus binding id is rejected.
        try {
            self::$flows->reserveOwnerRun($this->userA, $this->reservePayload(['appId' => $this->appId, 'bindingId' => 'nope']));
            $this->fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Unknown flow binding', $e->getMessage());
        }

        // Bad trigger event.
        try {
            self::$flows->reserveOwnerRun($this->userA, $this->reservePayload(['appId' => $this->appId, 'triggerEvent' => 'NOT AN EVENT']));
            $this->fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('triggerEvent', $e->getMessage());
        }
    }

    public function testOwnerAppLogicIsOwnerScopedAndResolvesForms(): void
    {
        $bundle = [
            'version' => 1,
            'runtime' => 'quickjs',
            'scripts' => [[
                'id' => 'call-incoming',
                'hook' => 'onConnectorEvent',
                'runtime' => 'quickjs',
                'source' => 'function run(ctx) { return {}; }',
            ]],
        ];
        self::$pdo->prepare('UPDATE apps SET custom_logic = ? WHERE id = ?')
            ->execute([json_encode($bundle), $this->appId]);

        // By slug selector.
        $slug = self::$pdo->query("SELECT slug FROM apps WHERE id = " . self::$pdo->quote($this->appId))->fetchColumn();
        $one = self::$flows->getOwnerAppLogic($this->userA, (string) $slug);
        $this->assertCount(1, $one);
        $this->assertSame($this->appId, $one[0]['app']['id']);
        $this->assertSame('onConnectorEvent', $one[0]['customLogic']['scripts'][0]['hook']);
        $this->assertSame($this->formId, $one[0]['forms'][0]['id']);
        $this->assertSame('Calls', $one[0]['forms'][0]['displayName']);

        // List-all only includes apps WITH a bundle; user B sees nothing.
        $all = self::$flows->getOwnerAppLogic($this->userA);
        $this->assertCount(1, $all);
        $this->assertSame([], self::$flows->getOwnerAppLogic($this->userB));
        $this->assertSame([], self::$flows->getOwnerAppLogic($this->userB, (string) $slug));
    }
}
