<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\BlueprintMaterializeService;
use FormLogic\Services\BlueprintService;
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
        self::$materializer = new BlueprintMaterializeService($conn, self::$blueprints, self::$forms, self::$apps);
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

        // Once linked, materialising again refuses (deltas are D5).
        $this->expectException(\InvalidArgumentException::class);
        self::$materializer->materialize($this->userId, $blueprint['id']);
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
