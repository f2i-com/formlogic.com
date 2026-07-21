<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AIController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\PlanService;
use FormLogic\Services\UserAiSettingsService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Per-user AI preferences (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 2): the
 * user_ai_settings round-trip (defaults when absent, full-replace PUT, enum/bounds
 * validation), the session GET/PUT controller shape (preferences + usage), and the
 * flk_ /api/v1 surface returning the ACCOUNT OWNER's settings under either the
 * ai:relay or grandfathered connector:relay scope. Skipped without a test database.
 */
class AiPreferencesTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static UserAiSettingsService $settings;

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
        self::$settings = new UserAiSettingsService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function controller(): AIController
    {
        $files = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']);
        return new AIController(
            new AIService(),
            new DocumentConverter(),
            [],
            null,
            new PlanService(self::$mysql, $files, ['planEnforced' => true]),
            self::$settings
        );
    }

    private function sessionRequest(string $method, string $path, ?array $body, ?string $userId): \Psr\Http\Message\ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, self::BASE . $path);
        if ($body !== null) {
            $req = $req->withParsedBody($body);
        }
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        return $req;
    }

    // ── service round-trip ──

    public function testDefaultsWhenNoRowExists(): void
    {
        $prefs = self::$settings->get($this->userId);
        $this->assertSame('site', $prefs['aiSource']);
        $this->assertNull($prefs['desktopProviderId']);
        $this->assertNull($prefs['desktopModel']);
        $this->assertNull($prefs['customProviderId']);
        $this->assertSame('auto', $prefs['chatToolMode']);
        $this->assertNull($prefs['updatedAt']);
    }

    public function testPutRoundTripsAndIsFullReplace(): void
    {
        $stored = self::$settings->put($this->userId, [
            'aiSource' => 'desktop',
            'desktopProviderId' => 'openai-codex-agent',
            'desktopModel' => 'gpt-5-codex',
            'chatToolMode' => 'confirm',
        ]);
        $this->assertSame('desktop', $stored['aiSource']);
        $this->assertSame('openai-codex-agent', $stored['desktopProviderId']);
        $this->assertSame('gpt-5-codex', $stored['desktopModel']);
        $this->assertSame('confirm', $stored['chatToolMode']);
        $this->assertNotNull($stored['updatedAt']);

        // A later PUT is a full replace: absent keys fall back to defaults.
        $stored2 = self::$settings->put($this->userId, ['aiSource' => 'custom', 'customProviderId' => 'local-llm']);
        $this->assertSame('custom', $stored2['aiSource']);
        $this->assertSame('local-llm', $stored2['customProviderId']);
        $this->assertNull($stored2['desktopProviderId']);
        $this->assertSame('auto', $stored2['chatToolMode']);
    }

    public function testPutRejectsBadEnumsAndOverlongIds(): void
    {
        try {
            self::$settings->put($this->userId, ['aiSource' => 'magic']);
            $this->fail('expected aiSource enum rejection');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('aiSource', $e->getMessage());
        }
        try {
            self::$settings->put($this->userId, ['chatToolMode' => 'yolo']);
            $this->fail('expected chatToolMode enum rejection');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('chatToolMode', $e->getMessage());
        }
        try {
            self::$settings->put($this->userId, ['desktopProviderId' => str_repeat('x', 129)]);
            $this->fail('expected the 128-char bound to bite');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('desktopProviderId', $e->getMessage());
        }
        // Nothing was persisted by the rejected writes.
        $this->assertSame('site', self::$settings->get($this->userId)['aiSource']);
    }

    // ── session controller ──

    public function testSessionGetPutPreferences(): void
    {
        $ctrl = $this->controller();

        $noAuth = $ctrl->getPreferences($this->sessionRequest('GET', '/api/ai/preferences', null, null), (new ResponseFactory())->createResponse());
        $this->assertSame(401, $noAuth->getStatusCode());

        $get = self::decode($ctrl->getPreferences($this->sessionRequest('GET', '/api/ai/preferences', null, $this->userId), (new ResponseFactory())->createResponse()));
        $this->assertSame('site', $get['data']['aiSource']);
        $this->assertSame(['used' => 0, 'limit' => 500], $get['data']['usage']);

        $put = $ctrl->putPreferences(
            $this->sessionRequest('PUT', '/api/ai/preferences', ['aiSource' => 'desktop', 'desktopProviderId' => 'openai-codex-agent'], $this->userId),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(200, $put->getStatusCode());
        $this->assertSame('desktop', self::decode($put)['data']['aiSource']);

        $bad = $ctrl->putPreferences(
            $this->sessionRequest('PUT', '/api/ai/preferences', ['aiSource' => 'magic'], $this->userId),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(400, $bad->getStatusCode());
    }

    // ── v1 (flk_) surface ──

    public function testV1ReturnsOwnerSettingsUnderEitherScope(): void
    {
        self::$settings->put($this->userId, ['aiSource' => 'desktop', 'desktopProviderId' => 'openai-codex-agent', 'desktopModel' => 'gpt-5-codex']);
        $ctrl = $this->controller();

        $v1 = function (array $scopes) use ($ctrl) {
            $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/v1/ai/preferences')
                ->withAttribute('userId', $this->userId)
                ->withAttribute('apiKeyScopes', $scopes);
            return $ctrl->preferencesV1($req, (new ResponseFactory())->createResponse());
        };

        foreach ([['ai:relay'], ['connector:relay'], ['flows:write', 'ai:relay']] as $scopes) {
            $resp = $v1($scopes);
            $this->assertSame(200, $resp->getStatusCode(), 'scopes: ' . implode(',', $scopes));
            $prefs = self::decode($resp)['data'];
            $this->assertSame('desktop', $prefs['aiSource']);
            $this->assertSame('openai-codex-agent', $prefs['desktopProviderId']);
            $this->assertSame('gpt-5-codex', $prefs['desktopModel']);
        }

        $denied = $v1(['flows:write']);
        $this->assertSame(403, $denied->getStatusCode());
        $this->assertSame('insufficient_scope', self::decode($denied)['code']);

        $noAuth = $ctrl->preferencesV1(
            (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/v1/ai/preferences'),
            (new ResponseFactory())->createResponse()
        );
        $this->assertSame(401, $noAuth->getStatusCode());
    }
}
