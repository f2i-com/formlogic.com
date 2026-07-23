<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\BlueprintMaterializeService;
use FormLogic\Services\BlueprintService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Diagram materialisation (§11A D3): concept form entities become real forms with their
 * sketched fields, ER relation edges become linked_record fields on the target form,
 * everything attaches to a NEW app atomically, and the blueprint links + stamps refs.
 * Once linked, a second materialisation refuses. Skipped without a test DB.
 */
class BlueprintMaterializeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static BlueprintService $blueprints;
    private static FormService $forms;
    private static AppService $apps;
    private static BlueprintMaterializeService $materializer;

    private string $userId = '';

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
        $sqliteDir = sys_get_temp_dir() . '/formlogic-bp-mz-' . bin2hex(random_bytes(4));
        mkdir($sqliteDir, 0777, true);
        $sqlite = new SQLiteConnection($sqliteDir);
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$blueprints = new BlueprintService($conn);
        self::$materializer = new BlueprintMaterializeService(
            $conn,
            self::$blueprints,
            self::$forms,
            self::$apps,
            new FlowService($conn)
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            self::markTestSkipped('No test database available');
        }
        $this->userId = 'bp-mz-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Materialize Tester')")
            ->execute([$this->userId, "{$this->userId}@test.local"]);
    }

    private function op(string $type, array $extra = []): array
    {
        return array_merge(['operationId' => 'op-' . bin2hex(random_bytes(8)), 'type' => $type], $extra);
    }

    public function testSketchMaterialisesIntoAppFormsAndRelation(): void
    {
        $blueprint = self::$blueprints->createBlueprint($this->userId, ['name' => 'Order tracker']);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-customers',
                    'elementType' => 'form',
                    'properties' => ['title' => 'Customers', 'fields' => [
                        ['name' => 'full_name', 'type' => 'short_text'],
                        ['name' => 'email', 'type' => 'email'],
                    ]],
                ]),
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-orders',
                    'elementType' => 'form',
                    'properties' => ['title' => 'Orders', 'fields' => [
                        ['name' => 'total', 'type' => 'number'],
                    ]],
                ]),
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-rel',
                    'elementType' => 'edge',
                    'properties' => ['edgeType' => 'relation', 'sourceId' => 'el-customers', 'targetId' => 'el-orders', 'cardinality' => '1:N', 'fkField' => 'customer'],
                ]),
            ],
        ]);

        $result = self::$materializer->materialize($this->userId, $blueprint['id']);
        $this->assertCount(2, $result['createdFormIds']);
        $this->assertSame(1, $result['relations']);

        // The app exists with BOTH forms attached.
        $attached = self::$pdo->prepare('SELECT form_id FROM app_forms WHERE app_id = ?');
        $attached->execute([$result['appId']]);
        $this->assertCount(2, $attached->fetchAll());

        // The Orders form carries the sketched field AND the relation's linked_record FK.
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertSame($result['appId'], $snapshot['appId']);
        $byId = array_column($snapshot['elements'], null, 'id');
        $ordersFormId = $byId['el-orders']['resourceRef']['id'] ?? null;
        $customersFormId = $byId['el-customers']['resourceRef']['id'] ?? null;
        $this->assertNotNull($ordersFormId, 'materialisation stamps resourceRefs through the gateway');
        $orders = self::$forms->getForm((string) $ordersFormId);
        $fk = null;
        foreach ($orders['fields'] as $field) {
            if (($field['type'] ?? null) === 'linked_record') {
                $fk = $field;
            }
        }
        $this->assertNotNull($fk, 'the relation edge became a linked_record field');
        $this->assertSame($customersFormId, $fk['properties']['targetFormId'] ?? null);
        $this->assertSame('customer', $fk['id']);

        // Sketched fields landed with slug ids + human labels.
        $customers = self::$forms->getForm((string) $customersFormId);
        $this->assertSame(['full_name', 'email'], array_column($customers['fields'], 'id'));
        $this->assertSame('Full name', $customers['fields'][0]['label']);

        // §11A D4 pull sync: link rows recorded the observed version → fresh reads are
        // 'synced' with the LIVE projection; a changed form reads 'stale'; a deleted
        // one reads 'missing'. Read-only — the diagram itself never mutates.
        $links = self::$pdo->prepare('SELECT COUNT(*) FROM blueprint_resource_links WHERE blueprint_id = ?');
        $links->execute([$blueprint['id']]);
        $this->assertSame(2, (int) $links->fetchColumn());
        $byId = array_column(self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements'], null, 'id');
        $this->assertSame('synced', $byId['el-orders']['sync']['state'] ?? null);
        $this->assertSame('Orders', $byId['el-orders']['sync']['title'] ?? null);

        // §11A D5: with nothing new sketched, applying refuses (and mutates nothing).
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected a nothing-new refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Nothing new to apply', $e->getMessage());
        }
        self::$pdo->prepare("UPDATE forms SET updated_at = '2030-01-01 00:00:00' WHERE id = ?")
            ->execute([$ordersFormId]);
        $byId = array_column(self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements'], null, 'id');
        $this->assertSame('stale', $byId['el-orders']['sync']['state'] ?? null);
        self::$forms->deleteForm((string) $customersFormId);
        $byId = array_column(self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements'], null, 'id');
        $this->assertSame('missing', $byId['el-customers']['sync']['state'] ?? null);

        // A delta over a MISSING linked resource refuses loudly (fix the sketch first).
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected a missing-resource refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('no longer exists', $e->getMessage());
        }
    }

    public function testLinkedDiagramAppliesDeltasOntoTheSameApp(): void
    {
        $blueprint = self::$blueprints->createBlueprint($this->userId, ['name' => 'Delta app']);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-a',
                    'elementType' => 'form',
                    'properties' => ['title' => 'Projects', 'fields' => [['name' => 'name', 'type' => 'short_text']]],
                ]),
            ],
        ]);
        $first = self::$materializer->materialize($this->userId, $blueprint['id']);
        $this->assertSame('created', $first['mode']);

        // Keep sketching on the LINKED diagram: a new entity + a relation to it.
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => $snapshot['semanticRevision'],
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-b',
                    'elementType' => 'form',
                    'properties' => ['title' => 'Tasks', 'fields' => [['name' => 'title', 'type' => 'short_text']]],
                ]),
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-rel',
                    'elementType' => 'edge',
                    'properties' => ['edgeType' => 'relation', 'sourceId' => 'el-a', 'targetId' => 'el-b', 'cardinality' => '1:N', 'fkField' => 'project'],
                ]),
            ],
        ]);

        $delta = self::$materializer->materialize($this->userId, $blueprint['id']);
        $this->assertSame('delta', $delta['mode']);
        $this->assertSame($first['appId'], $delta['appId'], 'deltas land on the SAME app');
        $this->assertCount(1, $delta['createdFormIds']);
        $this->assertSame(1, $delta['relations']);

        // The new form attached to the existing app and carries the relation FK.
        $attached = self::$pdo->prepare('SELECT COUNT(*) FROM app_forms WHERE app_id = ?');
        $attached->execute([$first['appId']]);
        $this->assertSame(2, (int) $attached->fetchColumn());
        $tasks = self::$forms->getForm($delta['createdFormIds'][0]);
        $fk = null;
        foreach ($tasks['fields'] as $field) {
            if (($field['type'] ?? null) === 'linked_record') {
                $fk = $field;
            }
        }
        $this->assertNotNull($fk);

        // Re-applying is idempotent: the relation already exists → nothing new.
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected a nothing-new refusal on re-apply');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Nothing new to apply', $e->getMessage());
        }

        // Concept FLOW + a 'triggers' edge from the form: the delta creates a real stub
        // flow in the app and a form.submitted binding wiring them (idempotent too).
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => $snapshot['semanticRevision'],
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-flow',
                    'elementType' => 'flow',
                    'properties' => ['title' => 'Project intake'],
                ]),
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-trig',
                    'elementType' => 'edge',
                    'properties' => ['edgeType' => 'triggers', 'sourceId' => 'el-a', 'targetId' => 'el-flow'],
                ]),
            ],
        ]);
        $flowDelta = self::$materializer->materialize($this->userId, $blueprint['id']);
        $this->assertCount(1, $flowDelta['createdFlowIds']);
        $this->assertSame(1, $flowDelta['bindings']);
        $flowRow = self::$pdo->prepare('SELECT app_id, enabled FROM flow_definitions WHERE id = ?');
        $flowRow->execute([$flowDelta['createdFlowIds'][0]]);
        $flow = $flowRow->fetch();
        $this->assertSame($first['appId'], $flow['app_id'], 'the stub flow lives in the SAME app');
        $binding = self::$pdo->prepare(
            "SELECT COUNT(*) FROM app_flow_bindings WHERE app_id = ? AND flow_definition_id = ? AND event_name = 'form.submitted'"
        );
        $binding->execute([$first['appId'], $flowDelta['createdFlowIds'][0]]);
        $this->assertSame(1, (int) $binding->fetchColumn());
        // The flow element's resourceRef stamped through the gateway.
        $byId = array_column(self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements'], null, 'id');
        $this->assertSame($flowDelta['createdFlowIds'][0], $byId['el-flow']['resourceRef']['id'] ?? null);
        // Re-apply: flow exists, binding exists → nothing new again.
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected a nothing-new refusal after the flow delta');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Nothing new to apply', $e->getMessage());
        }
    }

    public function testEmptyDiagramAndForeignFormRefsRefuseCleanly(): void
    {
        $blueprint = self::$blueprints->createBlueprint($this->userId, ['name' => 'Empty']);
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected an empty-diagram refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('at least one form', $e->getMessage());
        }

        // A placed form that belongs to SOMEONE ELSE refuses before creating anything.
        $otherId = 'bp-mz-other-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Other')")
            ->execute([$otherId, "{$otherId}@test.local"]);
        $foreign = self::$forms->createForm(['userId' => $otherId, 'title' => 'Not yours', 'fields' => []]);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-f',
                    'elementType' => 'form',
                    'resourceRef' => ['kind' => 'form', 'id' => $foreign['id']],
                    'properties' => ['title' => 'Not yours'],
                ]),
            ],
        ]);
        $appsBefore = self::$pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn();
        try {
            self::$materializer->materialize($this->userId, $blueprint['id']);
            $this->fail('expected a foreign-form refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString("isn't yours", $e->getMessage());
        }
        $this->assertSame($appsBefore, self::$pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn(), 'nothing was created');
    }
}
