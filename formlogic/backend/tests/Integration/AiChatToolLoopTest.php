<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AIController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppService;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Hosted tool loop in POST /api/ai/chat (plan Phase 6 §5.4): tools:true runs a bounded
 * agentic loop server-side AS THE SESSION USER — tool_call/tool_result SSE frames (their
 * wire format pinned via the encoder statics + runChatToolLoop's emit seam, since the
 * real SSE loop takes over the connection), the ≤6-round cap, the one-message-one-unit
 * metering staying per TURN (not per round), the typed tools_unsupported refusal for
 * flk_-authed callers, and demo_readonly for the shared demo. Skipped without a test DB.
 */
class AiChatToolLoopTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static ChatToolsService $tools;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-chatloop-test-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, self::$forms);
        self::$tools = new ChatToolsService(self::$forms, $apps, new ResponseService($conn, $sqlite));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
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

    private function controller(StubToolLoopAiService $stub): AIController
    {
        $files = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']);
        return new AIController(
            $stub,
            new DocumentConverter(),
            [],
            null,
            new PlanService(self::$mysql, $files, ['planEnforced' => true]),
            null,
            new \FormLogic\Services\ApiKeyService(self::$mysql),
            self::$tools,
            null
        );
    }

    private function chat(AIController $ctrl, array $body, bool $demo = false, ?string $flkKey = null): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat')
            ->withParsedBody($body);
        if ($flkKey !== null) {
            $req = $req->withHeader('Authorization', 'Bearer ' . $flkKey);
        } else {
            $req = $req->withAttribute('userId', $this->userId);
        }
        if ($demo) {
            $req = $req->withAttribute('user', (object) ['email' => $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local']);
        }
        $resp = $ctrl->chat($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** A round asking for one create_form tool call. */
    private static function toolCallRound(string $callId, array $args): array
    {
        return [
            'choices' => [['message' => [
                'content' => null,
                'tool_calls' => [[
                    'id' => $callId,
                    'type' => 'function',
                    'function' => ['name' => 'create_form', 'arguments' => json_encode($args)],
                ]],
            ]]],
            'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 5, 'total_tokens' => 15],
        ];
    }

    private static function finalRound(string $content): array
    {
        return [
            'choices' => [['message' => ['content' => $content]]],
            'usage' => ['prompt_tokens' => 20, 'completion_tokens' => 7, 'total_tokens' => 27],
        ];
    }

    private function myFormTitles(): array
    {
        return array_map(static fn ($f) => $f['title'], self::$forms->getAllForms($this->userId));
    }

    // ── tests ──

    public function testNonStreamingToolTurnExecutesAndMetersOneUnit(): void
    {
        $stub = new StubToolLoopAiService([
            self::toolCallRound('call_1', ['title' => 'Loop-built form']),
            self::finalRound('Created your form.'),
        ]);
        $out = $this->chat($this->controller($stub), [
            'messages' => [['role' => 'user', 'content' => 'make me a form']],
            'tools' => true,
        ]);
        $this->assertSame(200, $out['status']);
        $this->assertSame('Created your form.', $out['body']['data']['content']);
        // Usage sums across BOTH rounds…
        $this->assertSame(30, $out['body']['data']['usage']['promptTokens']);
        $this->assertSame(2, $stub->rounds);
        // …the tool really ran as the session user…
        $this->assertContains('Loop-built form', $this->myFormTitles());
        // …and metering stayed one unit per user MESSAGE, not per round.
        $stmt = self::$pdo->prepare("SELECT `count` FROM usage_meter WHERE user_id = ? AND metric = 'ai_messages' AND period = ?");
        $stmt->execute([$this->userId, gmdate('Y-m')]);
        $this->assertSame(1, (int) $stmt->fetchColumn());
    }

    public function testFlkCallersRequestingToolsGetTypedRefusal(): void
    {
        $apiKeys = new \FormLogic\Services\ApiKeyService(self::$mysql);
        $key = $apiKeys->createKey($this->userId, 'loop-flk', ['ai:relay']);
        $stub = new StubToolLoopAiService([self::finalRound('never reached')]);
        $out = $this->chat($this->controller($stub), [
            'messages' => [['role' => 'user', 'content' => 'hi']],
            'tools' => true,
        ], false, $key['key']);
        $this->assertSame(400, $out['status']);
        $this->assertSame('tools_unsupported', $out['body']['code']);
        $this->assertSame(0, $stub->rounds, 'refused before any upstream round');
    }

    public function testDemoToolsAre403(): void
    {
        $stub = new StubToolLoopAiService([self::finalRound('never reached')]);
        $out = $this->chat($this->controller($stub), [
            'messages' => [['role' => 'user', 'content' => 'hi']],
            'tools' => true,
        ], true);
        $this->assertSame(403, $out['status']);
        $this->assertSame('demo_readonly', $out['body']['code']);
        $this->assertSame(0, $stub->rounds);
    }

    public function testRoundsCapAtSixWithoutExecutingTheLastPendingCalls(): void
    {
        // Every round asks for another tool call → the loop must stop at 6 upstream rounds,
        // execute only rounds 1..5's calls, and answer honestly.
        $stub = new StubToolLoopAiService([
            self::toolCallRound('call_r', ['title' => 'Capped form']),
        ], true);
        $out = $this->chat($this->controller($stub), [
            'messages' => [['role' => 'user', 'content' => 'loop forever']],
            'tools' => true,
        ]);
        $this->assertSame(200, $out['status']);
        $this->assertSame(AIController::CHAT_TOOL_MAX_ROUNDS, $stub->rounds);
        $this->assertStringContainsString('tool-use limit', $out['body']['data']['content']);
        $created = array_values(array_filter($this->myFormTitles(), static fn ($t) => $t === 'Capped form'));
        $this->assertCount(AIController::CHAT_TOOL_MAX_ROUNDS - 1, $created, 'the capped round\'s pending calls are not executed');
    }

    public function testLoopEmitsThePinnedToolEventFrames(): void
    {
        $stub = new StubToolLoopAiService([
            self::toolCallRound('call_9', ['title' => 'SSE form']),
            self::finalRound('done'),
        ]);
        $frames = [];
        $result = $this->controller($stub)->runChatToolLoop(
            $this->userId,
            [['role' => 'user', 'content' => 'go']],
            static function (string $frame) use (&$frames): void {
                $frames[] = $frame;
            }
        );
        $this->assertSame('done', $result['content']);
        $this->assertCount(2, $frames);
        // Pinned data-only wire shapes (chatEngine.ts createSiteChatSseParser dispatches on `type`).
        $this->assertSame(AIController::sseToolCall('call_9', 'create_form'), $frames[0]);
        $this->assertStringStartsWith('data: {"type":"tool_call","id":"call_9","name":"create_form","status":"running"}', $frames[0]);
        $resultEvent = json_decode(trim(substr($frames[1], strlen('data: '))), true);
        $this->assertSame('tool_result', $resultEvent['type']);
        $this->assertSame('call_9', $resultEvent['id']);
        $this->assertSame('done', $resultEvent['status']);
        $this->assertSame('SSE form', $resultEvent['result']['title'] ?? null);
    }

    public function testFailedToolEmitsFailureFrameAndLoopStillAnswers(): void
    {
        // update_form with status archived is the guarded chat refusal → status:"failed" frame,
        // the error feeds back to the model, and the turn still ends with the final round.
        $stub = new StubToolLoopAiService([
            [
                'choices' => [['message' => [
                    'content' => null,
                    'tool_calls' => [[
                        'id' => 'call_x',
                        'type' => 'function',
                        'function' => ['name' => 'update_form', 'arguments' => json_encode(['formId' => 'missing', 'status' => 'archived'])],
                    ]],
                ]]],
                'usage' => [],
            ],
            self::finalRound('sorry, no'),
        ]);
        $frames = [];
        $result = $this->controller($stub)->runChatToolLoop(
            $this->userId,
            [['role' => 'user', 'content' => 'archive it']],
            static function (string $frame) use (&$frames): void {
                $frames[] = $frame;
            }
        );
        $this->assertSame('sorry, no', $result['content']);
        $failure = json_decode(trim(substr($frames[1], strlen('data: '))), true);
        $this->assertSame('tool_result', $failure['type']);
        $this->assertSame('failed', $failure['status']);
        $this->assertStringContainsStringIgnoringCase('archiv', (string) $failure['error']);
    }
}

/** AIService stub: configured; tool rounds replay a script (optionally looping the last step). */
class StubToolLoopAiService extends AIService
{
    public int $rounds = 0;

    /** @param array[] $script decoded /chat/completions bodies, served in order */
    public function __construct(private array $script, private bool $repeatLast = false)
    {
        $_ENV['AI_BASE_URL'] = 'http://127.0.0.1:9'; // keyless local endpoint → configured
        parent::__construct();
        unset($_ENV['AI_BASE_URL']);
    }

    protected function chatCompletionsToolsRequest(array $payload): array
    {
        $idx = $this->rounds;
        $this->rounds++;
        if ($idx >= count($this->script)) {
            if (!$this->repeatLast) {
                throw new \Exception('Stub script exhausted');
            }
            $idx = count($this->script) - 1;
        }
        return $this->script[$idx];
    }

    protected function chatCompletionsRequest(array $payload, bool $stream, ?callable $onDelta, ?callable $onHeartbeat): array
    {
        return ['content' => 'plain reply', 'usage' => ['promptTokens' => 1, 'completionTokens' => 1, 'totalTokens' => 2]];
    }
}
