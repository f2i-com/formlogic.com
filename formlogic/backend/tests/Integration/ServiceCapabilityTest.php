<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ConnectorCommandController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/** Owner-only website capability issuance for the Desktop OpenAI service pilots. */
class ServiceCapabilityTest extends TestCase
{
    private const BASE = 'http://localhost';
    private const SERVICE_ID = 'openai-codex-agent';
    private const SERVICE_GRANTS = [
        'service.openai-codex-agent.status.read',
        'service.openai-codex-agent.models.list',
        'service.openai-codex-agent.assistant.chat',
    ];
    private const OPENAI_API_SERVICE_ID = 'openai-api';
    private const OPENAI_API_GRANTS = [
        'service.openai-api.chat.complete',
        'service.openai-api.models.list',
    ];

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static ConnectorCommandController $controller;

    private string $ownerId = '';
    private string $memberId = '';
    private string $appId = '';
    private string $slug = '';

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
            $connection = new MySQLConnection($config);
            $connection->getConnection()->query('SELECT 1');
            $connection->initializeSchema();
            $connection->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }

        self::$mysql = $connection;
        self::$pdo = $connection->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-service-cap-' . bin2hex(random_bytes(4)));
        $forms = new FormService($connection, $sqlite);
        $apps = new AppService($connection, $forms);
        self::$controller = new ConnectorCommandController(
            new DesktopCommandService($connection),
            $apps,
            new AppUserService($connection),
            $connection
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }

        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        $this->memberId = 'u-' . bin2hex(random_bytes(12));
        foreach ([$this->ownerId, $this->memberId] as $userId) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$userId, $userId . '@test.local']);
        }

        $this->appId = 'app-' . bin2hex(random_bytes(12));
        $this->slug = 'service-cap-' . bin2hex(random_bytes(5));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Service Cap', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);

        $ownerRole = 'role-' . bin2hex(random_bytes(10));
        $memberRole = 'role-' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner', 1, 0)")
            ->execute([$ownerRole, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Member', 0, 1)")
            ->execute([$memberRole, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->ownerId, $ownerRole]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->memberId, $memberRole]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->appId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM connector_capabilities WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->ownerId, $this->memberId] as $userId) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
    }

    /** @return array{status:int,body:array<string,mixed>,cacheControl:string} */
    private function mint(?string $userId, array $body, ?string $slug = null): array
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', self::BASE . '/api/app/' . ($slug ?? $this->slug) . '/service-capability')
            ->withParsedBody($body);
        if ($userId !== null) {
            $request = $request->withAttribute('userId', $userId);
        }
        $response = self::$controller->mintServiceCapability(
            $request,
            (new ResponseFactory())->createResponse(),
            ['slug' => $slug ?? $this->slug]
        );
        return [
            'status' => $response->getStatusCode(),
            'body' => self::decode($response),
            'cacheControl' => $response->getHeaderLine('Cache-Control'),
        ];
    }

    /** @return array{status:int,body:array<string,mixed>,cacheControl:string} */
    private function mintWorkspace(?string $userId, array $body, ?object $principal = null): array
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', self::BASE . '/api/service-capability')
            ->withParsedBody($body);
        if ($userId !== null) {
            $request = $request
                ->withAttribute('userId', $userId)
                ->withAttribute('user', $principal ?? (object) ['id' => $userId]);
        }
        $response = self::$controller->mintWorkspaceServiceCapability(
            $request,
            (new ResponseFactory())->createResponse()
        );
        return [
            'status' => $response->getStatusCode(),
            'body' => self::decode($response),
            'cacheControl' => $response->getHeaderLine('Cache-Control'),
        ];
    }

    /** @return array{status:int,body:array<string,mixed>} */
    private function introspect(string $ownerId, string $token): array
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', self::BASE . '/api/v1/connector-capabilities/' . $token)
            ->withAttribute('userId', $ownerId);
        $response = self::$controller->introspectCapability(
            $request,
            (new ResponseFactory())->createResponse(),
            ['token' => $token]
        );
        return ['status' => $response->getStatusCode(), 'body' => self::decode($response)];
    }

    /** @return array<string,mixed> */
    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        $decoded = json_decode((string) $response->getBody(), true);
        return is_array($decoded) ? $decoded : [];
    }

    private function capabilityCount(): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM connector_capabilities WHERE app_id = ?');
        $stmt->execute([$this->appId]);
        return (int) $stmt->fetchColumn();
    }

    private function workspaceCapabilityCount(): int
    {
        $stmt = self::$pdo->prepare(
            'SELECT COUNT(*) FROM connector_capabilities WHERE owner_user_id = ? AND app_id IS NULL'
        );
        $stmt->execute([$this->ownerId]);
        return (int) $stmt->fetchColumn();
    }

    public function testActiveOwnerMintsOpaqueCapabilityAcceptedByDesktopIntrospection(): void
    {
        $result = $this->mint($this->ownerId, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(200, $result['status'], json_encode($result['body']));
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', (string) ($result['body']['token'] ?? ''));
        $this->assertSame(self::SERVICE_ID, $result['body']['serviceId'] ?? null);
        $this->assertSame(['status.read', 'models.list', 'assistant.chat'], $result['body']['actions'] ?? null);
        $this->assertSame(300, $result['body']['expiresInSeconds'] ?? null);
        $this->assertSame('no-store', $result['cacheControl']);

        $token = (string) $result['body']['token'];
        $stmt = self::$pdo->prepare(
            'SELECT token_hash, owner_user_id, user_id, app_id, connector_id, grants_json
             FROM connector_capabilities WHERE app_id = ?'
        );
        $stmt->execute([$this->appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertIsArray($row);
        $this->assertSame(hash('sha256', $token), $row['token_hash']);
        $this->assertSame($this->ownerId, $row['owner_user_id']);
        $this->assertSame($this->ownerId, $row['user_id']);
        $this->assertSame($this->appId, $row['app_id']);
        $this->assertSame(self::SERVICE_ID, $row['connector_id']);
        $storedGrants = json_decode((string) $row['grants_json'], true);
        $this->assertSame(self::SERVICE_GRANTS, $storedGrants);
        $this->assertNotContains('*', $storedGrants);

        $verified = $this->introspect($this->ownerId, $token);
        $this->assertSame(200, $verified['status'], json_encode($verified['body']));
        $this->assertSame($this->ownerId, $verified['body']['userId'] ?? null);
        $this->assertSame($this->appId, $verified['body']['appId'] ?? null);
        $this->assertSame(self::SERVICE_GRANTS, $verified['body']['grants'] ?? null);
        $this->assertNotContains('*', $verified['body']['grants'] ?? []);
        $this->assertGreaterThan(0, $verified['body']['expiresInSeconds'] ?? 0);
        $this->assertLessThanOrEqual(300, $verified['body']['expiresInSeconds'] ?? 301);

        // Introspection remains bound to the linked Desktop owner's API key.
        $wrongOwner = $this->introspect($this->memberId, $token);
        $this->assertSame(404, $wrongOwner['status']);
    }

    public function testActiveOwnerMintsOpenAiApiCapabilityWithOnlyExactGatewayGrants(): void
    {
        $result = $this->mint($this->ownerId, ['serviceId' => self::OPENAI_API_SERVICE_ID]);
        $this->assertSame(200, $result['status'], json_encode($result['body']));
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', (string) ($result['body']['token'] ?? ''));
        $this->assertSame(self::OPENAI_API_SERVICE_ID, $result['body']['serviceId'] ?? null);
        $this->assertSame(['chat.complete', 'models.list'], $result['body']['actions'] ?? null);
        $this->assertSame(300, $result['body']['expiresInSeconds'] ?? null);
        $this->assertSame('no-store', $result['cacheControl']);

        $token = (string) $result['body']['token'];
        $stmt = self::$pdo->prepare(
            'SELECT connector_id, grants_json FROM connector_capabilities
             WHERE app_id = ? AND token_hash = ?'
        );
        $stmt->execute([$this->appId, hash('sha256', $token)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertIsArray($row);
        $this->assertSame(self::OPENAI_API_SERVICE_ID, $row['connector_id']);
        $storedGrants = json_decode((string) $row['grants_json'], true);
        $this->assertSame(self::OPENAI_API_GRANTS, $storedGrants);
        $this->assertNotContains('*', $storedGrants);

        $verified = $this->introspect($this->ownerId, $token);
        $this->assertSame(200, $verified['status'], json_encode($verified['body']));
        $this->assertSame(self::OPENAI_API_GRANTS, $verified['body']['grants'] ?? null);
        $this->assertNotContains('*', $verified['body']['grants'] ?? []);
        $this->assertGreaterThan(0, $verified['body']['expiresInSeconds'] ?? 0);
        $this->assertLessThanOrEqual(300, $verified['body']['expiresInSeconds'] ?? 301);
    }

    public function testWorkspaceMintSupportsBothExactServicesWithoutAnAppId(): void
    {
        $services = [
            [
                'id' => self::SERVICE_ID,
                'actions' => ['status.read', 'models.list', 'assistant.chat'],
                'grants' => self::SERVICE_GRANTS,
            ],
            [
                'id' => self::OPENAI_API_SERVICE_ID,
                'actions' => ['chat.complete', 'models.list'],
                'grants' => self::OPENAI_API_GRANTS,
            ],
        ];

        foreach ($services as $service) {
            $result = $this->mintWorkspace($this->ownerId, ['serviceId' => $service['id']]);
            $this->assertSame(200, $result['status'], json_encode($result['body']));
            $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', (string) ($result['body']['token'] ?? ''));
            $this->assertSame($service['id'], $result['body']['serviceId'] ?? null);
            $this->assertSame($service['actions'], $result['body']['actions'] ?? null);
            $this->assertSame(300, $result['body']['expiresInSeconds'] ?? null);
            $this->assertSame('no-store', $result['cacheControl']);

            $token = (string) $result['body']['token'];
            $stmt = self::$pdo->prepare(
                'SELECT owner_user_id, user_id, app_id, connector_id, grants_json
                 FROM connector_capabilities WHERE token_hash = ?'
            );
            $stmt->execute([hash('sha256', $token)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $this->assertIsArray($row);
            $this->assertSame($this->ownerId, $row['owner_user_id']);
            $this->assertSame($this->ownerId, $row['user_id']);
            $this->assertNull($row['app_id']);
            $this->assertSame($service['id'], $row['connector_id']);
            $storedGrants = json_decode((string) $row['grants_json'], true);
            $this->assertSame($service['grants'], $storedGrants);
            $this->assertNotContains('*', $storedGrants);

            $verified = $this->introspect($this->ownerId, $token);
            $this->assertSame(200, $verified['status'], json_encode($verified['body']));
            $this->assertSame($this->ownerId, $verified['body']['userId'] ?? null);
            $this->assertArrayHasKey('appId', $verified['body']);
            $this->assertNull($verified['body']['appId']);
            $this->assertSame($service['grants'], $verified['body']['grants'] ?? null);
            $this->assertNotContains('*', $verified['body']['grants'] ?? []);
        }

        $this->assertSame(2, $this->workspaceCapabilityCount());
    }

    public function testWorkspaceMintRejectsAnonymousSuspendedStaleAndMalformedRequests(): void
    {
        $anonymous = $this->mintWorkspace(null, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(401, $anonymous['status']);

        $suspended = $this->mintWorkspace(
            $this->ownerId,
            ['serviceId' => self::SERVICE_ID],
            (object) ['id' => $this->ownerId, 'status' => 'suspended']
        );
        $this->assertSame(403, $suspended['status']);

        $mismatched = $this->mintWorkspace(
            $this->ownerId,
            ['serviceId' => self::SERVICE_ID],
            (object) ['id' => $this->memberId]
        );
        $this->assertSame(401, $mismatched['status']);

        $missingUserId = 'u-' . bin2hex(random_bytes(12));
        $stale = $this->mintWorkspace($missingUserId, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(401, $stale['status']);

        foreach ([
            [],
            ['serviceId' => 'anthropic-api'],
            ['serviceId' => ['openai-api']],
            ['serviceId' => self::OPENAI_API_SERVICE_ID, 'actions' => ['chat.complete']],
            ['serviceId' => self::SERVICE_ID, 'grants' => self::SERVICE_GRANTS],
        ] as $body) {
            $invalid = $this->mintWorkspace($this->ownerId, $body);
            $this->assertSame(400, $invalid['status'], json_encode($body));
        }
        $this->assertSame(0, $this->workspaceCapabilityCount());
    }

    public function testNonOwnerAndAnonymousCallersCannotMint(): void
    {
        $member = $this->mint($this->memberId, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(403, $member['status']);

        $anonymous = $this->mint(null, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(401, $anonymous['status']);
        $this->assertSame(0, $this->capabilityCount());
    }

    public function testOwnerMustHaveActiveMembershipInPublishedAccessibleApp(): void
    {
        self::$pdo->prepare("UPDATE app_users SET status = 'suspended' WHERE app_id = ? AND user_id = ?")
            ->execute([$this->appId, $this->ownerId]);
        $suspended = $this->mint($this->ownerId, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(403, $suspended['status']);

        self::$pdo->prepare("UPDATE app_users SET status = 'active' WHERE app_id = ? AND user_id = ?")
            ->execute([$this->appId, $this->ownerId]);
        self::$pdo->prepare("UPDATE apps SET status = 'archived' WHERE id = ?")->execute([$this->appId]);
        $archived = $this->mint($this->ownerId, ['serviceId' => self::SERVICE_ID]);
        $this->assertSame(404, $archived['status']);

        $missing = $this->mint($this->ownerId, ['serviceId' => self::SERVICE_ID], 'missing-app');
        $this->assertSame(404, $missing['status']);
        $this->assertSame(0, $this->capabilityCount());
    }

    public function testInputIsExactBoundedAndCannotSelectActionsOrGrants(): void
    {
        $invalidBodies = [
            [],
            ['serviceId' => 'anthropic-api'],
            ['serviceId' => 'openai-api-extra'],
            ['serviceId' => ['openai-codex-agent']],
            ['serviceId' => str_repeat('x', 65)],
            ['serviceId' => self::SERVICE_ID, 'actions' => ['assistant.chat']],
            ['serviceId' => self::SERVICE_ID, 'grants' => ['*']],
        ];
        foreach ($invalidBodies as $body) {
            $result = $this->mint($this->ownerId, $body);
            $this->assertSame(400, $result['status'], json_encode($body));
        }
        $this->assertSame(0, $this->capabilityCount());
    }
}
