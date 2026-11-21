<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordEventRouter;
use FormLogic\Services\NativeRecordStore;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ReportService;
use PDO;
use PHPUnit\Framework\TestCase;

final class SharedDatabaseAndCrossAppTest extends TestCase
{
    private string $tempDir;

    protected function setUp(): void
    {
        $this->tempDir = sys_get_temp_dir() . '/fl-shared-db-' . bin2hex(random_bytes(6));
        mkdir($this->tempDir, 0700, true);
    }

    protected function tearDown(): void
    {
        if (is_dir($this->tempDir)) {
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($this->tempDir, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($it as $entry) {
                if ($entry->isLink() || !$entry->isDir()) @unlink($entry->getPathname());
                else @rmdir($entry->getPathname());
            }
            @rmdir($this->tempDir);
        }
    }

    private function createInMemoryMetadataPdo(string $ownerId, string $appId, string $formId, array $binding): PDO
    {
        $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, settings TEXT)');
        $pdo->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $pdo->prepare('INSERT INTO apps (id, owner_id) VALUES (?, ?)')->execute([$appId, $ownerId]);
        $pdo->prepare('INSERT INTO forms (id, user_id, settings) VALUES (?, ?, ?)')->execute([
            $formId,
            $ownerId,
            json_encode(['nativeTableBinding' => $binding], JSON_THROW_ON_ERROR),
        ]);
        return $pdo;
    }

    private function seedNativeAppDb(NativeAppService $native, string $appId): void
    {
        $hash = hash('sha256', $appId);
        $root = $this->tempDir . '/' . $hash;
        mkdir($root . '/private/data', 0700, true);
        mkdir($root . '/app', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'version' => 1,
            'home' => true,
            'access' => 'members',
            'files' => [
                'manifest.json' => json_encode([
                    'id' => 'test.primary',
                    'version' => '1.0.0',
                    'main' => 'index.html',
                    'backend' => ['runtime' => 'php', 'entry' => 'backend/index.php'],
                ]),
                'index.html' => '<h1>Primary</h1>',
                'backend/index.php' => '<?php echo "ok";',
            ],
            'assets' => [],
        ], JSON_THROW_ON_ERROR));
        file_put_contents($root . '/private/config.json', json_encode([
            'appId' => 'test.primary',
            'development' => false,
            'keyHex' => str_repeat('a', 64),
            'capabilities' => ['sql'],
            'cryptoDomains' => ['hmac' => 'test:hmac', 'seal' => 'test:seal'],
            'enableHostContext' => true,
            'containerPrimaryDatabase' => 'application.sqlite',
        ], JSON_THROW_ON_ERROR));

        $db = new PDO('sqlite:' . $root . '/private/data/application.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $db->exec('CREATE TABLE work_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL, cost REAL NOT NULL, api_key TEXT, created_at TEXT NOT NULL)');
        $db->exec("INSERT INTO work_orders (title, status, cost, api_key, created_at) VALUES
            ('Fix roof leak', 'open', 450.5, 'secret-1', '2026-11-01 09:00:00'),
            ('Paint lobby', 'done', 1200.0, 'secret-2', '2026-11-02 10:00:00'),
            ('Replace valve', 'open', 300.0, 'secret-3', '2026-11-03 11:00:00')");
        $db = null;
    }

    public function testSharedDatabaseLinkAndBridgeCrudAndCharts(): void
    {
        $native = new NativeAppService($this->tempDir);
        $this->seedNativeAppDb($native, 'app-primary');

        // Link a secondary app to app-primary's SQLite database.
        $native->setSharedDatabaseLink('app-secondary', 'app-primary');
        $this->assertSame('app-primary', $native->sharedDatabaseAppId('app-secondary'));
        $this->assertSame('app-primary', $native->databaseAppId('app-secondary'));

        // Chained linking is refused.
        try {
            $native->setSharedDatabaseLink('app-third', 'app-secondary');
            $this->fail('Expected chained shared-database link to throw');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('primary database app', $e->getMessage());
        }

        // Secondary app sees primary app's tables & rows through NativeAppService::records().
        $tablesRes = $native->records('app-secondary');
        $this->assertSame(['work_orders'], $tablesRes['tables']);
        $this->assertSame('app-primary', $tablesRes['sharedDatabaseAppId']);

        // Build FormLogic form definition from work_orders schema (must hide api_key!).
        $schemas = $native->tableSchemas('app-primary');
        $def = NativeTableFormBridge::buildFormDefinitionFromTable('app-primary', 'work_orders', $schemas['work_orders']);
        $colNames = array_values($def['binding']['columns']);
        $this->assertContains('title', $colNames);
        $this->assertContains('status', $colNames);
        $this->assertContains('cost', $colNames);
        $this->assertNotContains('api_key', $colNames);

        // Bridge CRUD on the bound Form directly mutates app-primary's SQLite DB!
        $pdo = $this->createInMemoryMetadataPdo('owner-1', 'app-primary', 'form-wo', $def['binding']);
        $bridge = new NativeTableFormBridge($pdo, $native);
        $binding = $bridge->resolveBinding('form-wo');
        $this->assertNotNull($binding);
        $this->assertSame(3, $bridge->countResponses($binding));

        $list = $bridge->listResponses($binding);
        $this->assertCount(3, $list);
        $this->assertSame('Fix roof leak', $list[0]['answers']['title']);
        $this->assertArrayNotHasKey('api_key', $list[0]['answers']);

        // Create through the Form -> appears in SQLite!
        $created = $bridge->createResponse($binding, [
            'answers' => ['title' => 'Inspect boiler', 'status' => 'open', 'cost' => 199.5, 'created_at' => '2026-11-04 12:00:00'],
        ]);
        $this->assertSame('Inspect boiler', $created['answers']['title']);
        $this->assertSame(4, $bridge->countResponses($binding));

        // Update through the Form!
        $updated = $bridge->updateResponse($binding, (string) $created['id'], [
            'answers' => ['status' => 'done'],
        ]);
        $this->assertNotNull($updated);
        $this->assertSame('done', $updated['answers']['status']);

        // Charts & KPIs via ReportService run directly on the live SQLite table!
        $sqliteConn = new SQLiteConnection($this->tempDir . '/forms-db');
        $reports = new ReportService($sqliteConn, null, $pdo, $native);

        $kpiCount = $reports->runReport(['viz' => 'kpi', 'measure' => ['fn' => 'count']], $def['fields'], 'form-wo', 'all', 'owner-1');
        $this->assertSame(4.0, $kpiCount['value']);

        $kpiSum = $reports->runReport(['viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => 'cost']], $def['fields'], 'form-wo', 'all', 'owner-1');
        $this->assertEqualsWithDelta(2150.0, $kpiSum['value'], 0.01);

        $bar = $reports->runReport(
            ['viz' => 'bar', 'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count']],
            $def['fields'],
            'form-wo',
            'all',
            'owner-1'
        );
        $byLabel = array_column($bar['series'], 'value', 'label');
        $this->assertSame(2.0, $byLabel['open']);
        $this->assertSame(2.0, $byLabel['done']);

        // Delete through the Form!
        $this->assertTrue($bridge->deleteResponse($binding, (string) $created['id']));
        $this->assertSame(3, $bridge->countResponses($binding));

        // Cross-owner isolation: a form owned by another user resolves to null.
        $pdo->prepare("UPDATE forms SET user_id = 'other-user' WHERE id = 'form-wo'")->execute();
        $this->assertNull($bridge->resolveBinding('form-wo'));
    }

    public function testSecondarySoftnApiBackendReadsAndWritesSharedDatabaseEndToEnd(): void
    {
        $native = new NativeAppService($this->tempDir, null, null, 'node');
        if (!$native->available()) {
            $this->markTestSkipped('SoftN native runtime is not prepared in this environment.');
        }
        $this->seedNativeAppDb($native, 'app-primary');

        $schemas = $native->tableSchemas('app-primary');
        $tableCols = [];
        foreach ($schemas as $tbl => $s) {
            $tableCols[$tbl] = array_values(array_map(static fn(array $f): string => (string) $f['name'], $s['fields']));
        }
        $native->setSharedDatabaseLink('app-api', 'app-primary');
        $starter = NativeAppService::sharedApiBackendStarter('Maintenance API', 'app-api', $tableCols);
        $installed = $native->install('app-api', $starter, 0);
        $this->assertSame(1, $installed['version']);

        // Read rows from app-primary's live SQLite DB via app-api's .logic backend!
        $readRes = $native->request('app-api', [
            'method' => 'GET',
            'path' => '/api/records',
            'query' => (object) ['table' => 'work_orders', 'limit' => '10'],
            'body' => (object) [],
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''],
            'client_ip' => '127.0.0.1',
            'photos' => false,
        ]);
        $this->assertSame(200, $readRes['status']);
        $this->assertSame(3, $readRes['body']['count']);
        $this->assertArrayNotHasKey('api_key', $readRes['body']['records'][0]);

        // Write a row via app-api and verify it lands in app-primary's DB AND fires a record event!
        $writeRes = $native->request('app-api', [
            'method' => 'POST',
            'path' => '/api/records',
            'query' => (object) [],
            'body' => [
                'table' => 'work_orders',
                'values' => ['title' => 'External API Job', 'status' => 'open', 'cost' => 99.0, 'created_at' => '2026-11-05 12:00:00'],
            ],
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''],
            'client_ip' => '127.0.0.1',
            'photos' => false,
        ], [], [['event' => 'app.record.created.work_orders', 'bindings' => ['bind-1']]]);
        $this->assertSame(201, $writeRes['status']);

        $dispatched = [];
        $count = $native->dispatchRecordEvents('app-primary', static function (string $id, string $event, array $data, array $bindings) use (&$dispatched): void {
            $dispatched[] = ['event' => $event, 'record' => $data['record'] ?? [], 'bindings' => $bindings];
        });
        $this->assertSame(1, $count);
        $this->assertSame('app.record.created.work_orders', $dispatched[0]['event']);
        $this->assertSame('External API Job', $dispatched[0]['record']['title']);
        $this->assertArrayNotHasKey('api_key', $dispatched[0]['record']);
    }

    public function testBackendFlowTriggerExtractionAndCloudEligibility(): void
    {
        $headerRes = NativeRecordEventRouter::extractContainerTriggers([
            ['Content-Type', 'application/json'],
            ['X-FormLogic-Trigger-Flow', 'notify-team, sync-crm'],
            ['X-FormLogic-Trigger-Input', '{"orderId":42}'],
            ['X-FormLogic-Trigger-App', 'app-target'],
        ]);
        $this->assertSame([['Content-Type', 'application/json']], $headerRes['headers']);
        $this->assertCount(2, $headerRes['triggers']);
        $this->assertSame('notify-team', $headerRes['triggers'][0]['flow']);
        $this->assertSame(['orderId' => 42], $headerRes['triggers'][0]['inputs']);
        $this->assertSame('app-target', $headerRes['triggers'][0]['appId']);

        $bodyRes = NativeRecordEventRouter::extractBodyTriggers([
            'ok' => true,
            '__formlogicTriggerFlows' => [
                ['flow' => 'dispatch-job', 'inputs' => ['id' => 7]],
            ],
        ]);
        $this->assertSame(['ok' => true], $bodyRes['body']);
        $this->assertCount(1, $bodyRes['triggers']);
        $this->assertSame('dispatch-job', $bodyRes['triggers'][0]['flow']);

        $graph = [
            'nodes' => [
                ['id' => 'in', 'type' => 'input', 'data' => []],
                ['id' => 'call', 'type' => 'native_app_request', 'data' => ['appId' => 'app-a', 'method' => 'GET', 'path' => '/api/health']],
                ['id' => 'db', 'type' => 'native_record_action', 'data' => ['appId' => 'app-b', 'table' => 'orders', 'operation' => 'list']],
                ['id' => 'out', 'type' => 'output', 'data' => []],
            ],
            'edges' => [
                ['source' => 'in', 'target' => 'call'],
                ['source' => 'call', 'target' => 'db'],
                ['source' => 'db', 'target' => 'out'],
            ],
        ];
        $this->assertSame([], CloudFlowRunner::validateCloudEligible($graph));
    }

    public function testContainerBackendEmitsRecordEventsAndSharesDatabase(): void
    {
        $native = new NativeAppService($this->tempDir, null, null, 'node');
        if (!$native->available()) {
            $this->markTestSkipped('SoftN native runtime is not prepared in this environment.');
        }
        $this->seedNativeAppDb($native, 'app-primary');

        // Install a secondary PHP container backend linked to app-primary's shared SQLite database!
        $native->setSharedDatabaseLink('app-php-api', 'app-primary');
        $phpManifest = [
            'id' => 'test.php.shared',
            'name' => 'Shared PHP API',
            'version' => '1.0.0',
            'engine' => 2,
            'main' => 'index.html',
            'backend' => [
                'runtime' => 'php',
                'entry' => 'backend/index.php',
                'routes' => ['/api'],
            ],
            'databases' => [
                ['name' => 'main', 'file' => 'application.sqlite'],
            ],
        ];
        $phpCode = <<<'PHP'
<?php
header('Content-Type: application/json');
$pdo = new PDO('sqlite:application.sqlite');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $data = json_decode(file_get_contents('php://input') ?: '{}', true);
    $stmt = $pdo->prepare('INSERT INTO work_orders (title, status, cost, api_key, created_at) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$data['title'] ?? 'Untitled', 'open', 55.0, 'top-secret', '2026-11-06 08:00:00']);
    header('X-FormLogic-Trigger-Flow: notify-ops');
    echo json_encode(['ok' => true, 'user' => $_SERVER['HTTP_X_FORMLOGIC_USER_ID'] ?? null]);
    exit;
}
$rows = $pdo->query('SELECT id, title, status FROM work_orders ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
echo json_encode(['count' => count($rows), 'rows' => $rows]);
PHP;
        $installed = $native->install('app-php-api', [
            'home' => true,
            'access' => 'members',
            'files' => [
                'manifest.json' => json_encode($phpManifest, JSON_THROW_ON_ERROR),
                'index.html' => '<h1>PHP API</h1>',
                'backend/index.php' => $phpCode,
            ],
            'assets' => [],
        ], 0);
        $this->assertSame(1, $installed['version']);

        // 1. Read app-primary's SQLite rows from the PHP container backend!
        $getRes = $native->containerRequest('app-php-api', [
            'method' => 'GET',
            'path' => '/api/orders',
            'query' => '',
            'headers' => (object) [],
            'bodyBase64' => '',
            'client_ip' => '127.0.0.1',
        ], ['formlogic' => ['appId' => 'app-php-api', 'userId' => 'owner-99', 'roleId' => 'owner']]);
        $this->assertSame(200, $getRes['status']);
        $getBody = json_decode((string) base64_decode($getRes['bodyBase64'], true), true);
        $this->assertSame(3, $getBody['count']);

        // 2. Write a row from the PHP container backend with an active subscription -> captures diff event + receives userId header!
        $postRes = $native->containerRequest('app-php-api', [
            'method' => 'POST',
            'path' => '/api/orders',
            'query' => '',
            'headers' => (object) ['content-type' => 'application/json'],
            'bodyBase64' => base64_encode(json_encode(['title' => 'PHP Shared Job'], JSON_THROW_ON_ERROR)),
            'client_ip' => '127.0.0.1',
        ], ['formlogic' => ['appId' => 'app-php-api', 'userId' => 'owner-99', 'roleId' => 'owner']], null, [
            ['event' => 'app.record.created.work_orders', 'bindings' => ['bind-php-1']],
        ]);
        $this->assertSame(200, $postRes['status']);
        $postBody = json_decode((string) base64_decode($postRes['bodyBase64'], true), true);
        $this->assertSame('owner-99', $postBody['user']);

        // Verify trigger header extraction!
        $extracted = NativeRecordEventRouter::extractContainerTriggers($postRes['headers']);
        $this->assertCount(1, $extracted['triggers']);
        $this->assertSame('notify-ops', $extracted['triggers'][0]['flow']);

        // Verify record event landed in app-primary's _formlogic_record_events outbox with api_key redacted!
        $dispatched = [];
        $count = $native->dispatchRecordEvents('app-primary', static function (string $id, string $event, array $data, array $bindings) use (&$dispatched): void {
            $dispatched[] = ['event' => $event, 'record' => $data['record'] ?? [], 'bindings' => $bindings];
        });
        $this->assertSame(1, $count);
        $this->assertSame('app.record.created.work_orders', $dispatched[0]['event']);
        $this->assertSame('PHP Shared Job', $dispatched[0]['record']['title']);
        $this->assertArrayNotHasKey('api_key', $dispatched[0]['record']);
    }
}
