<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AIController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\PlanService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * POST /api/ai/chat (plan Phase 2): allowance gating with the typed ai_allowance_exceeded
 * refusal (402), usage_meter recording (message count + tokens), the planEnforced gate
 * (off = never refused, still metered), validation/503 ordering (no charge for a request
 * that can't run), and the stream=true refusal path staying JSON (the authorized stream
 * takes over the connection and can't return to PHPUnit — its wire format is locked by
 * the encoder tests in tests/Unit/AiChatServiceTest.php). Skipped without a test database.
 */
class AiChatControllerTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?\PDO $pdo = null;

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
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
        // Every test starts from the seeded 500/mo allowance.
        self::$pdo->prepare("INSERT INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES ('personal', 'ai_messages', 500, 1)
            ON DUPLICATE KEY UPDATE monthly_value = 500, enabled = 1")->execute();
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

    private function controller(bool $enforced = true): AIController
    {
        $files = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']);
        return new AIController(
            new StubChatAiService(),
            new DocumentConverter(),
            [],
            null,
            new PlanService(self::$mysql, $files, ['planEnforced' => $enforced]),
            null,
            new \FormLogic\Services\ApiKeyService(self::$mysql)
        );
    }

    private function chat(AIController $ctrl, ?array $body, ?string $userId = null): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withParsedBody($body ?? [])
            ->withAttribute('userId', $userId ?? $this->userId);
        $resp = $ctrl->chat($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function meter(): ?array
    {
        $stmt = self::$pdo->prepare("SELECT `count`, tokens_in, tokens_out FROM usage_meter WHERE user_id = ? AND metric = 'ai_messages' AND period = ?");
        $stmt->execute([$this->userId, gmdate('Y-m')]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    // ── tests ──

    public function testChatAnswerIsMeteredWithTokens(): void
    {
        $out = $this->chat($this->controller(), ['messages' => [['role' => 'user', 'content' => 'Hello']]]);
        $this->assertSame(200, $out['status']);
        $this->assertSame('stub reply', $out['body']['data']['content']);
        $this->assertSame(11, $out['body']['data']['usage']['promptTokens']);
        $meter = $this->meter();
        $this->assertNotNull($meter);
        $this->assertSame(1, (int) $meter['count']);
        $this->assertSame(11, (int) $meter['tokens_in']);
        $this->assertSame(7, (int) $meter['tokens_out']);
    }

    public function testOverAllowanceIsATyped402(): void
    {
        self::$pdo->prepare("UPDATE plan_allowances SET monthly_value = 1 WHERE plan = 'personal' AND metric = 'ai_messages'")->execute();
        $first = $this->chat($this->controller(), ['messages' => [['role' => 'user', 'content' => 'one']]]);
        $this->assertSame(200, $first['status']);
        $second = $this->chat($this->controller(), ['messages' => [['role' => 'user', 'content' => 'two']]]);
        $this->assertSame(402, $second['status']);
        $this->assertSame('ai_allowance_exceeded', $second['body']['code']);
        // Only the successful message was metered.
        $this->assertSame(1, (int) $this->meter()['count']);
    }

    public function testEnforcementOffNeverRefusesButStillMeters(): void
    {
        self::$pdo->prepare("UPDATE plan_allowances SET monthly_value = 1 WHERE plan = 'personal' AND metric = 'ai_messages'")->execute();
        $ctrl = $this->controller(false);
        for ($i = 0; $i < 3; $i++) {
            $out = $this->chat($ctrl, ['messages' => [['role' => 'user', 'content' => 'hi ' . $i]]]);
            $this->assertSame(200, $out['status']);
        }
        $this->assertSame(3, (int) $this->meter()['count']);
    }

    public function testStreamRefusalStaysJson(): void
    {
        self::$pdo->prepare("UPDATE plan_allowances SET monthly_value = 0 WHERE plan = 'personal' AND metric = 'ai_messages'")->execute();
        $out = $this->chat($this->controller(), ['messages' => [['role' => 'user', 'content' => 'hi']], 'stream' => true]);
        // The allowance refusal answers BEFORE any SSE starts, so it is ordinary JSON.
        $this->assertSame(402, $out['status']);
        $this->assertSame('ai_allowance_exceeded', $out['body']['code']);
    }

    public function testValidationAndAuthErrors(): void
    {
        $ctrl = $this->controller();
        // No userId attribute at all → 401.
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withParsedBody(['messages' => [['role' => 'user', 'content' => 'hi']]]);
        $resp = $ctrl->chat($req, (new ResponseFactory())->createResponse());
        $this->assertSame(401, $resp->getStatusCode());

        $missing = $this->chat($ctrl, []);
        $this->assertSame(400, $missing['status']);
        $badRole = $this->chat($ctrl, ['messages' => [['role' => 'wizard', 'content' => 'hi']]]);
        $this->assertSame(400, $badRole['status']);
        // Validation failures are not metered.
        $this->assertNull($this->meter());
    }

    /**
     * plan §5.6: the desktop flow runner calls POST /api/ai/chat over its flk_ key (no
     * session); the hosted call is metered to the ACCOUNT OWNER (the key's owner).
     */
    public function testChatAcceptsAScopedFlkKey(): void
    {
        $apiKeys = new \FormLogic\Services\ApiKeyService(self::$mysql);
        $key = $apiKeys->createKey($this->userId, 'desktop-test', ['ai:relay']);
        $ctrl = $this->controller();
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withHeader('Authorization', 'Bearer ' . $key['key'])
            ->withParsedBody(['messages' => [['role' => 'user', 'content' => 'Hello']]]);
        $resp = $ctrl->chat($req, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $resp->getStatusCode());
        $this->assertSame(1, (int) $this->meter()['count']);

        // Grandfathered connector:relay works too (plan §7).
        $legacy = $apiKeys->createKey($this->userId, 'desktop-legacy', ['connector:relay']);
        $req2 = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withHeader('Authorization', 'Bearer ' . $legacy['key'])
            ->withParsedBody(['messages' => [['role' => 'user', 'content' => 'Hello again']]]);
        $this->assertSame(200, $ctrl->chat($req2, (new ResponseFactory())->createResponse())->getStatusCode());

        // A key without either relay scope is refused.
        $wrongScope = $apiKeys->createKey($this->userId, 'desktop-wrong', ['flows:write']);
        $req3 = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withHeader('Authorization', 'Bearer ' . $wrongScope['key'])
            ->withParsedBody(['messages' => [['role' => 'user', 'content' => 'Hello']]]);
        $denied = $ctrl->chat($req3, (new ResponseFactory())->createResponse());
        $this->assertSame(403, $denied->getStatusCode());
        $this->assertSame('insufficient_scope', self::decode($denied)['code']);

        // A bogus key is a plain 401.
        $req4 = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withHeader('Authorization', 'Bearer flk_' . str_repeat('0', 40))
            ->withParsedBody(['messages' => [['role' => 'user', 'content' => 'Hello']]]);
        $this->assertSame(401, $ctrl->chat($req4, (new ResponseFactory())->createResponse())->getStatusCode());
    }
}

/** AIService stub: configured, and its transport returns a fixed answer with usage. */
class StubChatAiService extends AIService
{
    public function __construct()
    {
        $_ENV['AI_BASE_URL'] = 'http://127.0.0.1:9'; // keyless local endpoint → configured
        parent::__construct();
        unset($_ENV['AI_BASE_URL']);
    }

    protected function chatCompletionsRequest(array $payload, bool $stream, ?callable $onDelta, ?callable $onHeartbeat): array
    {
        return ['content' => 'stub reply', 'usage' => ['promptTokens' => 11, 'completionTokens' => 7, 'totalTokens' => 18]];
    }
}
