<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AdminController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AdminService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\RuntimeEngineService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The site client-engine policy against the real store: what a missing or corrupt row falls back
 * to, what a write refuses, that the policy and its audit row commit together, and that the
 * installed-engine record is read from the native runtime's provenance and fails closed.
 */
class RuntimeEnginePolicyTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AuthService $auth;
    private static AdminService $admin;
    private static string $tmpRoot = '';

    private string $adminId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$admin = new AdminService($conn);
        self::$auth = new AuthService($conn, ['secret' => 'engine-policy-test-secret-0123456789abcdef', 'algorithm' => 'HS256']);
        self::$tmpRoot = sys_get_temp_dir() . '/fl-engine-policy-' . bin2hex(random_bytes(6));
        mkdir(self::$tmpRoot, 0700, true);
    }

    public static function tearDownAfterClass(): void
    {
        foreach (glob(self::$tmpRoot . '/*') ?: [] as $file) {
            unlink($file);
        }
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) {
            rmdir(self::$tmpRoot);
        }
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->clearPolicy();
        $this->adminId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
            ->execute([$this->adminId, $this->adminId . '@test.local', password_hash('admin-pass-123', PASSWORD_DEFAULT)]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        $this->clearPolicy();
        self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$this->adminId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->adminId]);
    }

    private function clearPolicy(): void
    {
        self::$pdo->prepare('DELETE FROM system_meta WHERE meta_key = ?')->execute([RuntimeEngineService::POLICY_KEY]);
    }

    private function engines(?array $advertised = null): RuntimeEngineService
    {
        $path = null;
        if ($advertised !== null) {
            $path = self::$tmpRoot . '/provenance-' . bin2hex(random_bytes(4)) . '.json';
            file_put_contents($path, json_encode($advertised));
        }
        return new RuntimeEngineService(self::$mysql, $path);
    }

    private function audit(): AuditService
    {
        return new AuditService(self::$mysql, null, 'engine-policy-test-audit-key');
    }

    private function controller(?RuntimeEngineService $engines = null, ?AuditService $audit = null): AdminController
    {
        return new AdminController(
            self::$admin,
            self::$auth,
            new MaintenanceService(self::$tmpRoot . '/maintenance-' . bin2hex(random_bytes(3)) . '.json'),
            new \FormLogic\Services\UpgradeService(self::$tmpRoot . '/nowhere', self::$mysql, new MaintenanceService(self::$tmpRoot . '/m2.json')),
            $this->createMock(\FormLogic\Services\FormService::class),
            $this->createMock(\FormLogic\Services\AppService::class),
            $this->createMock(\FormLogic\Services\FlowService::class),
            $this->createMock(\FormLogic\Services\ResponseService::class),
            $audit ?? $this->audit(),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            $engines ?? $this->engines(),
        );
    }

    private function request(string $method, ?array $body = null): ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, '/api/admin/engine-policy', ['REMOTE_ADDR' => '203.0.113.7'])
            ->withAttribute('userId', $this->adminId);
        return $body === null ? $req : $req->withParsedBody($body);
    }

    private function json(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    // ── the stored policy ────────────────────────────────────────────────────

    public function testAMissingPolicyRowReadsAsWebPythonOnly(): void
    {
        $this->assertSame(RuntimeEngineService::defaults(), $this->engines()->readPolicy());
    }

    public function testACorruptPolicyRowReadsAsWebPythonOnly(): void
    {
        foreach (['not json at all', '{"default":"host-js","allowed":["host-js"]}', '[]', '{"default":"zipp-web","allowed":["zipp-web"]}'] as $raw) {
            self::$pdo->prepare('INSERT INTO system_meta (meta_key, meta_value) VALUES (:k, :v) ON DUPLICATE KEY UPDATE meta_value = :v2')
                ->execute(['k' => RuntimeEngineService::POLICY_KEY, 'v' => $raw, 'v2' => $raw]);
            $this->assertSame(RuntimeEngineService::defaults(), $this->engines()->readPolicy(), $raw);
        }
    }

    public function testWritePolicyStoresItAndBumpsTheRevisionEachTime(): void
    {
        $engines = $this->engines();
        $first = $engines->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'host-js']]);
        $this->assertSame(1, $first['revision']);
        $this->assertSame(['zipp-web-python', 'host-js'], $first['allowed']);
        $second = $engines->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python']]);
        $this->assertSame(2, $second['revision'], 'the revision is the server\'s, and only goes up');
        $this->assertSame($second, $this->engines()->readPolicy());
    }

    public function testWritePolicyRefusesAPolicyThatWouldLeaveAppsWithoutAFallback(): void
    {
        $engines = $this->engines();
        foreach ([
            ['default' => 'zipp-web', 'allowed' => ['zipp-web']],
            ['default' => 'host-js', 'allowed' => ['zipp-web-python', 'host-js']],
            ['default' => 'zipp-web', 'allowed' => ['zipp-web-python']],
        ] as $bad) {
            try {
                $engines->writePolicy($bad);
                $this->fail('accepted ' . json_encode($bad));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        $this->assertSame(RuntimeEngineService::defaults(), $engines->readPolicy(), 'nothing was stored');
    }

    // ── what the install advertises ──────────────────────────────────────────

    public function testTheInstalledEnginesComeFromTheNativeProvenanceAndFailClosed(): void
    {
        // The live tree's own record today: no hostedRuntime at all.
        $this->assertSame(['zipp-web-python'], $this->engines(['source' => 'softn', 'release' => ['tag' => 'v0.0.15-local']])->installedEngines());
        // A record that advertises engines is believed.
        $this->assertSame(
            ['zipp-web-python', 'host-js'],
            $this->engines(['hostedRuntime' => ['engines' => ['host-js', 'zipp-web-python']]])->installedEngines()
        );
        // No provenance file at all.
        $this->assertSame(['zipp-web-python'], (new RuntimeEngineService(self::$mysql, self::$tmpRoot . '/absent.json'))->installedEngines());
    }

    public function testTheDefaultProvenancePathIsTheInstalledNativeRuntimeRecord(): void
    {
        // Not a fixture: the record the fetch stamped from the archive this tree actually
        // installed. It advertises the fallback and host JavaScript, because the hosted runtime
        // ships the second entry document (host.html) that serves the latter. zipp-web is a real
        // id no runtime serves, so it stays absent here and resolves with reason 'not-installed'.
        $installed = (new RuntimeEngineService(self::$mysql))->installedEngines();
        $this->assertSame(['zipp-web-python', 'host-js'], $installed);
        $this->assertNotContains('zipp-web', $installed);
    }

    // ── the admin endpoints ──────────────────────────────────────────────────

    public function testGetEnginePolicyReturnsThePolicyTheInstallAndTheKnownIds(): void
    {
        $response = $this->controller()->getEnginePolicy($this->request('GET'), (new ResponseFactory())->createResponse());
        $body = $this->json($response);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(RuntimeEngineService::defaults(), $body['policy']);
        // What the install serves, against every id the server knows: an administrator's
        // allow-list can only ever take effect for an engine that is in both.
        $this->assertSame(['zipp-web-python', 'host-js'], $body['installed']);
        $this->assertSame(['zipp-web-python', 'zipp-web', 'host-js'], $body['engines']);
    }

    public function testPutEnginePolicyStoresItAndRecordsTheChange(): void
    {
        $response = $this->controller()->putEnginePolicy(
            $this->request('PUT', ['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'host-js'], 'hostJsRequireWorker' => false]),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['zipp-web-python', 'host-js'], $this->json($response)['policy']['allowed']);

        $row = $this->auditRow('admin.engine_policy_update');
        $this->assertNotNull($row, 'the policy change is audited');
        $details = json_decode((string) $row['details'], true);
        $this->assertSame(['zipp-web-python'], $details['previous']['allowed']);
        $this->assertSame(['zipp-web-python', 'host-js'], $details['next']['allowed']);
        $this->assertSame($this->adminId, $row['user_id']);
    }

    public function testPutEnginePolicyRefusesAnInvalidPolicyWithoutChangingAnything(): void
    {
        $response = $this->controller()->putEnginePolicy(
            $this->request('PUT', ['default' => 'zipp-web', 'allowed' => ['zipp-web']]),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('cannot be removed', $this->json($response)['message']);
        $this->assertSame(RuntimeEngineService::defaults(), $this->engines()->readPolicy());
        $this->assertNull($this->auditRow('admin.engine_policy_update'));
    }

    public function testAPolicyChangeThatCannotBeRecordedIsNotStored(): void
    {
        $failing = new class (self::$mysql) extends AuditService {
            public function __construct(MySQLConnection $mysql)
            {
                parent::__construct($mysql, null, 'engine-policy-test-audit-key');
            }

            public function logStrict(string $action, string $resourceType, ?string $resourceId, ?string $userId, ?string $ipAddress, array $details = []): void
            {
                throw new \RuntimeException('audit store is down');
            }
        };
        $response = $this->controller(null, $failing)->putEnginePolicy(
            $this->request('PUT', ['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'host-js']]),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(503, $response->getStatusCode());
        $this->assertSame(RuntimeEngineService::defaults(), $this->engines()->readPolicy(), 'the policy rolled back with its audit row');
    }

    private function auditRow(string $action): ?array
    {
        $stmt = self::$pdo->prepare('SELECT user_id, details FROM audit_log WHERE action = ? AND user_id = ? ORDER BY sequence_number DESC LIMIT 1');
        $stmt->execute([$action, $this->adminId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }
}
