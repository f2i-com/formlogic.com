<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowRevisionConflictException;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Immutable flow revisions + optimistic concurrency (extensible-flows plan §14.2):
 * expectedVersion guard (409 revision_conflict), contract-change version bumps, lazy
 * flow_definition_versions materialisation at run-reserve, byte-exact digests, and the
 * graph-v2 edge-id/graphVersion validation in sanitizeFlowJson. Skipped without a test DB.
 */
class FlowVersioningTest extends TestCase
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
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Ver App', ?, 'published')")
            ->execute([$this->appId, $this->userId, 'verapp-' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare(
            'DELETE v FROM flow_definition_versions v JOIN flow_definitions f ON f.id = v.flow_definition_id WHERE f.app_id = ?'
        )->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function makeFlow(string $slug = 'ver-flow'): array
    {
        return self::$flows->createFlow($this->appId, $this->userId, [
            'name' => 'Versioned flow',
            'slug' => $slug,
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ]);
    }

    // ── expectedVersion optimistic-concurrency guard ─────────────────────────────────────

    public function testStaleExpectedVersionThrowsConflictWithCurrentVersion(): void
    {
        $flow = $this->makeFlow();
        // Concurrent editor bumped the graph: version 1 → 2.
        self::$flows->updateFlow($this->appId, $flow['id'], [
            'flowJson' => ['nodes' => [['id' => 'solo', 'type' => 'input']], 'edges' => []],
        ]);

        try {
            self::$flows->updateFlow($this->appId, $flow['id'], [
                'expectedVersion' => 1,
                'flowJson' => ['nodes' => [['id' => 'mine', 'type' => 'input']], 'edges' => []],
            ]);
            $this->fail('Expected FlowRevisionConflictException');
        } catch (FlowRevisionConflictException $e) {
            $this->assertSame(2, $e->currentVersion);
        }
        // The stale write did NOT land.
        $current = self::$flows->getFlow($this->appId, $flow['id']);
        $this->assertSame('solo', $current['flowJson']['nodes'][0]['id']);
    }

    public function testMatchingExpectedVersionUpdates(): void
    {
        $flow = $this->makeFlow();
        $updated = self::$flows->updateFlow($this->appId, $flow['id'], [
            'expectedVersion' => 1,
            'flowJson' => ['nodes' => [['id' => 'next', 'type' => 'input']], 'edges' => []],
        ]);
        $this->assertSame(2, $updated['version']);
        $this->assertSame('next', $updated['flowJson']['nodes'][0]['id']);
    }

    public function testExpectedVersionMustBeAPositiveInteger(): void
    {
        $flow = $this->makeFlow();
        $this->expectException(\InvalidArgumentException::class);
        self::$flows->updateFlow($this->appId, $flow['id'], ['expectedVersion' => 'nope', 'name' => 'X']);
    }

    public function testAnyContractFieldChangeBumpsVersion(): void
    {
        $flow = $this->makeFlow();
        // executionLocation is executable contract → bumps (previously only flowJson did),
        // so immutable revision rows can never collide with different content.
        $updated = self::$flows->updateFlow($this->appId, $flow['id'], ['executionLocation' => 'cloud']);
        $this->assertSame(2, $updated['version']);
        // A pure rename is NOT contract → no bump.
        $renamed = self::$flows->updateFlow($this->appId, $flow['id'], ['name' => 'Renamed']);
        $this->assertSame(2, $renamed['version']);
    }

    // ── Lazy immutable revisions at run-reserve ──────────────────────────────────────────

    public function testReserveRunPinsAnImmutableRevision(): void
    {
        $flow = $this->makeFlow();
        $reserved = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'ver-flow',
            'triggerEvent' => 'test',
            'correlationId' => 'corr-1',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(8)),
        ]);
        $run = $reserved['run'];
        $this->assertNotNull($run['flowVersionId'], 'run must pin a revision');

        $row = $this->versionRow($run['flowVersionId']);
        $this->assertSame($flow['id'], $row['flow_definition_id']);
        $this->assertSame(1, (int) $row['version']);
        $this->assertSame(hash('sha256', (string) $row['definition_json']), $row['definition_digest'], 'digest is byte-exact');
        $decoded = json_decode((string) $row['definition_json'], true);
        $this->assertSame('f2i', $decoded['engine']);
        $this->assertCount(2, $decoded['flowJson']['nodes']);

        // Same contract, second run → SAME revision row (idempotent mint).
        $again = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'ver-flow',
            'triggerEvent' => 'test',
            'correlationId' => 'corr-2',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(8)),
        ]);
        $this->assertSame($run['flowVersionId'], $again['run']['flowVersionId']);

        // Contract change → the NEXT run pins a NEW revision; the old row is untouched.
        self::$flows->updateFlow($this->appId, $flow['id'], [
            'flowJson' => ['nodes' => [['id' => 'solo', 'type' => 'input']], 'edges' => []],
        ]);
        $after = self::$flows->reserveRun($this->appId, $this->userId, [
            'flowSlug' => 'ver-flow',
            'triggerEvent' => 'test',
            'correlationId' => 'corr-3',
            'idempotencyKey' => 'k-' . bin2hex(random_bytes(8)),
        ]);
        $this->assertNotSame($run['flowVersionId'], $after['run']['flowVersionId']);
        $newRow = $this->versionRow($after['run']['flowVersionId']);
        $this->assertSame(2, (int) $newRow['version']);
        $oldRow = $this->versionRow($run['flowVersionId']);
        $this->assertCount(2, json_decode((string) $oldRow['definition_json'], true)['flowJson']['nodes'], 'old revision is immutable');
    }

    public function testCreateTestRunPinsARevision(): void
    {
        $flow = $this->makeFlow();
        $run = self::$flows->createTestRun($this->appId, $flow['id']);
        $this->assertNotNull($run['flowVersionId']);
        $this->assertSame(1, (int) $this->versionRow($run['flowVersionId'])['version']);
    }

    // ── Graph v2 validation in sanitizeFlowJson ──────────────────────────────────────────

    public function testSanitizeFlowJsonValidatesEdgeIdsAndGraphVersion(): void
    {
        $nodes = [['id' => 'a', 'type' => 'input'], ['id' => 'b', 'type' => 'output']];

        // Edge ids round-trip; graphVersion is carried through (previously stripped).
        $ok = FlowService::sanitizeFlowJson([
            'graphVersion' => 2,
            'nodes' => $nodes,
            'edges' => [['id' => 'e1', 'source' => 'a', 'target' => 'b'], ['source' => 'a', 'target' => 'b']],
        ]);
        $this->assertSame('e1', $ok['edges'][0]['id']);
        $this->assertSame(2, $ok['graphVersion']);

        try {
            FlowService::sanitizeFlowJson([
                'nodes' => $nodes,
                'edges' => [
                    ['id' => 'dup', 'source' => 'a', 'target' => 'b'],
                    ['id' => 'dup', 'source' => 'a', 'target' => 'b', 'sourceHandle' => 'x'],
                ],
            ]);
            $this->fail('duplicate edge ids must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Duplicate flow edge id', $e->getMessage());
        }

        try {
            FlowService::sanitizeFlowJson(['nodes' => $nodes, 'edges' => [['id' => '', 'source' => 'a', 'target' => 'b']]]);
            $this->fail('empty edge id must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('invalid id', $e->getMessage());
        }

        try {
            FlowService::sanitizeFlowJson(['graphVersion' => 7, 'nodes' => $nodes, 'edges' => []]);
            $this->fail('unknown graphVersion must be rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('graphVersion', $e->getMessage());
        }
    }

    /** @return array<string, mixed> */
    private function versionRow(string $id): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_definition_versions WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertIsArray($row, "flow_definition_versions row {$id} must exist");
        return $row;
    }
}
