<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/** Real SoftN v2 Container (PHP 8.4 + SQLite in ZIPP WASM) integration through NativeAppService. */
final class NativeContainerBackendTest extends TestCase
{
    private string $storage;
    private NativeAppService $service;

    protected function setUp(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $node = getenv('FORMLOGIC_NODE_BIN') ?: 'node';
        if (!is_file($runtime . '/runner.mjs') || !is_file($runtime . '/container-backend.mjs')) {
            $this->markTestSkipped('SoftN v0.0.49 native runtime with container-backend.mjs is required.');
        }
        $this->storage = sys_get_temp_dir() . '/formlogic-container-test-' . bin2hex(random_bytes(10));
        mkdir($this->storage, 0700);
        $this->service = new NativeAppService($this->storage, $runtime, $node);
    }

    protected function tearDown(): void
    {
        if (!isset($this->storage) || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-container-test-')) {
            throw new \RuntimeException('Unexpected fixture path');
        }
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iterator as $file) {
            if ($file->isLink()) unlink($file->getPathname());
            elseif ($file->isDir()) rmdir($file->getPathname());
            else unlink($file->getPathname());
        }
        rmdir($root);
    }

    private function phpContainerProject(): array
    {
        $php = <<<'PHP'
<?php
header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$ctx = json_decode(getenv('SOFTN_HOST_CONTEXT') ?: '{}', true) ?: [];
$dbPath = getenv('SOFTN_DB_PATH') ?: 'data/app.db';
$pdo = new PDO('sqlite:' . $dbPath);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

if ($method === 'GET' && $path === '/api/items') {
    $rows = $pdo->query('SELECT id, title, created_by FROM items ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode([
        'items' => $rows,
        'caller' => $ctx['userId'] ?? null,
        'role' => $ctx['userRole'] ?? null,
    ]);
    exit;
}

if ($method === 'POST' && $path === '/api/items') {
    $input = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $title = trim((string) ($input['title'] ?? ''));
    $stmt = $pdo->prepare('INSERT INTO items (title, created_by) VALUES (?, ?)');
    $stmt->execute([$title, (string) ($ctx['userId'] ?? 'anon')]);
    $id = (int) $pdo->lastInsertId();
    http_response_code(201);
    echo json_encode([
        'id' => $id,
        'title' => $title,
        'created_by' => $ctx['userId'] ?? 'anon',
    ]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'not found', 'path' => $path]);
PHP;

        return [
            'access' => 'members',
            'assets' => [],
            'files' => [
                'manifest.json' => json_encode([
                    'id' => 'test.php-orders',
                    'name' => 'Orders Desk',
                    'version' => '1.0.0',
                    'engine' => 2,
                    'main' => 'index.html',
                    'backend' => [
                        'runtime' => 'php',
                        'entry' => 'backend/index.php',
                        'mode' => 'api',
                        'routes' => ['/api/'],
                    ],
                    'databases' => [[
                        'name' => 'app',
                        'engine' => 'sqlite',
                        'file' => 'data/app.db',
                        'seedSql' => 'backend/schema.sql',
                        'persist' => true,
                    ]],
                ], JSON_THROW_ON_ERROR),
                'index.html' => '<!doctype html><html><body><h1>Orders Desk</h1></body></html>',
                'backend/schema.sql' => "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_by TEXT NOT NULL);\nINSERT INTO items (title, created_by) VALUES ('Seed Order', 'seed');\n",
                'backend/index.php' => $php,
            ],
        ];
    }

    public function testClientFilesStripPrivatePhpBackendAndPreserveContainerRouting(): void
    {
        $project = $this->phpContainerProject();
        $this->assertTrue(NativeAppService::hasContainerBackend($project));
        $this->assertTrue(NativeAppService::hasBackend($project));

        $client = NativeAppService::clientFiles($project);
        $this->assertArrayHasKey('index.html', $client);
        $this->assertArrayNotHasKey('backend/index.php', $client);
        $this->assertArrayNotHasKey('backend/schema.sql', $client);

        $manifest = json_decode($client['manifest.json'], true, 512, JSON_THROW_ON_ERROR);
        $this->assertTrue($manifest['container'] ?? false);
        $this->assertArrayNotHasKey('databases', $manifest);
        $this->assertSame('php', $manifest['backend']['runtime'] ?? null);
        $this->assertSame(['/api/'], $manifest['backend']['routes'] ?? null);
        $this->assertArrayNotHasKey('entry', $manifest['backend']);
    }

    public function testInstallSeedsSqliteAndDispatchesVerifiedPhpContainerRequests(): void
    {
        $installed = $this->service->install('orders', $this->phpContainerProject(), 0);
        $this->assertSame(1, $installed['version']);

        // Seeded SQLite database must already be browsable via FormLogic's native records service.
        $initial = $this->service->records('orders', 'items');
        $this->assertContains('items', $initial['tables']);
        $this->assertCount(1, $initial['rows']);
        $this->assertSame('Seed Order', $initial['rows'][0]['title']);

        // POST /api/items through the real ZIPP PHP 8.4 WASM sandbox with verified identity.
        $create = $this->service->containerRequest('orders', [
            'method' => 'POST',
            'path' => '/api/items',
            'query' => '',
            'headers' => [['content-type', 'application/json']],
            'bodyBase64' => base64_encode(json_encode(['title' => 'Espresso Machine'], JSON_THROW_ON_ERROR)),
        ], [
            'userId' => 'user-42',
            'userRole' => 'admin',
            'email' => 'alex@example.com',
        ], 1);

        $this->assertSame(201, $create['status']);
        $createdBody = json_decode(base64_decode($create['bodyBase64'], true) ?: '', true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame('Espresso Machine', $createdBody['title']);
        $this->assertSame('user-42', $createdBody['created_by']);

        // Subsequent GET must read the persisted row from application.sqlite under verified host context.
        $list = $this->service->containerRequest('orders', [
            'method' => 'GET',
            'path' => '/api/items',
            'query' => '',
            'headers' => [],
            'bodyBase64' => '',
        ], [
            'userId' => 'user-99',
            'userRole' => 'member',
        ], 1);

        $this->assertSame(200, $list['status']);
        $listBody = json_decode(base64_decode($list['bodyBase64'], true) ?: '', true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame('user-99', $listBody['caller']);
        $this->assertSame('member', $listBody['role']);
        $this->assertCount(2, $listBody['items']);
        $this->assertSame('Espresso Machine', $listBody['items'][1]['title']);
        $this->assertSame('user-42', $listBody['items'][1]['created_by']);

        // FormLogic's data browser sees the persisted PHP write directly in private/data/application.sqlite.
        $after = $this->service->records('orders', 'items');
        $this->assertCount(2, $after['rows']);
    }

    /**
     * The runner answers for itself in another shape than a backend does: /api/meta, and every
     * refusal made before the backend ran. Each is the JSON response it says it is.
     */
    public function testTheRunnersOwnAnswerIsServedAsAJsonResponse(): void
    {
        $backend = NativeAppService::containerAnswer('{"status":201,"headers":[["Content-Type","text/plain"]],"bodyBase64":"b2s="}');
        $this->assertSame(['status' => 201, 'headers' => [['Content-Type', 'text/plain']], 'bodyBase64' => 'b2s=', 'own' => false], $backend);

        $busy = NativeAppService::containerAnswer('{"status":503,"body":{"error":"The server is busy. Please retry.","code":"database_busy"}}');
        $this->assertSame(503, $busy['status']);
        $this->assertTrue($busy['own']);
        $this->assertSame([['content-type', 'application/json; charset=utf-8']], $busy['headers']);
        $this->assertSame('{"error":"The server is busy. Please retry.","code":"database_busy"}', base64_decode($busy['bodyBase64'], true));
        // An empty object stays one, and text is sent as it was written.
        $this->assertSame('{"unservedRoutes":{},"note":"café /api"}', base64_decode(NativeAppService::containerAnswer('{"status":200,"body":{"unservedRoutes":{},"note":"café /api"}}')['bodyBase64'], true));

        foreach (['', 'not json', '[]', '{"status":"200","body":{}}', '{"status":200}', '{"status":99,"body":{}}', '{"status":200,"headers":[]}'] as $nothing) {
            $this->assertNull(NativeAppService::containerAnswer($nothing), $nothing);
        }

        // Through the real runner: /api/meta was "returned no response" before.
        $this->service->install('orders', $this->phpContainerProject(), 0);
        $meta = $this->service->containerRequest('orders', ['method' => 'GET', 'path' => '/api/meta', 'query' => '', 'headers' => [], 'bodyBase64' => ''], ['userId' => 'user-1', 'userRole' => 'member'], 1);
        $this->assertSame(200, $meta['status']);
        $this->assertSame(['status', 'headers', 'bodyBase64'], array_keys($meta));
        $said = json_decode(base64_decode($meta['bodyBase64'], true) ?: '', true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame('zipp-wasm-container', $said['runtime']);
        $this->assertSame('php', $said['backendRuntime']);
        $this->assertSame('test.php-orders', $said['appId']);
    }

    public function testValidationRefusesUnsupportedContainerBackendOrBothServerAndBackend(): void
    {
        $badRuntime = $this->phpContainerProject();
        $m = json_decode($badRuntime['files']['manifest.json'], true, 512, JSON_THROW_ON_ERROR);
        $m['backend']['runtime'] = 'ruby';
        $badRuntime['files']['manifest.json'] = json_encode($m, JSON_THROW_ON_ERROR);
        $this->expectException(\InvalidArgumentException::class);
        $this->service->install('bad-runtime', $badRuntime, 0);
    }

    public function testValidationRefusesDeclaringBothServerAndBackend(): void
    {
        $both = $this->phpContainerProject();
        $m = json_decode($both['files']['manifest.json'], true, 512, JSON_THROW_ON_ERROR);
        $m['server'] = ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']]];
        $both['files']['manifest.json'] = json_encode($m, JSON_THROW_ON_ERROR);
        $both['files']['server/main.logic'] = 'function ping() { return { status: 200 }; }';
        $this->expectException(\InvalidArgumentException::class);
        $this->service->install('both-backends', $both, 0);
    }
}
